// Pure bulk tag editing for character cards. The server applies it per card;
// the client uses the same functions to preview the confirmation summary, so
// what the user confirms is exactly what gets written.

export interface CharacterTagRename {
  from: string;
  to: string;
}

export interface CharacterTagEdit {
  add?: string[];
  remove?: string[];
  rename?: CharacterTagRename[];
}

export interface CharacterTagEditSummary {
  /** Cards whose tag list would change. */
  changedIds: string[];
  /** Per-operation affected card counts, keyed by the tag text as entered. */
  added: Array<{ tag: string; count: number }>;
  removed: Array<{ tag: string; count: number }>;
  renamed: Array<{ from: string; to: string; count: number }>;
}

const foldTag = (tag: string) => tag.trim().toLocaleLowerCase();

function cleanList(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(foldTag(trimmed))) continue;
    seen.add(foldTag(trimmed));
    result.push(trimmed);
  }
  return result;
}

/** Drop blanks and case-insensitive duplicates so an edit is well-formed. */
export function normalizeCharacterTagEdit(edit: CharacterTagEdit): Required<CharacterTagEdit> {
  const rename: CharacterTagRename[] = [];
  const seenFrom = new Set<string>();
  for (const item of edit.rename ?? []) {
    const from = typeof item?.from === "string" ? item.from.trim() : "";
    const to = typeof item?.to === "string" ? item.to.trim() : "";
    if (!from || !to || from === to || seenFrom.has(foldTag(from))) continue;
    seenFrom.add(foldTag(from));
    rename.push({ from, to });
  }
  return { add: cleanList(edit.add), remove: cleanList(edit.remove), rename };
}

export function isEmptyCharacterTagEdit(edit: CharacterTagEdit): boolean {
  const normalized = normalizeCharacterTagEdit(edit);
  return normalized.add.length === 0 && normalized.remove.length === 0 && normalized.rename.length === 0;
}

/**
 * Apply one bulk edit to a tag list. Order: rename, then remove, then add.
 * Matching is case-insensitive; a rename keeps the tag's position; the result
 * never contains case-insensitive duplicates.
 */
export function applyCharacterTagEdit(tags: readonly string[], edit: CharacterTagEdit): string[] {
  const { add, remove, rename } = normalizeCharacterTagEdit(edit);
  const renameMap = new Map(rename.map((item) => [foldTag(item.from), item.to]));
  const removeSet = new Set(remove.map(foldTag));
  const result: string[] = [];
  const seen = new Set<string>();
  const push = (tag: string) => {
    const folded = foldTag(tag);
    if (!folded || seen.has(folded)) return;
    seen.add(folded);
    result.push(tag.trim());
  };
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const renamed = renameMap.get(foldTag(tag)) ?? tag;
    if (removeSet.has(foldTag(renamed))) continue;
    push(renamed);
  }
  for (const tag of add) push(tag);
  return result;
}

export function characterTagListsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

/** Preview what a bulk edit would do across a set of cards. */
export function summarizeCharacterTagEdit(
  characters: ReadonlyArray<{ id: string; tags: readonly string[] }>,
  edit: CharacterTagEdit,
): CharacterTagEditSummary {
  const normalized = normalizeCharacterTagEdit(edit);
  const changedIds: string[] = [];
  const added = normalized.add.map((tag) => ({ tag, count: 0 }));
  const removed = normalized.remove.map((tag) => ({ tag, count: 0 }));
  const renamed = normalized.rename.map((item) => ({ ...item, count: 0 }));
  for (const character of characters) {
    const current = character.tags.filter((tag): tag is string => typeof tag === "string");
    const folded = new Set(current.map(foldTag));
    const next = applyCharacterTagEdit(current, normalized);
    if (!characterTagListsEqual(current, next)) changedIds.push(character.id);
    for (const item of renamed) if (folded.has(foldTag(item.from))) item.count++;
    const afterRename = new Set(applyCharacterTagEdit(current, { rename: normalized.rename }).map(foldTag));
    for (const item of removed) if (afterRename.has(foldTag(item.tag))) item.count++;
    if (added.length > 0) {
      const afterRemove = new Set(
        applyCharacterTagEdit(current, { rename: normalized.rename, remove: normalized.remove }).map(foldTag),
      );
      for (const item of added) if (!afterRemove.has(foldTag(item.tag))) item.count++;
    }
  }
  return { changedIds, added, removed, renamed };
}
