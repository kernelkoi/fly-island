const PLUGIN_FAILURES = [
  "plugin_index_unavailable", "plugin_index_incompatible", "plugin_not_listed",
  "plugin_package_download_failed", "plugin_package_integrity_failed", "plugin_package_invalid", "plugin_install_failed", "plugin_start_failed",
  "plugin_download_timeout", "plugin_download_interrupted", "plugin_download_http_client", "plugin_download_http_server",
  "plugin_disk_full", "plugin_install_in_progress", "plugin_uninstall_failed", "plugin_install_cancelled",
] as const;

export type PluginFailure = (typeof PLUGIN_FAILURES)[number];

export function pluginFailureCode(error: unknown): PluginFailure | undefined {
  const code = error instanceof Error ? error.message : error;
  return PLUGIN_FAILURES.find((value) => value === code);
}

// Host-generated failures keep their localized wording; a plugin's own action error (already
// bounded by the host to one short line) is shown as-is so "401" reads "401", not "failed".
const HOST_FAILURES = new Set([
  "Plugin action timeout", "Plugin action failed", "Unknown plugin action",
  "Plugin is stopped", "Plugin is busy or stopped", "Plugin exited",
  "Invalid plugin setting value", "Unknown plugin setting", "Invalid secret",
]);

type ActionFailureText = { actionExpired: string; actionUnconfirmed: string };

export function pluginFailureDetail(error: unknown, actionText?: ActionFailureText): string | undefined {
  const message = error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  if (message === "plugin_action_expired") return actionText?.actionExpired;
  if (message === "plugin_action_unconfirmed") return actionText?.actionUnconfirmed;
  return message && !HOST_FAILURES.has(message) ? message : undefined;
}
