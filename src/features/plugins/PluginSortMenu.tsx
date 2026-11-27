import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpDown, Check } from "lucide-react";
import { useTranslation } from "../../i18n";
import { holdIslandPicker } from "../../lib/islandPicker";
import type { PluginSortMode } from "./pluginSort";

const GAP = 6;
const EDGE = 6;

/**
 * The todo view's sort picker. The button carries the name of the current mode, so the order on
 * screen is explained without opening anything; each option repeats its name with one line saying
 * what it does. The menu is drawn into the page rather than the toolbar: the plugin list scrolls,
 * and an absolutely placed menu would be clipped by it.
 *
 * `modes` is what the caller can honour right now — grouping by list is left out when a single
 * list is in view, where it would reorder nothing.
 */
export function PluginSortMenu({ mode, modes, onChange }: { mode: PluginSortMode; modes: PluginSortMode[]; onChange: (mode: PluginSortMode) => void }) {
  const t = useTranslation().plugins;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

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
        className="plugin-tasks__sort"
        type="button"
        aria-label={`${t.sortMode}: ${t.sortModes[mode].label}`}
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
        <ArrowUpDown size={13} strokeWidth={2.2} aria-hidden="true" />
        <span className="plugin-tasks__sort-name">{t.sortModes[mode].label}</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={id}
          className="plugin-sort-menu"
          role="menu"
          aria-label={t.sortMode}
          style={{ top: place?.top ?? 0, left: place?.left ?? 0, visibility: place ? undefined : "hidden" }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close(true);
            }
          }}
        >
          {modes.map((option) => (
            <button
              key={option}
              className="plugin-sort-menu__item"
              type="button"
              role="menuitemradio"
              aria-checked={option === mode}
              onClick={() => {
                onChange(option);
                close(true);
              }}
            >
              <span className="plugin-sort-menu__check" aria-hidden="true">
                {option === mode && <Check size={12} strokeWidth={3} />}
              </span>
              <span className="plugin-sort-menu__text">
                <span className="plugin-sort-menu__label">{t.sortModes[option].label}</span>
                <span className="plugin-sort-menu__hint">{t.sortModes[option].hint}</span>
              </span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
