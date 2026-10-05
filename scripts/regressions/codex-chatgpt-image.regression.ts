import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_IMAGE_MODEL, inferImageSource } from "../../packages/shared/src/constants/model-lists.js";
import { logger } from "../../packages/server/src/lib/logger.js";
import { generateChatGPTImage, generateImage } from "../../packages/server/src/services/image/image-generation.js";

// A throwaway CODEX_HOME, so the test never reads or refreshes a real Codex login, and a stub
// fetch, so nothing reaches the network.
const codexHome = mkdtempSync(join(tmpdir(), "marinara-codex-image-"));
const previousCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = codexHome;

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const jpeg = "/9j/4AAQSkZJRgABAQ==";
const token = (exp: number) => `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
const validToken = token(9_999_999_999);
const writeLogin = (accessToken: string) =>
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: new Date().toISOString(),
      tokens: { access_token: accessToken, account_id: "account-fixture" },
    }),
  );

type FetchFixture = NonNullable<Parameters<typeof generateChatGPTImage>[1]>;
const calls: Array<{ url: string; init: RequestInit; policy: unknown }> = [];
let reply = () => Response.json({ created: 1, data: [{ b64_json: png }], size: "1024x1536" });
const fetchFixture: FetchFixture = async (url, init, policy) => {
  calls.push({ url: String(url), init: init ?? {}, policy });
  return reply();
};
const sent = (index = calls.length - 1) => JSON.parse(String(calls[index]!.init.body)) as Record<string, any>;

const logs: unknown[][] = [];
const priorWarn = logger.warn;
const priorLevel = logger.level;
logger.level = "warn";
logger.warn = ((...args: unknown[]) => logs.push(args)) as typeof logger.warn;

try {
  assert.equal(inferImageSource("codex_chatgpt", ""), "codex_chatgpt");
  writeLogin(validToken);

  // Text to image: generation endpoint, login headers, size and the stated canvas shape.
  const result = await generateChatGPTImage(
    { prompt: "a fox in the snow", negativePrompt: "text", width: 1024, height: 1536, debugMode: true },
    fetchFixture,
  );
  assert.deepEqual(result, { base64: png, mimeType: "image/png", ext: "png" });
  assert.equal(calls[0]!.url, "https://chatgpt.com/backend-api/codex/images/generations");
  assert.equal(calls[0]!.init.method, "POST");
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${validToken}`);
  assert.equal(headers.get("chatgpt-account-id"), "account-fixture");
  assert.match(headers.get("x-codex-image-turn-id") ?? "", /^[0-9a-f-]{36}$/u);
  assert.deepEqual(
    calls[0]!.policy,
    { allowLocal: false, allowLoopback: false, allowedOrigins: ["https://chatgpt.com/backend-api/codex"] },
    "The login token may only go to the fixed ChatGPT origin",
  );
  assert.deepEqual(sent(), {
    model: CODEX_IMAGE_MODEL,
    prompt:
      "a fox in the snow\n\nDo not include: text.\n\n" +
      "Target canvas: portrait, 2:3 aspect ratio (nominal size 1024 x 1536 pixels).\n" +
      "Compose the final image for this aspect ratio.",
    background: "opaque",
    quality: "auto",
    size: "1024x1536",
  });
  const payloadLogs = JSON.stringify(logs.filter(([message]) => String(message).includes("payload")));
  assert.match(payloadLogs, /a fox in the snow/u, "Debug mode shows the final prompt");
  assert.ok(!payloadLogs.includes(validToken), "The login token never reaches the logs");

  // References switch to the edit endpoint as data URLs, capped at 16 like OpenAI's.
  logs.length = 0;
  await generateChatGPTImage(
    {
      prompt: "the same character, waving",
      referenceImages: [`data:image/png;base64,${png}`, jpeg, ...Array.from({ length: 20 }, () => png)],
      width: 1280,
      height: 720,
      transparentBackground: true,
      model: " ",
      debugMode: true,
    },
    fetchFixture,
  );
  assert.equal(calls[1]!.url, "https://chatgpt.com/backend-api/codex/images/edits");
  const edit = sent();
  assert.equal(edit.model, CODEX_IMAGE_MODEL, "A blank model falls back to the Codex image model");
  assert.equal(edit.background, "transparent");
  assert.equal(edit.images.length, 16);
  assert.deepEqual(edit.images.slice(0, 2), [
    { image_url: `data:image/png;base64,${png}` },
    { image_url: `data:image/jpeg;base64,${jpeg}` },
  ]);
  assert.match(edit.prompt, /Do not inherit the canvas dimensions or aspect ratio of the attached reference images/u);
  assert.match(edit.prompt, /Target canvas: landscape, 16:9 aspect ratio/u);
  assert.ok(!JSON.stringify(logs).includes(png), "Reference image data stays out of the logs");

  // A single reference also edits; no size means no canvas line.
  await generateChatGPTImage({ prompt: "make it night", referenceImage: png }, fetchFixture);
  assert.match(calls[2]!.url, /\/images\/edits$/u);
  assert.equal(sent().images.length, 1);
  assert.equal(sent().prompt, "make it night");

  // Response parsing and endpoint errors.
  reply = () => Response.json({ created: 1, data: [] });
  await assert.rejects(generateChatGPTImage({ prompt: "x" }, fetchFixture), /No image data in ChatGPT response/u);
  reply = () => Response.json({ error: { type: "usage_limit_reached", message: "Limit hit" } }, { status: 429 });
  await assert.rejects(
    generateChatGPTImage({ prompt: "x" }, fetchFixture),
    /ChatGPT image generation failed \(429\).*usage_limit_reached/u,
  );
  reply = () => Response.json({ detail: "Unauthorized" }, { status: 401 });
  await assert.rejects(generateChatGPTImage({ prompt: "x" }, fetchFixture), /Run `codex login` again/u);

  // An expired login with nothing to refresh it fails before any request is sent.
  const requestsBeforeLoginErrors = calls.length;
  writeLogin(token(1));
  await assert.rejects(generateChatGPTImage({ prompt: "x" }, fetchFixture), /stale.*Run `codex login`/u);

  // No login at all, reached through the normal image service dispatch.
  rmSync(join(codexHome, "auth.json"));
  await assert.rejects(
    generateImage(CODEX_IMAGE_MODEL, "", "", "codex_chatgpt", { prompt: "x" }),
    /No Codex ChatGPT login found.*Run `codex login`/u,
  );
  assert.equal(calls.length, requestsBeforeLoginErrors, "Login errors never send an image request");
} finally {
  logger.warn = priorWarn;
  logger.level = priorLevel;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(codexHome, { recursive: true, force: true });
}

console.info("ChatGPT (Codex login) image regressions passed.");
