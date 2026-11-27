import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { useTranslation } from "../../i18n";
import { holdIslandPicker } from "../../lib/islandPicker";

const GAP = 6;
const EDGE = 6;

/**
 * The todo view's list filter: one toolbar button naming the list in view and how much is still
 * open in it, with every other list one click away. The menu is drawn into the page for the same
 * reason as the sort picker: the plugin list scrolls and would clip an absolutely placed menu.
 */
export function PluginListFilter({ lists, counts, total, value, onChange }: {
  lists: string[];
  counts: Map<string, number>;
  total: number;
  value: string | null;
  onChange: (list: string | null) => void;
}) {
  const t = useTranslation().plugins;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const count = (entry: string | null) => entry === null ? total : counts.get(entry) ?? 0;

  // Placed under the button, above it when the page bottom is close, and kept inside the window.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const left = Math.min(Math.max(rect.right - size.width, EDGE), window.innerWidth - size.width - EDGE);
    const below = rect.bottom + GAP + size.height <= window.innerHeight - EDGE;
    setPlace({ top: Math.max(EDGE, below ? rect.bottom + GAP : rect.top - GAP - size.height), left });
  }, [open]);

  // Keep the island open while the menu is: it is a short-lived interaction, like the date picker.
  useLayoutEffect(() => (open ? holdIslandPicker() : undefined), [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    // The plugins page stays mounted while collapsed; close when the island is no longer expanded.
    const island = buttonRef.current?.closest(".island");
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
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <button
        ref={buttonRef}
        className="plugin-tasks__list"
        type="button"
        aria-label={t.filterLists}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (open && event.key === "Escape") {
            event.stopPropagation();
            close(true);
          }
        }}
      >
        <span className="plugin-tasks__list-name">{value ?? t.allLists}</span>
        <b>{count(value)}</b>
        <ChevronDown size={12} strokeWidth={2.4} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={id}
          className="plugin-sort-menu plugin-list-menu"
          role="menu"
          aria-label={t.filterLists}
          style={{ top: place?.top ?? 0, left: place?.left ?? 0, visibility: place ? undefined : "hidden" }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close(true);
            }
          }}
        >
          {[null, ...lists].map((entry) => (
            <button
              key={entry ?? "*"}
              className="plugin-sort-menu__item plugin-list-menu__item"
              type="button"
              role="menuitemradio"
              aria-checked={entry === value}
              onClick={() => {
                onChange(entry);
                close(true);
              }}
            >
              <span className="plugin-sort-menu__check" aria-hidden="true">
                {entry === value && <Check size={12} strokeWidth={3} />}
              </span>
              <span className="plugin-list-menu__name">{entry ?? t.allLists}</span>
              <b className="plugin-list-menu__count">{count(entry)}</b>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
