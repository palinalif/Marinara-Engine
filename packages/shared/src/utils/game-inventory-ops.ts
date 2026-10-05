/**
 * Every change to Game Mode's inventory as one operation, applied by one function.
 *
 * The inventory screen sends these to the server, and the server applies the Game Master's
 * `[inventory: ...]` tags as these too, so the stacks, the detailed inventory on the game state and
 * the journal are all worked out in one place and saved together. Pure: nothing here reads or
 * writes storage.
 */
import { z } from "zod";
import type { InventoryItem } from "../types/game-state.js";
import {
  GAME_INVENTORY_HOLDER_MAX_LENGTH,
  GAME_INVENTORY_ITEM_REF_PATTERN,
  GAME_INVENTORY_MAX_QUANTITY,
  GAME_INVENTORY_NAME_MAX_LENGTH,
  addGameInventoryPlaced,
  gameInventoryAddedItem,
  gameInventoryGiveRefusal,
  gameInventoryKeptByCurse,
  gameInventoryUsableStack,
  gameInventoryOverloads,
  cleanGameInventoryHolder,
  gameInventoryBagKey,
  gameInventoryCountItems,
  gameInventoryItemId,
  gameInventoryItemsNamed,
  gameInventoryNameKey,
  gameInventoryStackLabel,
  giveGameInventoryStack,
  gameInventoryMergeOverloads,
  mergeGameInventoryStacks,
  newGameInventoryStackId,
  renameGameInventoryStack,
  setGameInventoryStackQuantity,
  splitGameInventoryStack,
  swapGameInventoryStacks,
  takeFromGameInventory,
  wearGameInventoryStack,
  type GameInventoryItemRules,
  type GameInventoryStack,
  type GameInventoryWearRefusal,
} from "./game-inventory-stacks.js";

/** The most operations one request applies. */
export const GAME_INVENTORY_MAX_OPS = 40;

const stackId = z.string().trim().min(1).max(80);
const itemName = z.string().trim().min(1).max(GAME_INVENTORY_NAME_MAX_LENGTH);
const holder = z.string().trim().min(1).max(GAME_INVENTORY_HOLDER_MAX_LENGTH);
const amount = z.number().int().min(1).max(GAME_INVENTORY_MAX_QUANTITY);

export const gameInventoryOpSchema = z.discriminatedUnion("op", [
  /** Into one bag by name, onto the item that name finds (a new one when it finds none): the player's
   *  bag when `holder` is absent. With `among`, the shared view instead: the bags it may go into, in
   *  the order they are asked ("" is the player's), which a ruleset that says what everyone carries
   *  picks from by who can carry it. With `item`, that ruleset item, and `name` is only what the
   *  journal calls it. `log` writes "acquired" in the journal. */
  z
    .object({
      op: z.literal("add"),
      name: itemName,
      item: z.string().max(121).regex(GAME_INVENTORY_ITEM_REF_PATTERN).optional(),
      count: amount,
      holder: holder.optional(),
      among: z.array(z.string().trim().max(GAME_INVENTORY_HOLDER_MAX_LENGTH)).min(1).max(20).optional(),
      log: z.boolean().optional(),
    })
    .strict(),
  /** Out by name, from one bag when `from` is given and otherwise the player's first. `as` is what the
   *  journal calls it; without it nothing is written there. Not held to one stack's bound. `worn` takes
   *  only from stacks the item may be used from, as a fight uses it (#6909). */
  z
    .object({
      op: z.literal("take"),
      name: itemName,
      count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      from: z.object({ holder: holder.optional() }).strict().optional(),
      as: z.enum(["lost", "used", "removed"]).optional(),
      worn: z.literal(true).optional(),
    })
    .strict(),
  /** `count` uses of one of the ruleset's items that holds charges, by its own name (#6909): each
   *  spends its cost from the first stack of it with enough, the player's own first (or `from`'s bag),
   *  and a stack emptied rolls the item's `breaksOn`, gone when it breaks. The journal says it was used,
   *  and lost where it broke. */
  z
    .object({
      op: z.literal("charge"),
      name: itemName,
      count: amount,
      from: z.object({ holder: holder.optional() }).strict().optional(),
    })
    .strict(),
  /** One stack set to a count; 0 removes it. A smaller count is written in the journal as removed. */
  z
    .object({ op: z.literal("set"), id: stackId, quantity: z.number().int().min(0).max(GAME_INVENTORY_MAX_QUANTITY) })
    .strict(),
  z.object({ op: z.literal("split"), id: stackId, size: amount }).strict(),
  z.object({ op: z.literal("merge"), from: stackId, into: stackId }).strict(),
  /** One stack's nickname; the item's own name clears it. */
  z.object({ op: z.literal("rename"), id: stackId, name: itemName }).strict(),
  z.object({ op: z.literal("swap"), first: stackId, second: stackId }).strict(),
  /** Some or all of one stack (all of it without `count`) to another bag: the player's without `to`. */
  z.object({ op: z.literal("give"), id: stackId, to: holder.optional(), count: amount.optional() }).strict(),
  /** One stack put on or taken off, bound or unbound, by whoever carries it. */
  z.object({ op: z.enum(["equip", "unequip", "bind", "unbind"]), id: stackId }).strict(),
]);

export type GameInventoryOp = z.infer<typeof gameInventoryOpSchema>;

export const gameInventoryOpsRequestSchema = z
  .object({
    chatId: z.string().trim().min(1).max(200),
    ops: z.array(gameInventoryOpSchema).min(1).max(GAME_INVENTORY_MAX_OPS),
  })
  .strict();

/** Why an operation changed nothing. `not-ruleset-item`: an add of something that is not one of the
 *  ruleset's items, where only those may be added. `too-heavy`: past what its bearer can carry. The
 *  rest are `GameInventoryWearRefusal`s; `cursed` also refuses parting with a bound cursed item. */
export type GameInventoryOpRefusal =
  | "missing-stack"
  | "none-held"
  | "not-ruleset-item"
  | "too-heavy"
  /** A service (#6917): bought, never carried. */
  | "service"
  | GameInventoryWearRefusal
  | "refused";

export type GameInventoryOpResult =
  | {
      ok: true;
      /** The stack the operation left the item in: the one added to, the new half of a split, the
       *  stack a rename or a gift ended in. */
      id?: string;
      /** How many really moved: added, taken or given. */
      count?: number;
      /** How many of the item that bag holds afterwards (the party's total for a take from anyone). */
      now?: number;
      /** An add into the shared view: how many went into whose bag, and how many that bag now holds. */
      placed?: Array<{ holder?: string; count: number; now: number }>;
      /** How many of an add nobody could carry, which were left behind. */
      left?: number;
      /** A charge: how many stacks of it broke when their last charge was spent. */
      broke?: number;
    }
  | { ok: false; reason: GameInventoryOpRefusal };

export interface GameInventoryJournalEntry {
  item: string;
  action: "acquired" | "lost" | "used" | "removed";
  quantity: number;
}

export interface GameInventoryOpsOutcome {
  stacks: GameInventoryStack[];
  results: GameInventoryOpResult[];
  journal: GameInventoryJournalEntry[];
}

/**
 * Every operation in order, each on the stacks the one before it left. One that cannot happen is
 * refused and changes nothing, and the rest still apply, the way the Game Master's sheet commands do.
 * `rules` are what the game's ruleset says about its items; without them every item is plain.
 */
export function applyGameInventoryOps(
  stacks: GameInventoryStack[],
  ops: readonly GameInventoryOp[],
  newId?: () => string,
  rules?: GameInventoryItemRules,
  /** Throws a die of that many sides, for an item that may break as its last charge is spent. Without
   *  it such an item never breaks. */
  roll?: (sides: number) => number,
): GameInventoryOpsOutcome {
  let current = stacks;
  const results: GameInventoryOpResult[] = [];
  const journal: GameInventoryJournalEntry[] = [];
  const makeId = () => (newId ? newId() : newGameInventoryStackId(current));
  const refuse = (reason: GameInventoryOpRefusal) => results.push({ ok: false, reason });
  const stackOf = (id: string) => current.find((stack) => stack.id === id);

  for (const op of ops) {
    switch (op.op) {
      case "add": {
        const bag = { holder: cleanGameInventoryHolder(op.holder) };
        // The item first: a ruleset item by its id only while the game offers it, or whatever the name
        // finds.
        const known = op.item ? (rules?.offers(op.item) ? rules.itemOf(op.item) : undefined) : undefined;
        const like = op.item
          ? known && { name: known.name, item: known.item }
          : gameInventoryAddedItem(current, op.name, bag.holder, rules);
        if (!like) {
          refuse("not-ruleset-item");
          break;
        }
        // A service (lodging, passage) is bought and never carried, whoever adds it.
        if (like.item && rules?.itemOf(like.item)?.service) {
          refuse("service");
          break;
        }
        const destination = op.among ? { among: op.among.map((holder) => cleanGameInventoryHolder(holder)) } : bag;
        const added = addGameInventoryPlaced(current, like, op.count, destination, makeId, rules);
        if (!added || added.shares.length === 0) {
          refuse(added ? "too-heavy" : "refused");
          break;
        }
        current = added.stacks;
        // How many of the item each bag it went into now holds: the name may have found that item by
        // a nickname in another bag, which a bag's own count by name would not see.
        const item = gameInventoryItemId(like);
        const holds = (holder: string | undefined) =>
          current
            .filter(
              (stack) =>
                gameInventoryItemId(stack) === item &&
                gameInventoryBagKey(stack.holder) === gameInventoryBagKey(holder),
            )
            .reduce((total, stack) => total + stack.quantity, 0);
        const placed = added.shares.map((share) => ({
          ...(share.holder ? { holder: share.holder } : {}),
          count: share.count,
          now: holds(share.holder),
        }));
        const count = placed.reduce((total, share) => total + share.count, 0);
        results.push({
          ok: true,
          id: added.shares[0]!.id,
          count,
          now: placed[0]!.now,
          ...(op.among ? { placed } : {}),
          ...(added.left > 0 ? { left: added.left } : {}),
        });
        if (op.log) journal.push({ item: op.name.trim(), action: "acquired", quantity: count });
        break;
      }
      case "take": {
        const from = op.from ? { holder: cleanGameInventoryHolder(op.from.holder) } : undefined;
        // Which items the name means is settled before the take: once the last stack of an item is
        // gone, the name alone could find another item by its nickname.
        const items = gameInventoryItemsNamed(current, op.name, from);
        const taken = takeFromGameInventory(current, op.name, op.count, from, rules, op.worn === true);
        if (taken.taken === 0) {
          // Held, but only as a bound cursed item the player cannot part with.
          const cursed = current.some(
            (stack) =>
              items.has(gameInventoryItemId(stack)) &&
              (!from || gameInventoryBagKey(stack.holder) === gameInventoryBagKey(from.holder)) &&
              gameInventoryKeptByCurse(stack, rules),
          );
          refuse(cursed ? "cursed" : "none-held");
          break;
        }
        current = taken.stacks;
        results.push({ ok: true, count: taken.taken, now: gameInventoryCountItems(current, items, from) });
        if (op.as) journal.push({ item: op.name.trim(), action: op.as, quantity: taken.taken });
        break;
      }
      case "charge": {
        const from = op.from ? { holder: cleanGameInventoryHolder(op.from.holder) } : undefined;
        const items = gameInventoryItemsNamed(current, op.name, from);
        // Only from a stack the item may be used from: worn where it takes slots, bound where it binds.
        const chargesOf = (stack: GameInventoryStack) =>
          gameInventoryUsableStack(stack, rules) && stack.item ? rules?.itemOf(stack.item)?.charges : undefined;
        const left = (stack: GameInventoryStack) => {
          const held = chargesOf(stack);
          return held ? Math.min(held.max, stack.charges ?? held.max) : 0;
        };
        let spent = 0;
        let broke = 0;
        for (; spent < op.count; spent++) {
          // The player's own bag first, then the party in the order the stacks are kept.
          const usable = current.filter(
            (stack) =>
              items.has(gameInventoryItemId(stack)) &&
              (!from || gameInventoryBagKey(stack.holder) === gameInventoryBagKey(from.holder)) &&
              chargesOf(stack) !== undefined &&
              left(stack) >= chargesOf(stack)!.cost,
          );
          const stack = usable.find((each) => !each.holder) ?? usable[0];
          if (!stack) break;
          const held = chargesOf(stack)!;
          const now = left(stack) - held.cost;
          const breaks = now === 0 && held.breaksOn && roll ? roll(held.breaksOn.die) <= held.breaksOn.atMost : false;
          if (breaks) broke++;
          current = breaks
            ? current.filter((each) => each !== stack)
            : current.map((each) => (each === stack ? { ...each, charges: now } : each));
        }
        if (spent === 0) {
          refuse("none-held");
          break;
        }
        results.push({ ok: true, count: spent, ...(broke > 0 ? { broke } : {}) });
        journal.push({ item: op.name.trim(), action: "used", quantity: spent });
        if (broke > 0) journal.push({ item: op.name.trim(), action: "lost", quantity: broke });
        break;
      }
      case "set": {
        const stack = stackOf(op.id);
        if (!stack) {
          refuse("missing-stack");
          break;
        }
        // A raised count is more to carry, held to its bearer's limit like any addition.
        if (
          op.quantity > stack.quantity &&
          gameInventoryOverloads(current, stack, op.quantity - stack.quantity, rules)
        ) {
          refuse("too-heavy");
          break;
        }
        const next = setGameInventoryStackQuantity(current, op.id, op.quantity, makeId, rules);
        if (next === current && op.quantity !== stack.quantity) {
          refuse(op.quantity < stack.quantity && gameInventoryKeptByCurse(stack, rules) ? "cursed" : "refused");
          break;
        }
        current = next;
        const after = stackOf(op.id)?.quantity ?? 0;
        // A count past one stack's worth fills this stack and starts new ones after it, so what moved
        // is the whole difference, and `now` is this stack's own count.
        results.push({
          ok: true,
          ...(after > 0 ? { id: op.id } : {}),
          count: Math.abs(op.quantity - stack.quantity),
          now: after,
        });
        if (op.quantity < stack.quantity)
          journal.push({
            item: gameInventoryStackLabel(stack),
            action: "removed",
            quantity: stack.quantity - op.quantity,
          });
        break;
      }
      case "split": {
        const index = current.findIndex((stack) => stack.id === op.id);
        const next = splitGameInventoryStack(current, op.id, op.size, makeId);
        if (index < 0 || next === current) {
          refuse(index < 0 ? "missing-stack" : "refused");
          break;
        }
        current = next;
        results.push({ ok: true, id: current[index + 1]!.id, count: op.size });
        break;
      }
      case "merge": {
        const next = mergeGameInventoryStacks(current, op.from, op.into, rules);
        if (next === current) {
          const from = stackOf(op.from);
          const into = stackOf(op.into);
          refuse(
            !from || !into
              ? "missing-stack"
              : gameInventoryMergeOverloads(current, from, into, rules)
                ? "too-heavy"
                : "refused",
          );
          break;
        }
        current = next;
        results.push({ ok: true, id: op.into });
        break;
      }
      case "rename": {
        const stack = stackOf(op.id);
        const renamed = stack ? renameGameInventoryStack(current, op.id, op.name) : null;
        if (!stack || !renamed) {
          refuse(stack ? "refused" : "missing-stack");
          break;
        }
        current = renamed.stacks;
        results.push({ ok: true, id: renamed.id });
        break;
      }
      case "swap": {
        if (!stackOf(op.first) || !stackOf(op.second)) {
          refuse("missing-stack");
          break;
        }
        current = swapGameInventoryStacks(current, op.first, op.second);
        results.push({ ok: true });
        break;
      }
      case "give": {
        const stack = stackOf(op.id);
        const kept = stack && gameInventoryGiveRefusal(current, stack, op.to, op.count ?? stack.quantity, rules);
        if (kept) {
          refuse(kept);
          break;
        }
        const given = stack ? giveGameInventoryStack(current, op.id, op.to, op.count, makeId, rules) : null;
        if (!stack || !given) {
          refuse(stack ? "refused" : "missing-stack");
          break;
        }
        current = given.stacks;
        const to = { holder: cleanGameInventoryHolder(op.to) };
        results.push({
          ok: true,
          id: given.id,
          count: op.count ?? stack.quantity,
          now: gameInventoryCountItems(current, new Set([gameInventoryItemId(stack)]), to),
        });
        break;
      }
      case "equip":
      case "unequip":
      case "bind":
      case "unbind": {
        const worn = wearGameInventoryStack(current, op.id, op.op, makeId, rules);
        if (!worn || "refused" in worn) {
          refuse(worn ? worn.refused : "missing-stack");
          break;
        }
        current = worn.stacks;
        results.push({ ok: true, id: worn.id });
        break;
      }
    }
  }
  return { stacks: current, results, journal };
}

/**
 * The detailed inventory on the game state, kept in step with the stacks: one entry per item, its
 * quantity what the player's own bag holds, since everything that reads it (the sheet, the trackers,
 * an encounter's prompt) reads it as the player's. Entries follow items, not names: each carries the
 * id of the item it follows (`item`), so a rename only changes the name an entry shows, and an entry
 * keeps its description and where it is kept through a rename or a gift. An entry written without an
 * id (by a tracker, or before entries had them) is matched by name once and then keeps one. Only the
 * difference is applied. Returns the same array when nothing it tracks changed.
 */
export function followGameInventoryDetails(
  detailed: readonly InventoryItem[] | null | undefined,
  before: readonly GameInventoryStack[],
  after: readonly GameInventoryStack[],
): InventoryItem[] {
  const source = Array.isArray(detailed) ? detailed : [];
  let items = source.slice();
  /** The player's own bag, one line per item: how many, and the names its first stack goes by. */
  const ownItems = (stacks: readonly GameInventoryStack[]) => {
    const lines = new Map<string, { quantity: number; label: string; own: string }>();
    for (const stack of stacks) {
      if (gameInventoryBagKey(stack.holder) !== "") continue;
      const item = gameInventoryItemId(stack);
      const line = lines.get(item);
      if (line) line.quantity += stack.quantity;
      else lines.set(item, { quantity: stack.quantity, label: gameInventoryStackLabel(stack), own: stack.name });
    }
    return lines;
  };
  const was = ownItems(before);
  const now = ownItems(after);
  const ownedBy = new Map<string, string>();
  for (const [item, line] of [...was, ...now]) ownedBy.set(gameInventoryNameKey(line.own), item);

  for (const item of new Set([...was.keys(), ...now.keys()])) {
    const then = was.get(item);
    const current = now.get(item);
    const difference = (current?.quantity ?? 0) - (then?.quantity ?? 0);
    if (difference === 0 && then?.label === current?.label) continue;
    // The entries this item has, in order: those carrying its id, then ones written without an id under
    // a name the item went by (as it was shown, its own name), then the name it is shown by now. A name
    // that is another held item's own name belongs to that item.
    const names = new Set(
      [then?.label, then?.own, current?.label, current?.own].flatMap((name) => {
        const key = name ? gameInventoryNameKey(name) : "";
        return key && (ownedBy.get(key) ?? item) === item ? [key] : [];
      }),
    );
    const finds = [
      (entry: InventoryItem) => entry.item === item,
      ...[...names].map(
        (key) => (entry: InventoryItem) => entry.item === undefined && gameInventoryNameKey(entry.name) === key,
      ),
    ];
    const shown = current?.label;
    if (difference >= 0) {
      const index = finds.map((find) => items.findIndex(find)).find((found) => found >= 0) ?? -1;
      if (index >= 0) {
        const entry = items[index]!;
        items[index] = { ...entry, item, name: shown ?? entry.name, quantity: entry.quantity + difference };
      } else if (difference > 0) {
        items.push({ item, name: shown!, description: "", quantity: difference, location: "on_person" });
      }
      continue;
    }
    // Taken from the entries in that order, and only the entries something was taken from change.
    let left = -difference;
    const takeAt = new Map<number, number>();
    for (const drains of finds) {
      items.forEach((entry, index) => {
        if (left < 1 || takeAt.has(index) || !drains(entry)) return;
        const take = Math.min(left, entry.quantity);
        left -= take;
        takeAt.set(index, take);
      });
    }
    items = items.flatMap((entry, index) => {
      const take = takeAt.get(index);
      if (take === undefined) return [entry];
      const rest = entry.quantity - take;
      return rest > 0 ? [{ ...entry, item, name: shown ?? entry.name, quantity: rest }] : [];
    });
  }
  const unchanged =
    items.length === source.length &&
    items.every((item, index) => JSON.stringify(item) === JSON.stringify(source[index]));
  return unchanged ? (source as InventoryItem[]) : items;
}
