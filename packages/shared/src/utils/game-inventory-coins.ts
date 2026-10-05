/**
 * Paying with a ruleset's coins (#6901). Coins are stacks (`coin:<unit>`), so a purse is the coins in
 * one bag, and paying changes those stacks.
 *
 * A price is paid inside the one family of coins it is named in, never across families. The largest
 * coins go first, as many as fit the price without going over; what is still owed is paid by breaking
 * the smallest coin left that covers it, and the change comes back in the family's smaller coins,
 * largest first. So 5 gold is paid with 3 gold and 20 of 30 silver, and 1 silver out of 10 gold leaves
 * 9 gold and 9 silver. Pure: the caller saves the stacks.
 */
import {
  gameInventoryBagKey,
  newGameInventoryStackId,
  type GameInventoryCoin,
  type GameInventoryStack,
} from "./game-inventory-stacks.js";

/** How many of each coin changed hands, by name: what was handed over, and what came back as change. */
export interface GameInventoryPayment {
  paid: Array<{ name: string; count: number }>;
  change: Array<{ name: string; count: number }>;
}

/** What one bag's coins of a family are worth, in the family's smallest coin. */
export function gameInventoryCoinWorth(
  stacks: readonly GameInventoryStack[],
  holder: string | undefined,
  family: readonly GameInventoryCoin[],
): number {
  const bag = gameInventoryBagKey(holder);
  return family.reduce(
    (sum, coin) =>
      sum +
      coin.value *
        stacks
          .filter((stack) => stack.item === coin.item && gameInventoryBagKey(stack.holder) === bag)
          .reduce((count, stack) => count + stack.quantity, 0),
    0,
  );
}

/**
 * Pay `owed` (in the family's smallest coin) out of one bag's coins of `family` (every coin of it,
 * largest first). Refused when the bag's coins of that family are worth less.
 */
export function payGameInventoryCoins(
  stacks: readonly GameInventoryStack[],
  holder: string | undefined,
  family: readonly GameInventoryCoin[],
  owed: number,
): ({ ok: true; stacks: GameInventoryStack[] } & GameInventoryPayment) | { ok: false; reason: "cannot-afford" } {
  const bag = gameInventoryBagKey(holder);
  const mine = (stack: GameInventoryStack, coin: GameInventoryCoin) =>
    stack.item === coin.item && gameInventoryBagKey(stack.holder) === bag;
  const held = new Map(
    family.map((coin) => [coin.item, stacks.filter((stack) => mine(stack, coin)).reduce((n, s) => n + s.quantity, 0)]),
  );
  if (gameInventoryCoinWorth(stacks, holder, family) < owed) return { ok: false, reason: "cannot-afford" };
  const largestFirst = [...family].sort((a, b) => b.value - a.value);
  const taken = new Map<string, number>();
  let left = owed;
  for (const coin of largestFirst) {
    const count = Math.min(held.get(coin.item) ?? 0, Math.floor(left / coin.value));
    if (count > 0) taken.set(coin.item, count);
    left -= count * coin.value;
  }
  const given = new Map<string, number>();
  if (left > 0) {
    // Every coin still held is worth more than what is left, so the smallest of them covers it.
    const broken = [...largestFirst]
      .reverse()
      .find((coin) => (held.get(coin.item) ?? 0) - (taken.get(coin.item) ?? 0) > 0)!;
    taken.set(broken.item, (taken.get(broken.item) ?? 0) + 1);
    // The change is worth less than the coin broken, so it comes back in smaller coins only.
    let change = broken.value - left;
    for (const coin of largestFirst) {
      const count = Math.floor(change / coin.value);
      if (count > 0) given.set(coin.item, count);
      change -= count * coin.value;
    }
  }
  // The coins handed over come off the bag's stacks of them, first stack first.
  const owedOf = new Map(taken);
  let next: GameInventoryStack[] = stacks.flatMap((stack) => {
    const due = stack.item ? (owedOf.get(stack.item) ?? 0) : 0;
    if (due === 0 || gameInventoryBagKey(stack.holder) !== bag) return [stack];
    const off = Math.min(due, stack.quantity);
    owedOf.set(stack.item!, due - off);
    return stack.quantity - off > 0 ? [{ ...stack, quantity: stack.quantity - off }] : [];
  });
  // And the change as new stacks. The bag never still holds a coin given as change: every coin smaller
  // than the one broken was paid over whole, or it would have been broken instead.
  for (const coin of largestFirst) {
    const count = given.get(coin.item) ?? 0;
    if (count === 0) continue;
    next = [
      ...next,
      {
        id: newGameInventoryStackId(next),
        name: coin.name,
        item: coin.item,
        quantity: count,
        ...(holder ? { holder } : {}),
      },
    ];
  }
  const named = (counts: Map<string, number>) =>
    largestFirst.flatMap((coin) => {
      const count = counts.get(coin.item) ?? 0;
      return count > 0 ? [{ name: coin.name, count }] : [];
    });
  return { ok: true, stacks: next, paid: named(taken), change: named(given) };
}
