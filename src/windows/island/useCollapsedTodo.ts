import { isUpdateTodo } from "../../features/todos/updateTodo";
import { useMemo, useState } from "react";
import { useClockWeather, useCurrentWeather } from "../../features/weather";
import { useCollapsedChrome } from "./useCollapsedChrome";
import { fitClockWeather } from "../../features/weather";
import { idleTextDisplay } from "../../features/appearance/idleText";
import type { CollapsedItem, IslandSettings } from "../../features/appearance/types";
import type { TodoItem } from "../../features/todos/types";
import { formatTodoCountdown, type TodoTimer } from "../../features/todos/timer";
import type { PluginFocusController } from "../../features/plugins/pluginFocus";
import { useTranslation } from "../../i18n";
import { useTodoRotation } from "./useIslandAutomation";
import { getCollapsedTextUnits } from "../../utils/text";
import { collapsedWidthTarget, type CollapsedWidthContent } from "./collapsedWidth";
import { nextCollapsedItem, resolveCollapsedItem } from "./collapsedItem";
import { selectRotatingTodos } from "../../features/todos/todoRotation";
import type { RunningAgent } from "../../features/agent-status/session";
import { useAgentPeek } from "./useAgentPeek";
import type { TodoRotationDisplay } from "./CollapsedTodoContent";

// Stands in for the agent icon (16px plus gap) when sizing the island for a session title.
const AGENT_ICON_TEXT = "MM";
// Lyric lines come and go every few seconds; the island keeps its widest size for them rather
// than resizing with each line.
const LYRICS_WIDTH_TEXT = "♪".repeat(24);
const NO_RUNNING_AGENTS: readonly RunningAgent[] = [];
// The song's cover (22px) and the gap after it.
const COVER_WIDTH = 30;
// An alert's icon and the spacing round its parts.
const ALERT_CHROME = 30;
// A countdown pill beside the todo title: gap, padding and about 7px a digit (12px a CJK glyph).
function timerPillWidth(text: string, fontScale: number) {
  return 20 + fontScale * [...text].reduce((width, char) => width + (/[⺀-￿]/.test(char) ? 12 : 7), 0);
}

/**
 * What the collapsed island shows: a running agent's session title (`agentTitle`), the lyric
 * line while a song plays (`lyricsPlaying`), or for todos the active (or rotating) todo title,
 * otherwise the pending count; whichever comes first in Settings → Appearance → Collapsed island
 * of those that have something to show (`collapsedItem`); a todo only claims its rank once one is
 * started (pickCollapsedItem). The wheel can choose another; an agent task that starts then shows
 * for a moment over that choice (`peekedAgent`, useAgentPeek). Also the width that needs, with room
 * for the song's cover beside the lyric line when `coverWanted`.
 */
export function useCollapsedTodo(
  todos: TodoItem[],
  activeTodoId: string | null,
  settings: IslandSettings,
  isRotationPaused: boolean,
  agentTitle: string | null = null,
  { lyricsPlaying = false, lyricsAvailable = false, agentActive = false, coverWanted = false, timer = null, activeIds, timers, notice = null, alertText = null, runningAgents = NO_RUNNING_AGENTS, agentPeekAllowed = false, pluginFocus = null }: {
    lyricsPlaying?: boolean; coverWanted?: boolean; timer?: TodoTimer | null; activeIds?: string[]; timers?: TodoTimer[];
    lyricsAvailable?: boolean; agentActive?: boolean;
    notice?: CollapsedWidthContent | null; alertText?: string | null;
    runningAgents?: readonly RunningAgent[]; agentPeekAllowed?: boolean;
    pluginFocus?: PluginFocusController | null;
  } = {},
) {
  const t = useTranslation();
  const clockWeather = useClockWeather();
  // Dragged off the island in Settings → Appearance, they take no room and fetch nothing.
  const clockOn = clockWeather.installed && clockWeather.settings.showClock && !settings.collapsedHidden.includes("clock");
  const weather = useCurrentWeather(clockWeather.installed && clockWeather.settings.showWeather && !settings.collapsedHidden.includes("weather"),
    clockWeather.settings.location);
  // Only the automatic width is measured; a manual width is the whole island.
  const chrome = useCollapsedChrome(settings.collapsedAutoWidth, settings.islandFontPercent / 100,
    `${settings.fontFamily}:${settings.localFontFamily}`);
  const pendingTodoIds = useMemo(
    () => todos.filter((todo) => !todo.completed && !isUpdateTodo(todo)).map((todo) => todo.id),
    [todos],
  );
  const rotationTodos = useMemo(() => selectRotatingTodos(todos, activeIds ?? (activeTodoId ? [activeTodoId] : [])), [todos, activeIds, activeTodoId]);
  const rotationIds = useMemo(() => rotationTodos.map((todo) => todo.id), [rotationTodos]);
  const rotating = settings.rotateTodos && rotationTodos.length > 0;
  const rotatingTodoId = useTodoRotation(
    rotationIds,
    activeTodoId,
    rotating,
    settings.todoRotationSeconds,
    isRotationPaused || settings.todoRotationMode === "scroll",
  );
  const displayedTodoId = rotating && settings.todoRotationMode === "scroll" ? rotationIds[0] : rotatingTodoId;
  const collapsedTimer = timers?.find((round) => round.todoId === displayedTodoId)
    ?? (timer?.todoId === displayedTodoId ? timer : null);
  const todoRotation: TodoRotationDisplay | null = rotating ? {
    ids: rotationIds,
    titles: rotationTodos.map((todo) => todo.title), mode: settings.todoRotationMode,
    timers: rotationTodos.map((todo) => timers?.find((round) => round.todoId === todo.id)
      ?? (timer?.todoId === todo.id ? timer : null)),
    selectedIndex: Math.max(0, rotationIds.indexOf(displayedTodoId ?? "")),
    speed: settings.todoScrollSpeed, paused: isRotationPaused,
  } : null;
  const collapsedTaskTitle = useMemo(() => {
    const activeTodo = todos.find(
      (todo) => todo.id === displayedTodoId && !todo.completed,
    );
    return activeTodo?.title ?? null;
  }, [displayedTodoId, todos]);
  // A plugin task the user started takes the todo slot: the island names the work in hand, and
  // the provider's task is left untouched. It also takes the face from rotation and from a
  // built-in round, so two titles (or two countdowns) never mix on one line.
  const pluginFocusTitle = pluginFocus?.title ?? null;
  const pluginFocusTimer = pluginFocus?.timer ?? null;
  const focusTitle = pluginFocusTitle ?? collapsedTaskTitle;
  const shownTimer = pluginFocusTitle === null ? collapsedTimer : null;
  const shownRotation = pluginFocusTitle === null ? todoRotation : null;
  // "0 todos left" is not worth a hint; with nothing pending the bar shows what it
  // would without a todo count.
  const pendingTodoCount = pendingTodoIds.length;
  const collapsedTodoCount = settings.showIdleTodoCount && !focusTitle && pendingTodoCount > 0
    ? pendingTodoCount
    : null;
  const available = {
    agent: agentTitle !== null,
    lyrics: lyricsPlaying,
    todo: focusTitle !== null || collapsedTodoCount !== null,
  };
  const canSwitchTo = { ...available, agent: available.agent && agentActive, lyrics: lyricsPlaying && lyricsAvailable };
  const [choice, setChoice] = useState<CollapsedItem | null>(null);
  const selection = resolveCollapsedItem(settings.collapsedPriority, available, canSwitchTo, choice,
    activeTodoId !== null && pendingTodoIds.includes(activeTodoId), Boolean(timers?.length || timer || pluginFocusTimer));
  if (choice !== selection.choice) setChoice(selection.choice);
  const { peekedAgent, cancelAgentPeek } = useAgentPeek(runningAgents, {
    allowed: agentPeekAllowed && settings.showCollapsedText && alertText === null,
    overChoice: selection.choice !== null && selection.choice !== "agent",
  });
  // A plugin task the user started claims the todo slot outright: an agent session or a lyric
  // line must not push its title (or its countdown) off the face.
  const collapsedItem = pluginFocusTitle !== null || pluginFocusTimer ? "todo" : peekedAgent ? "agent" : selection.item;
  const shownAgentTitle = peekedAgent?.title ?? agentTitle;
  const switchCollapsedItem = (direction: 1 | -1) => {
    if (!settings.showCollapsedText) return;
    // The wheel ends a peek and goes on from the user's own choice.
    cancelAgentPeek();
    const next = nextCollapsedItem(settings.collapsedPriority, canSwitchTo, selection.item, direction);
    if (next !== null) setChoice(next);
  };
  const idleDisplay = idleTextDisplay(settings, {
    itemShown: collapsedItem !== null,
    pendingLine: collapsedItem === "todo" && !focusTitle && collapsedTodoCount !== null,
  });
  const fontScale = settings.islandFontPercent / 100;
  const content = useMemo(() => {
    // A fixed width for the whole round; ticking digits never resize the native window. A plugin
    // focus owns the line, so the built-in rounds and rotation are not measured.
    const visibleTimers = pluginFocusTitle !== null ? [] : rotating && timers ? timers : collapsedTimer ? [collapsedTimer] : [];
    const widestTimer = visibleTimers.reduce<string | null>((widest, round) => {
      const text = round.notified ? t.todo.timeUp : formatTodoCountdown(round.durationMinutes * 60);
      return !widest || text.length > widest.length ? text : widest;
    }, null);
    const todoText = rotating && rotationTodos.length && pluginFocusTitle === null
      ? rotationTodos.reduce((widest, todo) => getCollapsedTextUnits(todo.title) > getCollapsedTextUnits(widest) ? todo.title : widest, "")
      : focusTitle ?? (collapsedTodoCount !== null ? idleDisplay.pending ?? t.island.pendingTodos(collapsedTodoCount) : null);
    const itemText = collapsedItem === "agent"
      ? AGENT_ICON_TEXT + shownAgentTitle
      : collapsedItem === "lyrics" ? LYRICS_WIDTH_TEXT : collapsedItem === "todo" ? todoText : null;
    // A focus round's pill is fixed for the round too, so ticks never resize the window.
    const focusPill = pluginFocusTimer && collapsedItem === "todo" && settings.showCollapsedText
      ? timerPillWidth(pluginFocusTimer.notified ? t.todo.timeUp : formatTodoCountdown(pluginFocusTimer.durationMinutes * 60), fontScale)
      : 0;
    return {
      text: settings.showCollapsedText ? itemText ?? "" : "",
      brand: settings.showCollapsedText ? idleDisplay.brand : null,
      fixedText: collapsedItem === "lyrics",
      extraWidth: (widestTimer && collapsedItem === "todo" && settings.showCollapsedText ? timerPillWidth(widestTimer, fontScale) : 0) + focusPill,
    };
  }, [shownAgentTitle, collapsedItem, collapsedTodoCount, focusTitle, pluginFocusTitle, pluginFocusTimer, fontScale, settings.showCollapsedText,
    idleDisplay.brand, idleDisplay.pending, t, collapsedTimer, timers, rotating, rotationTodos]);

  const statusFit = fitClockWeather(settings.collapsedAutoWidth ? settings.collapsedAutoWidthMax : settings.collapsedWidth,
    clockOn, weather !== null, fontScale);
  const coverWidth = coverWanted && collapsedItem === "lyrics" ? COVER_WIDTH : 0;
  const replacement = notice ?? (alertText === null ? null : { text: alertText, extraWidth: ALERT_CHROME });
  const collapsedIslandWidth = collapsedWidthTarget({
    manual: settings.collapsedWidth,
    range: settings.collapsedAutoWidth ? { min: settings.collapsedAutoWidthMin, max: settings.collapsedAutoWidthMax } : null,
    content: { ...content, extraWidth: content.extraWidth + coverWidth },
    preview: replacement && { ...replacement, extraWidth: replacement.extraWidth + coverWidth },
    fontScale, chrome: chrome.width, measure: chrome.measure,
    stageWidth: window.innerWidth, devicePixelRatio: window.devicePixelRatio,
  });
  return {
    collapsedTaskTitle: focusTitle, collapsedTodoCount, collapsedItem, peekedAgent, switchCollapsedItem,
    collapsedIslandWidth, statusFit, idleDisplay, todoRotation: shownRotation, collapsedTimer: shownTimer,
    /** The countdown of the focused plugin task, shown beside its title. */
    pluginFocusTimer,
  };
}
