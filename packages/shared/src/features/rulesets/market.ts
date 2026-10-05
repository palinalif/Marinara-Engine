/**
 * Markets (#6917, Capability API 1.65): what a place sells and at what price.
 *
 * A place is one of the market's sizes, smallest first. An item is sold at a place at least as big as
 * its own `sold` place, or else the place of the first `sold` rule it matches; an item nothing names is
 * sold anywhere. A seller is at a place at least as big as the seller's own place. A price is an item's
 * cost times a level, worked out in the smallest coin of the cost's family and rounded there, and said
 * in the largest coin the game's layers leave that pays it exactly.
 */
import type { RulesetCatalogItem, RulesetDefinition } from "../../schemas/ruleset.schema.js";
import {
  gameInventoryCoinRef,
  gameInventoryNameKey,
  type GameInventoryCoin,
  type GameInventoryStack,
} from "../../utils/game-inventory-stacks.js";
import type { GameInventoryMarket } from "../../utils/game-inventory-tags.js";
import type { RulesetItemBook } from "./item-book.js";
import { rulesetLayeredCurrencies, type RulesetLayerOptions } from "./layers.js";

export type RulesetMarket = NonNullable<NonNullable<RulesetDefinition["items"]>["market"]>;
export type RulesetMarketSeller = NonNullable<RulesetMarket["sellers"]>[number];
export type RulesetMarketLevel = RulesetMarket["prices"][number];
type ItemFilter = RulesetMarketSeller["sells"][number];

export interface RulesetMarketPlace {
  id: string;
  label: string;
  /** Its step on the ladder: 0 for the smallest place. */
  rank: number;
}

/** The place a word names: its id or its label, in any case. */
export function rulesetMarketPlace(market: RulesetMarket, word: string): RulesetMarketPlace | undefined {
  const key = gameInventoryNameKey(word);
  const rank = market.places.findIndex(
    (place) => gameInventoryNameKey(place.id) === key || gameInventoryNameKey(place.label) === key,
  );
  return rank < 0 ? undefined : { id: market.places[rank]!.id, label: market.places[rank]!.label, rank };
}

/** The level a word names (its id or label, in any case), or the default level for no word. */
export function rulesetMarketLevel(market: RulesetMarket, word?: string): RulesetMarketLevel | undefined {
  if (word === undefined || !word.trim()) return market.prices.find((level) => level.default);
  const key = gameInventoryNameKey(word);
  return market.prices.find(
    (level) => gameInventoryNameKey(level.id) === key || gameInventoryNameKey(level.label) === key,
  );
}

/** Whether an item has every word a filter names. */
export function rulesetItemMatchesFilter(item: RulesetCatalogItem, filter: ItemFilter): boolean {
  return (
    (filter.rarity === undefined || item.rarity === filter.rarity) &&
    (filter.category === undefined || item.category === filter.category) &&
    (filter.tag === undefined || !!item.tags?.includes(filter.tag))
  );
}

/** The rank of the smallest place that sells an item. */
export function rulesetItemSoldRank(market: RulesetMarket, item: RulesetCatalogItem): number {
  const place = item.sold?.place ?? market.sold?.find((rule) => rulesetItemMatchesFilter(item, rule.filter))?.place;
  return place === undefined
    ? 0
    : Math.max(
        0,
        market.places.findIndex((each) => each.id === place),
      );
}

/** The sellers at a place of this rank, in the ruleset's order. */
export function rulesetMarketSellersAt(market: RulesetMarket, rank: number): RulesetMarketSeller[] {
  return (market.sellers ?? []).filter(
    (seller) => seller.place === undefined || market.places.findIndex((place) => place.id === seller.place) <= rank,
  );
}

/** Whether a seller sells an item: one of its filters matches it. */
export function rulesetSellerSells(seller: RulesetMarketSeller, item: RulesetCatalogItem): boolean {
  return seller.sells.some((filter) => rulesetItemMatchesFilter(item, filter));
}

/**
 * What `count` of an item costs at a level: owed in the smallest coin of its cost's family (rounded
 * there, at least one where the cost is above nothing), the coins of that family the game's layers
 * leave, and the price said in the largest of them that pays it exactly. Undefined when the family's
 * coins are all gone.
 */
export function rulesetMarketPrice(
  definition: RulesetDefinition,
  cost: { amount: number; unit: string },
  times: number,
  count: number,
  layerOptions?: RulesetLayerOptions | null,
): { owed: number; family: GameInventoryCoin[]; said: string } | undefined {
  const full = definition.items?.currencies?.find((family) => family.units.some((unit) => unit.id === cost.unit));
  const unit = full?.units.find((each) => each.id === cost.unit);
  const left = full
    ? rulesetLayeredCurrencies(definition, layerOptions).find((each) => each.id === full.id)
    : undefined;
  if (!unit || !left || left.units.length === 0) return undefined;
  const worth = cost.amount * unit.value;
  const each = worth === 0 ? 0 : Math.max(1, Math.round(worth * times));
  const owed = each * count;
  const family = [...left.units]
    .sort((a, b) => b.value - a.value)
    .map((coin) => ({ item: gameInventoryCoinRef(coin.id), name: coin.label, value: coin.value }));
  // The family's smallest coin, worth 1, is always left, so some coin says the price exactly.
  const shown = family.find((coin) => owed % coin.value === 0) ?? family.at(-1)!;
  return { owed, family, said: `${owed / shown.value} ${shown.name}` };
}

/**
 * The Game Master's buys answered at a place (#6917): a market for `applyGameInventoryTags`. `place`
 * is the place in force for the reply, or null where none was said; `meets` says whether a buyer (the
 * player for no name), carrying what the stacks hold at that tag, passes a seller's `only`.
 */
export function rulesetMarketQuoter(
  definition: RulesetDefinition,
  book: Pick<RulesetItemBook, "itemNamed" | "offers">,
  place: RulesetMarketPlace | null,
  meets: (
    only: NonNullable<RulesetMarketSeller["only"]>,
    who: string | undefined,
    stacks: readonly GameInventoryStack[],
  ) => boolean,
  layerOptions?: RulesetLayerOptions | null,
): GameInventoryMarket {
  return {
    quote(request) {
      const market = definition.items?.market;
      if (!market) return { ok: false, reason: "no-market" };
      if (!place) return { ok: false, reason: "no-place" };
      const level = rulesetMarketLevel(market, request.level);
      if (!level) return { ok: false, reason: "unknown-level" };
      const found = book.itemNamed(request.item);
      const item = found?.entry.item;
      if (!found || !item || !book.offers(found.item)) return { ok: false, reason: "unknown-item" };
      if (!item.cost) return { ok: false, reason: "not-for-sale" };
      if (rulesetItemSoldRank(market, item) > place.rank) return { ok: false, reason: "not-here" };
      // A ruleset with no sellers sells from anybody; one with sellers sells only from the sellers
      // here that sell the item, the one named when the Game Master names one.
      let seller: RulesetMarketSeller | undefined;
      if (market.sellers?.length) {
        const here = rulesetMarketSellersAt(market, place.rank).filter((each) => rulesetSellerSells(each, item));
        const key = request.seller === undefined ? undefined : gameInventoryNameKey(request.seller);
        const asked =
          key === undefined
            ? here
            : here.filter((each) => gameInventoryNameKey(each.id) === key || gameInventoryNameKey(each.label) === key);
        if (asked.length === 0) return { ok: false, reason: "no-seller" };
        seller = asked.find((each) => !each.only || meets(each.only, request.who, request.stacks));
        if (!seller) return { ok: false, reason: "not-to-you" };
      }
      const price = rulesetMarketPrice(definition, item.cost, level.times, request.count, layerOptions);
      if (!price) return { ok: false, reason: "not-for-sale" };
      return {
        ok: true,
        item: found.item,
        name: found.name,
        service: item.service === true,
        family: price.family,
        owed: price.owed,
        price: price.said,
        level: level.label,
        ...(seller ? { seller: seller.label } : {}),
      };
    },
  };
}

/** The most items the Game Master's market block lists for one seller; the rest are bought by name. */
const MARKET_PROMPT_ITEMS = 12;

/**
 * The Game Master's market block for the place the scene is in (#6917): the place and its size, the
 * price levels, and each seller here with what they sell at the default level, cheapest first. Anything
 * a seller sells can be bought by name; the block lists a handful of each.
 */
export function rulesetMarketPromptText(
  definition: RulesetDefinition,
  book: Pick<RulesetItemBook, "entries">,
  place: { name?: string; size?: string } | null,
  layerOptions?: RulesetLayerOptions | null,
): string | undefined {
  const market = definition.items?.market;
  if (!market) return undefined;
  if (!place) return "MARKET: no place said yet. Say where the party is with [place:] before anyone buys.";
  const at = place.size ? rulesetMarketPlace(market, place.size) : undefined;
  const where = place.name ?? "Here";
  if (!at) return `MARKET: ${where} has no market.`;
  const fair = rulesetMarketLevel(market)!;
  const levels = market.prices.map((level) => `${level.label} ×${level.times}`).join(", ");
  const sold = book.entries.flatMap((entry) => {
    const item = entry.entry.item;
    if (!item?.cost || rulesetItemSoldRank(market, item) > at.rank) return [];
    const price = rulesetMarketPrice(definition, item.cost, fair.times, 1, layerOptions);
    return price ? [{ name: entry.name, item, price }] : [];
  });
  const line = (label: string, wares: typeof sold) => {
    const listed = [...wares]
      .sort((a, b) => a.price.owed - b.price.owed)
      .slice(0, MARKET_PROMPT_ITEMS)
      .map((ware) => `${ware.name} ${ware.price.said}${ware.item.service ? " (a service)" : ""}`);
    const more = wares.length - listed.length;
    return `- ${label}: ${listed.length ? listed.join(", ") : "nothing"}${more > 0 ? `, and ${more} more` : ""}`;
  };
  const here = market.sellers?.length ? rulesetMarketSellersAt(market, at.rank) : undefined;
  const sellers = here
    ? here.map((seller) =>
        line(
          `${seller.label}${seller.only ? ` (to ${seller.only.label} only)` : ""}`,
          sold.filter((ware) => rulesetSellerSells(seller, ware.item)),
        ),
      )
    : [line("Sold here", sold)];
  if (here?.length === 0) sellers.push("- No seller keeps shop in a place this size.");
  return [`MARKET: ${where}, a ${at.label}. Prices at ${fair.label}, the default level (${levels}).`, ...sellers].join(
    "\n",
  );
}
