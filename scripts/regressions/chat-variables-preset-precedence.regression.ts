// Preset variables outrank chat variables. History is resolved before the
// assembler merges preset values, so without the deferral a name defined in
// both would reach the model twice with two different values: the preset's in
// the prompt sections and the chat's in the user message.
//
// Driven through /api/generate/dryRun, the same path Peek Prompt uses.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousDataDir = process.env.DATA_DIR;
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "marinara-chat-variable-precedence-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createPromptsStorage } = await import("../../packages/server/src/services/storage/prompts.storage.js");
const { characterDataSchema } = await import("../../packages/shared/src/index.js");

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
app.decorate("activeGenerations", new Map());
await app.register(generateRoutes, { prefix: "/api/generate" });

try {
  const connections = createConnectionsStorage(db);
  const connection = await connections.create({
    name: "Precedence fixture",
    provider: "custom",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
    apiKey: "fixture",
    maxContext: 8192,
    maxTokensOverride: 256,
  });
  assert.ok(connection);

  const character = await createCharactersStorage(db).create(characterDataSchema.parse({ name: "Pantalone" }));
  assert.ok(character);

  // The preset owns char1; the chat also defines it, plus a name of its own.
  const presets = createPromptsStorage(db);
  const preset = await presets.create({
    name: "Precedence fixture",
    parameters: { maxTokens: 256, maxContext: 8192 },
    variableValues: { char1: "Anna" },
  });
  assert.ok(preset);
  await presets.createSection({
    presetId: preset.id,
    identifier: "lead",
    name: "Lead",
    content: "The lead is {{char1}}. The mood is {{mood}}.",
  });
  await presets.createSection({
    presetId: preset.id,
    identifier: "history",
    name: "Chat History",
    isMarker: true,
    markerConfig: { type: "chat_history" },
  });

  const chats = createChatsStorage(db);
  const chat = await chats.create({
    name: "Precedence proof",
    mode: "roleplay",
    characterIds: [character.id],
    connectionId: connection.id,
    promptPresetId: preset.id,
    personaId: null,
    groupId: null,
  });
  assert.ok(chat);
  await chats.patchMetadata(chat.id, { macroVariables: { char1: "Mary", mood: "tense" } });
  // The conditional and the bare tag are in one message on purpose: before the
  // fix this produced "CHAT_BRANCH then Anna walks in." — the same sentence
  // disagreeing with itself about which value char1 has.
  await chats.createMessage({
    chatId: chat.id,
    role: "user",
    content:
      '{{#if char1 == "Anna"}}PRESET_BRANCH{{else}}CHAT_BRANCH{{/if}} then {{char1}} walks in and looks {{mood}}.',
  });

  const dry = await app.inject({
    method: "POST",
    url: "/api/generate/dryRun",
    payload: { chatId: chat.id, returnPrompt: true },
  });
  assert.equal(dry.statusCode, 200, dry.body);
  const messages = dry.json().prompt.messages as Array<{ role: string; content: string }>;
  const prompt = JSON.stringify(messages);

  // One name, one value, everywhere in the request.
  assert.ok(prompt.includes("The lead is Anna."), `preset section should read Anna: ${prompt}`);
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  assert.ok(
    userText.includes("Anna walks in"),
    `the user message must use the preset value, not the chat's: ${userText}`,
  );
  assert.ok(!prompt.includes("Mary"), `the shadowed chat value must not reach the model: ${prompt}`);
  assert.ok(!prompt.includes("{{char1}}"), `no raw tag may escape to the model: ${prompt}`);

  // A conditional on the same name must read the preset value too, not the chat's.
  assert.ok(userText.includes("PRESET_BRANCH"), `the conditional must test the preset value: ${userText}`);
  assert.ok(!userText.includes("CHAT_BRANCH"), `the chat branch must not be chosen: ${userText}`);
  assert.ok(!/\u0000|MARINARA_DEFERRED/u.test(prompt), `no deferred control token may reach the model: ${prompt}`);

  // A chat variable the preset does not define still resolves from the chat.
  assert.ok(userText.includes("looks tense"), `chat-only variables still resolve: ${userText}`);
  assert.ok(prompt.includes("The mood is tense."), `and they reach prompt sections too: ${prompt}`);

  console.info("chat variable preset precedence regressions passed.");
} finally {
  await app.close();
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
}
