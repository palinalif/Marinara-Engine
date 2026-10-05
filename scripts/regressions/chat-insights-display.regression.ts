import assert from "node:assert/strict";

const { buildHeatmapGrid, formatPlayDuration, heatmapRange, heatmapThresholds, localDateInputToIso, splitSnippet } =
  await import("../../packages/client/src/lib/chat-insights-display.ts");

// Snippet highlighting splits into plain and marked parts and survives bad ranges.
assert.deepEqual(splitSnippet("The silver moon rose", [[4, 15]]), [
  { text: "The ", highlighted: false },
  { text: "silver moon", highlighted: true },
  { text: " rose", highlighted: false },
]);
assert.deepEqual(
  splitSnippet("abcdef", [
    [4, 99],
    [0, 2],
    [1, 3],
    [5, 5],
  ]),
  [
    { text: "ab", highlighted: true },
    { text: "c", highlighted: true },
    { text: "d", highlighted: false },
    { text: "ef", highlighted: true },
  ],
  "overlaps are clipped, empty and out-of-range ranges are tolerated",
);
assert.deepEqual(splitSnippet("plain", []), [{ text: "plain", highlighted: false }]);
assert.deepEqual(splitSnippet("", [[0, 3]]), []);

assert.equal(formatPlayDuration(0), "0m");
assert.equal(formatPlayDuration(29_000), "0m");
assert.equal(formatPlayDuration(45 * 60_000), "45m");
assert.equal(formatPlayDuration(3 * 3_600_000), "3h");
assert.equal(formatPlayDuration(3 * 3_600_000 + 20 * 60_000), "3h 20m");
assert.equal(formatPlayDuration(26 * 3_600_000), "1d 2h");
assert.equal(formatPlayDuration(48 * 3_600_000), "2d");
assert.equal(formatPlayDuration(-5), "0m");

assert.equal(localDateInputToIso("not a date", false), undefined);
const fromIso = localDateInputToIso("2026-03-04", false)!;
const toIso = localDateInputToIso("2026-03-04", true)!;
assert.equal(Date.parse(toIso) - Date.parse(fromIso), 86_400_000 - 1, "a local day spans one full day");
assert.equal(new Date(fromIso).getHours(), 0, "the start bound is local midnight");

assert.deepEqual(heatmapThresholds([]), [1, 1, 1]);
assert.deepEqual(heatmapThresholds([0, 1, 2, 3, 4, 5, 6, 7, 8]), [2, 4, 6]);
assert.deepEqual(heatmapThresholds([5, 5, 5]), [5, 5, 5]);

assert.deepEqual(heatmapRange("recent", "2026-09-22"), { start: "2025-09-23", end: "2026-09-22" });
assert.deepEqual(heatmapRange(2025, "2026-09-22"), { start: "2025-01-01", end: "2025-12-31" });

// 2026-01-01 is a Thursday, so the first week column pads Sunday to Wednesday.
const grid = buildHeatmapGrid(
  { "2026-01-01": 2, "2026-01-02": 8, "2026-02-01": 1, "2025-12-31": 50 },
  "2026-01-01",
  "2026-02-28",
);
assert.equal(grid.weeks[0]![0]!.date, "2025-12-28");
assert.equal(grid.weeks[0]![3]!.outside, true);
assert.equal(grid.weeks[0]![3]!.count, 0, "days outside the range are not counted");
assert.equal(grid.weeks[0]![4]!.date, "2026-01-01");
assert.ok(
  grid.weeks.every((week) => week.length === 7),
  "every column is a full week",
);
assert.equal(grid.weeks[grid.weeks.length - 1]![6]!.date, "2026-02-28");
assert.equal(grid.total, 11);
assert.equal(grid.activeDays, 3);
assert.equal(grid.maxCount, 8);
assert.deepEqual(
  grid.months.map((month) => [month.year, month.month]),
  [
    [2026, 0],
    [2026, 1],
  ],
);
assert.equal(grid.months[1]!.week, 5, "February starts in the sixth column");
const levels = Object.fromEntries(grid.weeks.flat().map((cell) => [cell.date, cell.level]));
assert.equal(levels["2026-01-03"], 0);
assert.equal(levels["2026-02-01"], 1);
assert.equal(levels["2026-01-02"], 4, "the busiest day gets the top level");
assert.deepEqual(buildHeatmapGrid({}, "2026-02-01", "2026-01-01").weeks, [], "reversed ranges are empty");

process.stdout.write("chat-insights-display regression passed\n");
