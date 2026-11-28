import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays } from "lucide-react";
import { useTranslation } from "../../i18n";
import { addDays } from "./schedule";
import { taskDueDateChoice } from "./datePickerCalendar";
import { holdIslandPicker } from "../../lib/islandPicker";
import { TodoDatePopover } from "./TodoDatePopover";
import "./TodoDatePicker.css";

/** Picks the day a new todo is for; a later day schedules it instead of adding it now. */
export function TodoDatePicker({
  value,
  today,
  disabled,
  onChange,
  label,
  ariaLabel,
  allowPast = false,
  popoverPlacement = "absolute",
}: {
  /** Chosen day (YYYY-MM-DD), or null for the list's own day. */
  value: string | null;
  today: string;
  disabled: boolean;
  onChange: (date: string | null) => void;
  /** An editing button shows its current date; the default button says Today / Tomorrow. */
  label?: (date: string | null) => string;
  /** Overrides the accessible name; the default is the pick-date wording plus the visible label. */
  ariaLabel?: string;
  allowPast?: boolean;
  /** "fixed" anchors the month to the island shape, for a row inside a scrolling list. */
  popoverPlacement?: "absolute" | "fixed";
}) {
  const t = useTranslation();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const showing = open && !disabled;
  const isLater = value !== null && value > today;
  const displayLabel = label ? label(value) : !isLater
    ? t.notebook.dateToday
    : value === addDays(today, 1)
      ? t.notebook.dateTomorrow
      : new Intl.DateTimeFormat(t.localeTag, { month: "numeric", day: "numeric" }).format(
          new Date(`${value}T00:00:00`),
        );

  useLayoutEffect(() => showing ? holdIslandPicker() : undefined, [showing]);
  useEffect(() => {
    if (!showing) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      const target = event.target as Node;
      // A fixed month is portaled out of the row, so it has to count as inside by itself.
      if (!wrapperRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    // The todo page stays mounted while collapsed; release its lock when it becomes hidden.
    const island = wrapperRef.current?.closest(".island");
    const observer = new MutationObserver(() => {
      if (!island?.classList.contains("island--expanded")) setOpen(false);
    });
    if (island) observer.observe(island, { attributes: true, attributeFilter: ["class"] });
    const blur = () => setOpen(false);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    window.addEventListener("blur", blur);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      window.removeEventListener("blur", blur);
    };
  }, [showing]);
  const close = () => { setOpen(false); buttonRef.current?.focus({ preventScroll: true }); };
  const popover = (
    <TodoDatePopover
      id={id}
      value={value}
      today={today}
      onSelect={onChange}
      onClose={close}
      allowPast={allowPast}
      chooseDate={allowPast ? taskDueDateChoice : undefined}
      fixed={popoverPlacement === "fixed"}
      anchorRef={wrapperRef}
      popoverRef={popoverRef}
    />
  );
  // A fixed month leaves the scrolling row and the scaled page panel behind: that panel's scale
  // would otherwise become its containing block, and the stage keeps the island's CSS variables.
  const host = showing && popoverPlacement === "fixed"
    ? wrapperRef.current?.closest<HTMLElement>(".stage") ?? document.body
    : null;

  return (
    <span ref={wrapperRef} className="todo-date-picker">
      <button
        ref={buttonRef}
        className={`todo-date-picker__button${isLater ? " todo-date-picker__button--later" : ""}`}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel ?? `${t.notebook.pickDate}: ${displayLabel}`}
        aria-haspopup="dialog"
        aria-expanded={showing}
        aria-controls={showing ? id : undefined}
        onClick={() => setOpen(!showing)}
      >
        <CalendarDays size={13} strokeWidth={2.2} aria-hidden="true" />
        <span>{displayLabel}</span>
      </button>
      {showing && (host ? createPortal(popover, host) : popover)}
    </span>
  );
}
