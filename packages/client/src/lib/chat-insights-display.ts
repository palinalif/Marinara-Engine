// ──────────────────────────────────────────────
// Chat insights: pure display helpers (snippets, durations, heatmap grid)
// ──────────────────────────────────────────────
import type { ChatSearchHighlight } from "@marinara-engine/shared";

export interface SnippetPart {
  text: string;
  highlighted: boolean;
}

/** Split a snippet into plain and highlighted parts, ignoring malformed ranges. */
export function splitSnippet(text: string, highlights: readonly ChatSearchHighlight[]): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let cursor = 0;
  const ranges = [...highlights]
    .filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && start < end)
    .sort((left, right) => left[0] - right[0]);
  for (const [rawStart, rawEnd] of ranges) {
    const start = Math.max(cursor, Math.min(text.length, rawStart));
    const end = Math.min(text.length, rawEnd);
    if (end <= start) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), highlighted: false });
    parts.push({ text: text.slice(start, end), highlighted: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false });
  return parts;
}

/** Compact duration such as "3h 20m", "45m" or "0m". */
export function formatPlayDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** Local calendar day (YYYY-MM-DD) for a Date in the reader's own time zone. */
export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Convert a local YYYY-MM-DD date input into an ISO bound for the server. */
export function localDateInputToIso(value: string, endOfDay: boolean): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return undefined;
  const date = endOfDay
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999)
    : new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export interface HeatmapCell {
  date: string;
  count: number;
  /** 0 for no activity, 1 to 4 for increasing activity. */
  level: 0 | 1 | 2 | 3 | 4;
  /** Outside the requested range (padding to complete the first or last week). */
  outside: boolean;
}

export interface HeatmapGrid {
  /** Week columns, each Sunday to Saturday. */
  weeks: HeatmapCell[][];
  /** Month label positions: the week column where each month first appears. */
  months: Array<{ week: number; month: number; year: number }>;
  total: number;
  activeDays: number;
  maxCount: number;
}

const DAY_MS = 86_400_000;

function keyToUtc(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

function utcToKey(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Thresholds splitting non-zero counts into four roughly equal bands. */
export function heatmapThresholds(counts: readonly number[]): [number, number, number] {
  const sorted = counts.filter((count) => count > 0).sort((left, right) => left - right);
  if (sorted.length === 0) return [1, 1, 1];
  const at = (fraction: number) => sorted[Math.floor((sorted.length - 1) * fraction)]!;
  return [at(0.25), at(0.5), at(0.75)];
}

/** Build a GitHub-style grid of Sunday-first weeks covering `startKey` through `endKey`. */
export function buildHeatmapGrid(
  days: Readonly<Record<string, number>>,
  startKey: string,
  endKey: string,
): HeatmapGrid {
  const start = keyToUtc(startKey);
  const end = keyToUtc(endKey);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return { weeks: [], months: [], total: 0, activeDays: 0, maxCount: 0 };
  }
  const gridStart = start - new Date(start).getUTCDay() * DAY_MS;
  const gridEnd = end + (6 - new Date(end).getUTCDay()) * DAY_MS;

  const inRange: number[] = [];
  for (let time = start; time <= end; time += DAY_MS) inRange.push(days[utcToKey(time)] ?? 0);
  const [low, mid, high] = heatmapThresholds(inRange);
  const level = (count: number): HeatmapCell["level"] => {
    if (count <= 0) return 0;
    if (count <= low) return 1;
    if (count <= mid) return 2;
    if (count <= high) return 3;
    return 4;
  };

  const weeks: HeatmapCell[][] = [];
  const months: HeatmapGrid["months"] = [];
  let total = 0;
  let activeDays = 0;
  let maxCount = 0;
  for (let time = gridStart; time <= gridEnd; time += DAY_MS) {
    const date = utcToKey(time);
    const outside = time < start || time > end;
    const count = outside ? 0 : (days[date] ?? 0);
    if (new Date(time).getUTCDay() === 0) weeks.push([]);
    const week = weeks[weeks.length - 1]!;
    week.push({ date, count, level: outside ? 0 : level(count), outside });
    if (!outside) {
      total += count;
      if (count > 0) activeDays += 1;
      maxCount = Math.max(maxCount, count);
      const current = new Date(time);
      const last = months[months.length - 1];
      if (!last || last.month !== current.getUTCMonth() || last.year !== current.getUTCFullYear()) {
        months.push({ week: weeks.length - 1, month: current.getUTCMonth(), year: current.getUTCFullYear() });
      }
    }
  }
  return { weeks, months, total, activeDays, maxCount };
}

/** The last 365 days ending today, or a whole calendar year. */
export function heatmapRange(selection: "recent" | number, todayKey: string): { start: string; end: string } {
  if (selection === "recent") {
    return { start: utcToKey(keyToUtc(todayKey) - 364 * DAY_MS), end: todayKey };
  }
  return { start: `${selection}-01-01`, end: `${selection}-12-31` };
}
