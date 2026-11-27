import type { ReactNode } from "react";
import { Check } from "lucide-react";
import "./TodoDayRow.css";

/** One todo on the selected calendar day, with its completion mark and contextual action. */
export function TodoDayRow({
  title,
  completed,
  scheduled = false,
  action,
  toggle,
}: {
  title: string;
  completed: boolean;
  /** Planned for a later day; drawn in the scheduled colour. */
  scheduled?: boolean;
  action?: ReactNode;
  /** Makes the mark itself the checkbox, for calendars whose rows are checked in place. */
  toggle?: { label: string; pending?: boolean; onClick: () => void };
}) {
  const className = ["todo-day-row", completed ? "todo-day-row--done" : "", scheduled ? "todo-day-row--scheduled" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={className} role="listitem">
      {toggle ? (
        <button
          className="todo-day-row__check"
          type="button"
          aria-pressed={completed}
          aria-label={toggle.label}
          disabled={toggle.pending}
          onClick={toggle.onClick}
        >
          {completed && <Check size={10} strokeWidth={3} aria-hidden="true" />}
        </button>
      ) : (
        <span className="todo-day-row__mark" aria-hidden="true">
          {completed && <Check size={10} strokeWidth={3} />}
        </span>
      )}
      <span className="todo-day-row__title">{title}</span>
      {action && <span className="todo-day-row__action">{action}</span>}
    </div>
  );
}
