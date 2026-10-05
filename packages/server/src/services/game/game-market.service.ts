// Markets (#6917): the place a scene is in, and the market a Game Master's buys are answered at.
import {
  defaultRulesetSheetBuild,
  evaluateRulesetSheetLive,
  lastGamePlace,
  normalizeCharacterLookupName,
  resolveRulesetValueRef,
  rulesetMarketPlace,
  rulesetMarketQuoter,
  rulesetSheetItems,
  type GameInventoryMarket,
  type GameInventoryStack,
  type GamePlace,
  type RulesetItemBook,
  type RulesetLiveStates,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { parseExtra } from "../generation/prompt-attachments.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import type { ResolvedGameRuleset } from "./ruleset-registry.service.js";
import { gameRulesetLayerOptions } from "./game-inventory.service.js";
import { loadGameRulesetSheetContext } from "./ruleset-sheet-turn.service.js";

/**
 * The place the chat's scene is in before a reply: the last place tag the Engine answered in the
 * messages as the player sees them (each its active swipe), from the latest conversation start on, as
 * the Game Master's own context is scoped. A regeneration reads only what came before the telling it
 * replaces. Null when none was said.
 */
export async function gamePlaceBefore(db: DB, chatId: string, replacing?: string | null): Promise<GamePlace | null> {
  const messages = await createChatsStorage(db).listMessages(chatId);
  const end = replacing ? messages.findIndex((message) => message.id === replacing) : -1;
  const before = end >= 0 ? messages.slice(0, end) : messages;
  let start = 0;
  for (let index = before.length - 1; index >= 0; index--) {
    if (parseExtra(before[index]!.extra).isConversationStart === true) {
      start = index;
      break;
    }
  }
  return lastGamePlace(
    // Only the Game Master's own replies: a place tag a player types is never answered.
    before
      .slice(start)
      .flatMap((message) =>
        message.role === "assistant" && typeof message.content === "string" ? [message.content] : [],
      ),
  );
}

/**
 * The market a Game Master's buys are answered at, for a game whose ruleset declares one: the place in
 * force, the ruleset's prices and sellers, and each buyer's sheet for a seller's `only`, read as an
 * item's check is (the player's card for no name or the player's own, a member's own card by name, and
 * a blank sheet for someone with none), with what they carry at that tag and `live`, the turn's own live state (the
 * one its items are used with, never a replaced telling's). Undefined for a ruleset without a market.
 */
export async function loadGameMarket(
  db: DB,
  chatId: string,
  resolved: ResolvedGameRuleset | null | undefined,
  book: RulesetItemBook,
  place: GamePlace | null,
  live: RulesetLiveStates | null | undefined,
): Promise<GameInventoryMarket | undefined> {
  if (resolved?.status !== "ok" || !resolved.definition.items?.market) return undefined;
  const { definition } = resolved;
  const market = resolved.definition.items.market;
  const context = await loadGameRulesetSheetContext(db, chatId, resolved);
  const same = (a: string, b: string) => normalizeCharacterLookupName(a) === normalizeCharacterLookupName(b);
  const cards = context?.cards ?? [];
  const player =
    (context?.playerName ? cards.find((card) => same(card.name, context.playerName!)) : undefined) ?? cards[0];
  const meets = (
    only: { value: Parameters<typeof resolveRulesetValueRef>[2]; atLeast: number },
    who: string | undefined,
    stacks: readonly GameInventoryStack[],
  ) => {
    const own = who ? cards.find((card) => same(card.name, who)) : undefined;
    const isPlayer = who ? (own ? own === player : !!context?.playerName && same(who, context.playerName)) : true;
    const card = own ?? (isPlayer ? player : undefined);
    const name = card?.name ?? who ?? "";
    const build = card?.build ?? defaultRulesetSheetBuild(definition);
    const held = rulesetSheetItems({ itemOf: book.itemOf }, stacks, isPlayer ? undefined : name);
    const evaluated = evaluateRulesetSheetLive(definition, build, live?.[normalizeCharacterLookupName(name)], held);
    return resolveRulesetValueRef(definition, build, only.value, evaluated) >= only.atLeast;
  };
  const at = place?.size ? (rulesetMarketPlace(market, place.size) ?? null) : null;
  return rulesetMarketQuoter(definition, book, at, meets, gameRulesetLayerOptions(resolved));
}
