// What a player typed into an inventory stack's amount, as the count the stack should become.
//
// A plain number sets the count ("300"). A sign adds or takes that many ("+100", "-50"), so moving
// three hundred of something is one entry rather than three hundred clicks. Anything else, or a
// result past what one stack may hold, is not an amount, and the field goes back to what it was.
import { GAME_INVENTORY_MAX_QUANTITY } from "@marinara-engine/shared";

export function parseInventoryAmount(text: string, current: number): number | null {
  const match = /^\s*([+-]?)\s*(\d{1,7})\s*$/.exec(text);
  if (!match) return null;
  const value = Number.parseInt(match[2]!, 10);
  const next = match[1] === "+" ? current + value : match[1] === "-" ? current - value : value;
  if (next > GAME_INVENTORY_MAX_QUANTITY) return null;
  return Math.max(0, next);
}

/** A typed count from 1 to `max`, digits only: "2abc", "1.5" and "" are not counts. Null otherwise. */
export function parseInventoryCount(text: string, max: number): number | null {
  const match = /^\s*(\d{1,7})\s*$/.exec(text);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 10);
  return value >= 1 && value <= max ? value : null;
}

/** The size a split starts at: half the stack, rounded down, and never less than one. */
export function defaultInventorySplitSize(quantity: number): number {
  return Math.max(1, Math.floor(quantity / 2));
}
