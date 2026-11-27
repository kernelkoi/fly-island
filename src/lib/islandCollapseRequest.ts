// The island folds away after a task is started: the plugin page cannot reach the island's
// navigation (a feature must not depend on the window layer), so the window listens for this
// instead.
const listeners = new Set<() => void>();
let wanted = false;
const publish = () => listeners.forEach((listener) => listener());

/** Asks the island to collapse. The island does it if it is listening. */
export function requestIslandCollapse() {
  wanted = true;
  publish();
}

/** The island's side: folds away once, and clears the request. */
export function takeIslandCollapseRequest() {
  if (!wanted) return false;
  wanted = false;
  return true;
}

/** Subscribes to collapse requests; the callback runs when one is made. */
export function onIslandCollapseRequest(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
