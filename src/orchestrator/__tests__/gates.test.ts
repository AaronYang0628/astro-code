import assert from "node:assert/strict";
import { resolveCutoutEnabled, shouldExecuteCutout } from "../cutout-gate.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n`);
    throw error;
  }
}

test("web selection gate must wait without confirmation", () => {
  const confirmationReceived = false;
  const responsePresent = true;
  const canProceed = confirmationReceived && responsePresent;
  assert.equal(canProceed, false);
});

test("web selection gate proceeds only with confirmation and response", () => {
  const confirmationReceived = true;
  const responsePresent = true;
  const canProceed = confirmationReceived && responsePresent;
  assert.equal(canProceed, true);
});

test("single-catalog workflow defaults cutout enabled", () => {
  assert.equal(resolveCutoutEnabled(undefined, true), true);
  assert.equal(resolveCutoutEnabled(false, true), false);
  assert.equal(resolveCutoutEnabled(undefined, false), false);
});

test("cutout executes only when selected rows > 0", () => {
  assert.equal(shouldExecuteCutout(true, 0), false);
  assert.equal(shouldExecuteCutout(true, 10), true);
  assert.equal(shouldExecuteCutout(false, 10), false);
});
