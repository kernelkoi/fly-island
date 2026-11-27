import type { PluginSession } from "./api";

/** The date windows above a plugin's task list. `all` turns the window off. */
export type PluginDateFilter = "all" | "today" | "tomorrow" | "week" | "overdue";

/** Chip order: the widest window first, so the row reads as a narrowing filter. */
export const PLUGIN_DATE_FILTERS: PluginDateFilter[] = ["all", "today", "tomorrow", "week", "overdue"];

/**
 * The local day `offset` days after `today` (YYYY-MM-DD). Noon keeps a DST switch at midnight
 * from turning the result into the previous or next day.
 */
export function shiftDay(today: string, offset: number) {
  const date = new Date(`${today}T12:00:00`);
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The day a row is worked on. A repeating task's due date is only its anchor: an anchor in the
 * past is worked today, the same rule the row's wording and the sort order already follow.
 */
function workDay(due: string, repeat: boolean, today: string) {
  return repeat && due < today ? today : due;
}

/**
 * Whether a row falls in the chosen window. `week` is the coming seven days, today included, so
 * it covers `today` and `tomorrow`. Undated rows and agent sessions have no day to place them,
 * so they only pass `all` (the same way they stay out of the calendar). Overdue is judged by the
 * date and excludes repeating rows, whose past anchor is today.
 */
export function matchesDateFilter(session: PluginSession, filter: PluginDateFilter, today: string): boolean {
  if (filter === "all") return true;
  const { due } = session;
  if (!due) return false;
  if (filter === "overdue") return session.bucket === "overdue"
    || (session.bucket == null && due < today && !session.repeat);
  const day = workDay(due, session.repeat === true, today);
  switch (filter) {
    case "today":
      return day === today;
    case "tomorrow":
      return day === shiftDay(today, 1);
    case "week":
      return day >= today && day <= shiftDay(today, 6);
    default:
      return false;
  }
}
