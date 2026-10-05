import assert from "node:assert/strict";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-message-trash-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
process.env.DISABLE_REQUEST_LOGGING = "true";
process.env.AUTO_CREATE_DEFAULT_CONNECTION = "false";

type TestApp = {
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<{ statusCode: number; json(): any; body: string }>;
  ready(): Promise<void>;
};
let app: TestApp | null = null;
let closeDatabase: (() => Promise<void>) | undefined;
const providerRequests: Array<Record<string, any>> = [];
const provider = createServer(async (request, response) => {
  if (request.url?.endsWith("/api/extra/abort")) {
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  providerRequests.push(body);
  assert(request.url?.endsWith("/messages"), "the prompt proof uses the mock Anthropic endpoint");
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, value: object) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send("message_start", {
    message: {
      id: "fixture",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Prompt proof response." } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
  send("message_stop", {});
  response.end();
});
try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { closeDB, getDB } = await import("../../packages/server/src/db/connection.js");
  closeDatabase = closeDB;
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { encodeShardKey } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, gameStateSnapshots, memoryChunks, messages, messageSwipes, messageTrash } =
    await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage, withMessageExtraPatchQueue } =
    await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createConnectionsStorage } =
    await import("../../packages/server/src/services/storage/connections.storage.js");
  const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
  const { createPromptsStorage } = await import("../../packages/server/src/services/storage/prompts.storage.js");
  const { createMessageTrashStorage, startMessageTrashMaintenance, sweepExpiredMessageTrash } =
    await import("../../packages/server/src/services/storage/message-trash.storage.js");
  const { characterDataSchema, MAX_PINNED_CONTEXT_MESSAGES, MESSAGE_TRASH_RETENTION_DAYS } =
    await import("../../packages/shared/src/index.ts");

  let resolveSweep!: (result: { purged: number }) => void;
  let maintenanceCalls = 0;
  const maintenance = startMessageTrashMaintenance(
    () => {
      maintenanceCalls += 1;
      return new Promise((resolve) => {
        resolveSweep = resolve;
      });
    },
    { info: () => undefined, warn: (error) => assert.fail(`unexpected maintenance error: ${String(error)}`) },
    60_000,
  );
  await Promise.resolve();
  assert.equal(maintenanceCalls, 1, "maintenance starts a cleanup immediately");
  const overlappingSweep = maintenance.sweep();
  assert.equal(maintenanceCalls, 1, "a second trigger reuses the in-flight sweep");
  let maintenanceStopped = false;
  const stoppingMaintenance = maintenance.stop().then(() => {
    maintenanceStopped = true;
  });
  await Promise.resolve();
  assert.equal(maintenanceStopped, false, "stop waits while cleanup is still writing");
  resolveSweep({ purged: 0 });
  await Promise.all([overlappingSweep, stoppingMaintenance]);
  assert.equal(maintenanceStopped, true);
  await maintenance.sweep();
  assert.equal(maintenanceCalls, 1, "a stopped maintenance runner cannot start new work");

  let retryCalls = 0;
  const maintenanceErrors: unknown[] = [];
  const retryMaintenance = startMessageTrashMaintenance(
    async () => {
      retryCalls += 1;
      if (retryCalls === 1) throw new Error("synthetic sweep failure");
      return { purged: 0 };
    },
    { info: () => undefined, warn: (error) => maintenanceErrors.push(error) },
    60_000,
  );
  await retryMaintenance.sweep();
  await retryMaintenance.sweep();
  assert.equal(retryCalls, 2, "a failed sweep is retried by the next trigger");
  assert.equal(maintenanceErrors.length, 1, "sweep failures are reported and contained");
  await retryMaintenance.stop();

  app = (await buildApp()) as TestApp;
  await app.ready();
  const db = await getDB();
  const storage = createChatsStorage(db);
  const timestamp = "2026-09-01T00:00:00.000Z";
  for (const [id, mode] of [
    ["chat-message-trash", "conversation"],
    ["game-message-trash", "game"],
    ["pin-restore-chat", "conversation"],
  ] as const) {
    await db.insert(chats).values({
      id,
      name: id,
      mode,
      characterIds: "[]",
      metadata: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const message = await storage.createMessage({
    chatId: "chat-message-trash",
    role: "assistant",
    characterId: null,
    content: "Restorable message",
    extra: { bookmark: { label: "Keep", createdAt: timestamp }, privateNote: "PRIVATE_NOTE_EXPORT_SENTINEL_6698" },
  } as never);
  assert.ok(message);
  const defaultOffDelete = await app.inject({
    method: "DELETE",
    url: `/api/chats/chat-message-trash/messages/${message.id}`,
  });
  assert.equal(defaultOffDelete.statusCode, 200, defaultOffDelete.body);
  assert.deepEqual(defaultOffDelete.json(), { trashed: false, trashedCount: 0 });
  assert.equal(await storage.getMessage(message.id), null, "trash is opt-in; default delete remains permanent");
  assert.equal(
    (await db.select().from(messageTrash).where(eq(messageTrash.chatId, "chat-message-trash"))).length,
    0,
    "default-off deletion does not create a trash entry",
  );

  const enabled = await app.inject({
    method: "PUT",
    url: "/api/app-settings/features",
    payload: { messageTrash: true },
  });
  assert.equal(enabled.statusCode, 200, enabled.body);

  // An edit already queued when Delete is tapped must be included in the recovery snapshot.
  const queuedEditMessage = await storage.createMessage({
    chatId: "chat-message-trash",
    role: "assistant",
    content: "Before the queued edit",
  } as never);
  assert(queuedEditMessage);
  let releaseEdit!: () => void;
  const heldEdit = withMessageExtraPatchQueue(
    queuedEditMessage.id,
    () =>
      new Promise<void>((resolve) => {
        releaseEdit = resolve;
      }),
  );
  await Promise.resolve();
  const queuedEdit = storage.updateMessageContent(queuedEditMessage.id, "Saved immediately before deletion");
  const queuedDeletion = app.inject({
    method: "DELETE",
    url: `/api/chats/chat-message-trash/messages/${queuedEditMessage.id}`,
  });
  // ponytail: this bounded queue hold follows existing race proofs; if slow runners make it flaky,
  // wait for an existing observable delete boundary instead of adding a production test hook.
  await new Promise((resolve) => setTimeout(resolve, 150));
  releaseEdit();
  await Promise.all([heldEdit, queuedEdit, queuedDeletion]);
  const queuedTrash = (await app.inject({ method: "GET", url: "/api/chats/chat-message-trash/trash" })).json();
  const queuedEntry = queuedTrash.find((row: { messageId: string }) => row.messageId === queuedEditMessage.id);
  assert(queuedEntry);
  assert.equal(queuedEntry.content, "Saved immediately before deletion", "trash captures the final queued edit");
  const queuedRestore = await app.inject({
    method: "POST",
    url: "/api/chats/chat-message-trash/trash/restore",
    payload: { entryIds: [queuedEntry.id] },
  });
  assert.equal(queuedRestore.statusCode, 200, queuedRestore.body);
  assert.equal((await storage.getMessage(queuedEditMessage.id))?.content, "Saved immediately before deletion");
  assert.equal((await storage.getSwipes(queuedEditMessage.id))[0]?.content, "Saved immediately before deletion");

  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const providerAddress = provider.address();
  assert(providerAddress && typeof providerAddress === "object");
  const connection = await createConnectionsStorage(db).create({
    name: "Message marks prompt proof",
    provider: "anthropic",
    baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
    model: "claude-opus-5-5",
    apiKey: "fixture",
    maxContext: 8192,
    maxTokensOverride: 128,
  });
  assert(connection);
  const character = await createCharactersStorage(db).create(characterDataSchema.parse({ name: "Narrator" }));
  assert(character);
  const prompts = createPromptsStorage(db);
  const preset = await prompts.create({
    name: "Message marks prompt proof",
    parameters: { maxTokens: 128, maxContext: 8192 },
    wrapFormat: "xml",
  });
  assert(preset);
  await prompts.createSection({
    presetId: preset.id,
    identifier: "rules",
    name: "Rules",
    content: "Respond as {{char}}.",
  });
  await prompts.createSection({
    presetId: preset.id,
    identifier: "history",
    name: "Chat History",
    isMarker: true,
    markerConfig: { type: "chat_history" },
  });
  const promptChat = await storage.create({
    name: "Private marks prompt proof",
    mode: "roleplay",
    characterIds: [character.id],
    connectionId: connection.id,
    promptPresetId: preset.id,
  });
  assert(promptChat);
  await storage.patchMetadata(promptChat.id, {
    enableAgents: false,
    enableMemoryRecall: false,
    contextMessageLimit: 1,
  });
  const oldPinnedMessage = await storage.createMessage({
    chatId: promptChat.id,
    role: "user",
    content: "PINNED_CONTEXT_SENTINEL_6698",
    extra: { pinnedToContext: true, privateNote: "PRIVATE_NOTE_MUST_NOT_REACH_PROMPT_6698" },
  } as never);
  assert(oldPinnedMessage);
  await storage.createMessage({
    chatId: promptChat.id,
    role: "user",
    content: "LATEST_CONTEXT_SENTINEL_6698",
  } as never);
  const generated = await app.inject({
    method: "POST",
    url: "/api/generate/",
    payload: { chatId: promptChat.id, forCharacterId: character.id, streaming: true },
  });
  assert.equal(generated.statusCode, 200, generated.body);
  assert.equal(providerRequests.length, 1, "the real generation route prepared a provider request");
  const preparedPrompt = JSON.stringify(providerRequests[0]);
  assert(preparedPrompt.includes("Pinned message from earlier in the chat"));
  assert(preparedPrompt.includes("PINNED_CONTEXT_SENTINEL_6698"));
  assert(preparedPrompt.includes("LATEST_CONTEXT_SENTINEL_6698"));
  assert(!preparedPrompt.includes("PRIVATE_NOTE_MUST_NOT_REACH_PROMPT_6698"));

  for (let index = 0; index < MAX_PINNED_CONTEXT_MESSAGES - 1; index += 1) {
    await storage.createMessage({
      chatId: "chat-message-trash",
      role: "user",
      content: `Pinned ${index}`,
      extra: { pinnedToContext: true },
    } as never);
  }
  const concurrentPinTargets = await Promise.all(
    ["pin-race-a", "pin-race-b"].map((content) =>
      storage.createMessage({
        chatId: "chat-message-trash",
        role: "assistant",
        content,
        extra: { translation: "Active translation" },
      } as never),
    ),
  );
  for (const target of concurrentPinTargets) await storage.addSwipe(target!.id, "Inactive alternate", true);
  const concurrentPinResults = await Promise.all(
    concurrentPinTargets.map((target) =>
      app!.inject({
        method: "PATCH",
        url: `/api/chats/chat-message-trash/messages/${target!.id}/extra?swipeIndex=1`,
        payload: {
          pinnedToContext: true,
          bookmark: true,
          privateNote: "Shared private note",
          translation: "Inactive translation",
        },
      }),
    ),
  );
  assert.deepEqual(
    concurrentPinResults.map((result) => result.statusCode).sort(),
    [200, 409],
    "the per-chat pin cap remains enforced under concurrent inactive-swipe updates",
  );
  const markedTarget = concurrentPinTargets[concurrentPinResults.findIndex((result) => result.statusCode === 200)]!;
  const markedMessage = (await storage.getMessage(markedTarget.id))!;
  const markedExtra = JSON.parse(markedMessage.extra);
  assert.equal(markedMessage.activeSwipeIndex, 0);
  assert.equal(markedExtra.pinnedToContext, true, "an inactive swipe pin immediately counts at message level");
  assert.equal(markedExtra.privateNote, "Shared private note");
  assert.ok(markedExtra.bookmark);
  assert.equal(markedExtra.translation, "Active translation", "inactive data cannot overwrite the active swipe");
  for (const swipe of await storage.getSwipes(markedTarget.id)) {
    const extra = JSON.parse(swipe.extra!);
    assert.equal(extra.pinnedToContext, true);
    assert.equal(extra.privateNote, "Shared private note");
    assert.deepEqual(extra.bookmark, markedExtra.bookmark);
    assert.equal(extra.translation, swipe.index === 0 ? "Active translation" : "Inactive translation");
  }
  await storage.setActiveSwipe(markedTarget.id, 1);
  assert.equal(JSON.parse((await storage.getMessage(markedTarget.id))!.extra).pinnedToContext, true);
  await storage.setActiveSwipe(markedTarget.id, 0);
  const clearedMarks = await app.inject({
    method: "PATCH",
    url: `/api/chats/chat-message-trash/messages/${markedTarget.id}/extra?swipeIndex=1`,
    payload: { pinnedToContext: false, bookmark: null, privateNote: null },
  });
  assert.equal(clearedMarks.statusCode, 200, clearedMarks.body);
  assert.deepEqual(JSON.parse(clearedMarks.json().extra), {
    ...markedExtra,
    pinnedToContext: false,
    bookmark: null,
    privateNote: null,
  });
  const remainingTarget = concurrentPinTargets.find((target) => target!.id !== markedTarget.id)!;
  const activePin = await app.inject({
    method: "PATCH",
    url: `/api/chats/chat-message-trash/messages/${remainingTarget.id}/extra?swipeIndex=0`,
    payload: { pinnedToContext: true, translation: "Updated active translation" },
  });
  assert.equal(activePin.statusCode, 200, "unpinning an inactive swipe frees the message's pin slot");
  assert.equal(JSON.parse(activePin.json().extra).translation, "Updated active translation");
  await app.inject({
    method: "PATCH",
    url: `/api/chats/chat-message-trash/messages/${remainingTarget.id}/extra`,
    payload: { pinnedToContext: false },
  });
  await storage.addSwipe(markedTarget.id, "Concurrent swipe target", true);
  let releaseMarkQueue!: () => void;
  const markQueueGate = new Promise<void>((resolve) => {
    releaseMarkQueue = resolve;
  });
  const heldMarkQueue = withMessageExtraPatchQueue(markedTarget.id, () => markQueueGate);
  try {
    const marking = app.inject({
      method: "PATCH",
      url: `/api/chats/chat-message-trash/messages/${markedTarget.id}/extra?swipeIndex=1`,
      payload: { pinnedToContext: true, bookmark: true, privateNote: "Raced note" },
    });
    // Resident file-store preflight reads settle before the next immediate, queuing marks before the swipe.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const switching = app.inject({
      method: "PUT",
      url: `/api/chats/chat-message-trash/messages/${markedTarget.id}/active-swipe`,
      payload: { index: 2 },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseMarkQueue();
    for (const result of await Promise.all([marking, switching])) assert.equal(result.statusCode, 200, result.body);
  } finally {
    releaseMarkQueue();
    await heldMarkQueue;
  }
  const racedMessage = (await storage.getMessage(markedTarget.id))!;
  assert.equal(racedMessage.activeSwipeIndex, 2);
  const racedExtra = JSON.parse(racedMessage.extra);
  assert.equal(racedExtra.pinnedToContext, true, "a queued swipe cannot discard a just-saved pin");
  assert.equal(racedExtra.privateNote, "Raced note");
  assert.ok(racedExtra.bookmark);
  const overLimitAfterSwipe = await app.inject({
    method: "PATCH",
    url: `/api/chats/chat-message-trash/messages/${remainingTarget.id}/extra`,
    payload: { pinnedToContext: true },
  });
  assert.equal(overLimitAfterSwipe.statusCode, 409, "the raced pin still occupies its slot");
  const restorable = await storage.createMessage({
    chatId: "chat-message-trash",
    role: "assistant",
    characterId: null,
    content: "Restorable message",
    extra: { bookmark: { label: "Keep", createdAt: timestamp }, privateNote: "PRIVATE_NOTE_EXPORT_SENTINEL_6698" },
  } as never);
  assert.ok(restorable);
  await storage.addSwipe(restorable.id, "Alternate text");
  await storage.setActiveSwipe(restorable.id, 1);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/api/chats/chat-message-trash/messages/${restorable.id}`,
  });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.deepEqual(deleted.json(), { trashed: true, trashedCount: 1 });
  assert.equal(
    await storage.getMessage(restorable.id),
    null,
    "the active transcript no longer contains the trashed message",
  );
  const listed = await app.inject({ method: "GET", url: "/api/chats/chat-message-trash/trash" });
  assert.equal(listed.statusCode, 200);
  const [entry] = listed.json();
  assert.equal(entry.messageId, restorable.id);
  assert.equal(entry.swipeCount, 2);

  const trashSnapshot = (await db.select().from(messageTrash).where(eq(messageTrash.id, entry.id)))[0]!;
  const firstSwipeId = (JSON.parse(trashSnapshot.snapshot) as { swipes: Array<{ id: string }> }).swipes[0]!.id;
  await db.insert(messageSwipes).values({
    id: firstSwipeId,
    messageId: "orphaned-swipe-collision",
    index: 0,
    content: "Collision row",
    extra: "{}",
    createdAt: timestamp,
  });
  const conflictedRestore = await app.inject({
    method: "POST",
    url: "/api/chats/chat-message-trash/trash/restore",
    payload: { entryIds: [entry.id] },
  });
  assert.ok(conflictedRestore.statusCode >= 400, "a swipe ID collision fails the restore unit");
  assert.equal(await storage.getMessage(restorable.id), null, "failed restore rolls back the message insert");
  assert.equal((await db.select().from(messageTrash).where(eq(messageTrash.id, entry.id))).length, 1);
  // A later failed restore unit must not skip reconciliation for an earlier successful one.
  const partialMessage = await storage.createMessage({
    chatId: "chat-message-trash",
    role: "user",
    content: "Restored before the swipe conflict",
  } as never);
  assert(partialMessage);
  const partialCreatedAt = "2026-09-01T00:00:01.000Z";
  await db.update(messages).set({ createdAt: partialCreatedAt }).where(eq(messages.id, partialMessage.id));
  await app.inject({ method: "DELETE", url: `/api/chats/chat-message-trash/messages/${partialMessage.id}` });
  const [partialEntry] = await db.select().from(messageTrash).where(eq(messageTrash.messageId, partialMessage.id));
  assert(partialEntry);
  await db.insert(memoryChunks).values({
    id: "partial-restore-stale-memory",
    chatId: "chat-message-trash",
    content: "Memory built while the restored message was missing",
    messageCount: 1,
    firstMessageAt: timestamp,
    lastMessageAt: partialCreatedAt,
    createdAt: timestamp,
  });
  await db.update(chats).set({ lastMessageAt: timestamp }).where(eq(chats.id, "chat-message-trash"));
  const partialRestore = await app.inject({
    method: "POST",
    url: "/api/chats/chat-message-trash/trash/restore",
    payload: { entryIds: [entry.id, partialEntry.id] },
  });
  assert.equal(partialRestore.statusCode, 200, partialRestore.body);
  assert.deepEqual(partialRestore.json(), {
    restoredMessageIds: [partialMessage.id],
    conflictEntryIds: [entry.id],
  });
  assert.equal((await storage.getMessage(partialMessage.id))?.content, partialMessage.content);
  assert.equal(await storage.getMessage(restorable.id), null, "the failed restore unit still rolls back");
  assert.equal((await db.select().from(messageTrash).where(eq(messageTrash.id, entry.id))).length, 1);
  assert.equal(
    (await db.select().from(memoryChunks).where(eq(memoryChunks.id, "partial-restore-stale-memory"))).length,
    0,
    "partial success still invalidates stale memory chunks",
  );
  assert.equal(
    (await storage.getById("chat-message-trash"))?.lastMessageAt,
    partialCreatedAt,
    "partial success still updates the chat's last message time",
  );
  await db.delete(messageSwipes).where(eq(messageSwipes.id, firstSwipeId));

  const restored = await app.inject({
    method: "POST",
    url: "/api/chats/chat-message-trash/trash/restore",
    payload: { entryIds: [entry.id] },
  });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(restored.json().restoredMessageIds, [restorable.id]);
  const restoredMessage = await storage.getMessage(restorable.id);
  assert.equal(restoredMessage?.content, "Alternate text");
  assert.equal(JSON.parse(restoredMessage!.extra).privateNote, "PRIVATE_NOTE_EXPORT_SENTINEL_6698");
  assert.equal((await storage.getSwipes(restorable.id)).length, 2, "restore brings back the alternate swipes");

  const createRestoreBatch = async (prefix: string, firstCreatedAt: string) => {
    const first = await storage.createMessage({
      chatId: "chat-message-trash",
      role: "user",
      content: `${prefix} first message`,
    } as never);
    const second = await storage.createMessage({
      chatId: "chat-message-trash",
      role: "user",
      content: `${prefix} second message`,
    } as never);
    assert(first && second);
    await storage.addSwipe(first.id, `${prefix} first swipe`);
    await storage.addSwipe(second.id, `${prefix} second swipe`);
    const secondCreatedAt = new Date(Date.parse(firstCreatedAt) + 1000).toISOString();
    await db.update(messages).set({ createdAt: firstCreatedAt }).where(eq(messages.id, first.id));
    await db.update(messages).set({ createdAt: secondCreatedAt }).where(eq(messages.id, second.id));
    for (const message of [first, second]) {
      const deleted = await app!.inject({
        method: "DELETE",
        url: `/api/chats/chat-message-trash/messages/${message.id}`,
      });
      assert.deepEqual(deleted.json(), { trashed: true, trashedCount: 1 });
    }
    const [firstEntry] = await db.select().from(messageTrash).where(eq(messageTrash.messageId, first.id));
    const [secondEntry] = await db.select().from(messageTrash).where(eq(messageTrash.messageId, second.id));
    assert(firstEntry && secondEntry);
    return { first, second, firstEntry, secondEntry, secondCreatedAt };
  };

  const laterFailureBatch = await createRestoreBatch("later-restore-failure", "2026-09-01T00:00:01.000Z");
  await db.update(chats).set({ lastMessageAt: timestamp }).where(eq(chats.id, "chat-message-trash"));
  await db.insert(memoryChunks).values({
    id: "later-restore-failure-stale-memory",
    chatId: "chat-message-trash",
    content: "Memory built while both restored turns were missing",
    messageCount: 2,
    firstMessageAt: laterFailureBatch.firstEntry.messageCreatedAt,
    lastMessageAt: laterFailureBatch.secondEntry.messageCreatedAt,
    createdAt: timestamp,
  });
  const originalInsert = db.insert.bind(db);
  let swipeInsertCount = 0;
  db.insert = ((table: Parameters<typeof db.insert>[0]) => {
    if (table === messageSwipes && ++swipeInsertCount === 2) throw new Error("Injected second-row swipe failure");
    return originalInsert(table);
  }) as typeof db.insert;
  let laterFailureRestore: { statusCode: number; json(): any; body: string };
  try {
    laterFailureRestore = await app!.inject({
      method: "POST",
      url: "/api/chats/chat-message-trash/trash/restore",
      payload: { entryIds: [laterFailureBatch.firstEntry.id, laterFailureBatch.secondEntry.id] },
    });
  } finally {
    db.insert = originalInsert as typeof db.insert;
  }
  assert.equal(laterFailureRestore.statusCode, 200, laterFailureRestore.body);
  assert.deepEqual(laterFailureRestore.json().restoredMessageIds, [laterFailureBatch.first.id]);
  assert.deepEqual(laterFailureRestore.json().conflictEntryIds, [laterFailureBatch.secondEntry.id]);
  assert.equal((await storage.getMessage(laterFailureBatch.first.id))?.content, "later-restore-failure first swipe");
  assert.equal(
    await storage.getMessage(laterFailureBatch.second.id),
    null,
    "the failed row transaction rolls back its message",
  );
  assert.equal(
    (await db.select().from(messageTrash).where(eq(messageTrash.id, laterFailureBatch.firstEntry.id))).length,
    0,
  );
  assert.equal(
    (await db.select().from(messageTrash).where(eq(messageTrash.id, laterFailureBatch.secondEntry.id))).length,
    1,
  );
  assert.equal(
    (await db.select().from(memoryChunks).where(eq(memoryChunks.id, "later-restore-failure-stale-memory"))).length,
    0,
    "a later transaction failure still reconciles memory for earlier commits",
  );
  assert.equal(
    (await storage.getById("chat-message-trash"))?.lastMessageAt,
    laterFailureBatch.firstEntry.messageCreatedAt,
  );
  assert.deepEqual(
    (await storage.getSwipes(laterFailureBatch.first.id)).map((swipe) => swipe.content),
    ["later-restore-failure first message", "later-restore-failure first swipe"],
  );
  const laterFailureRetry = await app!.inject({
    method: "POST",
    url: "/api/chats/chat-message-trash/trash/restore",
    payload: { entryIds: [laterFailureBatch.secondEntry.id] },
  });
  assert.equal(laterFailureRetry.statusCode, 200, laterFailureRetry.body);
  assert.deepEqual(laterFailureRetry.json().restoredMessageIds, [laterFailureBatch.second.id]);
  assert.equal((await storage.getMessage(laterFailureBatch.second.id))?.content, "later-restore-failure second swipe");
  assert.deepEqual(
    (await storage.getSwipes(laterFailureBatch.second.id)).map((swipe) => swipe.content),
    ["later-restore-failure second message", "later-restore-failure second swipe"],
  );
  const laterFailureMessageIds = (await storage.listMessages("chat-message-trash"))
    .filter((message) => [laterFailureBatch.first.id, laterFailureBatch.second.id].includes(message.id))
    .map((message) => message.id);
  assert.deepEqual(laterFailureMessageIds, [laterFailureBatch.first.id, laterFailureBatch.second.id]);

  const allFailureBatch = await createRestoreBatch("all-restore-failures", "2026-09-02T00:00:01.000Z");
  db.insert = ((table: Parameters<typeof db.insert>[0]) => {
    if (table === messageSwipes) throw new Error("Injected all-row swipe failure");
    return originalInsert(table);
  }) as typeof db.insert;
  let allFailureRestore: { statusCode: number; json(): any; body: string };
  try {
    allFailureRestore = await app!.inject({
      method: "POST",
      url: "/api/chats/chat-message-trash/trash/restore",
      payload: { entryIds: [allFailureBatch.firstEntry.id, allFailureBatch.secondEntry.id] },
    });
  } finally {
    db.insert = originalInsert as typeof db.insert;
  }
  assert.ok(allFailureRestore.statusCode >= 400, "a multi-row restore with no successful writes remains non-2xx");
  assert.equal(await storage.getMessage(allFailureBatch.first.id), null);
  assert.equal(await storage.getMessage(allFailureBatch.second.id), null);
  assert.equal(
    (await db.select().from(messageTrash).where(eq(messageTrash.id, allFailureBatch.firstEntry.id))).length,
    1,
  );
  assert.equal(
    (await db.select().from(messageTrash).where(eq(messageTrash.id, allFailureBatch.secondEntry.id))).length,
    1,
  );
  assert.equal(JSON.parse(allFailureBatch.firstEntry.snapshot).swipes.length, 2);
  assert.equal(JSON.parse(allFailureBatch.secondEntry.snapshot).swipes.length, 2);
  const allFailureRetry = await app!.inject({
    method: "POST",
    url: "/api/chats/chat-message-trash/trash/restore",
    payload: { entryIds: [allFailureBatch.firstEntry.id, allFailureBatch.secondEntry.id] },
  });
  assert.equal(allFailureRetry.statusCode, 200, allFailureRetry.body);
  assert.deepEqual(allFailureRetry.json().restoredMessageIds, [allFailureBatch.first.id, allFailureBatch.second.id]);
  const retryMessageIds = (await storage.listMessages("chat-message-trash"))
    .filter((message) => [allFailureBatch.first.id, allFailureBatch.second.id].includes(message.id))
    .map((message) => message.id);
  assert.deepEqual(retryMessageIds, [allFailureBatch.first.id, allFailureBatch.second.id]);

  for (const format of ["jsonl", "text"]) {
    const defaultExport = await app.inject({
      method: "GET",
      url: `/api/chats/chat-message-trash/export?format=${format}`,
    });
    assert.equal(defaultExport.statusCode, 200, defaultExport.body);
    assert(
      !defaultExport.body.includes("PRIVATE_NOTE_EXPORT_SENTINEL_6698"),
      `${format} excludes private notes by default`,
    );
    const optedInExport = await app.inject({
      method: "GET",
      url: `/api/chats/chat-message-trash/export?format=${format}&includePrivateNotes=true`,
    });
    assert.equal(optedInExport.statusCode, 200, optedInExport.body);
    assert(
      optedInExport.body.includes("PRIVATE_NOTE_EXPORT_SENTINEL_6698"),
      `${format} exports notes only after opt-in`,
    );
  }

  // Combined story exports remain public transcripts even when note export is enabled for JSONL/text.
  for (const format of ["markdown", "html"]) {
    for (const includePrivateNotes of [false, true]) {
      const storyExport = await app.inject({
        method: "GET",
        url: `/api/chats/chat-message-trash/export?format=${format}&includePrivateNotes=${includePrivateNotes}`,
      });
      assert.equal(storyExport.statusCode, 200, storyExport.body);
      assert(!storyExport.body.includes("PRIVATE_NOTE_EXPORT_SENTINEL_6698"), `${format} never includes private notes`);
    }
  }

  const wrongChatTarget = await storage.createMessage({
    chatId: "chat-message-trash",
    role: "user",
    content: "Must survive a mismatched chat route",
  } as never);
  assert.ok(wrongChatTarget);
  const wrongChatDelete = await app.inject({
    method: "DELETE",
    url: `/api/chats/game-message-trash/messages/${wrongChatTarget.id}`,
  });
  assert.equal(wrongChatDelete.statusCode, 404);
  const preservedWrongChatMessage = await storage.getMessage(wrongChatTarget.id);
  assert.equal(preservedWrongChatMessage?.chatId, "chat-message-trash");

  const skipTrashMessage = await storage.createMessage({
    chatId: "chat-message-trash",
    role: "assistant",
    characterId: null,
    content: "Explicitly permanent deletion",
  } as never);
  assert.ok(skipTrashMessage);
  const skippedTrash = await app.inject({
    method: "DELETE",
    url: `/api/chats/chat-message-trash/messages/${skipTrashMessage.id}?trash=false`,
  });
  assert.equal(skippedTrash.statusCode, 200, skippedTrash.body);
  assert.deepEqual(skippedTrash.json(), { trashed: false, trashedCount: 0 });

  const gameMessage = await storage.createMessage({
    chatId: "game-message-trash",
    role: "assistant",
    characterId: null,
    content: "Game turn",
  } as never);
  assert.ok(gameMessage);
  const gameDelete = await app.inject({
    method: "DELETE",
    url: `/api/chats/game-message-trash/messages/${gameMessage.id}`,
  });
  assert.equal(gameDelete.statusCode, 200, gameDelete.body);
  assert.deepEqual(gameDelete.json(), { trashed: false, trashedCount: 0 });
  assert.equal(await storage.getMessage(gameMessage.id), null, "Game mode retains its permanent delete behavior");
  assert.equal((await db.select().from(messageTrash).where(eq(messageTrash.chatId, "game-message-trash"))).length, 0);

  // Imported or mode-switched chats can keep Game snapshots after their mode changes.
  for (const bulk of [false, true]) {
    const formerGame = await storage.create({ name: `Former Game ${bulk}`, mode: "game", characterIds: [] });
    assert(formerGame);
    const gameTurn = await storage.createMessage({
      chatId: formerGame.id,
      role: "assistant",
      content: "Turn with Game state",
    } as never);
    assert(gameTurn);
    await db.insert(gameStateSnapshots).values({
      id: `former-game-snapshot-${bulk}`,
      chatId: formerGame.id,
      messageId: gameTurn.id,
      createdAt: timestamp,
    });
    await db.update(chats).set({ mode: "conversation" }).where(eq(chats.id, formerGame.id));
    const plainTurn = bulk
      ? await storage.createMessage({
          chatId: formerGame.id,
          role: "user",
          content: "Ordinary conversation turn",
        } as never)
      : null;
    const deleteFormerGame = await app.inject(
      bulk
        ? {
            method: "POST",
            url: `/api/chats/${formerGame.id}/messages/bulk-delete`,
            payload: { messageIds: [gameTurn.id, plainTurn!.id] },
          }
        : { method: "DELETE", url: `/api/chats/${formerGame.id}/messages/${gameTurn.id}` },
    );
    assert.equal(deleteFormerGame.statusCode, 200, deleteFormerGame.body);
    assert.deepEqual(
      deleteFormerGame.json(),
      { trashed: bulk, trashedCount: bulk ? 1 : 0 },
      "Game snapshot rows stay permanent even in a conversation chat",
    );
    assert.equal(await storage.getMessage(gameTurn.id), null);
    assert.equal(
      (await db.select().from(gameStateSnapshots).where(eq(gameStateSnapshots.messageId, gameTurn.id))).length,
      0,
      "normal deletion still removes the Game snapshot",
    );
    const retained = await db.select().from(messageTrash).where(eq(messageTrash.chatId, formerGame.id));
    assert.deepEqual(
      retained.map((row) => row.messageId),
      plainTurn ? [plainTurn.id] : [],
      "mixed bulk deletion retains only the recoverable conversation turn",
    );
    if (plainTurn) {
      assert.equal(await storage.getMessage(plainTurn.id), null);
      const restoredPlainTurn = await app.inject({
        method: "POST",
        url: `/api/chats/${formerGame.id}/trash/restore`,
        payload: { entryIds: retained.map((row) => row.id) },
      });
      assert.equal(restoredPlainTurn.statusCode, 200, restoredPlainTurn.body);
      assert.deepEqual(restoredPlainTurn.json().restoredMessageIds, [plainTurn.id]);
    }
  }

  const changedModeChat = await storage.create({
    name: "Changed mode recovery",
    mode: "conversation",
    characterIds: [],
  });
  assert(changedModeChat);
  const changedModeMessage = await storage.createMessage({
    chatId: changedModeChat.id,
    role: "user",
    content: "Retained before switching to Game Mode",
  } as never);
  assert(changedModeMessage);
  await app.inject({ method: "DELETE", url: `/api/chats/${changedModeChat.id}/messages/${changedModeMessage.id}` });
  const [changedModeEntry] = await db
    .select()
    .from(messageTrash)
    .where(eq(messageTrash.messageId, changedModeMessage.id));
  assert(changedModeEntry);
  await db.update(chats).set({ mode: "game" }).where(eq(chats.id, changedModeChat.id));
  const gameRestore = await app.inject({
    method: "POST",
    url: `/api/chats/${changedModeChat.id}/trash/restore`,
    payload: { entryIds: [changedModeEntry.id] },
  });
  assert.equal(gameRestore.statusCode, 409, "message-only recovery cannot restore Game state");
  assert.equal(await storage.getMessage(changedModeMessage.id), null);
  assert.equal((await db.select().from(messageTrash).where(eq(messageTrash.id, changedModeEntry.id))).length, 1);
  await db.update(chats).set({ mode: "conversation" }).where(eq(chats.id, changedModeChat.id));
  await app.inject({ method: "PUT", url: "/api/app-settings/features", payload: { messageTrash: false } });
  const disabledRetentionRestore = await app.inject({
    method: "POST",
    url: `/api/chats/${changedModeChat.id}/trash/restore`,
    payload: { entryIds: [changedModeEntry.id] },
  });
  assert.equal(disabledRetentionRestore.statusCode, 200, disabledRetentionRestore.body);
  assert.deepEqual(
    disabledRetentionRestore.json().restoredMessageIds,
    [changedModeMessage.id],
    "turning retention off does not strand existing recovery entries",
  );
  await app.inject({ method: "PUT", url: "/api/app-settings/features", payload: { messageTrash: true } });

  const pinRestoreTargets = await Promise.all(
    Array.from({ length: MAX_PINNED_CONTEXT_MESSAGES }, (_, index) =>
      storage.createMessage({
        chatId: "pin-restore-chat",
        role: "user",
        content: `Pinned for restore ${index}`,
        extra: { pinnedToContext: true },
      } as never),
    ),
  );
  const pinnedMessageToRestore = pinRestoreTargets[0]!;
  const deletedPinnedMessage = await app.inject({
    method: "DELETE",
    url: `/api/chats/pin-restore-chat/messages/${pinnedMessageToRestore.id}`,
  });
  assert.deepEqual(deletedPinnedMessage.json(), { trashed: true, trashedCount: 1 });
  const replacementPin = await storage.createMessage({
    chatId: "pin-restore-chat",
    role: "user",
    content: "Replacement pin",
  } as never);
  assert.ok(replacementPin);
  const pinReplacement = await app.inject({
    method: "PATCH",
    url: `/api/chats/pin-restore-chat/messages/${replacementPin.id}/extra`,
    payload: { pinnedToContext: true },
  });
  assert.equal(pinReplacement.statusCode, 200, pinReplacement.body);
  const pinnedTrashResponse = await app.inject({ method: "GET", url: "/api/chats/pin-restore-chat/trash" });
  const [pinnedTrashEntry] = pinnedTrashResponse.json() as Array<{ id: string }>;
  assert.ok(pinnedTrashEntry);
  const overLimitRestore = await app.inject({
    method: "POST",
    url: "/api/chats/pin-restore-chat/trash/restore",
    payload: { entryIds: [pinnedTrashEntry.id] },
  });
  assert.equal(overLimitRestore.statusCode, 409, overLimitRestore.body);
  assert.match(overLimitRestore.json().error, /limit of 10 pinned messages/);
  assert.equal(
    await storage.getMessage(pinnedMessageToRestore.id),
    null,
    "a rejected pinned restore leaves the message trashed",
  );
  assert.equal(
    (await db.select().from(messageTrash).where(eq(messageTrash.id, pinnedTrashEntry.id))).length,
    1,
    "a rejected pinned restore retains its trash entry",
  );

  const bulkTrashMessages = await Promise.all(
    ["Bulk one", "Bulk two"].map((content) =>
      storage.createMessage({ chatId: "chat-message-trash", role: "user", content } as never),
    ),
  );
  const bulkDelete = await app.inject({
    method: "POST",
    url: "/api/chats/chat-message-trash/messages/bulk-delete",
    payload: { messageIds: [...bulkTrashMessages.map((row) => row!.id), "missing-message-id"] },
  });
  assert.equal(bulkDelete.statusCode, 200, bulkDelete.body);
  assert.deepEqual(bulkDelete.json(), { trashed: true, trashedCount: 2 });

  // A permanent delete that wins before restore's transaction must not resurrect a stale snapshot.
  const trashStorage = createMessageTrashStorage(db);
  const discardedEntry = (await trashStorage.list("chat-message-trash"))[0]!;
  assert(discardedEntry);
  const originalTransaction = db.transaction.bind(db);
  db.transaction = (async (operation) => {
    db.transaction = originalTransaction;
    await trashStorage.deleteForever("chat-message-trash", [discardedEntry.id]);
    return originalTransaction(operation);
  }) as typeof db.transaction;
  try {
    const discardedRestore = await trashStorage.restore("chat-message-trash", [discardedEntry.id]);
    assert.deepEqual(
      discardedRestore.restoredMessageIds,
      [],
      "permanently deleted trash cannot be restored from a stale read",
    );
    assert.equal(await storage.getMessage(discardedEntry.messageId), null);
  } finally {
    db.transaction = originalTransaction;
  }

  const expiring = await storage.createMessage({
    chatId: "chat-message-trash",
    role: "user",
    content: "Expires",
  } as never);
  assert.ok(expiring);
  await app.inject({ method: "DELETE", url: `/api/chats/chat-message-trash/messages/${expiring.id}` });
  const trashRows = await db.select().from(messageTrash).where(eq(messageTrash.messageId, expiring.id));
  assert.equal(trashRows.length, 1);
  await db
    .update(messageTrash)
    .set({ deletedAt: "2026-07-01T00:00:00.000Z" })
    .where(eq(messageTrash.id, trashRows[0]!.id));
  const restoreAfterExpiry = await app.inject({
    method: "POST",
    url: "/api/chats/chat-message-trash/trash/restore",
    payload: { entryIds: [trashRows[0]!.id] },
  });
  assert.equal(restoreAfterExpiry.statusCode, 200, restoreAfterExpiry.body);
  assert.deepEqual(restoreAfterExpiry.json().restoredMessageIds, [], "expired trash cannot be restored directly");
  assert.equal(await storage.getMessage(expiring.id), null);
  assert.equal((await db.select().from(messageTrash).where(eq(messageTrash.id, trashRows[0]!.id))).length, 0);

  // Recovery and cleanup use the same inclusive 30-day boundary.
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - MESSAGE_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const cleanupChatIds = [
    "trash-cleanup-old",
    "trash-cleanup-boundary",
    "trash-cleanup-fresh",
    "trash-cleanup-cold",
    "trash-cleanup-cold-2",
    "trash-cleanup-cold-fresh",
  ];
  for (const id of cleanupChatIds) {
    await db.insert(chats).values({
      id,
      name: id,
      mode: "conversation",
      characterIds: "[]",
      metadata: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  const cleanupRows = cleanupChatIds.map((chatId, index) => ({
    id: `trash-cleanup-entry-${index}`,
    chatId,
    messageId: `trash-cleanup-message-${index}`,
    role: "user" as const,
    characterId: null,
    content: "synthetic expiration fixture",
    snapshot: JSON.stringify({ message: { id: `trash-cleanup-message-${index}` }, swipes: [] }),
    messageCreatedAt: timestamp,
    deletedAt:
      index === 0
        ? new Date(Date.parse(cutoff) - 1).toISOString()
        : index === 1
          ? cutoff
          : new Date(nowMs - 1).toISOString(),
  }));
  await db.insert(messageTrash).values(cleanupRows);
  const residentSweep = await sweepExpiredMessageTrash(db, { nowMs });
  assert.equal(residentSweep.purged, 2, "entries older than or exactly at 30 days are purged");
  assert.equal(
    (await db.select().from(messageTrash).where(eq(messageTrash.id, cleanupRows[2]!.id))).length,
    1,
    "entries newer than 30 days remain recoverable",
  );

  // Reopening clears resident chat units; the next sweep must find and purge the cold trash shard.
  const coldRows = [cleanupRows[3]!, cleanupRows[4]!];
  for (const row of coldRows) {
    await db.update(messageTrash).set({ deletedAt: cutoff }).where(eq(messageTrash.id, row.id));
  }
  await app.close();
  app = null;
  const reopenedDb = await getDB();
  const residentChats = reopenedDb._fileStore.getResidentChatUnits();
  assert.equal(residentChats.has(coldRows[0]!.chatId), false, "the fixture chat is cold after storage reopens");
  assert.equal(residentChats.has(cleanupRows[5]!.chatId), false, "the fresh backup fixture is also cold");
  const backupOnlyShard = join(
    reopenedDb._fileStore.rootDir,
    "tables",
    "message_trash",
    `${encodeShardKey(coldRows[0]!.chatId)}.json`,
  );
  assert.equal(
    existsSync(backupOnlyShard),
    true,
    "the synthetic primary trash shard exists before simulating recovery",
  );
  renameSync(backupOnlyShard, `${backupOnlyShard}.bak`);
  const freshBackupShard = join(
    reopenedDb._fileStore.rootDir,
    "tables",
    "message_trash",
    `${encodeShardKey(cleanupRows[5]!.chatId)}.json`,
  );
  assert.equal(
    existsSync(freshBackupShard),
    true,
    "the fresh synthetic primary shard exists before simulating recovery",
  );
  renameSync(freshBackupShard, `${freshBackupShard}.bak`);
  const firstColdSweep = await sweepExpiredMessageTrash(reopenedDb, { nowMs, maxChats: 1 });
  assert.equal(firstColdSweep.purged, 1, "one pass purges an expired backup-only trash shard");
  assert.equal(firstColdSweep.chats, 1, "one pass loads only one cold trash shard");
  const secondColdSweep = await sweepExpiredMessageTrash(reopenedDb, { nowMs, maxChats: 1 });
  assert.equal(secondColdSweep.purged, 1, "a later pass reaches the next expired cold shard");
  assert.equal((await reopenedDb.select().from(messageTrash).where(eq(messageTrash.id, coldRows[0]!.id))).length, 0);
  assert.equal((await reopenedDb.select().from(messageTrash).where(eq(messageTrash.id, coldRows[1]!.id))).length, 0);
  assert.equal(
    (await reopenedDb.select().from(messageTrash).where(eq(messageTrash.id, cleanupRows[5]!.id))).length,
    1,
    "a fresh backup-only shard remains recoverable",
  );
  const remainingFresh = await reopenedDb.select().from(messageTrash).where(eq(messageTrash.id, cleanupRows[2]!.id));
  assert.equal(remainingFresh.length, 1, "cold sweep preserves a fresh entry");
  await closeDB();
} finally {
  await app?.close();
  await closeDatabase?.();
  if (provider.listening) {
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
  }
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write("Message trash regression passed.\n");
