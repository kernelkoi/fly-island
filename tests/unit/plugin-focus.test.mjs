import assert from "node:assert/strict";
import test from "node:test";
import {
  isFocusMinutes,
  normalizePluginFocusStore,
  pluginTaskKey,
  resolvePluginFocus,
} from "../../src/features/plugins/pluginFocus.ts";

const snapshot = (overrides = {}) => ({
  registry: { developerMode: false, indexUrl: "", installed: {} },
  live: {},
  ...overrides,
});

const focus = (pluginId = "dida365", taskId = "p1:today") => ({
  pluginId, taskId, title: "写周报", timer: null,
});

test("a damaged store falls back to no focus and no durations", () => {
  assert.deepEqual(normalizePluginFocusStore(null), { focus: null, durations: {} });
  assert.deepEqual(normalizePluginFocusStore("nope"), { focus: null, durations: {} });
  assert.deepEqual(normalizePluginFocusStore({ focus: { pluginId: "", taskId: "x" } }), { focus: null, durations: {} });
});

test("a stored focus keeps its title and minutes that are in range", () => {
  const store = normalizePluginFocusStore({ focus: { pluginId: "d", taskId: "t", title: "写周报", timer: null }, durations: { "d/t": 25, "d/x": 999 } });
  assert.equal(store.focus?.title, "写周报");
  assert.deepEqual(store.durations, { "d/t": 25 });
});

test("minutes outside the allowed range are refused", () => {
  assert.equal(isFocusMinutes(0), false);
  assert.equal(isFocusMinutes(241), false);
  assert.equal(isFocusMinutes(15.5), false);
  assert.equal(isFocusMinutes(15), true);
});

test("the focus is gone once the task is finished, deleted, or its plugin is off", () => {
  const live = { dida365: { status: "running", quota: [], sessions: [{ id: "p1:today", title: "写周报", kind: "task", cwd: "工作", status: "running", updatedAt: 1, action: null }], notifications: [] } };
  const installed = { dida365: { enabled: true } };
  const done = { ...live, dida365: { ...live.dida365, sessions: [{ ...live.dida365.sessions[0], status: "completed" }] } };

  assert.equal(resolvePluginFocus(focus(), snapshot({ registry: { developerMode: false, indexUrl: "", installed }, live }), true)?.status, "active");
  assert.equal(resolvePluginFocus(focus(), snapshot({ registry: { developerMode: false, indexUrl: "", installed }, live: done }), true)?.status, "gone");
  // The task is not in the snapshot any more: it was deleted.
  assert.equal(resolvePluginFocus(focus(), snapshot({ registry: { developerMode: false, indexUrl: "", installed }, live: { dida365: { ...live.dida365, sessions: [] } } }), true)?.status, "gone");
  // The plugin is switched off.
  assert.equal(resolvePluginFocus(focus(), snapshot({ registry: { developerMode: false, indexUrl: "", installed: { dida365: { enabled: false } } }, live }), true)?.status, "gone");
});

test("an unknown plugin state keeps the focus: the task may still be there", () => {
  const focusState = focus();
  // Nothing has been published yet.
  assert.equal(resolvePluginFocus(focusState, snapshot(), true)?.status, "gone");
  // The plugin is installed but has not published yet.
  const installed = { dida365: { enabled: true } };
  assert.equal(resolvePluginFocus(focusState, snapshot({ registry: { developerMode: false, indexUrl: "", installed } }), true)?.status, "unknown");
  // The last refresh failed: the rows on screen are the last good ones.
  const stale = { dida365: { status: "running", stale: true, quota: [], sessions: [], notifications: [] } };
  assert.equal(resolvePluginFocus(focusState, snapshot({ registry: { developerMode: false, indexUrl: "", installed }, live: stale }), true)?.status, "unknown");
});

test("the focus key names the plugin and the task", () => {
  assert.equal(pluginTaskKey("dida365", "p1:today"), "dida365/p1:today");
});
