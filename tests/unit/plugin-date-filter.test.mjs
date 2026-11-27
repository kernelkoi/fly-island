import assert from "node:assert/strict";
import test from "node:test";
import { matchesDateFilter, shiftDay } from "../../src/features/plugins/pluginDateFilter.ts";

const today = "2026-11-18";
const task = (id, due, extra = {}) => ({
  id, title: id, kind: "task", due, repeat: false, status: "running", updatedAt: 1, action: null, cwd: null, listId: null, ...extra,
});
const passes = (row, filter) => matchesDateFilter(row, filter, today);

test("shiftDay walks the calendar across month, year and DST boundaries", () => {
  assert.equal(shiftDay(today, 0), today);
  assert.equal(shiftDay(today, 1), "2026-11-19");
  assert.equal(shiftDay(today, -1), "2026-11-17");
  assert.equal(shiftDay(today, 6), "2026-11-24");
  assert.equal(shiftDay("2026-11-30", 1), "2026-12-01");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
  // US DST starts on this Sunday: a noon date must not land on the previous day.
  assert.equal(shiftDay("2026-03-08", 1), "2026-03-09");
});

test("all is the off position: even undated tasks and agent rows stay", () => {
  assert.equal(passes(task("undated", null), "all"), true);
  assert.equal(passes({ ...task("agent", null), kind: null }, "all"), true);
  assert.equal(passes(task("late", "2026-11-10"), "all"), true);
});

test("today keeps only the rows worked today", () => {
  assert.equal(passes(task("today", today), "today"), true);
  assert.equal(passes(task("yesterday", "2026-11-17"), "today"), false);
  assert.equal(passes(task("tomorrow", "2026-11-19"), "today"), false);
  assert.equal(passes(task("undated", null), "today"), false);
});

test("tomorrow reads the next local day", () => {
  assert.equal(passes(task("tomorrow", "2026-11-19"), "tomorrow"), true);
  assert.equal(passes(task("today", today), "tomorrow"), false);
  assert.equal(passes(task("day-after", "2026-11-20"), "tomorrow"), false);
});

test("week is the coming seven days, today included", () => {
  assert.equal(passes(task("today", today), "week"), true);
  assert.equal(passes(task("tomorrow", "2026-11-19"), "week"), true);
  assert.equal(passes(task("last-of-window", "2026-11-24"), "week"), true);
  assert.equal(passes(task("past-window", "2026-11-25"), "week"), false);
  assert.equal(passes(task("yesterday", "2026-11-17"), "week"), false);
  assert.equal(passes(task("undated", null), "week"), false);
});

test("overdue is judged by the date, never the status word", () => {
  assert.equal(passes(task("late", "2026-11-17", { status: "running" }), "overdue"), true);
  assert.equal(passes(task("today", today), "overdue"), false);
  assert.equal(passes(task("tomorrow", "2026-11-19"), "overdue"), false);
  assert.equal(passes(task("undated", null), "overdue"), false);
});

test("a repeating row's past anchor is worked today, not overdue", () => {
  const repeat = task("repeat", "2026-11-16", { repeat: true });
  assert.equal(passes(repeat, "overdue"), false);
  assert.equal(passes(repeat, "today"), true);
  assert.equal(passes(repeat, "week"), true);
  assert.equal(passes(repeat, "tomorrow"), false);
  // A future anchor is still read as that day.
  assert.equal(passes(task("repeat-later", "2026-11-19", { repeat: true }), "tomorrow"), true);
});

test("windows only ever keep rows that have a day", () => {
  const agent = { ...task("agent", null), kind: null };
  for (const filter of ["today", "tomorrow", "week", "overdue"]) {
    assert.equal(passes(agent, filter), false, `${filter} keeps no agent row`);
  }
});
