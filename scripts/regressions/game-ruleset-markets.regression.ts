/**
 * Markets (#6917, Capability API 1.65).
 *
 *   - `items.market`: price levels on an item's cost, place sizes, where things are sold, and kinds of
 *     seller (with who they sell `only` to); an item's own `sold` place, and a `service`, bought and
 *     never carried. Checked at import, gated at 1.65.
 *   - The Game Master's `[place:]`, answered in place; the place in force is the last one answered.
 *   - The Game Master's `[inventory: action="buy"]`: priced at the place, paid out of the buyer's purse
 *     with change and put in their bag (a service only pays), or refused and nothing changes.
 *   - The Game Master's MARKET block and instructions, only where the ruleset has a market.
 *   - The server's place before a reply, and a seller's `only` read off the buyer's own sheet.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyGameInventoryOps,
  applyGameInventoryTags,
  applyGamePlaceTags,
  defaultRulesetSheetBuild,
  lastGamePlace,
  parseRulesetDefinition,
  readResolvedInventoryTags,
  rulesetItemBook,
  rulesetItemMatchesFilter,
  rulesetItemSoldRank,
  rulesetMarketLevel,
  rulesetMarketPlace,
  rulesetMarketPrice,
  rulesetMarketPromptText,
  rulesetMarketQuoter,
  rulesetMarketSellersAt,
  type GameInventoryStack,
  type RulesetCatalogEntry,
  type RulesetDefinition,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-markets-"));
process.env.DATA_DIR = dataDir;
process.env.MARINARA_DATA_DIR = dataDir;
process.env.DATABASE_URL = `file:${join(dataDir, "marinara-engine.db")}`;

const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");
const { buildGmFormatReminder } = await import("../../packages/server/src/services/game/gm-prompts.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { gamePlaceBefore, loadGameMarket } =
  await import("../../packages/server/src/services/game/game-market.service.js");

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const gravewatchText = read("../../docs/examples/rulesets/gravewatch.json");
const emberText = read("../../docs/examples/rulesets/ember-roads.json");
const variant = (text: string, edit: (doc: Record<string, any>) => void = () => {}): Record<string, any> => {
  const doc = JSON.parse(text) as Record<string, any>;
  edit(doc);
  return doc;
};
const parsedOrThrow = (document: unknown, what: string): RulesetDefinition => {
  const parsed = parseRulesetDefinition(document);
  assert.ok(parsed.ok, `${what} must import cleanly: ${parsed.ok ? "" : parsed.issues.join("; ")}`);
  return parsed.definition;
};
const refused = (edit: (doc: Record<string, any>) => void, pattern: RegExp, what: string) => {
  const parsed = parseRulesetDefinition(variant(gravewatchText, edit));
  assert.equal(parsed.ok, false, `${what}: the file should be refused`);
  if (parsed.ok) return;
  assert.ok(
    parsed.issues.some((issue) => pattern.test(issue)),
    `${what}: expected ${pattern}, got ${parsed.issues.join("; ")}`,
  );
};
const entriesOf = (definition: RulesetDefinition): Record<string, RulesetCatalogEntry[]> =>
  Object.fromEntries(
    (definition.catalogs ?? []).flatMap((catalog) =>
      catalog.entries && catalog.holds !== "rows" ? [[catalog.id, catalog.entries]] : [],
    ),
  );
const coins = (entries: Array<[name: string, unit: string, quantity: number, holder?: string]>): GameInventoryStack[] =>
  entries.map(([name, unit, quantity, holder], index) => ({
    id: `c${index}`,
    name,
    item: `coin:${unit}`,
    quantity,
    ...(holder ? { holder } : {}),
  }));
const held = (stacks: readonly GameInventoryStack[]) =>
  stacks.map((stack) => [stack.name, stack.quantity, stack.holder ?? ""]);

const gravewatch = parsedOrThrow(JSON.parse(gravewatchText), "Gravewatch");
const book = rulesetItemBook(gravewatch, entriesOf(gravewatch));
const market = gravewatch.items!.market!;
const night = { "layer.long_night": true };

// ── Import ──
{
  assert.deepEqual(
    market.places.map((place) => place.id),
    ["hamlet", "village", "town", "city"],
  );
  assert.equal(book.itemOf("kit/watch-house-bed")?.entry.item?.service, true, "the bed is a service");
  const at = (path: string[], value: unknown) => (doc: Record<string, any>) => {
    let node = doc.items.market;
    for (const key of path.slice(0, -1)) node = node[key];
    node[path.at(-1)!] = value;
  };
  refused(at(["prices"], []), /items\.market\.prices: Array must contain at least 1/, "no price levels");
  refused(
    at(
      ["prices"],
      [
        { id: "fair", label: "fair", times: 1 },
        { id: "dear", label: "dear", times: 2 },
      ],
    ),
    /One price level is the default/,
    "no default level",
  );
  refused(
    at(
      ["prices"],
      [
        { id: "fair", label: "fair", times: 1, default: true },
        { id: "dear", label: "dear", times: 2, default: true },
      ],
    ),
    /One price level is the default/,
    "two defaults",
  );
  refused(
    at(["prices", "0", "times"], 0),
    /items\.market\.prices\.0\.times: Number must be greater than 0/,
    "a level of nothing",
  );
  refused(at(["places"], []), /items\.market\.places: Array must contain at least 1/, "no places");
  refused(at(["places", "1", "id"], "hamlet"), /market\.places\.1\.id: Duplicate place id "hamlet"/, "a place twice");
  refused(at(["sold", "0", "place"], "metropolis"), /sold\.0\.place: Unknown place "metropolis"/, "a rule's place");
  refused(at(["sold", "0", "filter"], { rarity: "mythic" }), /sold\.0\.filter\.rarity: Unknown item rarity/, "a word");
  refused(at(["sold", "0", "filter"], {}), /sold\.0\.filter: A filter names a rarity, a category or a tag/, "a filter");
  refused(
    at(["sellers", "0", "place"], "metropolis"),
    /sellers\.0\.place: Unknown place "metropolis"/,
    "a seller's place",
  );
  refused(
    at(["sellers", "0", "sells"], [{ category: "wand" }]),
    /sellers\.0\.sells\.0\.category: Unknown item category "wand"/,
    "what a seller sells",
  );
  refused(
    at(["sellers", "2", "only", "value"], { abilityScore: "luck" }),
    /sellers\.2\.only\.value/,
    "who a seller sells to",
  );
  refused(
    at(["sellers", "1", "id"], "chandler"),
    /market\.sellers\.1\.id: Duplicate seller id "chandler"/,
    "a seller twice",
  );
  const item = (id: string, edit: (item: Record<string, any>) => void) => (doc: Record<string, any>) =>
    edit(
      doc.catalogs
        .find((catalog: { id: string }) => catalog.id === "kit")
        .entries.find((entry: { id: string }) => entry.id === id).item,
    );
  refused(
    item("watch-pistol", (it) => (it.sold = { place: "capital" })),
    /sold\.place: Unknown place "capital"/,
    "an item's place",
  );
  refused(
    (doc) => {
      delete doc.items.market;
    },
    /This ruleset declares no market, so nothing is sold anywhere/,
    "an item's place without a market",
  );
  refused(
    item("watch-house-bed", (it) => delete it.cost),
    /A service is bought, so it has a cost/,
    "a free service",
  );
  refused(
    item("watch-house-bed", (it) => (it.slots = { body: 1 })),
    /A service is never carried, so it has no slots/,
    "a service worn",
  );
  refused(
    item("watch-house-bed", (it) => (it.use = { kind: "heal", targets: "self", amount: { flat: 1 }, consumes: true })),
    /A service is never carried, so it has no use/,
    "a service used",
  );
}

// ── Places, levels, where things are sold, sellers ──
{
  assert.deepEqual(rulesetMarketPlace(market, "Market Town"), { id: "town", label: "market town", rank: 2 });
  assert.deepEqual(rulesetMarketPlace(market, "town"), { id: "town", label: "market town", rank: 2 }, "by id");
  assert.equal(rulesetMarketPlace(market, "metropolis"), undefined);
  assert.equal(rulesetMarketLevel(market)?.id, "fair", "the default level");
  assert.equal(rulesetMarketLevel(market, "DEAR")?.times, 1.5);
  assert.equal(rulesetMarketLevel(market, "bargain"), undefined);
  const item = (id: string) => book.itemOf(id)!.entry.item!;
  assert.equal(rulesetItemMatchesFilter(item("kit/silver-nail"), { tag: "silver" }), true, "a tag it has");
  assert.equal(rulesetItemMatchesFilter(item("kit/grave-spade"), { tag: "silver" }), false, "a tag it has not");
  assert.equal(
    rulesetItemMatchesFilter(item("kit/silver-nail"), { tag: "silver", category: "coat" }),
    false,
    "every word",
  );
  assert.equal(rulesetItemSoldRank(market, item("kit/lantern-coat")), 0, "sold anywhere");
  assert.equal(rulesetItemSoldRank(market, item("kit/grave-spade")), 1, "arms from a village");
  assert.equal(rulesetItemSoldRank(market, item("kit/silver-nail")), 2, "rare arms from a market town: first rule");
  assert.equal(rulesetItemSoldRank(market, item("kit/watch-pistol")), 3, "the item's own place wins");
  assert.deepEqual(
    rulesetMarketSellersAt(market, 0).map((seller) => seller.id),
    ["chandler"],
  );
  assert.deepEqual(
    rulesetMarketSellersAt(market, 2).map((seller) => seller.id),
    ["chandler", "smith", "chapel"],
  );
}

// ── Prices ──
{
  const coat = book.itemOf("kit/lantern-coat")!.entry.item!.cost!;
  assert.deepEqual(rulesetMarketPrice(gravewatch, coat, 1.5, 1)?.said, "12 shillings", "8 shillings, dear");
  assert.deepEqual(rulesetMarketPrice(gravewatch, coat, 0.75, 1)?.said, "6 shillings");
  assert.equal(rulesetMarketPrice(gravewatch, coat, 1, 2)?.owed, 192, "two coats in pennies");
  assert.equal(rulesetMarketPrice(gravewatch, coat, 1, 10)?.said, "16 crowns", "the largest coin that pays it");
  const tonic = book.itemOf("kit/warming-tonic")!.entry.item!.cost!;
  assert.equal(rulesetMarketPrice(gravewatch, tonic, 0.75, 1)?.owed, 3, "4 pennies cheap");
  assert.equal(rulesetMarketPrice(gravewatch, { amount: 1, unit: "penny" }, 0.3, 1)?.owed, 1, "never below one");
  assert.equal(rulesetMarketPrice(gravewatch, { amount: 0, unit: "penny" }, 1.5, 1)?.owed, 0, "free stays free");
  assert.equal(rulesetMarketPrice(gravewatch, { amount: 5, unit: "penny" }, 1.5, 1)?.owed, 8, "7.5 rounds up");
  const pistol = book.itemOf("kit/watch-pistol")!.entry.item!.cost!;
  assert.equal(rulesetMarketPrice(gravewatch, pistol, 1, 1)?.said, "3 crowns");
  assert.equal(
    rulesetMarketPrice(gravewatch, pistol, 1, 1, night)?.said,
    "15 shillings",
    "a layer that takes crowns out says the price in shillings",
  );
}

// ── Buying ──
const town = rulesetMarketPlace(market, "town")!;
const hamlet = rulesetMarketPlace(market, "hamlet")!;
const steady = (who: string | undefined) => who !== "Bram";
const quoter = (place = town, meets = steady) =>
  rulesetMarketQuoter(gravewatch, book, place, (_only, who) => meets(who));
const party = { members: ["Bram"] };
const buy = (tag: string, stacks: GameInventoryStack[], market = quoter()) =>
  applyGameInventoryTags(tag, stacks, party, undefined, book, undefined, undefined, market);
{
  // A dear coat (12 shillings, 144 pennies) out of three crowns: two go first, the third is broken,
  // and 3 shillings come back.
  const bought = buy(
    '[inventory: action="buy" item="Lantern-keeper\'s coat" level="dear"]',
    coins([["crowns", "crown", 3]]),
  );
  const [answer] = readResolvedInventoryTags(bought.content);
  assert.equal(answer?.ok, true, bought.content);
  assert.equal(answer?.price, "12 shillings");
  assert.match(bought.content, /level="dear" seller="chandler" result="ok" now="1" price="12 shillings"/);
  assert.match(bought.content, /note="Paid with crowns ×3; shillings ×3 back\."/);
  assert.deepEqual(held(bought.stacks), [
    ["shillings", 3, ""],
    ["Lantern-keeper's coat", 1, ""],
  ]);
  assert.deepEqual(bought.journal, [
    { item: "crowns", action: "used", quantity: 3 },
    { item: "shillings", action: "acquired", quantity: 3 },
    { item: "Lantern-keeper's coat", action: "acquired", quantity: 1 },
  ]);
  // A service only pays.
  const bed = buy('[inventory: action="buy" item="A bed at the watch-house"]', coins([["shillings", "shilling", 1]]));
  assert.match(bed.content, /result="ok" now="0" price="6 pennies"/);
  assert.deepEqual(held(bed.stacks), [["pennies", 6, ""]], "change, and no bed in the bag");
  // Out of a member's own purse, into their own bag, counted.
  const bram = buy(
    '[inventory: action="buy" item="Warming tonic" count="3" who="Bram"]',
    coins([
      ["shillings", "shilling", 1, "Bram"],
      ["shillings", "shilling", 5],
    ]),
  );
  assert.match(
    bram.content,
    /count="3" who="Bram" level="fair" seller="chandler" result="ok" now="3" price="1 shillings"/,
  );
  assert.deepEqual(held(bram.stacks), [
    ["shillings", 5, ""],
    ["Warming tonic", 3, "Bram"],
  ]);
  // Refusals change nothing.
  const refusedWith = (tag: string, reason: string, stacks = coins([["crowns", "crown", 9]]), at = quoter()) => {
    const answered = buy(tag, stacks, at);
    assert.match(answered.content, new RegExp(`result="refused" reason="${reason}"`), `${tag}: ${answered.content}`);
    assert.deepEqual(answered.stacks, stacks, `${tag} changes nothing`);
    assert.deepEqual(answered.journal, []);
  };
  refusedWith('[inventory: action="buy" item="Watch pistol"]', "not-here");
  refusedWith('[inventory: action="buy" item="Grave spade"]', "not-here", undefined, quoter(hamlet));
  refusedWith('[inventory: action="buy" item="Grave spade" seller="chandler"]', "no-seller");
  refusedWith('[inventory: action="buy" item="Grave spade" seller="fence"]', "no-seller");
  refusedWith('[inventory: action="buy" item="Page of the vigil litany" who="Bram"]', "not-to-you");
  refusedWith('[inventory: action="buy" item="Lantern-keeper\'s coat" level="bargain"]', "unknown-level");
  refusedWith('[inventory: action="buy" item="Golden spade"]', "unknown-item");
  refusedWith('[inventory: action="buy" item="Dawn bell"]', "not-for-sale");
  refusedWith('[inventory: action="buy" item="crowns"]', "unknown-item");
  refusedWith(
    '[inventory: action="buy" item="Lantern-keeper\'s coat"]',
    "cannot-afford",
    coins([["pennies", "penny", 5]]),
  );
  refusedWith(
    '[inventory: action="buy" item="Lantern-keeper\'s coat"]',
    "no-place",
    undefined,
    rulesetMarketQuoter(gravewatch, book, null, () => true),
  );
  // A game with no market refuses every buy.
  const noMarket = applyGameInventoryTags(
    '[inventory: action="buy" item="Lantern-keeper\'s coat"]',
    coins([["crowns", "crown", 9]]),
    party,
    undefined,
    book,
  );
  assert.match(noMarket.content, /result="refused" reason="no-market"/);
  assert.deepEqual(noMarket.journal, []);
  // The chapel sells its pages to a warden who meets its `only`, and the page at a market town.
  assert.match(
    buy('[inventory: action="buy" item="Page of the vigil litany"]', coins([["crowns", "crown", 1]])).content,
    /seller="chapel of the Vigil" result="ok"/,
  );
  // A seller's `only` reads the stacks as the reply's earlier tags left them: a ring added first is
  // carried when the page is bought after it.
  const ringHolder = rulesetMarketQuoter(gravewatch, book, town, (_only, _who, stacks) =>
    stacks.some((stack) => stack.item === "kit/widows-ring"),
  );
  const purseOnly = coins([["crowns", "crown", 1]]);
  const ringThenPage = applyGameInventoryTags(
    '[inventory: action="add" item="Widow\'s ring"] [inventory: action="buy" item="Page of the vigil litany"]',
    purseOnly,
    party,
    undefined,
    book,
    undefined,
    undefined,
    ringHolder,
  );
  assert.match(ringThenPage.content, /item="Page of the vigil litany".*result="ok"/);
  const pageAlone = applyGameInventoryTags(
    '[inventory: action="buy" item="Page of the vigil litany"]',
    purseOnly,
    party,
    undefined,
    book,
    undefined,
    undefined,
    ringHolder,
  );
  assert.match(pageAlone.content, /result="refused" reason="not-to-you"/);
  // An item a layer hides is not sold, whoever asks.
  const hidden = applyGameInventoryTags(
    '[inventory: action="buy" item="Warming tonic"]',
    coins([["crowns", "crown", 1]]),
    party,
    undefined,
    book,
    undefined,
    undefined,
    rulesetMarketQuoter(gravewatch, { itemNamed: book.itemNamed, offers: () => false }, town, () => true),
  );
  assert.match(hidden.content, /result="refused" reason="unknown-item"/);
  // A coat nobody can carry is not bought at all: the price stays in the purse.
  const carrying = parsedOrThrow(
    variant(gravewatchText, (doc) => {
      doc.items.stats.push({ id: "weight", label: "Weight", type: "number", min: 0, max: 100, default: 0 });
      doc.items.carry = { stat: "weight", encumberedAbove: { const: 1 }, limit: { const: 2 } };
      doc.catalogs
        .find((catalog: { id: string }) => catalog.id === "kit")
        .entries.find((entry: { id: string }) => entry.id === "lantern-coat").item.stats.weight = 5;
    }),
    "Gravewatch that counts weight",
  );
  const carryingBook = rulesetItemBook(carrying, entriesOf(carrying), {
    sheets: { player: defaultRulesetSheetBuild(carrying) },
  });
  const purse = coins([["crowns", "crown", 2]]);
  const tooHeavy = applyGameInventoryTags(
    '[inventory: action="buy" item="Lantern-keeper\'s coat"]',
    purse,
    party,
    undefined,
    carryingBook,
    undefined,
    undefined,
    rulesetMarketQuoter(carrying, carryingBook, town, () => true),
  );
  assert.match(tooHeavy.content, /result="refused" reason="too-heavy"/);
  assert.deepEqual(tooHeavy.stacks, purse, "nothing paid");
  assert.deepEqual(tooHeavy.journal, []);
  // Two coats where only one fits: paid for in full or not at all, so not at all.
  const oneFits = parsedOrThrow(
    variant(gravewatchText, (doc) => {
      doc.items.stats.push({ id: "weight", label: "Weight", type: "number", min: 0, max: 100, default: 0 });
      doc.items.carry = { stat: "weight", encumberedAbove: { const: 1 }, limit: { const: 2 } };
      doc.catalogs
        .find((catalog: { id: string }) => catalog.id === "kit")
        .entries.find((entry: { id: string }) => entry.id === "lantern-coat").item.stats.weight = 2;
    }),
    "Gravewatch with a coat that weighs 2",
  );
  const oneFitsBook = rulesetItemBook(oneFits, entriesOf(oneFits), {
    sheets: { player: defaultRulesetSheetBuild(oneFits) },
  });
  const richer = coins([["crowns", "crown", 5]]);
  const twoCoats = applyGameInventoryTags(
    '[inventory: action="buy" item="Lantern-keeper\'s coat" count="2"]',
    richer,
    party,
    undefined,
    oneFitsBook,
    undefined,
    undefined,
    rulesetMarketQuoter(oneFits, oneFitsBook, town, () => true),
  );
  assert.match(twoCoats.content, /result="refused" reason="too-heavy"/);
  assert.deepEqual(twoCoats.stacks, richer, "nothing paid, nothing added");
  // A service is never carried, however it is added: the Game Master's add, the picker's.
  assert.deepEqual(
    applyGameInventoryOps(
      [],
      [{ op: "add", name: "A bed at the watch-house", item: "kit/watch-house-bed", count: 1 }],
      undefined,
      book,
    ).results,
    [{ ok: false, reason: "service" }],
  );
  const added = applyGameInventoryTags(
    '[inventory: action="add" item="A bed at the watch-house"]',
    [],
    party,
    undefined,
    book,
  );
  assert.match(added.content, /result="refused" reason="service"/);
  assert.deepEqual(added.stacks, []);
  // A layer that takes crowns out prices and pays in what is left.
  const nightBook = rulesetItemBook(gravewatch, entriesOf(gravewatch), { layerOptions: night });
  const paidAtNight = applyGameInventoryTags(
    '[inventory: action="buy" item="Watch pistol"]',
    coins([["shillings", "shilling", 20]]),
    party,
    undefined,
    nightBook,
    undefined,
    undefined,
    rulesetMarketQuoter(gravewatch, nightBook, rulesetMarketPlace(market, "city")!, () => true, night),
  );
  assert.match(paidAtNight.content, /result="ok" now="1" price="15 shillings"/);
}

// ── Places ──
{
  const sizeOf = (word: string) => rulesetMarketPlace(market, word);
  const placed = applyGamePlaceTags(
    'Road. [place: name="Barrow Road"] Then [place: name=Millbrook size="Market Town"] and [place: size="metropolis"]',
    sizeOf,
  );
  assert.equal(
    placed.content,
    'Road. [place: name="Barrow Road" result="ok"] Then [place: name="Millbrook" size="town" result="ok"] and [place: size="metropolis" result="refused" reason="unknown-size"]',
  );
  assert.deepEqual(placed.place, { name: "Millbrook", size: "town" }, "a refused one changes nothing");
  assert.deepEqual(applyGamePlaceTags("[place: ]", sizeOf).content, '[place: result="refused" reason="unreadable"]');
  assert.equal(applyGamePlaceTags("No place here.", sizeOf).place, undefined);
  assert.deepEqual(lastGamePlace(['[place: name="A" size="hamlet" result="ok"]', placed.content, "Later."]), {
    name: "Millbrook",
    size: "town",
  });
  assert.equal(lastGamePlace(['[place: name="A" size="hamlet"]']), null, "only an answered tag counts");
  assert.deepEqual(lastGamePlace(['[place: name="Barrow Road" result="ok"]']), { name: "Barrow Road" }, "no market");
}

// ── The Game Master ──
{
  const text = rulesetMarketPromptText(gravewatch, book, { name: "Millbrook", size: "town" })!;
  const lines = text.split("\n");
  assert.equal(
    lines[0],
    "MARKET: Millbrook, a market town. Prices at fair, the default level (cheap ×0.75, fair ×1, dear ×1.5).",
  );
  assert.equal(
    lines[1],
    "- chandler: Shot and powder 1 pennies, Warming tonic 4 pennies, A bed at the watch-house 6 pennies (a service), Lantern-keeper's coat 8 shillings",
  );
  assert.equal(lines[2], "- smith: Grave spade 3 shillings, Silver coffin nail 2 crowns");
  assert.equal(
    lines[3],
    "- chapel of the Vigil (to wardens of Nerve 3 or more only): Page of the vigil litany 1 shillings",
  );
  assert.equal(lines.length, 4);
  assert.deepEqual(
    rulesetMarketPromptText(gravewatch, book, { name: "Crossroads", size: "hamlet" })!.split("\n").slice(1),
    [
      "- chandler: Shot and powder 1 pennies, Warming tonic 4 pennies, A bed at the watch-house 6 pennies (a service), Lantern-keeper's coat 8 shillings",
    ],
  );
  assert.equal(
    rulesetMarketPromptText(gravewatch, book, { name: "Barrow Road" }),
    "MARKET: Barrow Road has no market.",
  );
  assert.match(rulesetMarketPromptText(gravewatch, book, null)!, /no place said yet/);
  const ember = parsedOrThrow(JSON.parse(emberText), "Ember Roads");
  assert.equal(rulesetMarketPromptText(ember, book, { size: "town" }), undefined, "no market, no block");
  // A seller who needs a bigger place is not listed; with none here, the block says so.
  const smallOnly = parsedOrThrow(
    variant(
      gravewatchText,
      (doc) =>
        (doc.items.market.sellers = [{ id: "smith", label: "smith", sells: [{ category: "arm" }], place: "village" }]),
    ),
    "only a smith",
  );
  assert.deepEqual(
    rulesetMarketPromptText(smallOnly, rulesetItemBook(smallOnly, entriesOf(smallOnly)), { size: "hamlet" })!
      .split("\n")
      .slice(1),
    ["- No seller keeps shop in a place this size."],
  );
  // More than a dozen of one seller's wares: the cheapest dozen, and how many more.
  const crowded = parsedOrThrow(
    variant(gravewatchText, (doc) => {
      const kit = doc.catalogs.find((catalog: { id: string }) => catalog.id === "kit");
      for (let index = 0; index < 14; index++) {
        kit.entries.push({
          id: `tonic-${index}`,
          label: `Tonic ${index}`,
          item: { category: "tonic", cost: { amount: index + 10, unit: "penny" } },
        });
      }
    }),
    "a crowded chandler",
  );
  const crowdedLine = rulesetMarketPromptText(crowded, rulesetItemBook(crowded, entriesOf(crowded)), {
    size: "hamlet",
  })!.split("\n")[1]!;
  assert.match(crowdedLine, /, and 6 more$/);
  assert.equal(crowdedLine.split(", ").length - 1, 12, "twelve listed");

  const prompt = (definition: RulesetDefinition, market?: string) =>
    buildGmFormatReminder({ ruleset: definition, ...(market ? { market } : {}) } as Parameters<
      typeof buildGmFormatReminder
    >[0]);
  const taught = prompt(gravewatch, text);
  assert.match(
    taught,
    /\[place: name="Name" size="city"\] - whenever the scene moves to a new place, with its size, one of: hamlet, village, market town, city/,
  );
  assert.match(taught, /\[inventory: action="buy" item="Name" count="1" level="fair" seller="Seller" who="Name"\]/);
  assert.match(taught, /Levels: cheap ×0\.75, fair ×1 \(the default\), dear ×1\.5/);
  assert.match(taught, /Buying is a buy \(below\)/);
  assert.ok(taught.includes(text), "the block");
  const untaught = prompt(ember);
  assert.doesNotMatch(untaught, /\[place:|action="buy"|MARKET:/);
}

// ── Install gate: 1.65 ──
{
  const manifest = (minor: number) => ({
    schemaVersion: 2,
    capabilityApi: { major: 1, minor },
    builtAgainst: { engineVersion: "2.4.6", engineCommit: "0".repeat(40) },
    id: "ruleset-markets",
    name: "Markets",
    version: "0.1.0",
    description: "A packaged ruleset with a market.",
    engine: { min: "2.4.6", maxExclusive: "4.0.0" },
    kind: ["ruleset"],
    entrypoints: {},
    contributions: { assets: { paths: ["ruleset.json"] } },
    files: [{ path: "ruleset.json", sha256: "0".repeat(64), bytes: 10 }],
    permissions: [],
    restartRequired: false,
  });
  const gateIssue = /with a market, or whose items name where they are sold or are services.*capabilityApi 1\.65/;
  const issue = (minor: number, doc: Record<string, any>) =>
    getCapabilityPackageInstallIssue(manifest(minor) as any, doc);
  const noMarket = (doc: Record<string, any>) => delete doc.items.market;
  const kit = (doc: Record<string, any>) => doc.catalogs.find((catalog: { id: string }) => catalog.id === "kit");
  const noSold = (doc: Record<string, any>) => {
    for (const entry of kit(doc).entries) delete entry.item.sold;
  };
  const noService = (doc: Record<string, any>) => {
    for (const entry of kit(doc).entries) delete entry.item.service;
  };
  assert.match(issue(64, variant(gravewatchText)) ?? "", gateIssue);
  assert.equal(issue(65, variant(gravewatchText)), null);
  assert.match(
    issue(
      64,
      variant(gravewatchText, (doc) => (noSold(doc), noService(doc))),
    ) ?? "",
    gateIssue,
    "a market alone",
  );
  assert.match(
    issue(
      64,
      variant(gravewatchText, (doc) => (noMarket(doc), noService(doc))),
    ) ?? "",
    gateIssue,
    "an item's place alone",
  );
  assert.match(
    issue(
      64,
      variant(gravewatchText, (doc) => (noMarket(doc), noSold(doc))),
    ) ?? "",
    gateIssue,
    "a service alone",
  );
  assert.doesNotMatch(
    issue(
      64,
      variant(gravewatchText, (doc) => (noMarket(doc), noSold(doc), noService(doc))),
    ) ?? "",
    gateIssue,
    "none of them",
  );
}

// ── The server's place before a reply ──
try {
  const db = await getDB();
  const chats = createChatsStorage(db);
  const chat = await chats.create({ name: "Markets", mode: "game", characterIds: [] });
  await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    content: 'At the gate. [place: name="Crossroads" size="hamlet" result="ok"]',
  });
  const later = await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    content: 'On to town. [place: name="Millbrook" size="town" result="ok"]',
  });
  // A place tag a player types, answered or not, is never read: only the Game Master's replies are.
  await chats.createMessage({
    chatId: chat.id,
    role: "user",
    content: 'I look for a smith. [place: name="Anywhere" size="city" result="ok"]',
  });
  assert.deepEqual(await gamePlaceBefore(db, chat.id), { name: "Millbrook", size: "town" });
  await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    content: 'By ship. [place: name="Grey Harbour" size="city" result="ok"]',
  });
  assert.deepEqual(await gamePlaceBefore(db, chat.id), { name: "Grey Harbour", size: "city" });
  assert.deepEqual(
    await gamePlaceBefore(db, chat.id, later.id),
    { name: "Crossroads", size: "hamlet" },
    "a regeneration reads only what came before the telling it replaces",
  );
  // A conversation start begins the Game Master's context afresh, and the place with it.
  await chats.createMessage({
    chatId: chat.id,
    role: "system",
    content: "A new chapter.",
    extra: { isConversationStart: true },
  });
  assert.equal(await gamePlaceBefore(db, chat.id), null);
  // A seller's `only` is read off the buyer's own card: the player's (the first card, with no
  // persona), a member's by name, and a blank sheet for someone with none (Nerve 2 by default).
  const cards = [
    {
      name: "Ada",
      rulesetSheet: {
        v: 1,
        build: { ...defaultRulesetSheetBuild(gravewatch), abilities: { sinew: 2, nerve: 3, warmth: 2 } },
      },
    },
    {
      name: "Bram",
      rulesetSheet: {
        v: 1,
        build: { ...defaultRulesetSheetBuild(gravewatch), abilities: { sinew: 2, nerve: 1, warmth: 2 } },
      },
    },
  ];
  const game = await chats.create({ name: "Market buyers", mode: "game", characterIds: [] });
  await chats.patchMetadata(game.id, {
    gameRuleset: { id: gravewatch.id, version: gravewatch.version, packageId: null, options: {} },
    gameCharacterCards: cards,
  });
  const resolved = { status: "ok", definition: gravewatch, packageId: null, layers: [], ref: {} } as never;
  const buyers = (await loadGameMarket(db, game.id, resolved, book, { size: "town" }, {}))!;
  const page = (who?: string) =>
    buyers.quote({ item: "Page of the vigil litany", count: 1, ...(who ? { who } : {}), stacks: [] });
  assert.equal(page().ok, true, "the player (Ada, Nerve 3)");
  assert.equal(page("Ada").ok, true, "the player by name");
  assert.deepEqual(page("Bram"), { ok: false, reason: "not-to-you" }, "Bram, Nerve 1");
  assert.deepEqual(page("Cleo"), { ok: false, reason: "not-to-you" }, "a blank sheet, Nerve 2");
  assert.equal(
    await loadGameMarket(db, game.id, resolved, book, null, {}).then(
      (m) => m?.quote({ item: "Warming tonic", count: 1, stacks: [] }).ok,
    ),
    false,
  );
  // With a persona who has no card of their own name, the player is still the first card: named
  // by the persona, they buy with Ada's sheet.
  const wren = await createCharactersStorage(db).createPersona("Wren", "The player");
  await chats.update(game.id, { personaId: wren.id });
  const asPersona = (await loadGameMarket(db, game.id, resolved, book, { size: "town" }, {}))!;
  assert.equal(asPersona.quote({ item: "Page of the vigil litany", count: 1, who: "Wren", stacks: [] }).ok, true);
  // `only` reads the live state the turn hands it: a chapel that asks for Resolve left sells to Ada
  // with 3 and not with 1.
  const resolveChapel = parsedOrThrow(
    variant(gravewatchText, (doc) => {
      doc.items.market.sellers[2].only = {
        value: { livePool: "resolve" },
        atLeast: 2,
        label: "wardens with Resolve left",
      };
    }),
    "a chapel that asks for Resolve",
  );
  const resolveBook = rulesetItemBook(resolveChapel, entriesOf(resolveChapel));
  const resolvedChapel = { status: "ok", definition: resolveChapel, packageId: null, layers: [], ref: {} } as never;
  const withResolve = async (value: number) =>
    (await loadGameMarket(
      db,
      game.id,
      resolvedChapel,
      resolveBook,
      { size: "town" },
      {
        ada: { pools: { resolve: { value } } },
      },
    ))!.quote({ item: "Page of the vigil litany", count: 1, who: "Ada", stacks: [] });
  assert.equal((await withResolve(3)).ok, true);
  assert.deepEqual(await withResolve(1), { ok: false, reason: "not-to-you" });
} finally {
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}

console.info("game ruleset markets regressions passed.");
