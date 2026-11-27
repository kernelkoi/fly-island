import { useTranslation } from "../../i18n";
import { PLUGIN_DATE_FILTERS, type PluginDateFilter } from "./pluginDateFilter";

/**
 * The date windows above a plugin's add box, as one row of chips. The chips narrow the rows
 * together with the list filter ("and"), so picking a list first keeps its scope.
 */
export function PluginDateChips({ value, onChange }: {
  value: PluginDateFilter;
  onChange: (filter: PluginDateFilter) => void;
}) {
  const t = useTranslation().plugins;
  return (
    <div className="plugin-tasks__dates" role="group" aria-label={t.filterDates}>
      {PLUGIN_DATE_FILTERS.map((filter) => {
        const active = filter === value;
        return (
          <button
            key={filter}
            className={`plugin-tasks__date${active ? " plugin-tasks__date--active" : ""}`}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(filter)}
          >
            {t.dateFilters[filter]}
          </button>
        );
      })}
    </div>
  );
}
