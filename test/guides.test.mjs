import assert from "node:assert/strict";
import test from "node:test";
import { connectorGuide, connectorGuides } from "../dist/guides.js";

test("every connector guide names its CLI and connector, and lookups follow kind and product", () => {
  const guides = connectorGuides();
  assert.deepEqual(guides.map((guide) => [guide.name, guide.command, guide.connector, guide.product]),
    [["agent-browser", "agent-browser", "browser", undefined], ["feishu", "lark-cli", "feishu", undefined], ["google-gmail", "gws", "google", "gmail"]]);
  for (const guide of guides) {
    assert.ok(guide.description.length > 40 && guide.description.length < 300);
    assert.ok(!guide.body.startsWith("---") && guide.body.includes(guide.command));
  }
  assert.equal(connectorGuide("google", "gmail")?.name, "google-gmail");
  assert.equal(connectorGuide("google", "drive"), undefined);
  assert.equal(connectorGuide("feishu")?.command, "lark-cli");
  assert.equal(connectorGuide("browser")?.command, "agent-browser");
});
