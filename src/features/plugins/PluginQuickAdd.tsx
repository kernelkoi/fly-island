import { useState } from "react";
import { Plus } from "lucide-react";
import { getLocalDateString } from "../../utils/date";
import { useTranslation } from "../../i18n";
import { TodoDatePicker } from "../todos/TodoDatePicker";
import { runPluginAction } from "./api";
import "../todos/TodoNotebook.css";
import "./PluginQuickAdd.css";

/** Title cap in characters; the plugin enforces the same count, so reject before sending. */
const TITLE_LIMIT = 200;

/**
 * One-line quick add for a plugin that published `composer: true`, in the todo page's own form
 * shape. The action carries the chosen day and the title; the plugin creates the row and
 * republishes. A fixed day (the calendar's selected date) wins over the picker, and without
 * either the day is resolved at submit, so a window left open overnight does not add to the
 * previous day.
 */
export function PluginQuickAdd({ pluginId, date, listId, placeholder, className = "" }: {
  pluginId: string;
  date?: string;
  listId?: string | null;
  placeholder: string;
  className?: string;
}) {
  const t = useTranslation().plugins;
  const [draft, setDraft] = useState("");
  const [chosenDate, setChosenDate] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = getLocalDateString();
  // The calendar hands in its selected day; only the list view picks one here.
  const picksDate = date === undefined;

  const add = async () => {
    const title = draft.trim();
    if (!title || adding) return;
    if ([...title].length > TITLE_LIMIT) {
      setError(t.titleTooLong);
      return;
    }
    const day = date ?? chosenDate ?? today;
    // `list:<id>` names the target list; the plain form stays the plugin's default inbox.
    const target = listId && listId !== "inbox" ? `list:${listId}.` : "";
    setAdding(true);
    setError(null);
    try {
      await runPluginAction(pluginId, `create.${day}.${target}${title}`);
      setDraft("");
    } catch (actionError) {
      // Keep the text so the user can retry; the host's error shows as-is.
      setError(String(actionError));
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <form
        className={`todo-form${picksDate ? " todo-form--dated" : ""}${className ? ` ${className}` : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Plus size={16} strokeWidth={2.2} aria-hidden="true" />
        <input
          value={draft}
          placeholder={placeholder}
          aria-label={placeholder}
          spellCheck={false}
          disabled={adding}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void add();
            }
          }}
        />
        {picksDate && (
          <TodoDatePicker value={chosenDate} today={today} disabled={adding} onChange={setChosenDate} />
        )}
      </form>
      {error && <p className="plugin-quick-add__error" role="alert">{error}</p>}
    </>
  );
}
