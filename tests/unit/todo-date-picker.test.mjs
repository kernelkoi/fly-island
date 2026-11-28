import assert from "node:assert/strict";
import test from "node:test";
import { movePickerFocus, pickerMonthGrid, pickerPopoverPlacement, pickerWeekStart, quickAddDateChoice, shiftPickerMonth, taskDueDateChoice } from "../../src/features/todos/datePickerCalendar.ts";
import { holdIslandPicker, isIslandPickerOpen } from "../../src/lib/islandPicker.ts";

test("picker weeks follow the UI locale and span complete weeks across month boundaries", () => {
  assert.equal(pickerWeekStart("zh-CN"), 1);
  assert.equal(pickerWeekStart("en-US"), 0);
  const chinese = pickerMonthGrid("2026-11", 1);
  const english = pickerMonthGrid("2026-11", 0);
  assert.equal(chinese[0], "2026-10-26");
  assert.equal(chinese.length, 42);
  assert.equal(english[0], "2026-11-01");
  assert.equal(english.length, 35);
  assert.equal(pickerMonthGrid("2024-02", 1).includes("2024-02-29"), true);
});

test("month navigation clamps the day without overflowing a short month", () => {
  assert.equal(shiftPickerMonth("2024-01-31", 1), "2024-02-29");
  assert.equal(shiftPickerMonth("2025-03-31", -1), "2025-02-28");
  assert.equal(shiftPickerMonth("2026-12-15", 1), "2027-01-15");
});

test("keyboard navigation crosses weeks and months and stops at the minimum date", () => {
  const move = (date, key, start = 1) => movePickerFocus(date, key, start, "2026-11-15");
  assert.equal(move("2026-11-30", "ArrowRight"), "2026-12-01");
  assert.equal(move("2026-11-15", "ArrowLeft"), "2026-11-15");
  assert.equal(move("2026-11-22", "ArrowUp"), "2026-11-15");
  assert.equal(move("2026-11-22", "ArrowDown"), "2026-11-29");
  assert.equal(move("2026-11-25", "Home"), "2026-11-23");
  assert.equal(move("2026-11-25", "Home", 0), "2026-11-22");
  assert.equal(move("2026-11-25", "End"), "2026-11-29");
  assert.equal(move("2026-12-31", "PageUp"), "2026-11-30");
  assert.equal(move("2026-11-30", "PageDown"), "2026-12-30");
  assert.equal(move("2026-11-25", "Enter"), null);
  // No minimum: an existing task's editor may move into past months as well.
  assert.equal(movePickerFocus("2026-11-05", "ArrowLeft", 1, null), "2026-11-04");
  assert.equal(movePickerFocus("2026-11-05", "PageUp", 1, null), "2026-10-05");
});

test("a new todo keeps earlier days on its list, while editing a task keeps the chosen day", () => {
  assert.equal(quickAddDateChoice("2026-11-10", "2026-11-15"), null);
  assert.equal(quickAddDateChoice("2026-11-15", "2026-11-15"), null);
  assert.equal(quickAddDateChoice("2026-11-16", "2026-11-15"), "2026-11-16");
  assert.equal(taskDueDateChoice("2026-11-10", "2026-11-15"), "2026-11-10");
  assert.equal(taskDueDateChoice(null, "2026-11-15"), null);
});

test("a fixed picker opens below its row, flips above near the bottom, and stays inside the island", () => {
  const popover = { width: 248, height: 273 };
  const bounds = { top: 0, bottom: 420, left: 0, right: 560 };
  // Room below the row: directly under it, right-aligned to the row.
  assert.deepEqual(pickerPopoverPlacement({ top: 100, bottom: 124, right: 300 }, popover, bounds), { top: 128, left: 52 });
  // Near the bottom: above the row instead of running off the island.
  assert.deepEqual(pickerPopoverPlacement({ top: 360, bottom: 384, right: 540 }, popover, bounds), { top: 83, left: 292 });
  // Neither side fits: clamped into the island rather than hidden past its edge.
  assert.deepEqual(pickerPopoverPlacement({ top: 150, bottom: 174, right: 200 }, popover, bounds), { top: 143, left: 4 });
  // An island narrower than the month: aligned to its edge instead of overflowing to the right.
  assert.deepEqual(pickerPopoverPlacement({ top: 100, bottom: 124, right: 810 }, popover, { top: 0, bottom: 420, left: 295, right: 805 }), { top: 128, left: 553 });
  // The island's rounded bottom stays clear (bounds.bottom already excludes it), so a low row flips up.
  assert.deepEqual(pickerPopoverPlacement({ top: 330, bottom: 354, right: 787 }, popover, { top: 0, bottom: 344, left: 295, right: 805 }), { top: 53, left: 539 });
});

test("picker close/focus suppression remains held until every open owner releases it", () => {
  assert.equal(isIslandPickerOpen(), false);
  const releaseA = holdIslandPicker();
  const releaseB = holdIslandPicker();
  assert.equal(isIslandPickerOpen(), true);
  releaseA();
  releaseA();
  assert.equal(isIslandPickerOpen(), true);
  releaseB();
  assert.equal(isIslandPickerOpen(), false);
});
