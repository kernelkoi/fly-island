import { addDays } from "./schedule.ts";
import { getMonthGrid, monthOf, shiftMonth } from "./calendar.ts";

/** Locale week start for the two supported languages: Monday in Chinese, Sunday in en-US. */
export function pickerWeekStart(locale: string): 0 | 1 {
  return locale.toLowerCase().startsWith("zh") ? 1 : 0;
}

export function pickerMonthGrid(month: string, weekStart: 0 | 1): string[] {
  return getMonthGrid(month, weekStart);
}

/** Moving a month keeps the day where possible (Jan 31 → Feb 28), including leap years. */
export function shiftPickerMonth(date: string, delta: number) {
  const month = shiftMonth(monthOf(date), delta);
  const [year, monthNumber] = month.split("-").map(Number);
  return `${month}-${String(Math.min(Number(date.slice(8)), new Date(year, monthNumber, 0).getDate())).padStart(2, "0")}`;
}

/** Picking a new todo's day: today and earlier mean the current list, later days schedule it. */
export function quickAddDateChoice(date: string | null, today: string) {
  return date && date > today ? date : null;
}

/** Editing an existing row's due day: past days are allowed and null clears the date. */
export function taskDueDateChoice(date: string | null) {
  return date;
}

/**
 * Where a fixed-position month picker sits in the island's clickable box. Below the anchor by
 * default, above it when the bottom is close, and kept inside either way, so a picker opened from
 * a row near the page's bottom stays whole instead of running off the edge.
 *
 * `bounds` is the island shape itself, not the window: the stage around it passes clicks through,
 * so anything drawn past the shape is visible but cannot be clicked.
 */
export function pickerPopoverPlacement(
  anchor: { top: number; bottom: number; right: number },
  popover: { width: number; height: number },
  bounds: { top: number; bottom: number; left: number; right: number },
  gap = 4,
  edge = 4,
): { top: number; left: number } {
  const minTop = bounds.top + edge;
  const maxTop = Math.max(minTop, bounds.bottom - edge - popover.height);
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - popover.height;
  const top = below + popover.height <= bounds.bottom - edge
    ? below
    : above >= minTop
      ? above
      // Neither side fits: keep the picker inside the island and let it cover the rows.
      : Math.min(Math.max(below, minTop), maxTop);
  const minLeft = bounds.left + edge;
  const maxLeft = Math.max(minLeft, bounds.right - edge - popover.width);
  const left = Math.min(Math.max(anchor.right - popover.width, minLeft), maxLeft);
  return { top: Math.round(top), left: Math.round(left) };
}

/** `min` is the first selectable day, or null when the picker allows every past day. */
export function movePickerFocus(date: string, key: string, weekStart: 0 | 1, min: string | null): string | null {
  const weekday = (new Date(`${date}T00:00:00`).getDay() - weekStart + 7) % 7;
  const days: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
  const next = key in days ? addDays(date, days[key])
    : key === "PageUp" ? shiftPickerMonth(date, -1) : key === "PageDown" ? shiftPickerMonth(date, 1) : null;
  return next === null || min === null || next >= min ? next : min;
}
