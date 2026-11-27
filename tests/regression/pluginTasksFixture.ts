// Fixtures and IPC mocks for the plugin-tasks regression page: the page file stays under the
// 400-line cap, and the data lives in one place instead of being rebuilt by each check.
import { mockIPC } from "@tauri-apps/api/mocks";
import { LOCALE_STORAGE_KEY, TRANSLATIONS } from "../../src/i18n";

Object.assign(globalThis, { isTauri: true });
export const locale = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "zh-CN";
localStorage.setItem(LOCALE_STORAGE_KEY, locale);
export const t = TRANSLATIONS[locale].plugins;
export const todoText = TRANSLATIONS[locale].todo;
export const dayToday = TRANSLATIONS[locale].notebook.dayToday;
export const name = { "zh-CN": "滴答清单", en: "TickTick" };
const manifest = (id: string, contributes: string[], enabled = true) => ({
  manifest: { id, name, description: name, icon: id === "dida365" ? "ticktick" : null, version: "0.1.1", apiVersion: 1, runtime: { command: `${id}.exe` },
    permissions: ["network", "quota", "sessions"], contributes, settings: [], actions: [] },
  enabled, directory: `plugins/${id}`, development: true, settings: {},
});
export const dayFromNow = (offset: number) => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const session = (id: string, title: string, detail: string | null, status: string, updatedAt: number, action: string | null, cwd: string | null = "工作", due: string | null = null, repeat = false) =>
  ({ id, title, detail, kind: "task", cwd, listId: id.split(":")[0] || null, due, repeat, status, updatedAt, action, actionPrefixes: status === "completed" ? [] : [`due.${id.replace(":", ".")}.`], bucket: !due ? "future" : due < dayFromNow(0) ? (repeat ? "today" : "overdue") : due === dayFromNow(0) ? "today" : "future" });
const live = {
  dida365: {
    status: "running",
    quota: [{ id: "tasks", label: "TickTick", remainingPercent: 60, secondaryPercent: null, balance: "3 条", resetsAt: null, updatedAt: 1 }],
    sessions: [
      // Finished rows carry a reopen action, not a complete one: their check undoes the completion.
      session("p1:done", "已完成的活", null, "completed", 30, "reopen.p1.done", "工作", dayFromNow(0)),
      session("p2:done2", "刚完成的活", null, "completed", 80, "reopen.p2.done2", "学习", dayFromNow(0)),
      session("p1:late", "逾期的活", null, "running", 10, "complete.p1.late", "工作", dayFromNow(-1)),
      session("p1:today", "今天要做的活", null, "running", 20, "complete.p1.today", "工作", dayFromNow(0)),
      session("p2:study", "学习清单的活", null, "running", 40, "complete.p2.study", "学习", dayFromNow(1)),
      session("p3:life", "生活清单的活", null, "running", 5, "complete.p3.life", "生活", dayFromNow(3)),
      session("inbox:quick", "收件箱的活", null, "running", 50, "complete.inbox.quick", null, dayFromNow(1)),
      session("p4:loop", "重复的活", null, "running", 60, "complete.p4.loop", "重复", dayFromNow(-1), true),
    ],
    notifications: [],
    composer: true,
  },
  silent: { status: "running", quota: [], sessions: [], notifications: [] },
  emptyTodo: { status: "running", quota: [], sessions: [], notifications: [], composer: true },
  // An unconfigured plugin keeps its block to point at Settings instead of reading as "no tasks".
  unconfig: { status: "running", settingsConfigured: false, quota: [], sessions: [], notifications: [] },
  // A failed refresh keeps the last good rows and flags them, instead of wiping the list.
  staleTodo: { status: "running", stale: true, quota: [], notifications: [], sessions: [session("s1:old", "上次拉到的活", null, "running", 70, "complete.s1.old", "旧清单")] },
};
const snapshot = {
  registry: { developerMode: true, indexUrl: "", installed: {
    dida365: manifest("dida365", ["quota", "sessions", "notifications"]), silent: manifest("silent", ["sessions"]),
    disabled: manifest("disabled", ["sessions"], false), messagesOnly: manifest("messagesOnly", ["notifications"]),
    emptyTodo: manifest("emptyTodo", ["sessions"]), unconfig: manifest("unconfig", ["sessions"]),
    staleTodo: manifest("staleTodo", ["sessions"]),
  } },
  live,
};
export const ran: string[] = [];
mockIPC((command, payload) => {
  const args = (payload ?? {}) as Record<string, unknown>;
  if (command === "get_plugins") return snapshot;
  if (command === "run_plugin_action") {
    const action = String(args.action ?? "");
    ran.push(`${args.id}/${action}`);
    // One check, one undo, one due change and one quick add fail so the error paths can be verified.
    if (action === "complete.p1.late") throw "TickTick completion failed with status 401";
    if (action === "reopen.p2.done2") throw "TickTick reopen failed with status 404";
    if (action.startsWith("due.p1.today.")) throw "TickTick due date update failed with status 500";
    if (action.includes("失败")) throw "TickTick create failed with status 500";
    return true;
  }
  return null;
}, { shouldMockEvents: true });
