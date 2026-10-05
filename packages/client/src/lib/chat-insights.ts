// ──────────────────────────────────────────────
// Chat insights: modal openers and chat navigation
// ──────────────────────────────────────────────
// The openers are plain functions so a command palette, slash command or any
// other surface can open the same modals without importing their components.
import { useChatStore } from "../stores/chat.store";
import { isMobileShellViewport, useUIStore } from "../stores/ui.store";

export const GLOBAL_SEARCH_MODAL = "global-chat-search";
export const CHAT_STATS_MODAL = "chat-stats";
export const ACTIVITY_OVERVIEW_MODAL = "activity-overview";

/** Open the Search All Chats modal, optionally pre-filled. */
export function openGlobalSearch(initialQuery?: string) {
  useUIStore.getState().openModal(GLOBAL_SEARCH_MODAL, initialQuery ? { initialQuery } : undefined);
}

export function openChatStats(chatId: string) {
  useUIStore.getState().openModal(CHAT_STATS_MODAL, { chatId });
}

export function openActivityOverview() {
  useUIStore.getState().openModal(ACTIVITY_OVERVIEW_MODAL);
}

/** Switch to a chat and scroll to a 1-based message number once it loads. */
export function openChatAtMessage(chatId: string, messageNumber?: number) {
  const ui = useUIStore.getState();
  if (ui.hasAnyDetailOpen()) ui.closeAllDetails();
  const chat = useChatStore.getState();
  if (messageNumber && messageNumber > 0) chat.requestGotoMessage(chatId, messageNumber);
  chat.setActiveChatId(chatId);
  if (isMobileShellViewport()) ui.setSidebarOpen(false);
}
