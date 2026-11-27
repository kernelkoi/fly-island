import type { PluginSession } from "./api";
import { priorityRank } from "./pluginPriority.ts";

/** How the todo view orders its open rows. `due` is the order the page always used. */
export type PluginSortMode = "due" | "updated" | "list" | "priority";

/** Menu order. The first one is the default. */
export const PLUGIN_SORT_MODES: PluginSortMode[] = ["due", "updated", "list", "priority"];

/**
 * Grouping by list can only reorder rows when more than one list is in view, so the option is
 * dropped once a single list is picked (or the plugin only has one) instead of offering a mode
 * that would change nothing.
 */
export function sortModesFor(listCount: number) {
  return PLUGIN_SORT_MODES.filter((mode) => mode !== "list" || listCount > 1);
}

/** 0 = overdue (due day before today and not repeating; judged by date, not the status word),
 *  1 = a task with a day, 2 = a task without one, 3 = an agent session. Overdue always tops,
 *  undated tasks always trail dated ones, and agent rows always come after the tasks — the same
 *  frame in every mode, so switching the mode never hides overdue work. */
const rankOf = (session: PluginSession, today: string) => {
  if (session.due != null && session.due < today && !session.repeat) return 0;
  if (session.kind !== "task") return 3;
  return session.due ? 1 : 2;
};

/**
 * Open rows: overdue first, then tasks, then agent sessions; inside each, the chosen mode.
 *
 * Within a rank the three modes differ only in their first key — `due` reads the day, `updated`
 * reads the last edit, `list` reads the list name — and every mode breaks a full tie by the most
 * recent edit, so two rows that tie on the mode's key still have one stable order.
 */
export function sortOpenSessions(
  sessions: PluginSession[],
  mode: PluginSortMode,
  today: string,
  listLabel: (session: PluginSession) => string,
  locale: string,
) {
  const byMode = {
    due: (a: PluginSession, b: PluginSession) => compareDue(a, b),
    updated: (a: PluginSession, b: PluginSession) => b.updatedAt - a.updatedAt,
    list: (a: PluginSession, b: PluginSession) =>
      listLabel(a).localeCompare(listLabel(b), locale) || compareDue(a, b),
    priority: (a: PluginSession, b: PluginSession) =>
      priorityRank(b) - priorityRank(a) || compareDue(a, b),
  }[mode];
  return [...sessions].sort(
    (a, b) => rankOf(a, today) - rankOf(b, today) || byMode(a, b) || b.updatedAt - a.updatedAt,
  );
}

/** By due day ascending, empty last. */
function compareDue(a: PluginSession, b: PluginSession) {
  const adue = a.due ?? null;
  const bdue = b.due ?? null;
  if (adue && bdue && adue !== bdue) return adue.localeCompare(bdue);
  if (adue !== bdue) return adue ? -1 : 1;
  return 0;
}
