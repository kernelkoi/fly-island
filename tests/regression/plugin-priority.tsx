// Priority rows: a task's own importance as a short word in front of the title, "none" left out,
// and the optional priority order. The island is narrow, so the badge must stay inline.
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { I18nProvider, LOCALE_STORAGE_KEY, TRANSLATIONS } from "../../src/i18n";
import { PluginTasksPanel } from "../../src/features/plugins/PluginTasksPanel";
import { PluginFocusProvider } from "../../src/features/plugins/PluginFocusContext";
import { PLUGIN_RUNTIME_ENABLED } from "../../src/features/releaseFlags.ts";

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
// The provider's scale: 5 high, 3 medium, 1 low, 0 none.
const row = (id: string, title: string, due: string, priority: number, updatedAt: number) =>
  ({ id, title, detail: null, kind: "task", cwd: "工作", listId: "p1", due, repeat: false, status: "running", updatedAt, action: `complete.${id}`, priority });
const snapshot = {
  registry: { developerMode: true, indexUrl: "", installed: { dida365: {
    manifest: { id: "dida365", name: { "zh-CN": "滴答清单", en: "TickTick" }, description: null, icon: "ticktick", version: "0.1.9", apiVersion: 1,
      runtime: { command: "dida365.exe" }, permissions: ["network", "sessions"], contributes: ["sessions"], settings: [], actions: [] },
    enabled: true, directory: "plugins/dida365", development: true, settings: {},
  } } },
  live: { dida365: { status: "running", quota: [], composer: true, notifications: [], sessions: [
    // Overdue first in every mode, so the priority order is checked inside the dated group.
    row("p1:late", "逾期无优先级", dayFromNow(-1), 0, 10),
    row("p1:none", "无优先级", dayFromNow(0), 0, 20),
    row("p1:low", "低优先级", dayFromNow(0), 1, 30),
    row("p1:high", "高优先级", dayFromNow(0), 5, 40),
    row("p1:medium", "中优先级", dayFromNow(0), 3, 50),
  ] } },
};
mockIPC((command) => (command === "get_plugins" ? snapshot : null), { shouldMockEvents: true });

const messages: string[] = [];
function check(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
  messages.push(`PASS ${label}`);
}
const wait = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
const rowOf = (title: string) => [...document.querySelectorAll<HTMLElement>(".plugin-tasks__row")]
  .find((row) => row.querySelector(".todo-title")?.textContent?.includes(title)) ?? null;
const badgeOf = (title: string) => rowOf(title)?.querySelector<HTMLElement>(".plugin-tasks__priority") ?? null;
const titles = () => [...document.querySelectorAll(".plugin-tasks__row .todo-title")]
  .map((title) => title.textContent?.replace(/^(低|中|高|Low|Med|High)/, "") ?? "");

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
    check(document.querySelectorAll(".plugin-tasks__row").length === 5, "五条任务都显示");
    check(badgeOf("无优先级") === null && badgeOf("逾期无优先级") === null, "「无」不显示标记");
    check(badgeOf("低优先级")?.textContent === t.priorities.low && badgeOf("低优先级")?.classList.contains("plugin-tasks__priority--low"),
      "低优先级显示一个字的标记");
    check(badgeOf("中优先级")?.textContent === t.priorities.medium && badgeOf("中优先级")?.classList.contains("plugin-tasks__priority--medium"),
      "中优先级显示标记");
    check(badgeOf("高优先级")?.textContent === t.priorities.high && badgeOf("高优先级")?.classList.contains("plugin-tasks__priority--high"),
      "高优先级显示标记");
    check(badgeOf("高优先级")?.getAttribute("aria-label") === t.priorityLabel(t.priorities.high, "高优先级"),
      "标记的无障碍名带着任务标题和档位");
    // The badge is inside the title span, right before the text, and never wraps the row.
    const titleNode = rowOf("高优先级")?.querySelector(".todo-title");
    check(titleNode?.firstElementChild?.classList.contains("plugin-tasks__priority")
      && titleNode?.textContent?.endsWith("高优先级"), "标记在标题前，属于标题这一行");
    check(getComputedStyle(badgeOf("高优先级")!).whiteSpace === "nowrap" && getComputedStyle(badgeOf("高优先级")!).display === "inline",
      "标记不换行、不占独立一行");
    // Default stays the due order: priority changes only the optional mode.
    check(titles().join("|") === "逾期无优先级|中优先级|高优先级|低优先级|无优先级", "默认仍按到期日，同一天按最近改动，不按优先级打乱");
    const sortButton = document.querySelector<HTMLButtonElement>(".plugin-tasks__aside .plugin-tasks__sort")!;
    await act(async () => sortButton.click()); await wait();
    const priorityOption = [...document.querySelectorAll<HTMLButtonElement>(".plugin-sort-menu__item")]
      .find((item) => item.querySelector(".plugin-sort-menu__label")?.textContent === t.sortModes.priority.label)!;
    await act(async () => priorityOption.click()); await wait();
    check(titles().join("|") === "逾期无优先级|高优先级|中优先级|低优先级|无优先级", "按优先级排序：高在前，无在后，逾期仍置顶");
  }
  results.textContent = `${messages.join("\n")}\n\n全部 ${messages.length} 项检查通过。`;
  results.dataset.result = "passed";
} catch (error) {
  results.textContent = `${messages.join("\n")}\nFAIL ${String(error)}`;
  results.dataset.result = "failed";
  console.error(error);
}
