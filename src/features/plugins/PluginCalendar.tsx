import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "../../i18n";
import { getLocalDateString } from "../../utils/date";
import { dayDots, dayHeading, getMonthGrid, monthOf, shiftMonth, type CalendarTodo } from "../todos/calendar";
import { TodoDayDetail } from "../todos/TodoDayDetail";
import { TodoDayRow } from "../todos/TodoDayRow";
import { PluginQuickAdd } from "./PluginQuickAdd";
import { runPluginAction, type PluginSession } from "./api";
import { pluginFailureDetail } from "./errors";
import "../todos/TodoNotebook.css";
import "../todos/TodoCalendar.css";

type CalendarItem = CalendarTodo & { session: PluginSession };

/** The month beside the chosen day's tasks, using the todo page's own calendar parts. */
export function PluginCalendar({ pluginId, sessions, composer = false, listId = null, available = true }: {
  pluginId: string;
  sessions: PluginSession[];
  /** Whether the plugin accepts `create.<day>.<title>` actions for new tasks. */
  composer?: boolean;
  /** The filtered list's id, so quick add lands in the list the user is looking at. */
  listId?: string | null;
  /** False while the worker is restarting: the box stays, but sends nothing until it is back. */
  available?: boolean;
}) {
  const t = useTranslation();
  const today = getLocalDateString();
  const [month, setMonth] = useState(() => monthOf(today));
  const [selected, setSelected] = useState(today);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const grid = useMemo(() => getMonthGrid(month), [month]);
  const formats = useMemo(() => ({
    month: new Intl.DateTimeFormat(t.localeTag, { year: "numeric", month: "short" }),
    weekday: new Intl.DateTimeFormat(t.localeTag, { weekday: "narrow" }),
  }), [t.localeTag]);
  const toDate = (date: string) => new Date(`${date}T00:00:00`);

  const dayItems = useMemo(() => {
    const days = new Map<string, CalendarItem[]>();
    for (const session of sessions) {
      if (!session.due) continue;
      const date = session.due.slice(0, 10);
      const items = days.get(date) ?? [];
      items.push({ id: session.id, title: session.title, completed: session.status === "completed", scheduled: false, session });
      days.set(date, items);
    }
    return days;
  }, [sessions]);

  const selectedItems = dayItems.get(selected) ?? [];
  const openSelected = selectedItems.filter((item) => !item.completed).length;
  // Today's finished rows show up struck through, but the numbers stay about work left: how many
  // are late, due today, and hidden from the calendar because they have no date at all.
  const counts = useMemo(() => {
    const counts = { overdue: 0, today: 0, undated: 0 };
    for (const session of sessions) {
      if (session.status === "completed") continue;
      if (!session.due) counts.undated += 1;
      else if (session.due < today) counts.overdue += 1;
      else if (session.due === today) counts.today += 1;
    }
    return counts;
  }, [sessions, today]);
  const select = (date: string) => {
    setMonth(monthOf(date));
    if (date !== selected) setSelected(date);
  };

  return (
    <div className="todo-date-overview todo-calendar plugin-calendar">
      <nav className="todo-date-overview__sidebar" aria-label={t.notebook.pickDate}>
        <div className="todo-calendar__nav">
          <button type="button" aria-label={t.notebook.previousMonth} onClick={() => setMonth(shiftMonth(month, -1))}>
            <ChevronLeft size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <span className="todo-calendar__title" aria-live="polite">{formats.month.format(toDate(`${month}-01`))}</span>
          <button type="button" aria-label={t.notebook.nextMonth} onClick={() => setMonth(shiftMonth(month, 1))}>
            <ChevronRight size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <button
            className="todo-calendar__today"
            type="button"
            aria-label={t.notebook.calendarGoToToday}
            disabled={month === monthOf(today) && selected === today}
            onClick={() => select(today)}
          >
            {t.notebook.dateToday}
          </button>
        </div>
        <div className="todo-calendar__grid">
          {grid.slice(0, 7).map((date) => (
            <span key={`w${date}`} className="todo-calendar__weekday" aria-hidden="true">{formats.weekday.format(toDate(date))}</span>
          ))}
          {grid.map((date) => {
            const items = dayItems.get(date) ?? [];
            const openItems = items.filter((item) => !item.completed);
            const className = [
              "todo-calendar__day",
              monthOf(date) !== month ? "todo-calendar__day--outside" : "",
              date === today ? "todo-calendar__day--today" : "",
            ].filter(Boolean).join(" ");
            return (
              <button
                key={date}
                className={className}
                type="button"
                aria-pressed={date === selected}
                aria-current={date === today ? "date" : undefined}
                aria-label={t.notebook.dayTodos(dayHeading(date, today, t.notebook), openItems.length)}
                data-date={date}
                onClick={() => select(date)}
              >
                <span className="todo-calendar__number">{Number(date.slice(8))}</span>
                <span className="todo-calendar__dots" aria-hidden="true">
                  {dayDots(openItems).map((dot, index) => <span key={index} className={`todo-calendar__dot todo-calendar__dot--${dot}`} />)}
                </span>
              </button>
            );
          })}
        </div>
        {/* The legend belongs under the month grid, not in the day panel. */}
        <div className="plugin-calendar__legend">
          <span className="plugin-calendar__legend-item">
            <i className="plugin-calendar__legend-dot plugin-calendar__legend-dot--overdue" aria-hidden="true" />
            {t.plugins.legendOverdue} <b>{counts.overdue}</b>
          </span>
          <span className="plugin-calendar__legend-item">
            <i className="plugin-calendar__legend-dot plugin-calendar__legend-dot--today" aria-hidden="true" />
            {t.plugins.legendToday} <b>{counts.today}</b>
          </span>
          <span className="plugin-calendar__legend-item">
            <i className="plugin-calendar__legend-dot plugin-calendar__legend-dot--undated" aria-hidden="true" />
            {t.plugins.legendUndated(counts.undated)}
          </span>
        </div>
      </nav>
      <TodoDayDetail
        date={selected}
        today={today}
        summary={openSelected > 0 ? t.plugins.taskCount(openSelected) : undefined}
        footer={composer ? (
          <PluginQuickAdd
            pluginId={pluginId}
            date={selected}
            listId={listId}
            placeholder={t.plugins.addTaskFor(dayHeading(selected, today, t.notebook))}
            className="plugin-quick-add--calendar"
            disabled={!available}
          />
        ) : undefined}
      >
        {selectedItems.map((item) => {
          const action = item.session.action;
          return (
            <TodoDayRow
              key={item.id}
              title={item.title}
              completed={item.completed}
              toggle={action ? {
                label: item.completed ? t.plugins.reopenTask(item.title) : t.plugins.markComplete(item.title),
                pending: pendingAction === action,
                onClick: () => {
                  if (pendingAction === action) return;
                  setPendingAction(action);
                  setError(null);
                  // Like the todo rows: success republishes and the row changes side; failure stays
                  // where it is and says why.
                  void runPluginAction(pluginId, action)
                    .catch((actionError) => setError(pluginFailureDetail(actionError, t.plugins) ?? String(actionError)))
                    .finally(() => setPendingAction(null));
                },
              } : undefined}
            />
          );
        })}
        {error && <p className="plugin-calendar__error" role="alert">{error}</p>}
      </TodoDayDetail>
    </div>
  );
}
