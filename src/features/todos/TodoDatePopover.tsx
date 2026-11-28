import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "../../i18n";
import { monthOf, shiftMonth } from "./calendar";
import { movePickerFocus, pickerMonthGrid, pickerPopoverPlacement, pickerWeekStart, quickAddDateChoice, shiftPickerMonth } from "./datePickerCalendar";
import "./TodoDatePopover.css";

/** A calendar drawn inside the todo panel, so WebView2 keeps both focus and stacking order. */
export function TodoDatePopover({ id, value, today, onSelect, onClose, chooseDate = quickAddDateChoice, allowPast = false, fixed = false, anchorRef, popoverRef }: {
  id: string;
  value: string | null;
  today: string;
  onSelect: (date: string | null) => void;
  onClose: () => void;
  /** New todos map an earlier day to the current list; editing a task keeps the chosen day. */
  chooseDate?: (date: string | null, today: string) => string | null;
  allowPast?: boolean;
  /** Anchored to the island shape instead of the button: a scrolling list would clip the month. */
  fixed?: boolean;
  /** The trigger a fixed month measures itself against; it is portaled out of the row. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Lets the trigger treat clicks in the portaled month as inside itself. */
  popoverRef?: RefObject<HTMLDivElement | null>;
}) {
  const t = useTranslation();
  const initial = allowPast && value ? value : value && value >= today ? value : today;
  const [month, setMonth] = useState(monthOf(initial));
  const [focused, setFocused] = useState(initial);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const focusRequested = useRef(true);
  const ownPopup = useRef<HTMLDivElement>(null);
  const popup = popoverRef ?? ownPopup;
  const weekStart = pickerWeekStart(t.localeTag);
  const dates = useMemo(() => pickerMonthGrid(month, weekStart), [month, weekStart]);
  const formats = useMemo(() => ({
    month: new Intl.DateTimeFormat(t.localeTag, { month: "short", year: "numeric" }),
    weekday: new Intl.DateTimeFormat(t.localeTag, { weekday: "narrow" }),
    day: new Intl.DateTimeFormat(t.localeTag, { dateStyle: "full" }),
  }), [t.localeTag]);
  const toDate = (date: string) => new Date(`${date}T00:00:00`);

  useLayoutEffect(() => {
    if (!focusRequested.current) return;
    // A hidden element takes no focus: a fixed picker waits for its placement first.
    if (fixed && !place) return;
    popup.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus({ preventScroll: true });
    focusRequested.current = false;
  }, [focused, month, fixed, place, popup]);

  // A fixed picker is measured against its button once it has a size. It stays inside the island
  // shape rather than the window: the stage around the shape passes clicks through, so a month
  // drawn past it is visible but unclickable (and hovering there collapses the island). The
  // rounded corners are kept clear of the footer with the island's own radii.
  // Held back until placed so the first frame never shows it at the window's corner.
  useLayoutEffect(() => {
    if (!fixed) return;
    const element = popup.current;
    const trigger = anchorRef ? anchorRef.current : element?.parentElement;
    const anchor = trigger?.getBoundingClientRect();
    if (!element || !anchor) return;
    const island = trigger?.closest<HTMLElement>(".island");
    const rect = island?.getBoundingClientRect();
    const px = (length: string) => Number.parseFloat(length) || 0;
    const style = island ? getComputedStyle(island) : null;
    const bounds = rect && style
      ? {
          top: rect.top + Math.max(px(style.borderTopLeftRadius), px(style.borderTopRightRadius)),
          bottom: rect.bottom - Math.max(px(style.borderBottomLeftRadius), px(style.borderBottomRightRadius)),
          left: rect.left,
          right: rect.right,
        }
      : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    // The layout size, not the animated rect: the opening scale would measure it undersized.
    setPlace(pickerPopoverPlacement(
      { top: anchor.top, bottom: anchor.bottom, right: anchor.right },
      { width: element.offsetWidth, height: element.offsetHeight },
      bounds,
    ));
  }, [fixed, anchorRef, popup]);

  const moveMonth = (delta: number) => {
    setMonth(shiftMonth(month, delta));
    setFocused(shiftPickerMonth(focused, delta));
  };
  const select = (date: string | null) => { onSelect(chooseDate(date, today)); onClose(); };

  return (
    <div
      ref={popup}
      id={id}
      className={`todo-date-popover${fixed ? " todo-date-popover--fixed" : ""}`}
      role="dialog"
      aria-label={t.notebook.pickDate}
      style={fixed ? { top: place?.top ?? 0, left: place?.left ?? 0, visibility: place ? undefined : "hidden" } : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      }}
    >
      <div className="todo-date-popover__nav">
        <button type="button" aria-label={t.notebook.previousMonth} onClick={() => moveMonth(-1)}>
          <ChevronLeft size={15} strokeWidth={2.2} aria-hidden="true" />
        </button>
        <span aria-live="polite">{formats.month.format(toDate(`${month}-01`))}</span>
        <button type="button" aria-label={t.notebook.nextMonth} onClick={() => moveMonth(1)}>
          <ChevronRight size={15} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
      <div className="todo-date-popover__grid" role="grid" aria-label={formats.month.format(toDate(`${month}-01`))}
        onKeyDown={(event) => {
          const date = (event.target as HTMLElement).closest<HTMLElement>("[data-date]")?.dataset.date;
          if (!date) return;
          const next = movePickerFocus(date, event.key, weekStart, allowPast ? null : today);
          if (next === null) return;
          event.preventDefault();
          event.stopPropagation();
          focusRequested.current = true;
          setFocused(next);
          setMonth(monthOf(next));
        }}>
        <div className="todo-date-popover__week" role="row">
          {dates.slice(0, 7).map(date => <span role="columnheader" key={date}>{formats.weekday.format(toDate(date))}</span>)}
        </div>
        {Array.from({ length: dates.length / 7 }, (_, week) => (
          <div className="todo-date-popover__week" role="row" key={week}>
            {dates.slice(week * 7, week * 7 + 7).map(date => (
              <div role="gridcell" key={date} aria-selected={date === initial}>
                <button type="button" data-date={date} tabIndex={date === focused ? 0 : -1}
                  disabled={!allowPast && date < today} aria-label={formats.day.format(toDate(date))}
                  aria-current={date === today ? "date" : undefined} aria-pressed={date === initial}
                  className={`todo-date-popover__day${monthOf(date) !== month ? " todo-date-popover__day--outside" : ""}`}
                  onFocus={() => setFocused(date)} onClick={() => select(date)}>
                  {Number(date.slice(8))}
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="todo-date-popover__footer">
        <button type="button" onClick={() => select(today)}>{t.notebook.dateToday}</button>
        <button type="button" onClick={() => select(null)}>{t.notebook.clearDate}</button>
      </div>
    </div>
  );
}
