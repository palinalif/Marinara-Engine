/**
 * The Game Master's `[inventory: ...]` tags, applied to the stacks.
 *
 * The server calls this once for the reply it saves. Every tag becomes one resolved tag per item,
 * carrying what really happened, so the Game Master reads its refusals back next turn and the client
 * only has to announce what the tags say. Pure: the caller saves the stacks and the journal.
 */
import { normalizeCharacterLookupName } from "./character-lookup-name.js";
import {
  applyGameInventoryOps,
  type GameInventoryJournalEntry,
  type GameInventoryOp,
  type GameInventoryOpResult,
} from "./game-inventory-ops.js";
import {
  gameInventoryBagKey,
  gameInventoryCountItems,
  gameInventoryGiveRefusal,
  gameInventoryItemId,
  gameInventoryItemsNamed,
  giveFromGameInventoryNamed,
  wearGameInventoryStack,
  type GameInventoryBagRef,
  type GameInventoryCoin,
  type GameInventoryItemRules,
  type GameInventoryStack,
} from "./game-inventory-stacks.js";
import { payGameInventoryCoins, type GameInventoryPayment } from "./game-inventory-coins.js";
import {
  createInventoryTagRegex,
  createLootTagRegex,
  parseInventoryTagBody,
  parseLootTagBody,
  serializeInventoryTag,
  serializeLootTag,
  type InventoryTagOutcome,
} from "./inventory-command-tag.js";

/** Who can carry things in this game. */
/** Uses one of the ruleset's items for whoever carries the stack, outside a fight: what it does to
 *  them lands on their sheet, and the stacks come back spent. The server keeps the sheets, so it
 *  supplies this; without it an inventory tag cannot use anything. */
export type GameInventoryItemUser = (
  stacks: readonly GameInventoryStack[],
  stackId: string,
) =>
  | { ok: true; stacks: GameInventoryStack[]; journal: GameInventoryJournalEntry[]; line: string }
  | { ok: false; reason: string };

/** Why a market will not sell (#6917): no market in this ruleset, no place said, a level, item or seller
 *  it does not know, an item with no price or not sold at a place this size, or a seller who will not
 *  sell to this buyer. */
export type GameInventoryMarketRefusal =
  | "no-market"
  | "no-place"
  | "unknown-level"
  | "unknown-item"
  | "not-for-sale"
  | "not-here"
  | "no-seller"
  | "not-to-you";

/** What a buy costs at the place the party is in, worked out by the Engine; the server builds it from
 *  the ruleset's market, the place and the buyers' sheets. */
export interface GameInventoryMarket {
  quote(request: {
    item: string;
    count: number;
    level?: string;
    seller?: string;
    who?: string;
    /** The stacks as the reply's tags have left them so far, which a seller's `only` reads. */
    stacks: readonly GameInventoryStack[];
  }):
    | {
        ok: true;
        /** The item bought, and its name. */
        item: string;
        name: string;
        /** Bought and never carried: buying it only pays. */
        service: boolean;
        /** The coins of the family it is paid in, and how much, in the family's smallest coin. */
        family: readonly GameInventoryCoin[];
        owed: number;
        /** The price as said: "36 Shilling". */
        price: string;
        level: string;
        seller?: string;
      }
    | { ok: false; reason: GameInventoryMarketRefusal };
}

export interface GameInventoryParty {
  /** The player's own character's name, when it is known. */
  player?: string;
  /** Every other party member's name, as their card has it. */
  members: readonly string[];
}

/** The most tags one reply may carry before the rest are left unapplied. */
export const MAX_INVENTORY_TAGS = 40;

export type GameInventoryHolderLookup =
  | { ok: true; bag: GameInventoryBagRef | undefined }
  | { ok: false; reason: "unknown-character" | "ambiguous-character" };

/**
 * The bag a `who=` or `to=` names, matched the way a sheet command's `who` is: case, accents and
 * punctuation aside. The player's own name is the player's bag; `party`, or no name at all, names no
 * bag in particular (`bag` undefined). Somebody who has left the party but still holds something can
 * still be named.
 */
export function resolveGameInventoryHolder(
  name: string | undefined,
  party: GameInventoryParty,
  stacks: readonly GameInventoryStack[] = [],
): GameInventoryHolderLookup {
  const key = name ? normalizeCharacterLookupName(name) : "";
  if (!key || key === "party") return { ok: true, bag: undefined };
  if (party.player && normalizeCharacterLookupName(party.player) === key) return { ok: true, bag: {} };
  // Two members of one name are two people, so neither can be told apart from the other.
  const members = party.members.filter((member) => normalizeCharacterLookupName(member) === key);
  if (members.length > 1) return { ok: false, reason: "ambiguous-character" };
  if (members.length === 1) return { ok: true, bag: { holder: members[0]! } };
  const former = stacks.find((stack) => stack.holder && normalizeCharacterLookupName(stack.holder) === key)?.holder;
  return former ? { ok: true, bag: { holder: former } } : { ok: false, reason: "unknown-character" };
}

export interface GameInventoryTagsOutcome {
  content: string;
  stacks: GameInventoryStack[];
  journal: GameInventoryJournalEntry[];
  /** How many tags were found, answered or not. Zero means the reply changed nothing here. */
  tags: number;
}

/** What a payment handed over and got back, for the Game Master: "Paid with Crown ×1; Shilling ×2 back." */
function paymentNote(paid: GameInventoryPayment): string {
  const listed = (coins: GameInventoryPayment["paid"]) => {
    const each = coins.map((coin) => `${coin.name} ×${coin.count}`);
    return each.length > 1 ? `${each.slice(0, -1).join(", ")} and ${each.at(-1)}` : each.join("");
  };
  return `Paid with ${listed(paid.paid)}${paid.change.length ? `; ${listed(paid.change)} back` : ""}.`;
}

function outcomeOf(result: GameInventoryOpResult | undefined): InventoryTagOutcome {
  if (!result) return { ok: false, reason: "refused" };
  return result.ok
    ? { ok: true, count: result.count ?? 0, now: result.now ?? 0 }
    : { ok: false, reason: result.reason };
}

/**
 * Every tag in the reply, in order, each on the stacks the one before it left. A `result` the Game
 * Master wrote itself is ignored, as it is on a sheet command: it only ever asks, and the Engine
 * answers. The server runs this on the text a turn generated, never on a reply already saved.
 */
export function applyGameInventoryTags(
  content: string,
  stacks: GameInventoryStack[],
  party: GameInventoryParty,
  newId?: () => string,
  /** What the game's ruleset says about its items: a name that is one of them adds that item. */
  rules?: GameInventoryItemRules,
  /** Uses one of the ruleset's items, for `action="use"`. */
  useItem?: GameInventoryItemUser,
  /** Rolls one of the ruleset's loot tables, for `[loot:]`: what it dropped, or null for a table the
   *  ruleset does not have. Without it a loot tag is refused. */
  loot?: (table: string) => ReadonlyArray<{ item: string; name: string; count: number }> | null,
  /** The place the party is in and what it sells, for `action="buy"` (#6917). Without it a buy is
   *  refused. */
  market?: GameInventoryMarket,
): GameInventoryTagsOutcome {
  let current = stacks;
  const journal: GameInventoryJournalEntry[] = [];
  let tags = 0;

  const apply = (ops: GameInventoryOp[]): GameInventoryOpResult[] => {
    const outcome = applyGameInventoryOps(current, ops, newId, rules);
    current = outcome.stacks;
    journal.push(...outcome.journal);
    return outcome.results;
  };

  /** An add into the bag named (`named` as the Game Master wrote it, `bag` as it was found), or with
   *  nobody named into the shared view, which a ruleset that says what everyone carries fills by who can
   *  carry it, the player first. Answered as one resolved add per bag it went into, saying whose when
   *  nobody was named (the player's says nobody), and one for what nobody could carry; the first carries
   *  what was changed. */
  const addAnswered = (
    item: string,
    ref: { item?: string },
    count: number,
    named: string | undefined,
    bag: GameInventoryBagRef | undefined,
    note?: string,
    action: "add" | "earn" = "add",
  ): string => {
    const [result] = apply([
      bag
        ? { op: "add", name: item, ...ref, count, holder: bag.holder, log: true }
        : { op: "add", name: item, ...ref, count, among: ["", ...party.members], log: true },
    ]);
    const shown = { action, item, count, ...(named ? { who: named } : {}) };
    if (!result?.ok) return serializeInventoryTag(shown, outcomeOf(result), note);
    const answers = result.placed
      ? result.placed.map((share, index) =>
          serializeInventoryTag(
            { action, item, count: share.count, ...(share.holder ? { who: share.holder } : {}) },
            { ok: true, count: share.count, now: share.now },
            index === 0 ? note : undefined,
          ),
        )
      : [serializeInventoryTag(shown, outcomeOf(result), note)];
    if (result.left) {
      answers.push(
        serializeInventoryTag(
          { action, item, count: result.left, ...(named ? { who: named } : {}) },
          { ok: false, reason: "too-heavy" },
        ),
      );
    }
    return answers.join(" ");
  };

  /** Putting on, taking off, binding or unbinding up to `count` of the item a name finds in one bag,
   *  one at a time, each on a stack not already so. `now` is how many of it that bag has so after. */
  const wearNamed = (
    wear: "equip" | "unequip" | "bind" | "unbind",
    item: string,
    count: number,
    bag: GameInventoryBagRef,
  ): InventoryTagOutcome => {
    const flag = wear === "equip" || wear === "unequip" ? "equipped" : "bound";
    const on = wear === "equip" || wear === "bind";
    const items = gameInventoryItemsNamed(current, item, bag);
    const mine = (stack: GameInventoryStack) =>
      items.has(gameInventoryItemId(stack)) && gameInventoryBagKey(stack.holder) === gameInventoryBagKey(bag.holder);
    if (!current.some(mine)) return { ok: false, reason: "none-held" };
    // What goes together is kept together: putting on prefers the item already bound, binding the
    // one already worn; taking off and unbinding leave the other state alone where they can.
    const other = flag === "equipped" ? "bound" : "equipped";
    const rank = (stack: GameInventoryStack) => (Boolean(stack[other]) === on ? 0 : 1);
    let done = 0;
    while (done < count) {
      const stack = current
        .filter((each) => mine(each) && Boolean(each[flag]) !== on)
        .sort((a, b) => rank(a) - rank(b))[0];
      if (!stack) break;
      const worn = wearGameInventoryStack(current, stack.id, wear, newId, rules);
      if (!worn) break;
      if ("refused" in worn) {
        if (done === 0) return { ok: false, reason: worn.refused };
        break;
      }
      current = worn.stacks;
      done += 1;
    }
    const now = current.reduce((total, stack) => total + (mine(stack) && stack[flag] ? stack.quantity : 0), 0);
    return { ok: true, count: done, now };
  };

  const next = content.replace(createInventoryTagRegex(), (_whole, body: string) => {
    tags += 1;
    // Past the cap a tag is answered as refused rather than left as written, so a result the Game
    // Master wrote itself can never read as something that happened.
    if (tags > MAX_INVENTORY_TAGS) return refuseTagBody(body, "too-many");
    const request = parseInventoryTagBody(body);
    if (!request) return serializeInventoryTag({ raw: body.trim() }, { ok: false, reason: "unreadable" });

    const who = resolveGameInventoryHolder(request.who, party, current);
    const to = request.action === "give" ? resolveGameInventoryHolder(request.to, party, current) : null;
    return request.items
      .map((item) => {
        const shown = {
          action: request.action,
          item,
          count: request.count,
          ...(request.who ? { who: request.who } : {}),
          ...(request.to ? { to: request.to } : {}),
        };
        if (!who.ok) return serializeInventoryTag(shown, { ok: false, reason: who.reason });
        if (request.action === "add") {
          // A proposal first makes the item of the ruleset it describes, or finds the one of that name
          // already made, and the answer says what the Engine changed. Without a ruleset to invent in,
          // its parts are ignored and the name is added as it always was.
          const invented =
            request.proposal && rules?.invent ? rules.invent({ name: item, ...request.proposal }, current) : undefined;
          if (invented && "refused" in invented) {
            return serializeInventoryTag(shown, { ok: false, reason: invented.refused });
          }
          const note = invented?.notes.join(" ") || undefined;
          const ref = invented ? { item: invented.item } : {};
          return addAnswered(item, ref, request.count, request.who, who.bag, note);
        }
        if (
          request.action === "equip" ||
          request.action === "unequip" ||
          request.action === "bind" ||
          request.action === "unbind"
        ) {
          return serializeInventoryTag(shown, wearNamed(request.action, item, request.count, who.bag ?? {}));
        }
        if (request.action === "use") {
          if (!useItem) return serializeInventoryTag(shown, { ok: false, reason: "cannot-use" });
          // Each use on a stack of the item in who's own bag that can be used, the first such first.
          const items = gameInventoryItemsNamed(current, item, who.bag ?? {});
          const mine = (stack: GameInventoryStack) =>
            items.has(gameInventoryItemId(stack)) &&
            gameInventoryBagKey(stack.holder) === gameInventoryBagKey(who.bag?.holder);
          if (!current.some(mine)) return serializeInventoryTag(shown, { ok: false, reason: "none-held" });
          const lines: string[] = [];
          let refused: string | undefined;
          for (let done = 0; done < request.count; done++) {
            let used = false;
            for (const stack of current.filter(mine)) {
              const outcome = useItem(current, stack.id);
              if (!outcome.ok) {
                refused ??= outcome.reason;
                continue;
              }
              current = outcome.stacks;
              journal.push(...outcome.journal);
              lines.push(outcome.line);
              used = true;
              break;
            }
            if (!used) break;
          }
          if (lines.length === 0) return serializeInventoryTag(shown, { ok: false, reason: refused ?? "none-held" });
          return serializeInventoryTag(
            shown,
            { ok: true, count: lines.length, now: gameInventoryCountItems(current, items, who.bag ?? {}) },
            lines.join(" "),
          );
        }
        if (request.action === "pay" || request.action === "earn") {
          // Money is the ruleset's coins, a stack of each per bag. An earning is an add of that coin;
          // a payment comes out of one bag inside the coin's own family, with change.
          const named = rules?.coinNamed?.(item);
          if (!rules?.coinNamed) return serializeInventoryTag(shown, { ok: false, reason: "no-currencies" });
          if (!named) return serializeInventoryTag(shown, { ok: false, reason: "unknown-coin" });
          const coin = named.coin;
          if (request.action === "earn") {
            return addAnswered(coin.name, { item: coin.item }, request.count, request.who, who.bag, undefined, "earn");
          }
          const holder = who.bag?.holder;
          const paid = payGameInventoryCoins(current, holder, named.family, request.count * coin.value);
          const answered = { ...shown, item: coin.name };
          if (!paid.ok) return serializeInventoryTag(answered, { ok: false, reason: paid.reason });
          current = paid.stacks;
          // The journal says what was spent and what came back as change.
          journal.push(
            ...paid.paid.map((each) => ({ item: each.name, action: "used" as const, quantity: each.count })),
            ...paid.change.map((each) => ({ item: each.name, action: "acquired" as const, quantity: each.count })),
          );
          const now = current
            .filter(
              (stack) => stack.item === coin.item && gameInventoryBagKey(stack.holder) === gameInventoryBagKey(holder),
            )
            .reduce((sum, stack) => sum + stack.quantity, 0);
          const note = paymentNote(paid);
          return serializeInventoryTag(answered, { ok: true, count: request.count, now }, note);
        }
        if (request.action === "buy") {
          // The Engine prices it at the place the party is in, takes the price out of the buyer's
          // purse as a payment is, and puts the item in their bag; a service only pays. Either both
          // happen or neither does.
          if (!market) return serializeInventoryTag(shown, { ok: false, reason: "no-market" });
          const asked = {
            ...shown,
            ...(request.level ? { level: request.level } : {}),
            ...(request.seller ? { seller: request.seller } : {}),
          };
          const quote = market.quote({
            item,
            count: request.count,
            ...(request.level ? { level: request.level } : {}),
            ...(request.seller ? { seller: request.seller } : {}),
            ...(request.who ? { who: request.who } : {}),
            stacks: current,
          });
          if (!quote.ok) return serializeInventoryTag(asked, { ok: false, reason: quote.reason });
          const answered = {
            ...asked,
            item: quote.name,
            level: quote.level,
            ...(quote.seller ? { seller: quote.seller } : {}),
          };
          const holder = who.bag?.holder;
          const paid = payGameInventoryCoins(current, holder, quote.family, quote.owed);
          if (!paid.ok) return serializeInventoryTag(answered, { ok: false, reason: paid.reason });
          let after = paid.stacks;
          const bought: GameInventoryJournalEntry[] = [];
          let now = 0;
          if (!quote.service) {
            const added = applyGameInventoryOps(
              paid.stacks,
              [{ op: "add", name: quote.name, item: quote.item, count: request.count, holder, log: true }],
              newId,
              rules,
            );
            const [result] = added.results;
            if (!result?.ok) return serializeInventoryTag(answered, outcomeOf(result));
            // Paid for in full, so delivered in full: what does not fit leaves the whole buy undone.
            if ((result.left ?? 0) > 0) return serializeInventoryTag(answered, { ok: false, reason: "too-heavy" });
            after = added.stacks;
            bought.push(...added.journal);
            now = result.now ?? 0;
          }
          current = after;
          journal.push(
            ...paid.paid.map((each) => ({ item: each.name, action: "used" as const, quantity: each.count })),
            ...paid.change.map((each) => ({ item: each.name, action: "acquired" as const, quantity: each.count })),
            ...bought,
          );
          // Something free takes no coin at all.
          const note = paid.paid.length ? paymentNote(paid) : undefined;
          return serializeInventoryTag(
            { ...answered, price: quote.price },
            { ok: true, count: request.count, now },
            note,
          );
        }
        if (request.action === "remove") {
          const [result] = apply([
            { op: "take", name: item, count: request.count, ...(who.bag ? { from: who.bag } : {}), as: "lost" },
          ]);
          return serializeInventoryTag(shown, outcomeOf(result));
        }
        // A give names who receives it, and a receiver nobody can find leaves the item where it is.
        // It comes out of who's own bag, the player's when who is left out: never out of somebody
        // the Game Master did not name.
        if (!to || !to.ok)
          return serializeInventoryTag(shown, { ok: false, reason: to && !to.ok ? to.reason : "no-recipient" });
        if (!to.bag) return serializeInventoryTag(shown, { ok: false, reason: "no-recipient" });
        // Nobody is handed more than they can carry: weighed by what would really move, which is no
        // more than the giver holds.
        const from = who.bag ?? {};
        const named = gameInventoryItemsNamed(current, item, from);
        const first = current.find(
          (stack) =>
            named.has(gameInventoryItemId(stack)) &&
            gameInventoryBagKey(stack.holder) === gameInventoryBagKey(from.holder),
        );
        const moving = Math.min(request.count, gameInventoryCountItems(current, named, from));
        const heavy = first && gameInventoryGiveRefusal(current, first, to.bag.holder, moving, rules);
        if (heavy) return serializeInventoryTag(shown, { ok: false, reason: heavy });
        // Stack by stack, so the item stays the same item and a nickname stays on its stack.
        // The items it names are settled first, and counted by item in the receiver's bag, where the
        // name may be a nickname nothing there carries.
        const items = gameInventoryItemsNamed(current, item, who.bag ?? {});
        const handed = giveFromGameInventoryNamed(
          current,
          item,
          request.count,
          who.bag ?? {},
          to.bag.holder,
          newId,
          rules,
        );
        if (handed.given === 0) return serializeInventoryTag(shown, { ok: false, reason: "none-held" });
        current = handed.stacks;
        return serializeInventoryTag(shown, {
          ok: true,
          count: handed.given,
          now: gameInventoryCountItems(current, items, to.bag),
        });
      })
      .join(" ");
  });

  // Then each loot tag, on the stacks the inventory tags left: what it dropped is answered as the
  // inventory's own resolved adds, so the screen announces it and the Game Master reads it back as it
  // reads any add; a tag that dropped nothing, or was refused, keeps its own place.
  const looted = next.replace(createLootTagRegex(), (_whole, body: string) => {
    tags += 1;
    if (tags > MAX_INVENTORY_TAGS) return serializeLootTag({ raw: body.trim() }, "too-many");
    const request = parseLootTagBody(body);
    if (!request) return serializeLootTag({ raw: body.trim() }, "unreadable");
    if (!loot) return serializeLootTag(request, "no-loot-tables");
    const who = resolveGameInventoryHolder(request.who, party, current);
    if (!who.ok) return serializeLootTag(request, who.reason);
    const drops = loot(request.table);
    if (!drops) return serializeLootTag(request, "unknown-loot-table");
    if (drops.length === 0) return serializeLootTag(request);
    return drops.map((drop) => addAnswered(drop.name, { item: drop.item }, drop.count, request.who, who.bag)).join(" ");
  });
  return { content: looted, stacks: current, journal, tags };
}

/** One tag body answered as refused: one tag per item it names, or its sanitized text when it names
 *  none. */
function refuseTagBody(body: string, reason: string): string {
  const request = parseInventoryTagBody(body);
  if (!request) return serializeInventoryTag({ raw: body.trim() }, { ok: false, reason });
  return request.items
    .map((item) =>
      serializeInventoryTag(
        {
          action: request.action,
          item,
          count: request.count,
          ...(request.who ? { who: request.who } : {}),
          ...(request.to ? { to: request.to } : {}),
        },
        { ok: false, reason },
      ),
    )
    .join(" ");
}

/**
 * Every inventory tag in `content` answered as refused, for a reply whose tags the Engine could not
 * carry out at all. Whatever the tags said, they then say that nothing happened, which is true.
 */
export function refuseGameInventoryTags(content: string, reason: string): string {
  return content
    .replace(createInventoryTagRegex(), (_whole, body: string) => refuseTagBody(body, reason))
    .replace(createLootTagRegex(), (_whole, body: string) => {
      const request = parseLootTagBody(body);
      return serializeLootTag(request ?? { raw: body.trim() }, reason);
    });
}
