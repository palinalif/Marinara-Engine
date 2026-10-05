// Pure duplicate-character finder for the character library.
// Two signals: an identical normalized name, or overlapping description +
// personality text measured with word-shingle Jaccard similarity. Candidate
// pairs come from an inverted shingle index, so a large library never pays
// for an all-pairs comparison. Detection only: callers must never delete.

export interface DuplicateCharacterInput {
  id: string;
  name: string;
  description?: string | null;
  personality?: string | null;
}

export interface CharacterDuplicateGroup {
  /** Member ids, in input order. */
  ids: string[];
  /** True when at least one pair in the group shares a normalized name. */
  nameMatch: boolean;
  /** Highest pairwise content similarity inside the group (0..1). */
  similarity: number;
}

export interface FindDuplicateCharactersOptions {
  /** Minimum Jaccard similarity for a content match. Default 0.5. */
  threshold?: number;
  /** Words per shingle. Default 3. */
  shingleSize?: number;
  /** Texts with fewer shingles than this are too short to compare. Default 8. */
  minShingles?: number;
  /** Shingles shared by more characters than this are boilerplate and ignored. Default 40. */
  maxShingleFrequency?: number;
}

const COPY_SUFFIX = /(?:^|\s)(?:copy|duplicate|dup|imported|import|new|old|v\d+(?:\.\d+)*|\d+)$/u;

/**
 * Normalize a character name for duplicate matching: accents stripped,
 * case folded, bracketed notes and "copy" / version / counter suffixes removed.
 */
export function normalizeCharacterName(name: string): string {
  let value = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  for (let guard = 0; guard < 4; guard++) {
    const next = value.replace(COPY_SUFFIX, "").trim();
    if (next === value || !next) break;
    value = next;
  }
  return value.replace(/\s+/gu, " ");
}

function shingles(text: string, size: number): Set<string> {
  const words = text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const result = new Set<string>();
  if (words.length < size) {
    if (words.length > 0) result.add(words.join(" "));
    return result;
  }
  for (let index = 0; index + size <= words.length; index++) {
    result.add(words.slice(index, index + size).join(" "));
  }
  return result;
}

/** Jaccard similarity of two sets (0 when both are empty). */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const value of small) if (large.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/** Group likely duplicate characters. Groups are sorted strongest first. */
export function findDuplicateCharacters(
  characters: readonly DuplicateCharacterInput[],
  options: FindDuplicateCharactersOptions = {},
): CharacterDuplicateGroup[] {
  const threshold = options.threshold ?? 0.5;
  const shingleSize = options.shingleSize ?? 3;
  const minShingles = options.minShingles ?? 8;
  const maxShingleFrequency = options.maxShingleFrequency ?? 40;

  const parent = characters.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };
  const nameMatched = new Set<number>();
  const bestSimilarity = new Map<number, number>();

  // Name signal.
  const byName = new Map<string, number[]>();
  characters.forEach((character, index) => {
    const normalized = normalizeCharacterName(character.name ?? "");
    if (!normalized) return;
    const list = byName.get(normalized);
    if (list) list.push(index);
    else byName.set(normalized, [index]);
  });
  for (const indexes of byName.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      union(indexes[0]!, index);
      nameMatched.add(index);
    }
  }

  // Content signal through an inverted shingle index.
  const shingleSets = characters.map((character) =>
    shingles(`${character.description ?? ""}\n${character.personality ?? ""}`, shingleSize),
  );
  const postings = new Map<string, number[]>();
  shingleSets.forEach((set, index) => {
    if (set.size < minShingles) return;
    for (const shingle of set) {
      const list = postings.get(shingle);
      if (list) list.push(index);
      else postings.set(shingle, [index]);
    }
  });
  const shared = new Map<number, number>();
  const count = characters.length;
  for (const list of postings.values()) {
    if (list.length < 2 || list.length > maxShingleFrequency) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const pairKey = list[i]! * count + list[j]!;
        shared.set(pairKey, (shared.get(pairKey) ?? 0) + 1);
      }
    }
  }
  for (const [pairKey, indexedIntersection] of shared) {
    if (indexedIntersection < 2) continue;
    const a = Math.floor(pairKey / count);
    const b = pairKey % count;
    const sizeA = shingleSets[a]!.size;
    const sizeB = shingleSets[b]!.size;
    // Jaccard can never exceed the size ratio, so skip hopeless pairs before
    // the exact comparison (boilerplate shingles are left out of the index but
    // still count in the exact score).
    if (Math.min(sizeA, sizeB) / Math.max(sizeA, sizeB) < threshold) continue;
    const similarity = jaccardSimilarity(shingleSets[a]!, shingleSets[b]!);
    if (similarity < threshold) continue;
    union(a, b);
    bestSimilarity.set(a, Math.max(bestSimilarity.get(a) ?? 0, similarity));
    bestSimilarity.set(b, Math.max(bestSimilarity.get(b) ?? 0, similarity));
  }

  const groups = new Map<number, number[]>();
  characters.forEach((_, index) => {
    const root = find(index);
    const list = groups.get(root);
    if (list) list.push(index);
    else groups.set(root, [index]);
  });

  const result: CharacterDuplicateGroup[] = [];
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    result.push({
      ids: indexes.map((index) => characters[index]!.id),
      nameMatch: indexes.some((index) => nameMatched.has(index)),
      similarity: Math.round(Math.max(0, ...indexes.map((index) => bestSimilarity.get(index) ?? 0)) * 100) / 100,
    });
  }
  return result.sort(
    (a, b) =>
      Number(b.nameMatch && b.similarity > 0) - Number(a.nameMatch && a.similarity > 0) ||
      b.similarity - a.similarity ||
      Number(b.nameMatch) - Number(a.nameMatch) ||
      b.ids.length - a.ids.length,
  );
}
