import { useRef, useState } from "react";
import { Play, Square, Timer } from "lucide-react";
import { useTranslation } from "../../i18n";
import { TodoCountdown, TodoDurationPicker } from "../todos/index.ts";

/**
 * The Start button of a plugin task row, with the small watch that sets the round's length.
 *
 * Starting a task is this side's own act: the provider's task is not written to at all, so the
 * task keeps its due date, its tags and its status. The button only says which task the island is
 * working on; the countdown beside it is the focus round.
 *
 * The watch stays beside Start even while the task is the one being worked on — otherwise
 * starting a task would take away the only way to give it a countdown.
 */
export function PluginFocusButton({
  title,
  active,
  timer,
  minutes,
  onToggle,
  onMinutesChange,
  onStartRound,
}: {
  title: string;
  /** Whether this task is the one being worked on. */
  active: boolean;
  /** The countdown of the focused task, or null while there is none. */
  timer: { endsAt: number; notified: boolean } | null;
  /** The minutes the round runs for. */
  minutes: number;
  onToggle: () => void;
  onMinutesChange: (minutes: number) => void;
  /** Starts the task with a round of `minutes`; the watch's own start button. */
  onStartRound: (minutes: number) => void;
}) {
  const t = useTranslation().todo;
  const [choosing, setChoosing] = useState(false);
  const watch = useRef<HTMLButtonElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);

  const label = active ? t.stop : t.start;
  const start = (
    <button
      ref={startButton}
      className={active ? "todo-start plugin-tasks__focus plugin-tasks__focus--active" : "todo-start plugin-tasks__focus"}
      type="button"
      aria-label={t.actionOnTask(label, title)}
      aria-pressed={active}
      onClick={onToggle}
    >
      {active ? <Square size={11} strokeWidth={2.4} aria-hidden="true" /> : <Play size={13} strokeWidth={2.4} aria-hidden="true" />}
      {active && timer && !timer.notified && <TodoCountdown endsAt={timer.endsAt} />}
    </button>
  );

  return (
    <div className="todo-start-group plugin-tasks__focus-group">
      <button
        ref={watch}
        className="todo-timer-button"
        type="button"
        aria-expanded={choosing}
        aria-label={t.changeDuration(minutes)}
        title={t.changeDuration(minutes)}
        onClick={() => setChoosing((current) => !current)}
      >
        <Timer size={14} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {start}
      {choosing && (
        <TodoDurationPicker
          anchor={watch}
          minutes={minutes}
          onChange={onMinutesChange}
          onStart={(chosen) => { setChoosing(false); onStartRound(chosen); }}
          onClose={(refocus) => { setChoosing(false); if (refocus) watch.current?.focus(); }}
        />
      )}
    </div>
  );
}
