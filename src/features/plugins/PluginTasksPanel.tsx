import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { PluginQuotaRings } from "../agent-status/PluginQuotaRings";
import { TodoViewSwitch, type TodoView } from "../todos/TodoViewSwitch";
import { PluginCalendar } from "./PluginCalendar";
import { PluginDateChips } from "./PluginDateChips";
import { PluginDueDateEditor } from "./PluginDueDateEditor";
import { PluginFocusButton } from "./PluginFocusButton";
import { PluginListFilter } from "./PluginListFilter";
import { PluginQuickAdd } from "./PluginQuickAdd";
import { PluginSortMenu } from "./PluginSortMenu";
import { matchesDateFilter, type PluginDateFilter } from "./pluginDateFilter";
import { sortModesFor, sortOpenSessions, type PluginSortMode } from "./pluginSort";
import { pluginPriority } from "./pluginPriority";
import { usePluginFocusOrNone } from "./PluginFocusContext";
import type { PluginFocusController } from "./pluginFocus";
import { useLocale, useTranslation } from "../../i18n";
import type { PluginPageText } from "../../i18n/sections/plugins";
import { getLocalDateString } from "../../utils/date";
import { runPluginAction, type PluginQuota, type PluginSession, type Localized } from "./api";
import { pluginFailureDetail } from "./errors";
import { usePlugins } from "./usePlugins";
import "../todos/TodoListItem.css";
import "./PluginTasksPanel.css";

/** The list a row belongs to, in the user's language. The inbox is a pseudo list the UI names itself. */
function listLabel(session: PluginSession, inbox: string) {
  return session.listId === "inbox" ? inbox : session.cwd;
}

/** The due wording of a task row. The plugin sends only the day and a repeat flag; saying them in
 *  the user's language is this side's job, so a plugin never ships localized detail text. */
function dueDetail(session: PluginSession, t: PluginPageText) {
  const { due, repeat } = session;
  if (!due) return null;
  const days = Math.round((Date.parse(due) - Date.parse(getLocalDateString())) / 86_400_000);
  // A repeat task's due date is only the anchor: a past one means it is due today, not overdue.
  if (repeat) return days <= 0 ? t.repeatsToday : t.repeatsSince(due);
  if (days < 0) return t.overdueDays(-days);
  if (days === 0) return t.dueToday;
  return t.dueOn(due);
}

/**
 * The line under a title. A task row says when it is due, and which list only while every list is
 * in view — the filter button already names the list once one is picked. An agent session keeps its
 * status word, which a to-do has no use for.
 */
function rowDetail(session: PluginSession, statusLabel: string, t: PluginPageText, showList: boolean) {
  const parts = session.kind === "task"
    ? [showList ? listLabel(session, t.inbox) : null, dueDetail(session, t)]
    : [statusLabel, session.detail, session.cwd];
  return parts.filter(Boolean).join(" · ");
}

/** One task row in the todo page's own item shape: a check on the left, title and detail. */
function TaskRow({ pluginId, session, locale, showList, focus }: {
  pluginId: string;
  session: PluginSession;
  locale: "zh-CN" | "en";
  showList: boolean;
  focus: PluginFocusController;
}) {
  const t = useTranslation().plugins;
  const [pending, setPending] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completed = session.status === "completed";
  const statusLabel = session.status === "waiting" ? t.waiting : session.status === "running" ? t.running : t.completed;
  const detail = rowDetail(session, statusLabel, t, showList);
  // The row being worked on; only one task can be the focus at a time.
  const isFocused = focus.focus?.pluginId === pluginId && focus.focus.taskId === session.id;
  // The provider's own importance; "none" is not drawn at all.
  const priority = pluginPriority(session);
  return (
    <div className={`todo-item todo-item--readonly plugin-tasks__row plugin-tasks__row--focusable${completed ? " todo-item--done" : ""}${isFocused ? " todo-item--active" : ""}`} role="listitem">
      <button
        className="todo-check"
        type="button"
        aria-pressed={completed}
        disabled={pending || editingDate || !session.action}
        aria-label={completed ? t.reopenTask(session.title) : t.markComplete(session.title)}
        onClick={() => {
          if (!session.action || pending) return;
          setPending(true);
          setError(null);
          // Completing moves the row into the done group, undoing moves it back out. Either way
          // the plugin republishes; on failure the row stays here and says why.
          void runPluginAction(pluginId, session.action)
            .catch((actionError) => setError(pluginFailureDetail(actionError, t) ?? String(actionError)))
            .finally(() => setPending(false));
        }}
      >
        {completed && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}
      </button>
      <div className="plugin-tasks__text">
        <span className="todo-title" lang={locale}>
          {priority !== "none" && (
            <span
              className={`plugin-tasks__priority plugin-tasks__priority--${priority}`}
              aria-label={t.priorityLabel(t.priorities[priority], session.title)}
            >
              {t.priorities[priority]}
            </span>
          )}
          {session.title}
        </span>
        {detail && <span className="plugin-tasks__detail" lang={locale}>{detail}</span>}
        {error && <span className="plugin-tasks__error" role="alert">{error}</span>}
      </div>
      {!completed && (
        <span className="plugin-tasks__actions">
          <PluginDueDateEditor
            pluginId={pluginId}
            session={session}
            onPendingChange={setEditingDate}
            onError={setError}
          />
          {/* Starting a task is this side's own act: the provider's task is not written to. */}
          <PluginFocusButton
            title={session.title}
            active={isFocused}
            timer={isFocused ? focus.timer : null}
            minutes={focus.minutesFor(pluginId, session.id)}
            onToggle={() => focus.toggle(pluginId, session.id, session.title)}
            onMinutesChange={(minutes) => focus.chooseMinutes(pluginId, session.id, minutes)}
            onStartRound={(minutes) => focus.startRound(pluginId, session.id, session.title, minutes)}
          />
        </span>
      )}
    </div>
  );
}

/** One plugin block: its name, the todo/calendar switch, and the open view. */
function PluginBlock({ id, name, quota, composer, sessions, stale, configured, available }: { id: string; name: Localized; quota: PluginQuota[]; composer: boolean; sessions: PluginSession[]; stale: boolean; configured: boolean; available: boolean }) {
  const { locale } = useLocale();
  const t = useTranslation();
  // The task being worked on, shared with the collapsed island.
  const focus = usePluginFocusOrNone();
  // The lists the plugin published, in the user's order of names; a row without one stays in "all".
  // The inbox's rows carry its id but no name, so the filter shows it in the user's language too.
  const lists = Array.from(new Set(sessions.map((s) => listLabel(s, t.plugins.inbox))))
    .filter((label): label is string => Boolean(label))
    .sort((left, right) => left.localeCompare(right, locale));
  // Each chip says how much is still unfinished in its list. Counted over the whole plugin, not the
  // filtered rows, so the numbers stay put while one list is selected.
  const openCounts = new Map<string, number>();
  let openTotal = 0;
  for (const session of sessions) {
    if (session.status === "completed") continue;
    openTotal += 1;
    const label = listLabel(session, t.plugins.inbox);
    if (label) openCounts.set(label, (openCounts.get(label) ?? 0) + 1);
  }
  const [view, setView] = useState<TodoView>("today");
  const [list, setList] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<PluginDateFilter>("all");
  const [sort, setSort] = useState<PluginSortMode>("due");
  const today = getLocalDateString();
  const activeList = list !== null && lists.includes(list) ? list : null;
  // The two filters are "and": a row must sit in the chosen list and inside the chosen window.
  const inList = activeList === null ? sessions : sessions.filter((session) => listLabel(session, t.plugins.inbox) === activeList);
  const visible = dateFilter === "all" ? inList : inList.filter((session) => matchesDateFilter(session, dateFilter, today));
  // Date windows mean nothing to a plugin that publishes no due dates (a launcher's shortcuts),
  // so the chips stay out of its block instead of reading as five dead filters.
  const hasDue = sessions.some((session) => session.due);
  // Grouping by list only reorders rows while several lists are on screen; with one list picked it
  // would do nothing, so the menu leaves it out and a stale pick falls back to the default order.
  const sortModes = sortModesFor(activeList === null ? lists.length : 1);
  const activeSort = sortModes.includes(sort) ? sort : "due";
  // Rows name their list only while the list filter is off: once one list is picked, repeating its
  // name on every row is noise next to the filter button that already says it.
  const showList = activeList === null && lists.length > 1;
  // Read from the list-filtered rows, not the date-filtered ones: an empty window must not send
  // a quick add back to the inbox behind the user's back.
  const activeListId = activeList === null ? null : inList.find((session) => listLabel(session, t.plugins.inbox) === activeList)?.listId ?? null;
  const done = visible.filter((session) => session.status === "completed").length;
  // Finished rows leave the open list but stay visible in a group of their own at the bottom, so a
  // mis-tap is one click away from being undone instead of a task silently vanishing.
  const openRows = sortOpenSessions(
    visible.filter((session) => session.status !== "completed"),
    activeSort,
    today,
    (session) => listLabel(session, t.plugins.inbox) ?? "",
    locale,
  );
  const doneRows = visible.filter((session) => session.status === "completed").sort((a, b) => b.updatedAt - a.updatedAt);
  const isCalendar = view === "calendar";
  return (
    <section className={`plugin-tasks__plugin${isCalendar ? " plugin-tasks__plugin--calendar" : ""}`} aria-label={name[locale]}>
      <div className="plugin-tasks__toolbar">
        <TodoViewSwitch pageMode={view} onSelect={setView} views={["today", "calendar"]} />
        <div className="plugin-tasks__aside">
          {quota.length > 0 && <PluginQuotaRings items={quota} />}
          {/* The list filter names the list in view and carries its open count, so the chips row
              and the per-row list name both had nothing left to say. */}
          {!isCalendar && lists.length > 1 && (
            <PluginListFilter
              lists={lists}
              counts={openCounts}
              total={openTotal}
              value={activeList}
              onChange={setList}
            />
          )}
          {!isCalendar && openRows.length > 0 && (
            <PluginSortMenu mode={activeSort} modes={sortModes} onChange={setSort} />
          )}
          {!isCalendar && done > 0 && (
            <span className="plugin-tasks__progress">
              <progress value={done} max={visible.length} aria-label={t.notebook.doneOf(done, visible.length)} />
              <span aria-hidden="true">{done}/{visible.length}</span>
            </span>
          )}
        </div>
      </div>
      {!configured ? (
        // Secrets still unset: point the way to Settings instead of an empty task list.
        <p className="plugin-tasks__empty">{t.plugins.notConfigured}</p>
      ) : (
        <>
          {stale && (
            // One line, once: the rows below are the last good snapshot, not live data.
            <p className="plugin-tasks__stale" role="status">{t.plugins.refreshFailed}</p>
          )}
          {isCalendar ? (
            // The calendar follows the list filter so quick add lands in it too; the date chips
            // belong to the list — the month grid is already a view of every day.
            <PluginCalendar pluginId={id} sessions={inList} composer={composer} listId={activeListId} available={available} />
          ) : (
            <>
              {/* Right above the add box: the window narrows the rows below it, "and" with the
                  list filter in the toolbar. */}
              {hasDue && <PluginDateChips value={dateFilter} onChange={setDateFilter} />}
              {/* Right under the view switch, in the page's flow: pinned to the bottom it covered
                  the last rows' text, and the list scrolls under it. */}
              {composer && (
                <div className="plugin-tasks__add">
                  <PluginQuickAdd
                    pluginId={id}
                    listId={activeListId}
                    placeholder={t.plugins.addTaskFor(t.notebook.dayToday)}
                    disabled={!available}
                  />
                </div>
              )}
              {openRows.map((session) => (
                <TaskRow key={session.id} pluginId={id} session={session} locale={locale} showList={showList} focus={focus} />
              ))}
              {/* Configured with nothing unfinished: a line of its own, distinct from "not configured". */}
              {composer && openRows.length === 0 && <p className="plugin-tasks__none">{t.plugins.noTasks}</p>}
              {doneRows.length > 0 && (
                <div className="plugin-tasks__done" role="group" aria-label={t.plugins.completedGroup(doneRows.length)}>
                  <p className="plugin-tasks__done-head">{t.plugins.completedGroup(doneRows.length)}</p>
                  {doneRows.map((session) => (
                    <TaskRow key={session.id} pluginId={id} session={session} locale={locale} showList={showList} focus={focus} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The plugins page: each enabled plugin's quota rings and the tasks it published, laid out like
 * the todo page's own list and calendar — plugins never draw their own visuals.
 */
export function PluginTasksPanel(): ReactNode {
  const t = useTranslation().plugins;
  const snapshot = usePlugins();
  const plugins = Object.entries(snapshot.registry.installed)
    .filter(([, p]) => p.enabled && p.manifest.contributes.includes("sessions"))
    .flatMap(([id, p]) => {
      const live = snapshot.live[id];
      // An unconfigured or stale plugin keeps its block even with nothing to show: its state
      // line replaces the rows, instead of the page reading both as "no plugin published tasks".
      // A supervisor restart keeps it too, so a quick add awaiting its answer does not lose the
      // text and the check-before-retry note; a first start with nothing yet still stays hidden.
      const recovering = live?.status === "restarting" || live?.status === "failed";
      const booting = live?.status === "starting";
      if (!live || (live.status !== "running" && !recovering && !booting)) return [];
      const hasContent = live.sessions.length > 0 || live.quota.length > 0 || live.composer === true;
      if (!hasContent && (!live.stale || booting) && live.settingsConfigured !== false) return [];
      return [{ id, name: p.manifest.name, quota: live.quota, composer: live.composer === true, sessions: live.sessions, stale: live.stale === true, configured: live.settingsConfigured !== false, available: live.status === "running" }];
    });
  return (
    <div className="plugin-tasks">
      {plugins.length === 0
        ? <p className="plugin-tasks__empty">{t.empty}</p>
        : plugins.map((p) => <PluginBlock key={p.id} id={p.id} name={p.name} quota={p.quota} composer={p.composer} sessions={p.sessions} stale={p.stale} configured={p.configured} available={p.available} />)}
    </div>
  );
}
