import { useEffect, useState } from "react";
import { getLocalDateString } from "../../utils/date";
import { useLocale, useTranslation } from "../../i18n";
import { TodoDatePicker } from "../todos/TodoDatePicker";
import { runPluginAction, type PluginSession } from "./api";
import "./PluginDueDateEditor.css";

/** The namespace a row declared for its due-day editor. The plugins page is generic, so the
 *  editor only appears for a row that published one; the plugin still validates the day. */
function duePrefix(session: PluginSession) {
  return session.actionPrefixes?.find((prefix) => prefix === `due.${session.id.replace(":", ".")}.`);
}

/**
 * Changes an existing task's due day with the todo page's own month picker. The id is
 * `<prefix><YYYY-MM-DD>`, or `<prefix>clear`; failure leaves the row's day untouched and is
 * reported by the row that owns this editor.
 */
export function PluginDueDateEditor({ pluginId, session, onPendingChange, onError }: {
  pluginId: string;
  session: PluginSession;
  onPendingChange: (pending: boolean) => void;
  onError: (error: string | null) => void;
}) {
  const t = useTranslation().plugins;
  const { locale } = useLocale();
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<string | null>(session.due ?? null);
  // This editor's own choice until the published snapshot catches up, so a poll that reaches
  // the page mid-request cannot flip the button back to the old day.
  const [optimistic, setOptimistic] = useState(false);
  useEffect(() => {
    if (!optimistic) { setSelected(session.due ?? null); return; }
    if ((session.due ?? null) === selected) setOptimistic(false);
  }, [session.due, selected, optimistic]);
  const prefix = duePrefix(session);
  const dateLabel = (date: string | null) => date
    ? new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(new Date(`${date}T00:00:00`))
    : t.noDueDate;
  const changeDate = async (date: string | null) => {
    if (!prefix || pending || date === (session.due ?? null)) return;
    setPending(true);
    onPendingChange(true);
    onError(null);
    setSelected(date);
    setOptimistic(true);
    try {
      await runPluginAction(pluginId, `${prefix}${date ?? "clear"}`);
    } catch (error) {
      setSelected(session.due ?? null);
      setOptimistic(false);
      onError(String(error));
    } finally {
      setPending(false);
      onPendingChange(false);
    }
  };
  if (!prefix) return null;
  return (
    <span className="plugin-due-date">
      {/* Fixed placement keeps the month out of the scrolling list, like the row's other pickers. */}
      <TodoDatePicker
        value={selected}
        today={getLocalDateString()}
        disabled={pending}
        onChange={(date) => { void changeDate(date); }}
        allowPast
        label={dateLabel}
        ariaLabel={t.changeDueDate(session.title, dateLabel(selected))}
        popoverPlacement="fixed"
      />
    </span>
  );
}
