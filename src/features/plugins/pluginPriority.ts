import type { PluginSession } from "./api";

/**
 * The provider's importance, in the provider's own numbers: 0 none, 1 low, 3 medium, 5 high.
 * Anything else is "none", so an unexpected value never invents a level the UI has no word for.
 */
export type PluginPriority = "none" | "low" | "medium" | "high";

export function pluginPriority(session: PluginSession): PluginPriority {
  switch (session.priority) {
    case 1: return "low";
    case 3: return "medium";
    case 5: return "high";
    default: return "none";
  }
}

/** The number the provider uses, so a row can be ordered by it. */
export function priorityRank(session: PluginSession) {
  switch (pluginPriority(session)) {
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
    default: return 0;
  }
}

/** The levels that are worth drawing; "none" is the absence of a level, not a level. */
export const PLUGIN_PRIORITIES: Exclude<PluginPriority, "none">[] = ["high", "medium", "low"];
