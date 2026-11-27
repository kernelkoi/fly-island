// The real island with a mocked plugin host: starting a plugin task must fold the island and
// put the task's title (and its countdown) on the collapsed face.
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import { I18nProvider, LOCALE_STORAGE_KEY } from "../../src/i18n";
import { IslandApp } from "../../src/windows/island/IslandApp";
import { PluginFocusProvider } from "../../src/features/plugins/PluginFocusContext";
import { getLocalDateString } from "../../src/utils/date";
import { DEFAULT_MEDIA_STATE } from "../../src/features/media/mediaState";

Object.assign(globalThis, { isTauri: true, IS_REACT_ACT_ENVIRONMENT: true });
const original = new Map(Object.entries(localStorage).filter(([key]) => key.startsWith("fly-island-")));
for (const key of original.keys()) localStorage.removeItem(key);
localStorage.setItem(LOCALE_STORAGE_KEY, "zh-CN");
localStorage.setItem("fly-island-current-date", getLocalDateString());
localStorage.setItem("fly-island-settings", JSON.stringify({
  agentStatusEnabled: false, musicEnabled: false, shelfEnabled: false, mailEnabled: false,
  rotateTodos: false, todoRotationSeconds: 3, autoCollapseSeconds: 0, autoTuck: false,
  expandedScale: 1, carryOverIncompleteTodos: false, todoTimerEnabled: true, todoEnabled: true,
  showCollapsedText: true, collapsedAutoWidth: true,
}));
localStorage.setItem("fly-island-save-directory", "");

const dayFromNow = (offset: number) => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const manifest = {
  manifest: { id: "dida365", name: { "zh-CN": "滴答清单", en: "TickTick" }, description: { "zh-CN": "滴答清单", en: "TickTick" },
    icon: "ticktick", version: "0.1.9", apiVersion: 1, runtime: { command: "dida365.exe" },
    permissions: ["network", "quota", "sessions"], contributes: ["sessions"], settings: [], actions: [] },
  enabled: true, directory: "plugins/dida365", development: true, settings: {},
};
const snapshot = {
  registry: { developerMode: true, indexUrl: "", installed: { dida365: manifest } },
  live: { dida365: { status: "running", quota: [], composer: true, notifications: [], sessions: [
    { id: "p1:today", title: "今天要做的活", detail: null, kind: "task", due: dayFromNow(0), listId: "p1",
      repeat: false, cwd: "工作", status: "running", updatedAt: 20, action: "complete.p1.today" },
    { id: "p2:study", title: "学习清单的活", detail: null, kind: "task", due: dayFromNow(1), listId: "p2",
      repeat: false, cwd: "学习", status: "running", updatedAt: 40, action: "complete.p2.study" },
  ] } },
};

mockIPC((command) => {
  switch (command) {
    case "show_ready_island": return null;
    case "plugin:window|is_visible": return true;
    case "get_plugins": return snapshot;
    case "get_clipboard_history": return {
      settings: { enabled: false, captureImages: true, maxItems: 100, shortcut: "Ctrl+Shift+V", shortcutEnabled: false }, items: [],
    };
    case "get_file_shelf": return { items: [] };
    case "list_agent_sessions":
    case "agent_sessions_in_front":
    case "agent_approval_pending":
    case "get_qq_mail_state": return [];
    case "get_agent_status": return { codex: { phase: "idle", updatedAt: 0 }, claudeCode: { phase: "idle", updatedAt: 0 }, updatedAt: 0, statusPath: "" };
    case "get_media_state": return DEFAULT_MEDIA_STATE;
    case "get_foreground_fullscreen": return { active: false, onIslandMonitor: false };
    case "set_island_interaction": return "disabled";
    case "get_island_top_attachment": return true;
    case "set_qq_notifications_enabled":
    case "get_qq_notification_state": return { revision: 1, enabled: false, status: "disabled", items: [], error: null };
    case "set_wechat_reminders_enabled": return { revision: 1, enabled: false, status: "disabled", pending: false, lastAttentionAt: null, error: null, previewEnabled: false, previewStatus: "off", hideMinimizedTaskbar: false, messages: [] };
    case "set_translation_shortcut": return "";
    case "updater_configured":
    case "has_translation_secret": return false;
    default: return null;
  }
}, { shouldMockEvents: true });
mockWindows("main");

const root = createRoot(document.getElementById("root")!);
const results = document.getElementById("results")!;
const messages: string[] = [];
function check(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
  messages.push(`PASS ${label}`);
}
const settle = async () => {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
  }
};
const clickNode = (node: HTMLElement | null, label: string) => act(async () => {
  if (!node) throw new Error(`Missing ${label}`);
  node.click();
});
const click = (selector: string) => clickNode(document.querySelector<HTMLElement>(selector), selector);
/** The row of one task: the title may start with a priority badge, so match by inclusion. */
const rowOf = (title: string) => [...document.querySelectorAll<HTMLElement>(".plugin-tasks__row")]
  .find((row) => row.querySelector(".todo-title")?.textContent?.includes(title)) ?? null;

try {
  await act(async () => root.render(
    <StrictMode><I18nProvider><PluginFocusProvider><IslandApp /></PluginFocusProvider></I18nProvider></StrictMode>,
  ));
  await settle();
  // The plugins page exists because an enabled plugin publishes sessions.
  await click(".dot-button--plugins");
  await settle();
  check(document.querySelector(".plugin-tasks__row") !== null, "插件页列出插件发布的任务");
  await clickNode(rowOf("今天要做的活")?.querySelector<HTMLElement>(".plugin-tasks__focus") ?? null, "今天要做的活 的开始按钮");
  await settle();
  check(document.querySelector(".island--collapsed") !== null, "开始后岛收起");
  check(document.querySelector(".island__text-slot")?.textContent?.includes("今天要做的活"),
    "折叠岛显示正在做的那条任务标题");
  check(document.querySelector(".island__timer-pill") === null, "没有计时时折叠岛不显示倒计时");
  // The watch must still be there on the focused row: starting a task cannot take away the only
  // way to give it a countdown.
  await click(".dot-button--plugins");
  await settle();
  const watch = rowOf("今天要做的活")?.querySelector<HTMLElement>(".todo-timer-button") ?? null;
  check(watch !== null, "正在做的行仍显示怀表");
  await clickNode(watch, "正在做的行的怀表");
  await settle();
  check(document.querySelector(".todo-duration-picker") !== null, "怀表打开小时间设置");
  await click(".todo-duration-picker__start");
  await settle();
  check(document.querySelector(".island--collapsed") !== null, "开始一轮后岛收起");
  check(document.querySelector(".island__text-slot")?.textContent?.includes("今天要做的活")
    && /^\d{2}:\d{2}$/.test(document.querySelector(".island__timer-pill")?.textContent ?? ""),
    "折叠岛显示标题和倒计时");
  results.textContent = `${messages.join("\n")}\n\n全部 ${messages.length} 项检查通过。`;
  results.dataset.result = "passed";
} catch (error) {
  results.textContent = `${messages.join("\n")}\nFAIL ${String(error)}`;
  results.dataset.result = "failed";
  console.error(error);
}
