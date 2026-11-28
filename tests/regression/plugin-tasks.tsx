import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, TRANSLATIONS } from "../../src/i18n";
import { PluginTasksPanel } from "../../src/features/plugins/PluginTasksPanel";
import { PluginFocusProvider } from "../../src/features/plugins/PluginFocusContext";
import { PLUGIN_RUNTIME_ENABLED } from "../../src/features/releaseFlags.ts";
import { dayFromNow, dayToday, locale, name, ran, setDidaStatus, t, todoText } from "./pluginTasksFixture.ts";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/features/plugins/PluginTasksPanel.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const messages: string[] = [];
function check(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
  messages.push(`PASS ${label}`);
}
const wait = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
const root = createRoot(document.getElementById("fixture")!);
try {
  await act(async () => root.render(
    <StrictMode><I18nProvider><PluginFocusProvider><PluginTasksPanel /></PluginFocusProvider></I18nProvider></StrictMode>,
  ));
  await wait();
  if (!PLUGIN_RUNTIME_ENABLED) {
    check(!document.querySelector(".plugin-tasks__row"), "关闭时没有任务行");
  } else {
    const rows = [...document.querySelectorAll(".plugin-tasks__row")];
    const titles = () => [...document.querySelectorAll(".plugin-tasks__row .todo-title")].map((title) => title.textContent);
    check(rows.length === 9, "只有启用的、发布会话的插件出任务行（空会话且无状态的插件整块不显示）");
    check(titles().join("|") === "逾期的活|重复的活|今天要做的活|收件箱的活|学习清单的活|生活清单的活|刚完成的活|已完成的活|上次拉到的活",
      "未完成任务在上，已完成分组在列表底部，组内最近完成的在上");
    check(rows[0].querySelector(".plugin-tasks__detail")?.textContent === `工作 · ${t.overdueDays(1)}`, "详情行显示清单和到期信息");
    check(!rows.some((row) => row.querySelector(".plugin-tasks__detail")?.textContent?.includes("进行中")), "任务行不显示 Agent 的状态词");
    check(rows[0].classList.contains("todo-item"), "任务行使用待办页的行样式");
    check(!document.querySelector(".plugin-tasks .plugin-icon"), "插件页不再显示插件标志");
    check(!document.querySelector(".agent-quota__values span")?.textContent, "插件块不再重复显示额度名");
    check((document.querySelector(".plugin-tasks__plugin") as HTMLElement | null)?.getAttribute("aria-label") === name[locale],
      "插件名只作为无障碍标签");
    check(!document.querySelector(".plugin-tasks__plugin-name"), "待办和日历上方不再显示插件名字样");
    check(document.querySelectorAll(".plugin-tasks__plugin").length === 4,
      "有内容、声明 composer、未配置和刷新失败的插件各占一块");
    const blocks = [...document.querySelectorAll<HTMLElement>(".plugin-tasks__plugin")];
    const unconfigured = blocks.find((block) => block.querySelector(".plugin-tasks__empty"));
    check(unconfigured?.querySelector(".plugin-tasks__empty")?.textContent === t.notConfigured,
      "未配置的插件引导去设置而不是被当成没有任务");
    check(!unconfigured?.querySelector("input"), "未配置的插件不显示快速添加");
    const staleBlock = blocks.find((block) => block.querySelector(".plugin-tasks__stale"));
    check(staleBlock?.querySelector(".plugin-tasks__stale")?.textContent === t.refreshFailed,
      "刷新失败给出一次失败提示");
    check(staleBlock?.querySelector(".plugin-tasks__row .todo-title")?.textContent === "上次拉到的活",
      "刷新失败保留上次的任务行");
    const emptyBlock = blocks.find((block) => block.querySelector(".plugin-tasks__none"));
    check(emptyBlock?.querySelector(".plugin-tasks__none")?.textContent === t.noTasks,
      "已配置但没有未完成任务时显示没有待办");
    check(document.querySelector(".plugin-tasks .agent-quota__agent"), "额度环用 Agent 页的原生组件");
    check(document.querySelector(".plugin-tasks__progress span")?.textContent === "2/8", "待办视图显示完成进度");
    const viewSwitch = document.querySelector(".plugin-tasks__toolbar .todo-view-switch");
    check(viewSwitch && viewSwitch.querySelectorAll(".todo-view-switch__segment").length === 2, "插件页有待办和日历两个视图");
    await act(async () => document.querySelector<HTMLButtonElement>('.todo-view-switch__segment[data-view="calendar"]')!.click()); await wait();
    check(document.querySelector(".plugin-calendar") && !document.querySelector(".plugin-tasks__dates"), "切到日历后显示月历，不显示日期标签");
    const dayRows = [...document.querySelectorAll(".todo-day-row")];
    check(dayRows.length === 3 && dayRows.map((row) => row.textContent).join("|").includes("今天要做的活"), "日历右栏只列选中那天的任务");
    check(dayRows.some((row) => row.classList.contains("todo-day-row--done")), "已完成任务在日历里划线");
    check(dayRows.every((row) => row.querySelector("button.todo-day-row__check")), "日历的行用左边的方框勾选");
    check(!document.querySelector(".todo-day-detail .todo-day-row__button"), "日历的行不再把勾选放在右边");
    const dayRowOf = (title: string) => dayRows.find((row) => row.textContent === title)!;
    const doneCheck = dayRowOf("已完成的活").querySelector<HTMLButtonElement>(".todo-day-row__check")!;
    check(doneCheck.getAttribute("aria-pressed") === "true" && doneCheck.getAttribute("aria-label") === t.reopenTask("已完成的活"),
      "已完成的方框表示已勾选，点它撤销完成");
    await act(async () => doneCheck.click()); await wait();
    check(ran.includes("dida365/reopen.p1.done"), "在日历里点方框撤销该任务");
    const openCheck = dayRowOf("今天要做的活").querySelector<HTMLButtonElement>(".todo-day-row__check")!;
    check(openCheck.getAttribute("aria-pressed") === "false" && openCheck.getAttribute("aria-label") === t.markComplete("今天要做的活"),
      "未完成的方框表示未勾选，点它完成任务");
    await act(async () => openCheck.click()); await wait();
    check(ran.includes("dida365/complete.p1.today"), "在日历里点方框完成该任务");
    await act(async () => dayRowOf("刚完成的活").querySelector<HTMLButtonElement>(".todo-day-row__check")!.click()); await wait();
    check(document.querySelector(".plugin-calendar__error")?.textContent === "TickTick reopen failed with status 404",
      "日历里撤销失败时行内说明原因");
    // 计数只算未完成：今天三行里只有一行还没做完。
    check(document.querySelector(".todo-day-detail__summary")?.textContent === t.taskCount(1), "日历的当天任务数不计已完成");
    const legendText = document.querySelector(".todo-date-overview__sidebar .plugin-calendar__legend")?.textContent ?? "";
    check(legendText.includes(`${t.legendOverdue} 2`) && legendText.includes(`${t.legendToday} 1`),
      "月历下方显示逾期和今天数量");
    check(legendText.includes(t.legendUndated(0)), "无日期任务在图例里注明不显示");
    check(!document.querySelector(".todo-day-detail .plugin-calendar__legend"), "图例不在右侧任务栏");
    const addInput = document.querySelector<HTMLInputElement>(".plugin-quick-add--calendar input");
    check(addInput?.placeholder === t.addTaskFor(dayToday), "右栏底部有快速添加输入框");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(addInput, "买牛奶");
      addInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait();
    await act(async () => {
      addInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await wait();
    check(ran.includes(`dida365/create.${dayFromNow(0)}.买牛奶`), "回车把标题和选中日期交给插件");
    check(addInput?.value === "", "添加成功后清空输入框");
    await act(async () => document.querySelector<HTMLButtonElement>('.todo-view-switch__segment[data-view="today"]')!.click()); await wait();
    const listAdd = document.querySelector<HTMLInputElement>(".plugin-tasks__add input");
    check(document.querySelectorAll(".plugin-tasks__add input").length === 2,
      "没有任务但声明 composer 的插件也显示添加框");
    check(listAdd?.placeholder === t.addTaskFor(dayToday), "待办视图也有快速添加输入框");
    check(document.querySelector(".plugin-tasks__toolbar")?.nextElementSibling?.classList.contains("plugin-tasks__dates"),
      "日期标签紧跟在待办和日历按钮下方");
    check(document.querySelector(".plugin-tasks__dates")?.nextElementSibling?.classList.contains("plugin-tasks__add"),
      "日期标签在添加框上方、任务列表顶部");
    check(getComputedStyle(document.querySelector(".plugin-tasks__add")!).position !== "sticky",
      "快速添加不再固定在页面底部，不遮挡任务行");
    await act(async () => {
      setter.call(listAdd, "写周报");
      listAdd!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait();
    await act(async () => {
      listAdd!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await wait();
    check(ran.includes(`dida365/create.${dayFromNow(0)}.写周报`), "待办页回车把标题和今天交给插件");
    check(listAdd?.value === "", "待办页添加成功后清空输入框");
    // The list filter is one toolbar button: the list in view and its open count, others in a menu.
    // Re-queried each time: the button unmounts while the calendar view is showing.
    const listButton = () => document.querySelector<HTMLButtonElement>(".plugin-tasks__list")!;
    check(listButton()?.getAttribute("aria-haspopup") === "menu", "清单筛选收进工具栏的一个菜单按钮");
    check(listButton().querySelector(".plugin-tasks__list-name")?.textContent === t.allLists
      && listButton().querySelector("b")?.textContent === "6", "按钮显示当前清单和未完成数");
    check(!document.querySelector(".plugin-tasks__filters") && !document.querySelector(".plugin-tasks__filter"),
      "不再有单独的清单胶囊行");
    const openListMenu = async () => {
      await act(async () => listButton().click()); await wait();
      return document.querySelector<HTMLDivElement>(".plugin-list-menu")!;
    };
    const listItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".plugin-list-menu__item")]
      .find((item) => item.querySelector(".plugin-list-menu__name")?.textContent === label)!;
    const itemCount = (label: string) => listItem(label).querySelector(".plugin-list-menu__count")?.textContent;
    const pickList = async (label: string) => {
      await openListMenu();
      await act(async () => listItem(label).click()); await wait();
    };
    const menu = await openListMenu();
    check(menu.getAttribute("role") === "menu" && menu.getAttribute("aria-label") === t.filterLists,
      "清单菜单有无障碍名");
    const items = [...menu.querySelectorAll<HTMLButtonElement>(".plugin-list-menu__item")];
    check(items.length === 6 && items[0].querySelector(".plugin-list-menu__name")?.textContent === t.allLists, "菜单列出全部和五个清单");
    check(items[0].getAttribute("aria-checked") === "true" && items.filter((item) => item.getAttribute("aria-checked") === "true").length === 1, "当前清单打勾且只打一个");
    check(itemCount(t.allLists) === "6" && itemCount("工作") === "2" && itemCount("学习") === "1"
      && itemCount("生活") === "1" && itemCount("重复") === "1" && itemCount(t.inbox) === "1",
      "每个清单显示自己的未完成数（已完成的不计入）");
    await act(async () => listItem("工作").click());
    await wait();
    check(titles().join("|") === "逾期的活|今天要做的活|已完成的活|上次拉到的活", "筛选工作后仍按状态和时间排序");
    check(!document.querySelector(".plugin-list-menu"), "选完清单后菜单关闭");
    check(listButton().querySelector(".plugin-tasks__list-name")?.textContent === "工作"
      && listButton().querySelector("b")?.textContent === "2", "按钮换成选中的清单和它的未完成数");
    check(document.querySelector(".plugin-tasks__row .plugin-tasks__detail")?.textContent === t.overdueDays(1), "选中清单后行内不再重复清单名");
    await openListMenu();
    check(itemCount(t.allLists) === "6" && itemCount("学习") === "1", "选中某个清单后，各清单计数不变");
    await act(async () => listItem("工作").click());
    await wait();
    const filterAdd = document.querySelector<HTMLInputElement>(".plugin-tasks__add input");
    await act(async () => {
      setter.call(filterAdd, "整理周报");
      filterAdd!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait();
    await act(async () => {
      filterAdd!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await wait();
    check(ran.includes(`dida365/create.${dayFromNow(0)}.list:p1.整理周报`), "筛选清单后添加目标跟随该清单");
    // The calendar's quick add follows the same list filter as the rows.
    await act(async () => document.querySelector<HTMLButtonElement>('.todo-view-switch__segment[data-view="calendar"]')!.click()); await wait();
    const calendarAdd = document.querySelector<HTMLInputElement>(".plugin-quick-add--calendar input");
    await act(async () => {
      setter.call(calendarAdd, "整理日历项");
      calendarAdd!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait();
    await act(async () => {
      calendarAdd!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await wait();
    check(ran.includes(`dida365/create.${dayFromNow(0)}.list:p1.整理日历项`), "日历右栏快速添加也跟随清单筛选");
    await act(async () => document.querySelector<HTMLButtonElement>('.todo-view-switch__segment[data-view="today"]')!.click()); await wait();
    await pickList("学习");
    check(titles().join("|") === "学习清单的活|刚完成的活|上次拉到的活", "筛选学习只留该清单的行，已完成的也在其中");
    await pickList(t.allLists);
    check(titles().length === 9, "回到全部后恢复所有行");
    // The inbox and repeat rows get their wording from the UI's own language, not the plugin.
    const inboxRow = [...document.querySelectorAll(".plugin-tasks__row")]
      .find((row) => row.querySelector(".todo-title")?.textContent === "收件箱的活")!;
    check(inboxRow.querySelector(".plugin-tasks__detail")?.textContent === `${t.inbox} · ${t.dueOn(dayFromNow(1))}`,
      "收集箱行用前端文案命名清单和到期");
    const loopRow = [...document.querySelectorAll(".plugin-tasks__row")]
      .find((row) => row.querySelector(".todo-title")?.textContent === "重复的活")!;
    check(loopRow.querySelector(".plugin-tasks__detail")?.textContent === `重复 · ${t.repeatsToday}`,
      "重复任务行不显示逾期而是今天的重复文案");
    // A rejected quick add keeps the text and shows the host's error as-is.
    const failAdd = document.querySelector<HTMLInputElement>(".plugin-tasks__add input");
    await act(async () => {
      setter.call(failAdd, "失败添加");
      failAdd!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait();
    await act(async () => {
      failAdd!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await wait();
    check(ran.includes(`dida365/create.${dayFromNow(0)}.失败添加`), "失败的动作也送到了插件");
    check(failAdd?.value === "失败添加", "添加失败后输入保留");
    check(document.querySelector(".plugin-tasks__add .plugin-quick-add__error")?.textContent === "TickTick create failed with status 500",
      "添加失败在输入框下显示行内错误");
    for (const [draft, message] of [["未确认", t.actionUnconfirmed], ["排队过期", t.actionExpired]]) {
      await act(async () => {
        setter.call(failAdd, draft);
        failAdd!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => failAdd!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      await wait();
      check(failAdd?.value === draft && document.querySelector('.plugin-tasks__add [role="alert"]')?.textContent === message,
        "新建未确认与未执行的提示不同，且都保留输入");
      check(ran.filter((id) => id.endsWith(`.${draft}`)).length === 1, "不自动重试新建");
    }
    // Losing the reply to a worker restart must not take the box, the text or the advice with it.
    const restartDraft = "重启未确认";
    await act(async () => {
      setter.call(failAdd, restartDraft);
      failAdd!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => failAdd!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await wait();
    const restartInput = () => document.querySelector<HTMLInputElement>(".plugin-tasks__add input");
    check(restartInput()?.value === restartDraft && document.querySelector('.plugin-tasks__add [role="alert"]')?.textContent === t.actionUnconfirmed,
      "插件重启时草稿和「先核对」提示都保留");
    check(restartInput()?.disabled === true, "重启期间不能再提交");
    await act(async () => setDidaStatus("running", false));
    await wait();
    check(restartInput()?.disabled === false && restartInput()?.value === restartDraft, "插件恢复后仍是同一份草稿");
    await act(async () => {
      setter.call(restartInput(), "");
      restartInput()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Titles past the shared 200-character cap are rejected before the action runs.
    await act(async () => {
      setter.call(failAdd, "测".repeat(201));
      failAdd!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait();
    await act(async () => {
      failAdd!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await wait();
    check(document.querySelector(".plugin-tasks__add .plugin-quick-add__error")?.textContent === t.titleTooLong, "超长标题被前端拦下并提示");
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".plugin-tasks__row .todo-check")];
    check(buttons.length === 9 && buttons.every((button) => !button.disabled), "未完成和已完成的勾选都可以点（后者是撤销）");
    // Today's finished rows sit in their own group at the bottom, newest completion first.
    const doneGroup = document.querySelector(".plugin-tasks__done");
    check(doneGroup?.querySelector(".plugin-tasks__done-head")?.textContent === t.completedGroup(2), "待办页底部有已完成分组");
    check([...(doneGroup?.querySelectorAll(".todo-title") ?? [])].map((title) => title.textContent).join("|") === "刚完成的活|已完成的活", "已完成分组里最近完成的在上");
    check(document.querySelector(".plugin-tasks__plugin")?.lastElementChild?.classList.contains("plugin-tasks__done"), "已完成分组排在列表最下方");
    const rowOf = (title: string) => [...document.querySelectorAll(".plugin-tasks__row")].find((row) => row.querySelector(".todo-title")?.textContent === title)!;
    const checkOf = (title: string) => rowOf(title).querySelector<HTMLButtonElement>(".todo-check")!;
    // Starting a task is this side's own act: it runs no plugin action and writes nothing back.
    const startOf = (title: string) => rowOf(title).querySelector<HTMLButtonElement>(".plugin-tasks__focus")!;
    check(document.querySelectorAll(".plugin-tasks__focus").length === 7, "只有未完成的行有开始按钮，已完成的行没有");
    check(startOf("逾期的活").getAttribute("aria-label") === todoText.actionOnTask(todoText.start, "逾期的活"), "开始按钮有无障碍名称");
    const ranBeforeStart = ran.length;
    await act(async () => startOf("逾期的活").click()); await wait();
    check(ran.length === ranBeforeStart, "开始任务不调用插件动作，不改滴答里的数据");
    check(startOf("逾期的活").getAttribute("aria-pressed") === "true" && rowOf("逾期的活").classList.contains("todo-item--active") && !startOf("逾期的活").querySelector(".todo-countdown"), "开始后这一行标为正在做，不自动开计时");
    check(startOf("今天要做的活").getAttribute("aria-pressed") === "false", "别的行没有同时被标为正在做");
    await act(async () => startOf("今天要做的活").click()); await wait();
    check(startOf("今天要做的活").getAttribute("aria-pressed") === "true" && startOf("逾期的活").getAttribute("aria-pressed") === "false", "同一时间只有一条正在做，点另一条就切过去");
    await act(async () => startOf("今天要做的活").click()); await wait();
    check(startOf("今天要做的活").getAttribute("aria-pressed") === "false", "再点一次停止");
    const watchOf = (title: string) => rowOf(title).querySelector<HTMLButtonElement>(".todo-timer-button")!;
    check(watchOf("今天要做的活").getAttribute("aria-label") === todoText.changeDuration(15), "开始按钮旁的怀表默认 15 分钟");
    // The watch's own setter is what starts a round: click it, then the little start in the card.
    await act(async () => watchOf("今天要做的活").click()); await wait();
    const picker = document.querySelector<HTMLFormElement>(".todo-duration-picker");
    check(picker !== null && picker.querySelector("input")?.value === "15", "点怀表打开小时间设置，默认 15 分钟");
    await act(async () => picker!.querySelector<HTMLButtonElement>(".todo-duration-picker__start")!.click()); await wait();
    check(!document.querySelector(".todo-duration-picker"), "小时间设置里的开始关闭卡片");
    check(startOf("今天要做的活").getAttribute("aria-pressed") === "true", "小时间设置里的开始把这条标为正在做");
    check(!!startOf("今天要做的活").querySelector(".todo-countdown"), "开始一轮后按钮里出现倒计时");
    check(JSON.parse(localStorage.getItem("fly-island-plugin-focus") ?? "null")?.focus?.timer?.durationMinutes === 15, "这一轮的时长写进本地焦点");
    await act(async () => startOf("今天要做的活").click()); await wait();
    check(startOf("今天要做的活").getAttribute("aria-pressed") === "false" && !startOf("今天要做的活").querySelector(".todo-countdown"), "再点一次停止，倒计时一起消失");
    check(checkOf("已完成的活").getAttribute("aria-label") === t.reopenTask("已完成的活"), "已完成行的勾选读作撤销完成");
    await act(async () => checkOf("刚完成的活").click()); await wait();
    check(ran.includes("dida365/reopen.p2.done2"), "点已完成行的勾运行撤销动作");
    check(rowOf("刚完成的活").querySelector(".plugin-tasks__error")?.textContent === "TickTick reopen failed with status 404", "撤销失败在行内显示错误");
    await act(async () => checkOf("已完成的活").click()); await wait();
    check(ran.includes("dida365/reopen.p1.done") && !rowOf("已完成的活").querySelector(".plugin-tasks__error"), "撤销成功不留行内错误");
    await act(async () => checkOf("逾期的活").click()); await wait();
    check(ran.includes("dida365/complete.p1.late"), "点勾运行该会话的动作");
    check(rowOf("逾期的活").querySelector(".plugin-tasks__error")?.textContent === "TickTick completion failed with status 401", "勾选失败在行内显示错误");
    check(checkOf("逾期的活").getAttribute("aria-label") === t.markComplete("逾期的活"), "勾选按钮有无障碍名称");
    // The due-day editor: only rows that declared the namespace get one, and it writes back.
    const monthDay = (date: string) => new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(new Date(`${date}T00:00:00`));
    const dueButtonOf = (title: string) => rowOf(title).querySelector<HTMLButtonElement>(".plugin-due-date .todo-date-picker__button")!;
    const pickDay = async (day: string) => {
      // The month is portaled out of the row (and the island's scaled panel) while open.
      await act(async () => document.querySelector<HTMLButtonElement>(`.todo-date-popover [data-date="${day}"]`)!.click());
      await wait();
    };
    check(document.querySelectorAll(".plugin-due-date").length === 7, "每个未完成行都有改到期日按钮");
    check(!rowOf("已完成的活").querySelector(".plugin-due-date"), "已完成行不改到期日");
    check(dueButtonOf("逾期的活").getAttribute("aria-label") === t.changeDueDate("逾期的活", monthDay(dayFromNow(-1))),
      "改到期日按钮的无障碍名带着任务和当前日期");
    await act(async () => dueButtonOf("逾期的活").click()); await wait();
    check(document.querySelector(".todo-date-popover"), "点日期按钮打开月历");
    check(!document.querySelector<HTMLButtonElement>(`.todo-date-popover [data-date="${dayFromNow(-3)}"]`)?.disabled,
      "改到期日允许选择过去的日期");
    await pickDay(dayFromNow(1));
    check(ran.includes(`dida365/due.p1.late.${dayFromNow(1)}`), "选择新日期把该行的命名空间动作发给插件");
    check(dueButtonOf("逾期的活").getAttribute("aria-label") === t.changeDueDate("逾期的活", monthDay(dayFromNow(1))),
      "选完后按钮显示新日期");
    await act(async () => dueButtonOf("学习清单的活").click()); await wait();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".todo-date-popover__footer button")]
      .find((button) => button.textContent === TRANSLATIONS[locale].notebook.clearDate)!.click());
    await wait();
    check(ran.includes("dida365/due.p2.study.clear"), "清除日期把 clear 动作发给插件");
    check(dueButtonOf("学习清单的活").getAttribute("aria-label") === t.changeDueDate("学习清单的活", t.noDueDate),
      "清除后按钮读作无到期日");
    await act(async () => dueButtonOf("今天要做的活").click()); await wait();
    await pickDay(dayFromNow(2));
    check(ran.includes(`dida365/due.p1.today.${dayFromNow(2)}`), "改到期日失败时动作也已发出");
    check(rowOf("今天要做的活").querySelector(".plugin-tasks__error")?.textContent === "TickTick due date update failed with status 500",
      "改到期日失败在行内显示原因");
    check(dueButtonOf("今天要做的活").getAttribute("aria-label") === t.changeDueDate("今天要做的活", monthDay(dayFromNow(0))),
      "失败后按钮回到原日期");
    // The sort picker names the mode in force, and each option says what it does to the order.
    const sortButton = document.querySelector<HTMLButtonElement>(".plugin-tasks__aside .plugin-tasks__sort");
    check(sortButton?.getAttribute("aria-label") === `${t.sortMode}: ${t.sortModes.due.label}` && sortButton?.querySelector(".plugin-tasks__sort-name")?.textContent === t.sortModes.due.label, "排序按钮显示当前规则名，无障碍名里也带着它");
    check(getComputedStyle(sortButton!).height === "24px" && sortButton?.nextElementSibling?.classList.contains("plugin-tasks__progress"), "排序按钮与工具栏其他按钮同高，排在进度条左侧");
    check(document.querySelectorAll(".plugin-tasks__sort").length === 2, "有待办行的插件块才有排序按钮");
    // 476px is the island at its narrowest (560 x the 0.85 scale): the row must still fit.
    const toolbar = document.querySelector<HTMLElement>(".plugin-tasks__toolbar")!;
    check(toolbar.scrollWidth <= toolbar.clientWidth, "工具栏在窄页里不溢出");
    await act(async () => sortButton!.click()); await wait();
    const sortMenu = document.querySelector(".plugin-sort-menu");
    check(sortMenu?.getAttribute("role") === "menu" && getComputedStyle(sortMenu).position === "fixed", "点排序按钮打开菜单，fixed 定位不被列表裁掉");
    const sortOptions = [...document.querySelectorAll<HTMLButtonElement>(".plugin-sort-menu__item")];
    check(sortOptions.length === 4 && sortOptions[0].getAttribute("aria-checked") === "true", "默认按到期日并打勾");
    check(sortOptions.map((item) => item.querySelector(".plugin-sort-menu__label")?.textContent).join("|")
      === [t.sortModes.due.label, t.sortModes.updated.label, t.sortModes.list.label, t.sortModes.priority.label].join("|")
      && sortOptions.every((item) => (item.querySelector(".plugin-sort-menu__hint")?.textContent ?? "").length > 0),
      "菜单列出到期日 / 最近改动 / 按清单 / 优先级，每种带一句说明");
    await act(async () => sortButton!.click()); await wait();
    const openSort = async () => {
      await act(async () => sortButton!.click()); await wait();
      return [...document.querySelectorAll<HTMLButtonElement>(".plugin-sort-menu__item")];
    };
    const pickSort = async (label: string) => {
      const option = (await openSort())
        .find((item) => item.querySelector(".plugin-sort-menu__label")?.textContent === label)!;
      await act(async () => option.click()); await wait();
    };
    await pickSort(t.sortModes.updated.label);
    check(titles().slice(0, 6).join("|") === "逾期的活|重复的活|收件箱的活|学习清单的活|今天要做的活|生活清单的活",
      "最近改动把刚改的放前面，逾期仍在最前");
    await pickSort(t.sortModes.list.label);
    // List names collate differently per language, so assert the order is sorted rather than a fixed string.
    const listNameOf: Record<string, string> = { "今天要做的活": "工作", "学习清单的活": "学习",
      "生活清单的活": "生活", "重复的活": "重复", "收件箱的活": t.inbox };
    const shownLists = titles().slice(1, 6)
      .map((title) => (title ? listNameOf[title] : undefined))
      .filter((name): name is string => Boolean(name));
    check(titles()[0] === "逾期的活" && shownLists.length === 5
      && shownLists.every((name, index) => index === 0 || shownLists[index - 1].localeCompare(name, locale) <= 0),
      "按清单排序先按清单名再按到期");
    // These rows carry no priority, so the priority mode falls back to the due order.
    await pickSort(t.sortModes.priority.label);
    check(titles().slice(0, 6).join("|") === "逾期的活|重复的活|今天要做的活|收件箱的活|学习清单的活|生活清单的活", "没有优先级时按优先级排序仍按到期日");
    await pickSort(t.sortModes.due.label);
    check(titles().join("|") === "逾期的活|重复的活|今天要做的活|收件箱的活|学习清单的活|生活清单的活|刚完成的活|已完成的活|上次拉到的活",
      "切回按到期日恢复默认顺序");
    // One list in view means grouping by list would reorder nothing, so the option is not offered.
    await pickList("工作");
    check((await openSort()).length === 3, "筛选到单个清单后菜单不再有按清单这一项");
    await act(async () => sortButton!.click()); await wait();
    await pickList(t.allLists);
    check((await openSort()).length === 4, "回到全部后按清单又出现了");
    await act(async () => sortButton!.click()); await wait();
  }
  await act(async () => root.unmount());
  document.documentElement.dataset.testResult = "passed";
} catch (error) {
  messages.push(`FAIL ${String(error)}`);
  document.documentElement.dataset.testResult = "failed";
}
document.getElementById("results")!.textContent = messages.join("\n");
