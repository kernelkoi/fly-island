export type PluginPageText = {
  /** The plugins page: its header button label and empty state. */
  title: string;
  waiting: string;
  running: string;
  completed: string;
  empty: string;
  /** The plugin's secret settings are unset: point the way to them instead of "no tasks". */
  notConfigured: string;
  /** The refresh failed; the rows shown are the last good snapshot, kept with a note. */
  refreshFailed: string;
  actionExpired: string;
  actionUnconfirmed: string;
  /** Configured but nothing unfinished: a third state, distinct from both lines above. */
  noTasks: string;
  /** The provider's default inbox list: rows from it carry no name, the UI names it. */
  inbox: string;
  /** The detail line under a task title, composed from the day and repeat flag the plugin sends. */
  repeatsToday: string;
  repeatsSince: (date: string) => string;
  overdueDays: (days: number) => string;
  dueToday: string;
  dueOn: (date: string) => string;
  /** The list filter above a plugin's rows: "All lists" and its accessible group label. */
  allLists: string;
  filterLists: string;
  /** The date chips above a plugin's task list: the group's accessible name and each window. */
  filterDates: string;
  dateFilters: Record<"all" | "today" | "tomorrow" | "week" | "overdue", string>;
  /** The calendar's day count and the legend below the month grid. */
  taskCount: (total: number) => string;
  legendOverdue: string;
  legendToday: string;
  legendUndated: (total: number) => string;
  /** The quick-add input's placeholder and accessible name, e.g. "Add task · Today". */
  addTaskFor: (day: string) => string;
  /** The quick-add rejection when the title is over the shared 200-character cap. */
  titleTooLong: string;
  /** The check button that runs a session's action. */
  markComplete: (title: string) => string;
  /** A row finished today: its check undoes the completion instead of redoing it. */
  reopenTask: (title: string) => string;
  /** The group at the bottom of the todo view that holds today's finished rows. */
  completedGroup: (total: number) => string;
  /** The sort menu in the todo view: its button name, then each mode's name and one line saying
   *  what that mode does to the order, so the menu never asks the reader to guess. */
  sortMode: string;
  sortModes: Record<"due" | "updated" | "list" | "priority", { label: string; hint: string }>;
  /** The task's own importance, as a short word on the row. "none" is not drawn at all. */
  priorities: Record<"low" | "medium" | "high", string>;
  /** The priority mark on a row, named for anyone who cannot see the colour. */
  priorityLabel: (level: string, title: string) => string;
  /** The row's due-day editor: its button label, and an undated row's button text. */
  changeDueDate: (title: string, date: string) => string;
  noDueDate: string;
};

// "2026-11-20" → "11月20日"; string math so node tests and browsers agree.
const monthDayZh = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
// "2026-11-20" → "Nov 20".
const monthDayEn = (date: string) => `${MONTHS_EN[Number(date.slice(5, 7)) - 1] ?? date.slice(5)} ${Number(date.slice(8, 10))}`;

export const zhCN: PluginPageText = {
  title: "插件",
  waiting: "待处理",
  running: "进行中",
  completed: "已完成",
  empty: "启用的插件还没有发布任务",
  notConfigured: "插件还没有配置，去设置里填 API 口令",
  refreshFailed: "刷新失败，显示的是上次的数据",
  actionExpired: "操作排队超时，尚未执行。请重试。",
  actionUnconfirmed: "操作结果未确认。请先到原应用核对，再决定是否重试。",
  noTasks: "没有待办",
  inbox: "收集箱",
  repeatsToday: "重复任务 · 今天",
  repeatsSince: (date) => `重复任务 · ${monthDayZh(date)}起`,
  overdueDays: (days) => `逾期 ${days} 天`,
  dueToday: "今天到期",
  dueOn: (date) => `${monthDayZh(date)}到期`,
  allLists: "全部",
  filterLists: "按清单筛选",
  filterDates: "按日期筛选",
  dateFilters: { all: "全部", today: "今天", tomorrow: "明天", week: "未来7天", overdue: "逾期" },
  taskCount: (total) => `${total} 条待办`,
  legendOverdue: "逾期",
  legendToday: "今天",
  legendUndated: (total) => `无日期 ${total} 不显示`,
  addTaskFor: (day) => `添加待办 · ${day}`,
  titleTooLong: "标题最多 200 字",
  markComplete: (title) => `完成：${title}`,
  reopenTask: (title) => `撤销完成：${title}`,
  completedGroup: (total) => `已完成 ${total}`,
  sortMode: "排序方式",
  sortModes: {
    due: { label: "到期日", hint: "逾期的在前，没日期的在最后" },
    updated: { label: "最近改动", hint: "刚改过的在前" },
    list: { label: "按清单", hint: "同一清单挨在一起，组内按到期日" },
    priority: { label: "优先级", hint: "重要的在前，组内按到期日" },
  },
  priorities: { low: "低", medium: "中", high: "高" },
  priorityLabel: (level, title) => `${title} · 优先级${level}`,
  changeDueDate: (title, date) => `修改到期日：${title} · ${date}`,
  noDueDate: "无到期日",
};

export const en: PluginPageText = {
  title: "Plugins",
  waiting: "Waiting",
  running: "Running",
  completed: "Completed",
  empty: "No enabled plugin has published tasks yet",
  notConfigured: "Not configured yet — add the API token in Settings",
  refreshFailed: "Refresh failed; showing the last snapshot",
  actionExpired: "The action timed out before it started. Try again.",
  actionUnconfirmed: "Result not confirmed. Check the original app before retrying.",
  noTasks: "No tasks",
  inbox: "Inbox",
  repeatsToday: "Repeats today",
  repeatsSince: (date) => `Repeats · since ${monthDayEn(date)}`,
  overdueDays: (days) => (days === 1 ? "Overdue 1 day" : `Overdue ${days} days`),
  dueToday: "Today",
  dueOn: monthDayEn,
  allLists: "All",
  filterLists: "Filter by list",
  filterDates: "Filter by date",
  dateFilters: { all: "All", today: "Today", tomorrow: "Tomorrow", week: "Next 7 days", overdue: "Overdue" },
  taskCount: (total) => `${total} tasks`,
  legendOverdue: "Overdue",
  legendToday: "Today",
  legendUndated: (total) => `No date ${total} hidden`,
  addTaskFor: (day) => `Add task · ${day}`,
  titleTooLong: "Title can be at most 200 characters",
  markComplete: (title) => `Complete: ${title}`,
  reopenTask: (title) => `Undo complete: ${title}`,
  completedGroup: (total) => `Completed ${total}`,
  sortMode: "Sort by",
  sortModes: {
    due: { label: "Due date", hint: "Overdue first, undated last" },
    updated: { label: "Last updated", hint: "Most recently edited first" },
    list: { label: "List", hint: "Same list together, due date inside" },
    priority: { label: "Priority", hint: "Most important first, due date inside" },
  },
  priorities: { low: "Low", medium: "Med", high: "High" },
  priorityLabel: (level, title) => `${title} · Priority ${level}`,
  changeDueDate: (title, date) => `Change due date: ${title} · ${date}`,
  noDueDate: "No due date",
};
