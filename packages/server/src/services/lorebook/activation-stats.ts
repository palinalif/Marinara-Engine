// ──────────────────────────────────────────────
// Lorebook: Activation Statistics
// Counts how often each entry fires in real generations. The generation
// route reports the entries it actually injected; counts accumulate in memory
// and flush in one batched write a moment later. Recording is best-effort by
// design: every failure is logged and swallowed so it can never affect a
// generation.
// ──────────────────────────────────────────────
import type { DB } from "../../db/connection.js";
import { eq, inArray } from "../../db/file-query.js";
import { lorebookEntries, lorebookEntryActivationStats } from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { isFeatureEnabled } from "../features/feature-settings.js";

export interface LorebookEntryActivationStat {
  entryId: string;
  lorebookId: string;
  count: number;
  lastActivatedAt: string | null;
  lastChatId: string | null;
}

interface PendingActivation {
  count: number;
  lastActivatedAt: string;
  lastChatId: string | null;
}

const FLUSH_DELAY_MS = 2_000;

let pending = new Map<string, PendingActivation>();
let pendingDb: DB | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushChain: Promise<void> = Promise.resolve();

/**
 * Note that these entries fired once in a generation. Synchronous, allocation
 * light, and never throws; the write happens later in a batch.
 */
export function recordLorebookActivations(
  db: DB,
  input: { entryIds: readonly string[]; chatId?: string | null; at?: string },
): void {
  if (!isFeatureEnabled("usageAndActivationStats")) return;
  try {
    const ids = new Set(input.entryIds.filter((id) => typeof id === "string" && id.length > 0));
    if (ids.size === 0) return;
    const at = input.at ?? new Date().toISOString();
    for (const id of ids) {
      const current = pending.get(id);
      pending.set(id, {
        count: (current?.count ?? 0) + 1,
        lastActivatedAt: at,
        lastChatId: input.chatId ?? current?.lastChatId ?? null,
      });
    }
    pendingDb = db;
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushLorebookActivationStats();
      }, FLUSH_DELAY_MS);
      flushTimer.unref?.();
    }
  } catch (err) {
    logger.debug(err, "[lorebook-stats] Failed to queue activation stats");
  }
}

/**
 * Write every queued activation in one transaction. Safe to call at any time;
 * concurrent calls run one after another. Resolves even when the write fails.
 * ponytail: counts queued in the last FLUSH_DELAY_MS are lost on a hard exit;
 * flush from the shutdown hook if exact counts ever matter.
 */
export function flushLorebookActivationStats(db?: DB): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushChain = flushChain.then(async () => {
    const target = db ?? pendingDb;
    if (!target || pending.size === 0) return;
    const batch = pending;
    pending = new Map();
    if (!isFeatureEnabled("usageAndActivationStats")) return;
    try {
      await writeBatch(target, batch);
    } catch (err) {
      logger.warn(err, "[lorebook-stats] Failed to write %d activation stat(s); counts dropped", batch.size);
    }
  });
  return flushChain;
}

async function writeBatch(db: DB, batch: Map<string, PendingActivation>) {
  const ids = Array.from(batch.keys());
  await db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(lorebookEntryActivationStats)
      .where(inArray(lorebookEntryActivationStats.entryId, ids));
    const existingById = new Map(existingRows.map((row) => [row.entryId, row]));
    const missingIds = ids.filter((id) => !existingById.has(id));
    const lorebookIdByEntryId = new Map(
      missingIds.length > 0
        ? (
            await tx
              .select({ id: lorebookEntries.id, lorebookId: lorebookEntries.lorebookId })
              .from(lorebookEntries)
              .where(inArray(lorebookEntries.id, missingIds))
          ).map((row) => [row.id, row.lorebookId])
        : [],
    );

    for (const [entryId, activation] of batch) {
      const existing = existingById.get(entryId);
      if (existing) {
        await tx
          .update(lorebookEntryActivationStats)
          .set({
            count: (existing.count ?? 0) + activation.count,
            lastActivatedAt: activation.lastActivatedAt,
            lastChatId: activation.lastChatId ?? existing.lastChatId ?? null,
          })
          .where(eq(lorebookEntryActivationStats.entryId, entryId));
        continue;
      }
      // An entry deleted since it fired has nothing left to count.
      const lorebookId = lorebookIdByEntryId.get(entryId);
      if (!lorebookId) continue;
      await tx.insert(lorebookEntryActivationStats).values({
        entryId,
        lorebookId,
        count: activation.count,
        lastActivatedAt: activation.lastActivatedAt,
        lastChatId: activation.lastChatId,
      });
    }
  });
}

/** Stats for the given entries (entries that never fired are simply absent). */
export async function listLorebookActivationStats(
  db: DB,
  entryIds: readonly string[],
): Promise<LorebookEntryActivationStat[]> {
  if (!isFeatureEnabled("usageAndActivationStats") || entryIds.length === 0) return [];
  const rows = await db
    .select()
    .from(lorebookEntryActivationStats)
    .where(inArray(lorebookEntryActivationStats.entryId, [...entryIds]));
  return rows.map((row) => ({
    entryId: row.entryId,
    lorebookId: row.lorebookId,
    count: row.count ?? 0,
    lastActivatedAt: row.lastActivatedAt ?? null,
    lastChatId: row.lastChatId ?? null,
  }));
}
