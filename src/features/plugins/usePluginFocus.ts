import { useCallback, useEffect, useMemo, useState } from "react";
import { readJson, writeJson, removeItem } from "../../lib/storage.ts";
import { requestIslandCollapse } from "../../lib/islandCollapseRequest.ts";
import { createTodoTimer } from "../todos/timer.ts";
import {
  DEFAULT_FOCUS_MINUTES,
  isFocusMinutes,
  normalizePluginFocusStore,
  PLUGIN_FOCUS_STORAGE_KEY,
  pluginTaskKey,
  resolvePluginFocus,
  type PluginFocusController,
} from "./pluginFocus";
import { pluginsLoaded, usePlugins } from "./usePlugins";

/**
 * The plugin task the user is working on.
 *
 * The focus is this side's own state: the provider's task is never written to, so starting a task
 * changes nothing in the provider (no due date, no tag, no status). It lives in localStorage so
 * the island still names the task after a restart, and it is dropped as soon as the task is
 * finished, deleted, or its plugin is switched off.
 */
export function usePluginFocus(): PluginFocusController {
  const snapshot = usePlugins();
  const [store, setStore] = useState(() => normalizePluginFocusStore(readJson(PLUGIN_FOCUS_STORAGE_KEY)));

  useEffect(() => {
    if (store.focus || Object.keys(store.durations).length > 0) writeJson(PLUGIN_FOCUS_STORAGE_KEY, store);
    else removeItem(PLUGIN_FOCUS_STORAGE_KEY);
  }, [store]);

  const startRound = useCallback((pluginId: string, taskId: string, title: string, minutes: number) => {
    const key = pluginTaskKey(pluginId, taskId);
    const round = isFocusMinutes(minutes) ? minutes : DEFAULT_FOCUS_MINUTES;
    const timer = createTodoTimer(key, round, Date.now());
    setStore((current) => ({
      ...current,
      focus: { pluginId, taskId, title, timer },
      durations: { ...current.durations, [key]: round },
    }));
    // The island folds away and shows the task on its collapsed face, like the built-in todo.
    requestIslandCollapse();
  }, []);

  /**
   * The same task again stops it; a different one takes its place. Starting on its own runs no
   * countdown — as with the built-in todo, a round only comes from the watch's setter.
   */
  const toggle = useCallback((pluginId: string, taskId: string, title: string) => {
    setStore((current) => {
      if (current.focus && current.focus.pluginId === pluginId && current.focus.taskId === taskId) {
        return { ...current, focus: null };
      }
      return { ...current, focus: { pluginId, taskId, title, timer: null } };
    });
    requestIslandCollapse();
  }, []);

  const chooseMinutes = useCallback((pluginId: string, taskId: string, minutes: number) => {
    if (!isFocusMinutes(minutes)) return;
    setStore((current) => ({
      ...current,
      durations: { ...current.durations, [pluginTaskKey(pluginId, taskId)]: minutes },
    }));
  }, []);

  // The task is gone (finished, deleted, or its plugin is off): stop naming it. Until a snapshot
  // has arrived the plugin state is unknown, so a stored focus survives an app restart.
  const focus = store.focus;
  const loaded = pluginsLoaded();
  const resolved = useMemo(() => resolvePluginFocus(focus, snapshot, loaded), [focus, loaded, snapshot]);
  useEffect(() => {
    if (focus && resolved?.status === "gone") setStore((current) => ({ ...current, focus: null }));
  }, [focus, resolved]);

  // The countdown ends: the island keeps naming the task, but the timer is over.
  useEffect(() => {
    const timer = focus?.timer;
    if (!timer || timer.notified) return;
    const check = () => {
      if (Date.now() >= timer.endsAt) {
        setStore((current) => current.focus?.timer === timer
          ? { ...current, focus: { ...current.focus, timer: { ...timer, notified: true } } }
          : current);
      }
    };
    check();
    const interval = window.setInterval(check, 1000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [focus]);

  const minutesFor = useCallback((pluginId: string, taskId: string) => {
    const minutes = store.durations[pluginTaskKey(pluginId, taskId)];
    return isFocusMinutes(minutes) ? minutes : DEFAULT_FOCUS_MINUTES;
  }, [store.durations]);

  return {
    focus,
    title: resolved?.status === "active" ? resolved.title : focus?.title ?? null,
    timer: focus?.timer ?? null,
    minutesFor,
    toggle,
    startRound,
    chooseMinutes,
  };
}
