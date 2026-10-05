// ──────────────────────────────────────────────
// Place tag — `[place: name="Millbrook" size="town"]` (#6917)
//
// The Game Master says which place a scene is in and how big it is, on the ladder of places the
// ruleset's market declares. The Engine answers each tag in place, as it does an inventory tag, so the
// size is always one of the ladder's own. The place in force is the last one answered: in the messages
// the player sees, and then in the reply. A place with no size has no market (the road, the wilds).
// ──────────────────────────────────────────────

import { readGmTagAttributes } from "./skill-check-tag.js";

/** Longest body a place tag can carry. */
const MAX_PLACE_TAG_BODY = 400;
/** Longest place name kept. */
const MAX_PLACE_NAME_LENGTH = 120;

/** The place a scene is in: its name, and its size by the ladder's id. */
export interface GamePlace {
  name?: string;
  size?: string;
}

/** A fresh global, case-insensitive matcher over `[place: ...]` tags. */
export function createPlaceTagRegex(): RegExp {
  return new RegExp(`\\[place:([^\\]]{0,${MAX_PLACE_TAG_BODY}})\\]`, "gi");
}

function clean(value: string | undefined): string | undefined {
  const cleaned = value
    ?.trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[\r\n"[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PLACE_NAME_LENGTH);
  return cleaned ? cleaned : undefined;
}

function readValues(body: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const attribute of readGmTagAttributes(body)) {
    const key = attribute.key.trim().toLowerCase();
    if (key && !values.has(key)) values.set(key, attribute.rawValue);
  }
  return values;
}

function serialize(place: GamePlace, answer: { result: "ok" } | { result: "refused"; reason: string }): string {
  const parts: string[] = [];
  if (place.name) parts.push(`name="${place.name}"`);
  if (place.size) parts.push(`size="${place.size}"`);
  parts.push(`result="${answer.result}"`);
  if (answer.result === "refused") parts.push(`reason="${answer.reason}"`);
  return `[place: ${parts.join(" ")}]`;
}

/**
 * Every place tag in a reply, answered in place: a size the ladder has becomes its id, a size it does
 * not have is refused (and changes nothing), and a tag naming neither a place nor a size is refused.
 * `place` is the last place the reply moved to, or undefined when it moved nowhere.
 */
export function applyGamePlaceTags(
  content: string,
  sizeOf: (word: string) => { id: string } | undefined,
): { content: string; place?: GamePlace } {
  let place: GamePlace | undefined;
  const next = content.replace(createPlaceTagRegex(), (_whole, body: string) => {
    const values = readValues(body);
    const name = clean(values.get("name"));
    const written = clean(values.get("size"));
    if (!name && !written) return serialize({}, { result: "refused", reason: "unreadable" });
    const size = written === undefined ? undefined : sizeOf(written);
    if (written !== undefined && !size) {
      return serialize({ ...(name ? { name } : {}), size: written }, { result: "refused", reason: "unknown-size" });
    }
    place = { ...(name ? { name } : {}), ...(size ? { size: size.id } : {}) };
    return serialize(place, { result: "ok" });
  });
  return { content: next, ...(place ? { place } : {}) };
}

/** The place in force after these texts, oldest first: the last place tag the Engine answered ok, or
 *  null when none was. */
export function lastGamePlace(texts: readonly string[]): GamePlace | null {
  for (let index = texts.length - 1; index >= 0; index--) {
    const found = [...(texts[index] ?? "").matchAll(createPlaceTagRegex())].reverse();
    for (const match of found) {
      const values = readValues(match[1] ?? "");
      if (clean(values.get("result"))?.toLowerCase() !== "ok") continue;
      const name = clean(values.get("name"));
      const size = clean(values.get("size"));
      return { ...(name ? { name } : {}), ...(size ? { size } : {}) };
    }
  }
  return null;
}
