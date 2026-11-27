import assert from "node:assert/strict";
import test from "node:test";
import { sortModesFor, sortOpenSessions } from "../../src/features/plugins/pluginSort.ts";
import { pluginPriority } from "../../src/features/plugins/pluginPriority.ts";

const today = "2026-11-18";
const task = (id, title, due, updatedAt, extra = {}) => ({
  id, title, kind: "task", due, updatedAt, status: "running", action: `complete.${id}`, cwd: "工作", listId: "p1", ...extra,
});
const agent = (id, updatedAt) => ({
  id, title: id, cwd: "repo", status: "running", updatedAt, action: null,
});
const ids = (sessions) => sessions.map((session) => session.id).join(",");
const sort = (sessions, mode) => sortOpenSessions(sessions, mode, today, (session) => session.cwd ?? "", "en");

test("due keeps overdue on top, then due day, then undated, then agent rows", () => {
  const rows = [
    agent("agent", 999),
    task("nodue", "No day", null, 90),
    task("same-old", "Same old", "2026-11-19", 10),
    task("same-new", "Same new", "2026-11-19", 20),
    task("today", "Today", "2026-11-18", 5),
    task("repeat", "Repeat", "2026-11-17", 9, { repeat: true }),
    task("late", "Late", "2026-11-17", 1),
  ];
  assert.equal(ids(sort(rows, "due")), "late,repeat,today,same-new,same-old,nodue,agent");
});

test("updated reads the rest newest first, the same frame around it", () => {
  const rows = [
    task("nodue", "No day", null, 99),
    task("old", "Old", "2026-11-19", 10),
    task("new", "New", "2026-11-20", 50),
    task("late", "Late", "2026-11-17", 1),
    agent("agent", 999),
  ];
  assert.equal(ids(sort(rows, "updated")), "late,new,old,nodue,agent");
});

test("list reads by list name, then due day; an undated task still comes last", () => {
  const rows = [
    task("beta", "Beta", "2026-11-18", 1, { cwd: "Beta" }),
    task("alpha-late", "Alpha late", "2026-11-20", 2, { cwd: "Alpha" }),
    task("alpha-early", "Alpha early", "2026-11-19", 3, { cwd: "Alpha" }),
    task("nodue", "No day", null, 4, { cwd: "Aaa" }),
    agent("agent", 5),
  ];
  assert.equal(ids(sort(rows, "list")), "alpha-early,alpha-late,beta,nodue,agent");
});

test("priority reads high, then medium, then low, then none; due day inside each level", () => {
  const rows = [
    task("none", "None", "2026-11-18", 1),
    task("low", "Low", "2026-11-18", 2, { priority: 1 }),
    task("high-late", "High late", "2026-11-20", 3, { priority: 5 }),
    task("high-early", "High early", "2026-11-19", 4, { priority: 5 }),
    task("medium", "Medium", "2026-11-18", 5, { priority: 3 }),
    task("late-high", "Late high", "2026-11-17", 6, { priority: 5 }),
  ];
  assert.equal(ids(sort(rows, "priority")), "late-high,high-early,high-late,medium,low,none");
});

test("a provider's importance maps to the four words the UI has", () => {
  assert.equal(pluginPriority({ priority: 1 }), "low");
  assert.equal(pluginPriority({ priority: 3 }), "medium");
  assert.equal(pluginPriority({ priority: 5 }), "high");
  assert.equal(pluginPriority({ priority: 0 }), "none");
  assert.equal(pluginPriority({ priority: 2 }), "none");
  assert.equal(pluginPriority({}), "none");
});

test("grouping by list is only offered while several lists are in view", () => {
  assert.deepEqual(sortModesFor(3), ["due", "updated", "list", "priority"]);
  assert.deepEqual(sortModesFor(1), ["due", "updated", "priority"]);
  assert.deepEqual(sortModesFor(0), ["due", "updated", "priority"]);
});
