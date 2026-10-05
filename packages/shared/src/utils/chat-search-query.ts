// ──────────────────────────────────────────────
// Chat search query parsing, matching and snippets
// ──────────────────────────────────────────────
import type { ChatSearchHighlight } from "../types/chat-insights.js";

export interface ParsedChatSearchQuery {
  /** Every needle (loose words and quoted phrases) that must appear, in query order. */
  needles: string[];
  /** Quoted phrases only, for display. */
  phrases: string[];
}

export interface CompiledChatSearchQuery extends ParsedChatSearchQuery {
  patterns: RegExp[];
}

export interface ChatSearchSnippet {
  text: string;
  highlights: ChatSearchHighlight[];
}

const MAX_NEEDLES = 12;
const MAX_NEEDLE_LENGTH = 200;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Split a query into needles. `"quoted phrases"` stay together, everything else
 * splits on whitespace. An unmatched quote treats the rest of the query as a phrase.
 */
export function parseChatSearchQuery(raw: string): ParsedChatSearchQuery {
  const input = typeof raw === "string" ? raw.normalize("NFKC") : "";
  const needles: string[] = [];
  const phrases: string[] = [];
  const seen = new Set<string>();
  const add = (value: string, phrase: boolean) => {
    const trimmed = value.replace(/\s+/gu, " ").trim().slice(0, MAX_NEEDLE_LENGTH);
    if (!trimmed || needles.length >= MAX_NEEDLES) return;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    needles.push(trimmed);
    if (phrase) phrases.push(trimmed);
  };

  let index = 0;
  while (index < input.length) {
    const char = input[index]!;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"' || char === "“" || char === "”") {
      const rest = input.slice(index + 1);
      const close = rest.search(/["“”]/u);
      const phrase = close === -1 ? rest : rest.slice(0, close);
      add(phrase, true);
      index += 1 + (close === -1 ? rest.length : close + 1);
      continue;
    }
    let end = index;
    while (end < input.length && !/[\s"“”]/u.test(input[end]!)) end += 1;
    add(input.slice(index, end), false);
    index = end;
  }

  return { needles, phrases };
}

export function compileChatSearchQuery(raw: string): CompiledChatSearchQuery {
  const parsed = parseChatSearchQuery(raw);
  return {
    ...parsed,
    patterns: parsed.needles.map((needle) => new RegExp(needle.split(" ").map(escapeRegExp).join("\\s+"), "giu")),
  };
}

/** True when every needle appears in the text, case-insensitively. */
export function matchesChatSearchQuery(text: string, query: CompiledChatSearchQuery): boolean {
  if (query.patterns.length === 0 || !text) return false;
  for (const pattern of query.patterns) {
    pattern.lastIndex = 0;
    if (!pattern.test(text)) return false;
  }
  return true;
}

function collectRanges(text: string, patterns: RegExp[]): ChatSearchHighlight[] {
  const ranges: ChatSearchHighlight[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      ranges.push([match.index, match.index + match[0].length]);
      if (ranges.length > 200) break;
    }
  }
  ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const merged: ChatSearchHighlight[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/**
 * Build a short single-line excerpt around the first match, with highlight
 * ranges relative to the returned text. Whitespace is collapsed first so the
 * offsets line up with what the reader sees.
 */
export function buildChatSearchSnippet(
  content: string,
  query: CompiledChatSearchQuery,
  maxLength = 220,
): ChatSearchSnippet {
  const text = content.replace(/\s+/gu, " ").trim();
  const ranges = collectRanges(text, query.patterns);
  if (text.length <= maxLength) return { text, highlights: ranges };

  const first = ranges[0];
  const lead = Math.floor(maxLength / 3);
  let start = first ? Math.max(0, first[0] - lead) : 0;
  if (start > 0) {
    const space = text.lastIndexOf(" ", start + 12);
    if (space > start - 20 && space < (first?.[0] ?? start)) start = space + 1;
  }
  let end = Math.min(text.length, start + maxLength);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start + maxLength * 0.6) end = space;
  }

  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const shift = prefix.length - start;
  const highlights = ranges
    .filter(([rangeStart, rangeEnd]) => rangeEnd > start && rangeStart < end)
    .map(([rangeStart, rangeEnd]): ChatSearchHighlight => [
      Math.max(rangeStart, start) + shift,
      Math.min(rangeEnd, end) + shift,
    ]);
  return { text: `${prefix}${text.slice(start, end)}${suffix}`, highlights };
}
