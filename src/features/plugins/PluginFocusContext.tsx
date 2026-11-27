import { createContext, useContext, type ReactNode } from "react";
import { usePluginFocus } from "./usePluginFocus";
import { DEFAULT_FOCUS_MINUTES, type PluginFocusController } from "./pluginFocus";

/**
 * The plugin task being worked on, shared by the plugin page (which starts it) and the collapsed
 * island (which names it). One source, so the two can never disagree about which task it is.
 */
const PluginFocusContext = createContext<PluginFocusController | null>(null);

export function PluginFocusProvider({ children }: { children: ReactNode }) {
  const focus = usePluginFocus();
  return <PluginFocusContext.Provider value={focus}>{children}</PluginFocusContext.Provider>;
}

/** The focus, or null when no provider is above (the settings window, the web demo). */
export function usePluginFocusState(): PluginFocusController | null {
  return useContext(PluginFocusContext);
}

/** The focus, or a do-nothing one where there is no provider: the row then shows no Start button. */
export function usePluginFocusOrNone(): PluginFocusController {
  const focus = usePluginFocusState();
  return focus ?? NO_FOCUS;
}

const NO_FOCUS: PluginFocusController = {
  focus: null,
  title: null,
  timer: null,
  minutesFor: () => DEFAULT_FOCUS_MINUTES,
  toggle: () => {},
  startRound: () => {},
  chooseMinutes: () => {},
};

