// The plugin page's date chips: one row above the add box, "and" with the list filter, and the
// quick add still targets the chosen list when the window leaves no rows in it.
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { I18nProvider, LOCALE_STORAGE_KEY, TRANSLATIONS } from "../../src/i18n";
import { PluginTasksPanel } from "../../src/features/plugins/PluginTasksPanel";
import { PluginFocusProvider } from "../../src/features/plugins/PluginFocusContext";
import { PLUGIN_RUNTIME_ENABLED } from "../../src/features/releaseFlags.ts";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/features/plugins/PluginTasksPanel.css";

Object.assign(globalThis, { isTauri: true, IS_REACT_ACT_ENVIRONMENT: true });
const locale = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "zh-CN";
localStorage.setItem(LOCALE_STORAGE_KEY, locale);
const t = TRANSLATIONS[locale].plugins;
const dayFromNow = (offset: number) => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const manifest = (id: string, name: string) => ({
  manifest: { id, name: { "zh-CN": name, en: name }, description: null, icon: id === "dida365" ? "ticktick" : null, version: "0.1.1",
    apiVersion: 1, runtime: { command: `${id}.exe` }, permissions: ["network", "sessions"], contributes: ["sessions"], settings: [], actions: [] },
  enabled: true, directory: `plugins/${id}`, development: true, settings: {},
});
const row = (id: string, title: string, due: string | null, cwd: string | null, extra = {}) =>
  ({ id, title, detail: null, kind: "task", cwd, listId: id.split(":")[0], due, repeat: false,
    status: "running", updatedAt: 10, action: `complete.${id}`, ...extra });
const snapshot = {
  registry: { developerMode: true, indexUrl: "", installed: {
    dida365: manifest("dida365", "滴答清单"),
    launcher: manifest("launcher", "快捷链接"),
  } },
  live: {
    dida365: { status: "running", quota: [], composer: true, notifications: [], sessions: [
      // The window boundaries sit on today +6 (inside) and today +7 (outside).
      row("p1:done", "已完成的活", dayFromNow(0), "工作", { status: "completed", updatedAt: 30, action: "reopen.p1.done" }),
      row("p1:late", "逾期的活", dayFromNow(-1), "工作", { status: "waiting", updatedAt: 10 }),
      row("p1:today", "今天要做的活", dayFromNow(0), "工作", { updatedAt: 20 }),
      row("p2:study", "学习清单的活", dayFromNow(1), "学习", { updatedAt: 40 }),
      row("p3:life", "生活清单的活", dayFromNow(3), "生活", { updatedAt: 5 }),
      row("inbox:quick", "收件箱的活", dayFromNow(1), null, { listId: "inbox", updatedAt: 50 }),
      row("p4:loop", "重复的活", dayFromNow(-1), "重复", { repeat: true, updatedAt: 60 }),
      row("p1:week-end", "第七天的活", dayFromNow(6), "工作", { updatedAt: 15 }),
      row("p1:beyond", "第八天的活", dayFromNow(7), "工作", { updatedAt: 12 }),
      row("p1:nodue", "没有日期的活", null, "工作", { updatedAt: 8 }),
    ] },
    // A plugin that publishes no due dates gets no date chips at all.
    launcher: { status: "running", quota: [], composer: true, notifications: [], sessions: [
      row("p9:app", "快捷方式", null, "常用", { updatedAt: 9 }),
    ] },
  },
};
const ran: string[] = [];
mockIPC((command, payload) => {
  if (command === "get_plugins") return snapshot;
  if (command === "run_plugin_action") {
    ran.push(`${(payload as { id?: string }).id}/${(payload as { action?: string }).action}`);
    return true;
  }
  return null;
}, { shouldMockEvents: true });

const messages: string[] = [];
function check(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
  messages.push(`PASS ${label}`);
}
const wait = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
const titles = () => [...document.querySelectorAll(".plugin-tasks__row .todo-title")].map((title) => title.textContent);

const root = createRoot(document.getElementById("fixture")!);
const results = document.getElementById("results")!;
try {
  await act(async () => root.render(
    <StrictMode><I18nProvider><PluginFocusProvider><PluginTasksPanel /></PluginFocusProvider></I18nProvider></StrictMode>,
  ));
  await wait();
  if (!PLUGIN_RUNTIME_ENABLED) {
    check(!document.querySelector(".plugin-tasks__row"), "关闭时没有任务行");
  } else {
    const chips = () => [...document.querySelectorAll<HTMLButtonElement>(".plugin-tasks__date")];
    const chipOf = (label: string) => chips().find((chip) => chip.textContent === label)!;
    const pickDate = async (label: string) => {
      await act(async () => chipOf(label).click()); await wait();
    };
    const listButton = () => document.querySelector<HTMLButtonElement>(".plugin-tasks__list")!;
    const pickList = async (label: string) => {
      await act(async () => listButton().click()); await wait();
      const item = [...document.querySelectorAll<HTMLButtonElement>(".plugin-list-menu__item")]
        .find((entry) => entry.querySelector(".plugin-list-menu__name")?.textContent === label)!;
      await act(async () => item.click()); await wait();
    };
    const labels = [t.dateFilters.all, t.dateFilters.today, t.dateFilters.tomorrow, t.dateFilters.week, t.dateFilters.overdue];
    check(document.querySelectorAll(".plugin-tasks__dates").length === 1, "发布到期日的插件块才有一排日期标签");
    check(chips().map((chip) => chip.textContent).join("|") === labels.join("|"), "五个日期标签按全部 / 今天 / 明天 / 未来7天 / 逾期排列");
    check(document.querySelector(".plugin-tasks__dates")?.getAttribute("role") === "group"
      && document.querySelector(".plugin-tasks__dates")?.getAttribute("aria-label") === t.filterDates, "日期标签组有无障碍名");
    check(chipOf(t.dateFilters.all).getAttribute("aria-pressed") === "true"
      && chips().filter((chip) => chip.getAttribute("aria-pressed") === "true").length === 1, "默认选中全部，且只选中一个");
    check(document.querySelector(".plugin-tasks__toolbar")?.nextElementSibling?.classList.contains("plugin-tasks__dates")
      && document.querySelector(".plugin-tasks__dates")?.nextElementSibling?.classList.contains("plugin-tasks__add"),
      "日期标签在视图按钮下方、添加框上方");

    await pickDate(t.dateFilters.today);
    check(titles().join("|") === "重复的活|今天要做的活|已完成的活|快捷方式",
      "今天：留下今天到期的行、重复任务和已完成的行；无日期的块不受影响");
    check(chipOf(t.dateFilters.today).getAttribute("aria-pressed") === "true"
      && chipOf(t.dateFilters.all).getAttribute("aria-pressed") === "false", "选中的标签换成今天");

    await pickDate(t.dateFilters.tomorrow);
    check(titles().join("|") === "收件箱的活|学习清单的活|快捷方式", "明天：只留明天到期的行");
    await pickDate(t.dateFilters.week);
    check(titles().join("|") === "重复的活|今天要做的活|收件箱的活|学习清单的活|生活清单的活|第七天的活|已完成的活|快捷方式",
      "未来7天：今天到第 7 天，第 8 天不进来");
    await pickDate(t.dateFilters.overdue);
    check(titles().join("|") === "逾期的活|快捷方式", "逾期：只留日期已过的行，重复任务不算逾期");
    await pickDate(t.dateFilters.all);
    check(titles().length === 11, "回到全部后两边插件的行都在");

    // The two filters are "and", and an empty window must not redirect quick add.
    await pickList("工作");
    await pickDate(t.dateFilters.today);
    check(titles().join("|") === "今天要做的活|已完成的活|快捷方式", "清单和日期同时生效，两个条件都要满足");
    await pickList("生活");
    await pickDate(t.dateFilters.today);
    check(!document.querySelector(".plugin-tasks__row .todo-title")?.textContent?.includes("生活清单的活"),
      "该清单在这个窗口里没有行时不显示它的任务");
    const input = document.querySelector<HTMLInputElement>(".plugin-tasks__add input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "空窗口添加");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await wait();
    check(ran.includes(`dida365/create.${dayFromNow(0)}.list:p3.空窗口添加`), "日期标签为空时不改变快速添加的目标清单");

    // The calendar keeps the list filter only; the chips are the list's own window.
    await pickDate(t.dateFilters.all);
    await pickList(t.allLists);
    await act(async () => document.querySelector<HTMLButtonElement>('.todo-view-switch__segment[data-view="calendar"]')!.click());
    await wait();
    check(document.querySelector(".plugin-calendar") && !document.querySelector(".plugin-tasks__dates"), "日历视图不显示日期标签");
  }
  results.textContent = `${messages.join("\n")}\n\n全部 ${messages.length} 项检查通过。`;
  results.dataset.result = "passed";
} catch (error) {
  results.textContent = `${messages.join("\n")}\nFAIL ${String(error)}`;
  results.dataset.result = "failed";
  console.error(error);
}
