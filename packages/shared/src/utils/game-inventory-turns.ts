/**
 * Game Mode's inventory across the tellings of one turn.
 *
 * The stacks are one value per chat, but a turn can be told several times: regenerated, or swiped
 * back to an earlier telling. So the latest turn whose tags touched the stacks is remembered as
 * `gameInventoryTurn` in the chat's metadata: the stacks it began with, and what each telling left.
 * A new telling then starts from the turn's beginning, and switching tellings shows what that one
 * left, but only while the stacks are still exactly what the telling being left behind left them
 * as. Anything the player changed since is never thrown away: the new telling applies on top of it.
 * Pure: the server reads and writes the record.
 */
import { normalizeGameInventoryStacks, type GameInventoryStack } from "./game-inventory-stacks.js";
import { readResolvedInventoryTags } from "./inventory-command-tag.js";

export interface GameInventoryTurn {
  messageId: string;
  /** The stacks the turn began with. */
  before: GameInventoryStack[];
  /** What each telling left, by swipe index. */
  swipes: Record<string, GameInventoryStack[]>;
}

/** The most tellings of one turn remembered; the oldest are forgotten first. */
export const GAME_INVENTORY_TURN_MAX_SWIPES = 20;

/** The record as it is stored, read tolerantly. Null for anything that is not one. */
export function readGameInventoryTurn(raw: unknown): GameInventoryTurn | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.messageId !== "string" || !source.messageId || !Array.isArray(source.before)) return null;
  const swipes: Record<string, GameInventoryStack[]> = {};
  if (source.swipes && typeof source.swipes === "object" && !Array.isArray(source.swipes)) {
    for (const [index, stacks] of Object.entries(source.swipes as Record<string, unknown>)) {
      if (/^\d{1,4}$/.test(index) && Array.isArray(stacks)) swipes[index] = normalizeGameInventoryStacks(stacks);
    }
  }
  return { messageId: source.messageId, before: normalizeGameInventoryStacks(source.before), swipes };
}

/** Whether two stack lists are the same inventory: the same stacks, in the same order, bags, names,
 *  items, and what is worn or bound. */
export function sameGameInventory(
  first: readonly GameInventoryStack[],
  second: readonly GameInventoryStack[],
): boolean {
  const key = (stacks: readonly GameInventoryStack[]) =>
    JSON.stringify(
      normalizeGameInventoryStacks(stacks).map(({ id, name, nickname, item, quantity, holder, equipped, bound }) => [
        id,
        name,
        nickname ?? null,
        item ?? null,
        quantity,
        holder ?? null,
        equipped ?? false,
        bound ?? false,
      ]),
    );
  return key(first) === key(second);
}

/** Whether a saved telling changed the inventory at all: any of its tags the server carried out. */
export function tellingChangedGameInventory(content: string): boolean {
  return readResolvedInventoryTags(content).some((tag) => tag.ok);
}

/**
 * Where a new telling starts, and the record it continues.
 *
 * - `regenerate` replaces the telling at `replaced` of `messageId`: it starts from the turn's
 *   beginning when the stacks are still what that telling left; from the stacks as they are when
 *   the telling changed nothing (they ARE the beginning); and otherwise from the stacks as they are,
 *   forgetting the older tellings, whose beginning can no longer be told apart from later changes.
 * - `continue` adds to the telling at `replaced`, so it starts from the stacks as they are.
 * - A new turn starts from the stacks as they are.
 */
export function gameInventoryTellingStart(
  turn: GameInventoryTurn | null,
  current: GameInventoryStack[],
  telling:
    { kind: "new" } | { kind: "regenerate" | "continue"; messageId: string; replaced: number; replacedContent: string },
): { start: GameInventoryStack[]; before: GameInventoryStack[]; swipes: Record<string, GameInventoryStack[]> } {
  if (telling.kind === "new") return { start: current, before: current, swipes: {} };
  const own = turn?.messageId === telling.messageId ? turn : null;
  const left = own?.swipes[String(telling.replaced)];
  if (own && left && sameGameInventory(current, left)) {
    return telling.kind === "regenerate"
      ? { start: own.before, before: own.before, swipes: own.swipes }
      : { start: current, before: own.before, swipes: own.swipes };
  }
  if (!tellingChangedGameInventory(telling.replacedContent)) {
    // That telling left the stacks as it found them, so they are the turn's beginning.
    return { start: current, before: current, swipes: { [String(telling.replaced)]: current } };
  }
  return { start: current, before: current, swipes: {} };
}

/** The record once a telling is saved at `swipe`, keeping the newest tellings only. */
export function recordGameInventoryTelling(
  messageId: string,
  before: GameInventoryStack[],
  swipes: Record<string, GameInventoryStack[]>,
  swipe: number,
  after: GameInventoryStack[],
): GameInventoryTurn {
  const next = { ...swipes, [String(swipe)]: after };
  const kept = Object.keys(next)
    .sort((a, b) => Number(a) - Number(b))
    .slice(-GAME_INVENTORY_TURN_MAX_SWIPES);
  return { messageId, before, swipes: Object.fromEntries(kept.map((index) => [index, next[index]!])) };
}

/**
 * The record once the telling at `removed` of `messageId` is deleted: the tellings after it move down
 * one, as the message's swipes do. Another turn's record is returned as it is.
 */
export function forgetGameInventoryTelling(
  turn: GameInventoryTurn | null,
  messageId: string,
  removed: number,
): GameInventoryTurn | null {
  if (!turn || turn.messageId !== messageId) return turn;
  const swipes: Record<string, GameInventoryStack[]> = {};
  for (const [index, stacks] of Object.entries(turn.swipes)) {
    const at = Number(index);
    if (at !== removed) swipes[String(at > removed ? at - 1 : at)] = stacks;
  }
  return { ...turn, swipes };
}

/**
 * The stacks to show when the player switches `messageId` from the telling at `from` to the one at
 * `to`: what `to` left, when the stacks are still what `from` left. Null leaves them as they are.
 */
export function gameInventoryForTelling(
  turn: GameInventoryTurn | null,
  current: GameInventoryStack[],
  messageId: string,
  from: number,
  to: number,
): GameInventoryStack[] | null {
  if (!turn || turn.messageId !== messageId || from === to) return null;
  const left = turn.swipes[String(from)];
  const target = turn.swipes[String(to)];
  if (!left || !target || !sameGameInventory(current, left)) return null;
  return sameGameInventory(current, target) ? null : target;
}
