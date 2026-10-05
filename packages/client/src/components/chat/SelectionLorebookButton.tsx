// ──────────────────────────────────────────────
// Selected chat text → new lorebook entry (#6899)
// A small button follows a selection inside a chat message on desktop and
// mobile, asks which lorebook, then opens it with the new entry expanded.
// ──────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, BookPlus } from "lucide-react";
import { toast } from "sonner";
import { useChat } from "../../hooks/use-chats";
import { useCreateLorebookEntry, useLorebooks } from "../../hooks/use-lorebooks";
import { getChatActiveLorebookIds } from "../../lib/chat-lorebooks";
import { cn } from "../../lib/utils";
import { useChatStore } from "../../stores/chat.store";
import { useUIStore } from "../../stores/ui.store";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { NEUTRAL_PANEL_SHELL } from "../ui/neutral-surface-styles";

/** Entry names allow 200 characters, so longer selections are not offered. */
const MAX_ENTRY_NAME_LENGTH = 200;

type SelectionAnchor = { text: string; x: number; y: number };
type LorebookMenu = SelectionAnchor & { fromKeyboard: boolean };

function readMessageSelection(): SelectionAnchor | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const inMessage = (node: Node | null) =>
    Boolean((node instanceof Element ? node : node?.parentElement)?.closest("[data-message-id]"));
  if (!inMessage(selection.anchorNode) || !inMessage(selection.focusNode)) return null;
  const text = selection.toString().replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_ENTRY_NAME_LENGTH) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > window.innerHeight) return null;
  return {
    text,
    x: Math.min(Math.max(rect.left + rect.width / 2, 80), window.innerWidth - 80),
    y: Math.min(rect.bottom + 8, window.innerHeight - 48),
  };
}

export function SelectionLorebookButton() {
  const { t } = useTranslation();
  const activeChatId = useChatStore((s) => s.activeChatId);
  const { data: chat } = useChat(activeChatId);
  const { data: lorebooks } = useLorebooks();
  const createEntry = useCreateLorebookEntry();
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);
  const [menu, setMenu] = useState<LorebookMenu | null>(null);

  const update = useCallback(() => setAnchor(readMessageSelection()), []);

  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [update]);

  const openMenu = (button: HTMLElement, fromKeyboard: boolean) => {
    if (!anchor) return;
    const rect = button.getBoundingClientRect();
    setMenu({ text: anchor.text, x: rect.left, y: rect.bottom + 4, fromKeyboard });
  };

  const items = useMemo((): ContextMenuItem[] => {
    if (!menu) return [];
    // The chat's own lorebooks first; the rest keep the library order.
    const activeIds = new Set(chat ? getChatActiveLorebookIds(chat) : []);
    const ordered = [...(lorebooks ?? [])].sort(
      (left, right) => Number(activeIds.has(right.id)) - Number(activeIds.has(left.id)),
    );
    if (ordered.length === 0) {
      return [{ label: t("chat.selectionLorebook.noLorebooks"), onSelect: () => undefined, disabled: true }];
    }
    return ordered.map((lorebook) => ({
      label: lorebook.name,
      icon: <BookOpen size="0.8125rem" />,
      onSelect: () => {
        // A slow create leaves the button up; a second pick must not add a duplicate entry.
        if (createEntry.isPending) return;
        createEntry
          .mutateAsync({
            lorebookId: lorebook.id,
            name: menu.text,
            content: "",
            keys: [menu.text],
            preventRecursion: true,
          })
          .then((entry) => {
            window.getSelection()?.removeAllRanges();
            useUIStore.getState().openLorebookDetail(lorebook.id, { initialTab: "entries", entryId: entry.id });
          })
          .catch(() => toast.error(t("chat.selectionLorebook.failed")));
      },
    }));
  }, [chat, createEntry, lorebooks, menu, t]);

  return (
    <>
      {anchor &&
        createPortal(
          <button
            type="button"
            data-selection-lorebook-button
            title={t("chat.selectionLorebook.add")}
            style={{ left: anchor.x, top: anchor.y }}
            // A tap would collapse the selection before its click; opening on press also
            // suppresses the tap's compatibility mousedown that would close the menu.
            onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => {
              event.preventDefault();
              openMenu(event.currentTarget, false);
            }}
            // Enter or Space: a click without a pointer (detail 0) moves focus into the menu.
            onClick={(event) => openMenu(event.currentTarget, event.detail === 0)}
            className={cn(
              NEUTRAL_PANEL_SHELL,
              "fixed z-[9998] inline-flex min-h-9 -translate-x-1/2 items-center gap-1.5 !rounded-full px-3 text-xs font-medium text-[var(--marinara-chat-chrome-panel-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]",
            )}
          >
            <BookPlus size="0.8125rem" aria-hidden="true" />
            {t("chat.selectionLorebook.add")}
          </button>,
          document.body,
        )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items}
          autoFocus={menu.fromKeyboard}
          onClose={() => {
            setMenu(null);
            update();
          }}
        />
      )}
    </>
  );
}
