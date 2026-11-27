import type { PluginsSnapshot } from "./api";
import type { TodoTimer } from "../todos/timer.ts";

/**
 * The one plugin task the user is working on, and its countdown.
 *
 * The focus lives only on this side: no plugin action runs for it, so the task in the provider is
 * left exactly as it was (no due date, no tag, no status written back).
 */
export type PluginFocusState = {
  /** The plugin that published the task. */
  pluginId: string;
  /** The session id of the task inside that plugin. */
  taskId: string;
  /** The title as it was when the focus started; the live row replaces it when it is known. */
  title: string;
  /** The countdown, or null while the task runs without one. */
  timer: TodoTimer | null;
};

/** What is kept in localStorage: the focus and the duration each task was given. */
export type PluginFocusStore = {
  focus: PluginFocusState | null;
  /** "pluginId/taskId" → the minutes that task's countdown runs for. */
  durations: Record<string, number>;
};

export const PLUGIN_FOCUS_STORAGE_KEY = "fly-island-plugin-focus";

export const MIN_FOCUS_MINUTES = 1;
export const MAX_FOCUS_MINUTES = 240;
/** Before any choice: a short focus round, like the built-in todo's default. */
export const DEFAULT_FOCUS_MINUTES = 15;

/** "pluginId/taskId": how the focus names the one task it is on. */
export function pluginTaskKey(pluginId: string, taskId: string) {
  return `${pluginId}/${taskId}`;
}

export function isFocusMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= MIN_FOCUS_MINUTES && value <= MAX_FOCUS_MINUTES;
}

/** A stored focus that is damaged or from another shape is dropped rather than half-restored. */
export function normalizePluginFocus(value: unknown): PluginFocusState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const pluginId = typeof raw.pluginId === "string" ? raw.pluginId.trim() : "";
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
  if (!pluginId || !taskId) return null;
  return {
    pluginId,
    taskId,
    title: typeof raw.title === "string" ? raw.title : "",
    timer: normalizeFocusTimer(raw.timer),
  };
}

/** The countdown, shaped like the built-in todo's timer so the island can show it the same way. */
export function normalizeFocusTimer(value: unknown): TodoTimer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.todoId !== "string" || !raw.todoId.trim()
    || typeof raw.endsAt !== "number" || !Number.isSafeInteger(raw.endsAt) || raw.endsAt <= 0
    || !isFocusMinutes(raw.durationMinutes)) return null;
  return {
    todoId: raw.todoId,
    endsAt: raw.endsAt,
    durationMinutes: raw.durationMinutes,
    notified: raw.notified === true,
  };
}

export function normalizePluginFocusStore(value: unknown): PluginFocusStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { focus: null, durations: {} };
  const raw = value as Record<string, unknown>;
  const durations: Record<string, number> = {};
  if (raw.durations && typeof raw.durations === "object" && !Array.isArray(raw.durations)) {
    for (const [key, minutes] of Object.entries(raw.durations as Record<string, unknown>)) {
      if (key && isFocusMinutes(minutes)) durations[key] = minutes;
    }
  }
  return { focus: normalizePluginFocus(raw.focus), durations };
}

/**
 * What the stored focus means right now:
 * - "active": the task is still open, so the island keeps naming it;
 * - "gone": the task was finished or deleted, or its plugin is off — stop naming it;
 * - "unknown": the plugin has not published yet (or its last refresh failed), so the focus is
 *   kept: the task may well still be there.
 */
export type PluginFocusStatus = "active" | "gone" | "unknown";
export type ResolvedPluginFocus = { status: PluginFocusStatus; title: string };

export function resolvePluginFocus(
  state: PluginFocusState | null,
  snapshot: PluginsSnapshot,
  loaded: boolean,
): ResolvedPluginFocus | null {
  if (!state) return null;
  if (!loaded) return { status: "unknown", title: state.title };
  const installed = snapshot.registry.installed[state.pluginId];
  // Uninstalled or switched off: there is nothing left to work on.
  if (!installed || !installed.enabled) return { status: "gone", title: state.title };
  const live = snapshot.live[state.pluginId];
  // Not running yet, or the last refresh failed: the rows on screen are the last good ones, so
  // they cannot tell that the task is gone.
  if (!live || live.status !== "running" || live.stale) return { status: "unknown", title: state.title };
  const session = live.sessions.find((row) => row.id === state.taskId);
  if (!session) return { status: "gone", title: state.title };
  if (session.status === "completed") return { status: "gone", title: state.title };
  return { status: "active", title: session.title };
}

/** What the plugin page and the island both need of the focus. */
export type PluginFocusController = {
  /** The task being worked on, or null. */
  focus: PluginFocusState | null;
  /** Its title: the live row's when the task is still there. */
  title: string | null;
  /** The countdown of the focused task, or null. */
  timer: TodoTimer | null;
  /** The minutes the countdown of a task runs for. */
  minutesFor: (pluginId: string, taskId: string) => number;
  /** The same task again stops it; another one takes its place. Runs no countdown of its own. */
  toggle: (pluginId: string, taskId: string, title: string) => void;
  /** Works on a task with a countdown of `minutes`. */
  startRound: (pluginId: string, taskId: string, title: string, minutes: number) => void;
  /** Sets the minutes a task's countdown runs for. */
  chooseMinutes: (pluginId: string, taskId: string, minutes: number) => void;
};
