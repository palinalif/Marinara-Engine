// ──────────────────────────────────────────────
// Schema: Lorebook Entry Activation Stats
// One row per entry that has fired in a real generation. Written in batches
// by services/lorebook/activation-stats.ts; never read by generation itself.
// ──────────────────────────────────────────────
import { fileTable, text, integer } from "../file-schema.js";

export const lorebookEntryActivationStats = fileTable("lorebook_entry_activation_stats", {
  entryId: text("entry_id").primaryKey(),
  lorebookId: text("lorebook_id").notNull(),
  count: integer("count").notNull().default(0),
  lastActivatedAt: text("last_activated_at"),
  lastChatId: text("last_chat_id"),
});
