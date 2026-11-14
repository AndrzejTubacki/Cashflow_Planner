import assert from "node:assert/strict";
import test from "node:test";
import { requireNotificationChannels } from "../../src/server/cashflow-settings-validation.js";
test("channel sets normalise and reject unknown or repeated channels", () => {
  assert.equal(requireNotificationChannels(["discord", "ntfy"]), "ntfy,discord");
  assert.equal(requireNotificationChannels("discord"), "discord");
  assert.equal(requireNotificationChannels([]), null);
  assert.equal(requireNotificationChannels(null), null);
  for (const bad of [["sms"], ["ntfy", "ntfy"], "ntfy,email"]) assert.throws(() => requireNotificationChannels(bad));
});
