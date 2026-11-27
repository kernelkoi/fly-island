import type { CSSProperties } from "react";
import { hasPluginAppIcon, NativePluginIcon } from "./native/NativePluginIcon";
import type { PluginPanelIcon } from "./panelTypes";
import { pluginLineIcon } from "./pluginLineIcons";
import ticktickIcon from "../../assets/brands/ticktick.svg";
import { Puzzle } from "lucide-react";
import "./PluginIcon.css";

/** Brand marks the host owns: a plugin's manifest names one, it never ships its own image. */
const PLUGIN_ICONS: Record<string, string> = { ticktick: ticktickIcon };

/**
 * A plugin's tile. With an `icon` brand name it shows that mark (or a generic puzzle);
 * otherwise it shows the plugin's app icon by `id`, falling back to a line tile.
 */
export function PluginIcon({ id, size = 16, className = "", panelIcon, icon }: { id?: string; size?: number; className?: string; panelIcon?: PluginPanelIcon; icon?: string | null }) {
  if (icon) {
    const src = PLUGIN_ICONS[icon];
    if (!src) return <Puzzle size={size} strokeWidth={1.5} absoluteStrokeWidth aria-hidden="true" />;
    return <img className="plugin-icon" src={src} alt="" aria-hidden="true" width={size} height={size} draggable={false} />;
  }
  if (id && hasPluginAppIcon(id)) return <NativePluginIcon id={id} size={size} className={className} />;
  const Icon = pluginLineIcon(id ?? "", panelIcon);
  return <span className={`native-plugin-icon plugin-icon--line ${className}`.trim()} aria-hidden="true"
    style={{ width: size, height: size, "--plugin-tint": "var(--color-accent)" } as CSSProperties}>
    <Icon size={size * 0.72} strokeWidth={1.5} />
  </span>;
}
