import { isPageDot } from "../../features/appearance/settingsLimits.ts";
import type { HeaderPage } from "../../features/appearance/types";
import { isPageEnabled, type IslandFeatures } from "./features.ts";
import type { IslandPage } from "./types";

/**
 * The pages Ctrl + wheel steps through, in the header's order: the Agent page, the page dots
 * (translation only while it opens inside the island, a detached clipboard not at all, since
 * both open a window of their own), the plugin pages and messages among them.
 */
export function wheelPageOrder(pageOrder: HeaderPage[], features: IslandFeatures, clipboardDetached: boolean): IslandPage[] {
  const pages: IslandPage[] = [];
  if (features.agents) pages.push("agents");
  const pluginPages = features.pluginPages ?? [];
  for (const dot of pageOrder) {
    if (dot === "clipboard" && clipboardDetached) continue;
    if (dot === "plugins") {
      if (isPageEnabled("plugins", features)) pages.push("plugins");
      continue;
    }
    if (dot === "qq") {
      if (isPageEnabled("qq", features)) pages.push("qq");
      continue;
    }
    if (!isPageDot(dot)) {
      if (pluginPages.some((info) => info.page === dot)) pages.push(dot);
      continue;
    }
    if (features[dot]) pages.push(dot);
  }
  // Plugin pages, the plugins page and messages the saved order lacks (a newly installed plugin)
  // line up after the dots in the original order, matching the header.
  for (const info of pluginPages) {
    if (!pageOrder.includes(info.page)) pages.push(info.page);
  }
  if (isPageEnabled("plugins", features) && !pageOrder.includes("plugins")) pages.push("plugins");
  if (isPageEnabled("qq", features) && !pageOrder.includes("qq")) pages.push("qq");
  return pages;
}

/** The page `direction` (1 down, -1 up) steps from `page` to, round the ends; null with nowhere to go. */
export function nextWheelPage(pages: IslandPage[], page: IslandPage, direction: 1 | -1): IslandPage | null {
  if (pages.length === 0) return null;
  const index = pages.indexOf(page);
  if (index < 0) return pages[direction > 0 ? 0 : pages.length - 1];
  const next = pages[(index + direction + pages.length) % pages.length];
  return next === page ? null : next;
}
