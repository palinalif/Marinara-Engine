// ──────────────────────────────────────────────
// Storage: Message Trash
// ──────────────────────────────────────────────
// User deletes snapshot the exact message + swipe rows before the normal delete path runs,
// so every delete side effect (interruption undo, game state, lore cascade, memory chunk
// invalidation) stays in one place. Restore reinserts the rows under their original ids and
// createdAt, which puts them back at their original position in the timeline.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_PINNED_CONTEXT_MESSAGES,
  MESSAGE_TRASH_RETENTION_DAYS,
  isMessagePinnedToContext,
  type MessageTrashEntry,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { encodeShardKey, isLazyUnitTable } from "../../db/file-backed-store.js";
import { and, desc, eq, gt, inArray, isNull, lte } from "../../db/file-query.js";
import {
  chats,
  gameStateSnapshots,
  memoryChunks,
  messages,
  messageSwipes,
  messageTrash,
} from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { newId, now } from "../../utils/id-generator.js";
import { createChatsStorage } from "./chats.storage.js";

type MessageRow = typeof messages.$inferSelect;
type SwipeRow = typeof messageSwipes.$inferSelect;
type TrashRow = typeof messageTrash.$inferSelect;
type TrashSnapshot = { message: MessageRow; swipes: SwipeRow[] };

const RETENTION_MS = MESSAGE_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MESSAGE_TRASH_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function parseSnapshot(row: TrashRow): TrashSnapshot | null {
  try {
    const parsed = JSON.parse(row.snapshot) as Partial<TrashSnapshot> | null;
    if (!parsed?.message || typeof parsed.message.id !== "string") return null;
    return { message: parsed.message, swipes: Array.isArray(parsed.swipes) ? parsed.swipes : [] };
  } catch {
    return null;
  }
}

export function toMessageTrashEntry(row: TrashRow): MessageTrashEntry {
  const snapshot = parseSnapshot(row);
  const deletedMs = Date.parse(row.deletedAt);
  return {
    id: row.id,
    chatId: row.chatId,
    messageId: row.messageId,
    role: row.role,
    characterId: row.characterId ?? null,
    content: row.content,
    swipeCount: snapshot?.swipes.length ?? 0,
    messageCreatedAt: row.messageCreatedAt,
    deletedAt: row.deletedAt,
    expiresAt: new Date((Number.isNaN(deletedMs) ? Date.now() : deletedMs) + RETENTION_MS).toISOString(),
  };
}

export type RestoreTrashResult = {
  restoredMessageIds: string[];
  /** Entries that could not be restored; retained snapshots can be retried. */
  conflictEntryIds: string[];
};

export class MessageTrashPinnedLimitError extends Error {
  constructor() {
    super(`Restore would exceed the limit of ${MAX_PINNED_CONTEXT_MESSAGES} pinned messages. Unpin one first.`);
    this.name = "MessageTrashPinnedLimitError";
  }
}

export function createMessageTrashStorage(db: DB) {
  const chatsStorage = createChatsStorage(db);

  const readTrash = async (chatId: string, entryIds?: string[]) =>
    entryIds
      ? db
          .select()
          .from(messageTrash)
          .where(and(eq(messageTrash.chatId, chatId), inArray(messageTrash.id, entryIds)))
      : db.select().from(messageTrash).where(eq(messageTrash.chatId, chatId));

  return {
    /** Drop entries older than the retention window. Returns how many were purged. */
    async purgeExpired(chatId: string, nowMs = Date.now()): Promise<number> {
      const cutoff = new Date(nowMs - RETENTION_MS).toISOString();
      const expired = await db
        .select({ id: messageTrash.id })
        .from(messageTrash)
        .where(and(eq(messageTrash.chatId, chatId), lte(messageTrash.deletedAt, cutoff)));
      if (expired.length === 0) return 0;
      await db.delete(messageTrash).where(
        inArray(
          messageTrash.id,
          expired.map((row) => row.id),
        ),
      );
      return expired.length;
    },

    async list(chatId: string): Promise<MessageTrashEntry[]> {
      await this.purgeExpired(chatId);
      const rows = await db
        .select()
        .from(messageTrash)
        .where(eq(messageTrash.chatId, chatId))
        .orderBy(desc(messageTrash.deletedAt), desc(messageTrash.messageCreatedAt));
      return rows.map(toMessageTrashEntry);
    },

    async count(chatId: string): Promise<number> {
      return db.count(messageTrash, eq(messageTrash.chatId, chatId));
    },

    /**
     * Move messages of one chat to its trash, then delete them through the normal path.
     * Ids outside the chat are ignored. Returns the ids that were trashed.
     */
    async trashMessages(chatId: string, messageIds: string[]): Promise<string[]> {
      const uniqueIds = [...new Set(messageIds)];
      if (uniqueIds.length === 0) return [];
      await this.purgeExpired(chatId);
      const trashedIds: string[] = [];
      await chatsStorage.removeMessages(uniqueIds, chatId, async (rows) => {
        if (rows.length === 0) return;
        // A mode change or import can leave Game state attached to a non-Game chat.
        // Message-only recovery cannot restore that state, so those turns stay permanent.
        const gameSnapshots = await db
          .select({ messageId: gameStateSnapshots.messageId })
          .from(gameStateSnapshots)
          .where(
            and(
              eq(gameStateSnapshots.chatId, chatId),
              inArray(
                gameStateSnapshots.messageId,
                rows.map((row) => row.id),
              ),
            ),
          );
        const permanentIds = new Set(gameSnapshots.map((snapshot) => snapshot.messageId));
        const recoverableRows = rows.filter((row) => !permanentIds.has(row.id));
        if (recoverableRows.length === 0) return;
        const swipesByMessage = new Map<string, SwipeRow[]>();
        for (const swipe of await chatsStorage.listSwipesByMessageIds(recoverableRows.map((row) => row.id))) {
          const list = swipesByMessage.get(swipe.messageId) ?? [];
          list.push(swipe);
          swipesByMessage.set(swipe.messageId, list);
        }
        const deletedAt = now();
        const entries = recoverableRows.map((row) => ({
          id: newId(),
          chatId,
          messageId: row.id,
          role: row.role,
          characterId: row.characterId ?? null,
          content: row.content,
          snapshot: JSON.stringify({
            message: row,
            swipes: (swipesByMessage.get(row.id) ?? []).sort((a, b) => a.index - b.index),
          } satisfies TrashSnapshot),
          messageCreatedAt: row.createdAt,
          deletedAt,
        }));
        if (entries.length > 0) await db.insert(messageTrash).values(entries);
        trashedIds.push(...recoverableRows.map((row) => row.id));
      });
      return trashedIds;
    },

    /** Put trashed messages back at their original position (same id, createdAt, swipes and extra). */
    async restore(chatId: string, entryIds: string[]): Promise<RestoreTrashResult> {
      const result: RestoreTrashResult = { restoredMessageIds: [], conflictEntryIds: [] };
      await this.purgeExpired(chatId);
      const rows = (await readTrash(chatId, [...new Set(entryIds)])).sort((a, b) =>
        a.messageCreatedAt.localeCompare(b.messageCreatedAt),
      );
      const currentMessages = await db
        .select({ id: messages.id, extra: messages.extra })
        .from(messages)
        .where(eq(messages.chatId, chatId));
      const currentIds = new Set(currentMessages.map((message) => message.id));
      const currentPinCount = currentMessages.filter((message) => isMessagePinnedToContext(message.extra)).length;
      const incomingPinCount = rows.filter((row) => {
        if (currentIds.has(row.messageId)) return false;
        const snapshot = parseSnapshot(row);
        return snapshot ? isMessagePinnedToContext(snapshot.message.extra) : false;
      }).length;
      if (currentPinCount + incomingPinCount > MAX_PINNED_CONTEXT_MESSAGES) {
        throw new MessageTrashPinnedLimitError();
      }
      let earliest: string | null = null;
      let latest: string | null = null;
      let restoreFailed = false;
      let firstRestoreError: unknown;
      for (const row of rows) {
        const snapshot = parseSnapshot(row);
        if (!snapshot) {
          result.conflictEntryIds.push(row.id);
          continue;
        }
        const message = { ...snapshot.message, chatId, id: row.messageId };
        // Message, swipes and trash removal form one restore unit. A swipe ID conflict or write
        // failure must roll back the message insert so the trash entry remains retryable.
        let inserted: boolean;
        try {
          inserted = await db.transaction(async (tx) => {
            // A purge or permanent deletion may have removed the entry after the initial read.
            const retained = await tx
              .select({ id: messageTrash.id })
              .from(messageTrash)
              .where(eq(messageTrash.id, row.id));
            if (retained.length === 0) return false;
            const existing = await tx.select({ id: messages.id }).from(messages).where(eq(messages.id, message.id));
            if (existing.length > 0) return false;
            await tx.insert(messages).values({
              id: message.id,
              chatId,
              role: message.role,
              characterId: message.characterId ?? null,
              content: message.content ?? "",
              activeSwipeIndex: message.activeSwipeIndex ?? 0,
              extra: typeof message.extra === "string" ? message.extra : JSON.stringify(message.extra ?? {}),
              createdAt: message.createdAt,
            });
            if (snapshot.swipes.length > 0) {
              await tx.insert(messageSwipes).values(
                snapshot.swipes.map((swipe) => ({
                  id: typeof swipe.id === "string" && swipe.id ? swipe.id : newId(),
                  messageId: message.id,
                  index: swipe.index,
                  content: swipe.content ?? "",
                  extra: typeof swipe.extra === "string" ? swipe.extra : JSON.stringify(swipe.extra ?? {}),
                  createdAt: swipe.createdAt,
                })),
              );
            }
            await tx.delete(messageTrash).where(eq(messageTrash.id, row.id));
            return true;
          });
        } catch (error) {
          if (rows.length === 1) throw error;
          if (!restoreFailed) firstRestoreError = error;
          restoreFailed = true;
          logger.warn({ err: error, chatId, entryId: row.id }, "Could not restore a message trash entry");
          result.conflictEntryIds.push(row.id);
          continue;
        }
        if (!inserted) {
          result.conflictEntryIds.push(row.id);
          continue;
        }
        result.restoredMessageIds.push(message.id);
        if (!earliest || message.createdAt < earliest) earliest = message.createdAt;
        if (!latest || message.createdAt > latest) latest = message.createdAt;
      }
      if (earliest && latest) {
        // Recall chunks built across the gap no longer match the transcript.
        await db
          .delete(memoryChunks)
          .where(
            and(
              eq(memoryChunks.chatId, chatId),
              isNull(memoryChunks.sourceChatId),
              gt(memoryChunks.lastMessageAt, earliest),
            ),
          );
        await db
          .delete(memoryChunks)
          .where(
            and(
              eq(memoryChunks.chatId, chatId),
              isNull(memoryChunks.sourceChatId),
              eq(memoryChunks.lastMessageAt, earliest),
            ),
          );
        const chat = (
          await db.select({ lastMessageAt: chats.lastMessageAt }).from(chats).where(eq(chats.id, chatId))
        )[0];
        if (chat && (!chat.lastMessageAt || chat.lastMessageAt < latest)) {
          await db.update(chats).set({ lastMessageAt: latest }).where(eq(chats.id, chatId));
        }
        // Deleting undid any roleplay interruption this message applied; re-apply it where still valid.
        // The chat variables these replies changed (#6923) come back the same way, oldest first.
        const variableChanges: unknown[] = [];
        for (const id of result.restoredMessageIds) {
          const restored = await chatsStorage.getMessage(id);
          if (restored && restored.extra.includes("roleplayCommandActivity")) {
            await chatsStorage.reconcileRoleplayInterruption(id);
          }
          // Deleting read the record from the swipe on screen, so restoring reads it from there too.
          const shown = restored
            ? (await chatsStorage.getSwipes(id)).find((swipe) => swipe.index === restored.activeSwipeIndex)
            : undefined;
          if (shown?.extra.includes("macroVariableChanges")) {
            try {
              variableChanges.push(JSON.parse(shown.extra).macroVariableChanges);
            } catch {
              // Unreadable extra: nothing to re-apply.
            }
          }
        }
        // The restore route holds this chat's metadata queue for the whole restore.
        await chatsStorage.replayVariableChanges(chatId, [], variableChanges, { metadataQueueHeld: true });
      }
      if (result.restoredMessageIds.length === 0 && restoreFailed) throw firstRestoreError;
      return result;
    },

    /** Permanently remove trash entries (all of the chat's entries when `entryIds` is omitted). */
    async deleteForever(chatId: string, entryIds?: string[]): Promise<number> {
      const rows = await readTrash(chatId, entryIds ? [...new Set(entryIds)] : undefined);
      if (rows.length === 0) return 0;
      await db.delete(messageTrash).where(
        inArray(
          messageTrash.id,
          rows.map((row) => row.id),
        ),
      );
      return rows.length;
    },
  };
}

/** True when a trash shard file holds at least one entry deleted before `cutoff`. Unreadable means yes. */
function shardHasExpiredEntry(path: string, cutoff: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return true; // Let the store's own loader arbitrate a damaged shard.
  }
  const stack: unknown[] = [parsed];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "deletedAt" || key === "deleted_at") && typeof child === "string" && child <= cutoff) return true;
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return false;
}

/**
 * Purge expired trash in chats nobody has opened. Listing a chat's trash purges it too, but
 * without this sweep a never-reopened chat would keep expired entries forever. Resident chats
 * are purged in memory; for the rest only chats whose trash shard file holds an expired entry
 * are loaded, up to `maxChats` cold trash shards per sweep.
 */
export async function sweepExpiredMessageTrash(
  db: DB,
  options: { nowMs?: number; maxChats?: number } = {},
): Promise<{ purged: number; chats: number }> {
  const nowMs = options.nowMs ?? Date.now();
  const maxChats = options.maxChats ?? 25;
  const cutoff = new Date(nowMs - RETENTION_MS).toISOString();
  const store = createMessageTrashStorage(db);
  const fileStore = db._fileStore;
  const resident = fileStore.getResidentChatUnits();
  const lazy = isLazyUnitTable("message_trash") && !fileStore.getFullyResidentLazyTables().has("message_trash");
  const shardDir = join(fileStore.rootDir, "tables", "message_trash");
  let purged = 0;
  let touched = 0;
  for (const { id } of await db.select({ id: chats.id }).from(chats)) {
    if (lazy && !resident.has(id)) {
      if (touched >= maxChats) continue;
      const shardPath = join(shardDir, `${encodeShardKey(id)}.json`);
      const inspectionPath = existsSync(shardPath)
        ? shardPath
        : existsSync(`${shardPath}.bak`)
          ? `${shardPath}.bak`
          : null;
      if (!inspectionPath || !shardHasExpiredEntry(inspectionPath, cutoff)) continue;
      touched += 1;
    }
    purged += await store.purgeExpired(id, nowMs);
  }
  return { purged, chats: touched };
}

/** Run cleanup at startup and periodically, without overlapping writes or closing storage under one. */
export function startMessageTrashMaintenance(
  runSweep: () => Promise<{ purged: number }>,
  logger: { info: (purged: number) => void; warn: (error: unknown) => void },
  intervalMs = MESSAGE_TRASH_SWEEP_INTERVAL_MS,
): { sweep: () => Promise<void>; stop: () => Promise<void> } {
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const sweep = (): Promise<void> => {
    if (stopped) return inFlight ?? Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(runSweep)
      .then(({ purged }) => {
        if (purged > 0) logger.info(purged);
      })
      .catch((error: unknown) => logger.warn(error))
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref();
  void sweep();
  return {
    sweep,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
