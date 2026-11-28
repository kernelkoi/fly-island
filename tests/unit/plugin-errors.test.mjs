import assert from "node:assert/strict";
import { test } from "node:test";
import { pluginFailureCode, pluginFailureDetail } from "../../src/features/plugins/errors.ts";

test("market errors show only recognized IPC codes, not paths or URLs", () => {
  assert.equal(pluginFailureCode("plugin_index_unavailable"), "plugin_index_unavailable");
  assert.equal(pluginFailureCode(new Error("plugin_start_failed")), "plugin_start_failed");
  assert.equal(pluginFailureCode("Could not open C:\\users\\secret"), undefined);
  assert.equal(pluginFailureCode("https://secret@example.com/catalog"), undefined);
  assert.equal(pluginFailureCode({ toString: () => "plugin_index_unavailable" }), undefined);
});

test("download failures keep their own codes", () => {
  for (const code of ["plugin_download_timeout", "plugin_download_interrupted", "plugin_download_http_client",
    "plugin_download_http_server", "plugin_disk_full", "plugin_install_in_progress", "plugin_uninstall_failed",
    "plugin_install_cancelled"]) {
    assert.equal(pluginFailureCode(code), code);
  }
  assert.equal(pluginFailureCode("error decoding response body"), undefined);
});

test("action expiry and an unconfirmed write have distinct recovery instructions", () => {
  const messages = { actionExpired: "The action did not start. Try again.", actionUnconfirmed: "Check the original app before retrying." };
  assert.equal(pluginFailureDetail("plugin_action_expired", messages), "The action did not start. Try again.");
  assert.equal(pluginFailureDetail(new Error("plugin_action_unconfirmed"), messages), "Check the original app before retrying.");
  assert.equal(pluginFailureDetail("  401 Unauthorized  ", messages), "401 Unauthorized");
});

test("a plugin's own action error is shown, host failures stay localized", () => {
  assert.equal(pluginFailureDetail(new Error("Token expired; sign in again")), "Token expired; sign in again");
  assert.equal(pluginFailureDetail("  401 Unauthorized  "), "401 Unauthorized");
  for (const message of ["Plugin action failed", "Plugin action timeout", "Plugin is stopped", "Invalid secret"]) {
    assert.equal(pluginFailureDetail(new Error(message)), undefined);
  }
  assert.equal(pluginFailureDetail(new Error("   ")), undefined);
  assert.equal(pluginFailureDetail(undefined), undefined);
  assert.equal(pluginFailureDetail({ toString: () => "401" }), undefined);
});
