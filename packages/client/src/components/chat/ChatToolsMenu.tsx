import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Reorder, useDragControls } from "framer-motion";
import { GripVertical, Lock, MoreHorizontal, Unlock, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { WindowBubble } from "../ui/WindowBubble";
import { usePhoneBubbleBounds } from "../ui/FloatingWindow";
import { PHONE_BUBBLE_SIZE_PX, getPhoneBubbleSlot, type WindowPoint } from "../../lib/floating-window-layout";
import { PHONE_BUBBLE_Z_INDEX, useFloatingWindowStore } from "../../stores/floating-window.store";
import { CHAT_TOOLS_MENU_ID, useChatToolsMenuStore, type ChatToolsMenuEntry } from "../../stores/chat-tools-menu.store";

function ToolRow({
  entry,
  position,
  count,
  locked,
  onOpen,
  onMove,
}: {
  entry: ChatToolsMenuEntry;
  position: number;
  count: number;
  locked: boolean;
  onOpen: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const { t } = useTranslation();
  const dragControls = useDragControls();
  const reorderLabel = t("chat.toolsMenu.reorder", { name: entry.label, position, count });
  return (
    <Reorder.Item
      value={entry.id}
      dragListener={false}
      dragControls={dragControls}
      drag={locked ? false : "y"}
      data-chat-tools-menu-item={entry.id}
      className="mari-drawer relative flex min-h-11 items-center gap-1"
      aria-posinset={position}
      aria-setsize={count}
    >
      <button
        type="button"
        onClick={onOpen}
        className="mari-drawer__toggle flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
      >
        <span className="mari-drawer__icon relative flex shrink-0 items-center justify-center [&_svg]:size-4">
          {entry.icon}
          {entry.badge}
        </span>
        <span className="mari-drawer__title min-w-0 text-sm">{entry.label}</span>
      </button>
      <button
        type="button"
        disabled={locked}
        aria-label={reorderLabel}
        title={reorderLabel}
        data-chat-tools-menu-reorder={entry.id}
        className="mari-window__control !min-h-11 !min-w-11 touch-none disabled:opacity-40"
        onPointerDown={(event) => {
          if (!locked) dragControls.start(event);
        }}
        onKeyDown={(event) => {
          if (locked || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
          event.preventDefault();
          event.stopPropagation();
          onMove(event.key === "ArrowUp" ? -1 : 1);
        }}
      >
        <GripVertical size={16} />
      </button>
    </Reorder.Item>
  );
}

/** One phone launcher for Chat Settings tools; their existing sheets keep ownership of their content. */
export function ChatToolsMenu() {
  const { t } = useTranslation();
  const bounds = usePhoneBubbleBounds(true);
  const entries = useChatToolsMenuStore((state) => state.entries);
  const menu = useFloatingWindowStore((state) => state.phoneMenu);
  const points = useFloatingWindowStore((state) => state.phoneBubbles);
  const resetRevision = useFloatingWindowStore((state) => state.resetRevision);
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState(PHONE_BUBBLE_SIZE_PX);
  const [placed, setPlaced] = useState<WindowPoint>(() => getPhoneBubbleSlot(bounds, 1, size));
  const bubbleRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  const locked = menu?.locked === true;
  const savedOrder = menu?.order ?? [];
  // Existing saved phone rows provide a familiar initial order; new tools follow by stable id.
  const ids = Object.keys(entries).sort((left, right) => {
    const leftIndex = savedOrder.indexOf(left);
    const rightIndex = savedOrder.indexOf(right);
    if (leftIndex >= 0 || rightIndex >= 0)
      return (leftIndex < 0 ? Infinity : leftIndex) - (rightIndex < 0 ? Infinity : rightIndex);
    const a = points[left];
    const b = points[right];
    if (a && b) return a.y - b.y || a.x - b.x || left.localeCompare(right);
    return Number(!a) - Number(!b) || left.localeCompare(right);
  });
  const hasEntries = ids.length > 0;
  const updatePosition = useCallback((point: WindowPoint) => {
    setPlaced((current) => (current.x === point.x && current.y === point.y ? current : point));
  }, []);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) bubbleRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => setOpen(false), [resetRevision, hasEntries]);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus({ preventScroll: true });
    const onOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || panelRef.current?.contains(target) || bubbleRef.current?.contains(target))
        return;
      close(false);
    };
    document.addEventListener("pointerdown", onOutside, true);
    return () => document.removeEventListener("pointerdown", onOutside, true);
  }, [close, open]);

  if (!hasEntries) return null;

  const width = Math.min(300, Math.max(0, bounds.right - bounds.left));
  const left = Math.max(bounds.left, Math.min(placed.x + size - width, bounds.right - width));
  const below = bounds.bottom - placed.y - size - 8;
  const above = placed.y - bounds.top - 8;
  const placeBelow = below >= Math.min(240, 52 + ids.length * 44) || below >= above;
  const available = placeBelow ? below : above;
  // If the keyboard leaves almost no space beside the launcher, use the remaining chat area.
  const cramped = available < 96;
  const top = cramped ? bounds.top : placeBelow ? placed.y + size + 8 : placed.y - 8;
  const maxHeight = Math.max(0, cramped ? bounds.bottom - bounds.top : available);
  const reorder = (order: string[]) => useFloatingWindowStore.getState().savePhoneMenuOrder(order);

  return (
    <>
      <WindowBubble
        id={CHAT_TOOLS_MENU_ID}
        buttonRef={bubbleRef}
        point={points[CHAT_TOOLS_MENU_ID] ?? { ...getPhoneBubbleSlot(bounds, 1, size), automatic: true }}
        bounds={bounds}
        size={PHONE_BUBBLE_SIZE_PX}
        onSizeChange={setSize}
        onPositionChange={updatePosition}
        icon={<MoreHorizontal size={18} />}
        label={t("chat.toolsMenu.title")}
        ariaLabel={t("chat.toolsMenu.title")}
        expanded={open}
        locked={locked}
        zIndex={PHONE_BUBBLE_Z_INDEX}
        attributes={{ "data-presentation": "sheet", "data-chat-tools-menu-button": true }}
        onMove={(point) => useFloatingWindowStore.getState().savePhoneBubble(CHAT_TOOLS_MENU_ID, point)}
        onOpen={() => setOpen((current) => !current)}
      />
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          tabIndex={-1}
          data-chat-tools-menu
          data-window={CHAT_TOOLS_MENU_ID}
          data-presentation="menu"
          data-locked={locked ? "true" : "false"}
          data-no-intuitive-swipe
          className="mari-window fixed flex min-h-0 flex-col outline-none"
          style={{
            left,
            top,
            width,
            maxHeight,
            transform: !cramped && !placeBelow ? "translateY(-100%)" : undefined,
            zIndex: PHONE_BUBBLE_Z_INDEX + 1,
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            close(true);
          }}
        >
          <div className="mari-window__header flex shrink-0 items-center justify-between gap-2">
            <h2 id={headingId} className="mari-window__title text-sm font-semibold">
              {t("chat.toolsMenu.title")}
            </h2>
            <div className="mari-window__controls flex shrink-0 items-center">
              <button
                type="button"
                data-window-control="lock"
                aria-label={t(locked ? "chat.toolsMenu.unlock" : "chat.toolsMenu.lock")}
                title={t(locked ? "chat.toolsMenu.unlock" : "chat.toolsMenu.lock")}
                aria-pressed={locked}
                className="mari-window__control !min-h-11 !min-w-11"
                onClick={() => useFloatingWindowStore.getState().setPhoneMenuLocked(!locked)}
              >
                {locked ? <Lock size={16} /> : <Unlock size={16} />}
              </button>
              <button
                type="button"
                aria-label={t("window.controls.close")}
                data-window-control="close"
                className="mari-window__control !min-h-11 !min-w-11"
                onClick={() => close(true)}
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <Reorder.Group
            axis="y"
            values={ids}
            onReorder={reorder}
            layoutScroll
            className="mari-window__body min-h-0 overflow-y-auto overscroll-contain"
          >
            {ids.map((id, index) => (
              <ToolRow
                key={id}
                entry={entries[id]!}
                position={index + 1}
                count={ids.length}
                locked={locked}
                onOpen={() => {
                  close(false);
                  useFloatingWindowStore.getState().openWindow(id, bubbleRef.current);
                }}
                onMove={(direction) => {
                  const nextIndex = index + direction;
                  if (nextIndex < 0 || nextIndex >= ids.length) return;
                  const next = [...ids];
                  [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
                  reorder(next);
                }}
              />
            ))}
          </Reorder.Group>
        </div>
      )}
    </>
  );
}
