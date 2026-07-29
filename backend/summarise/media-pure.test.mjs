import assert from "node:assert/strict";
import { fpsForDuration, DEFAULT_FPS, MEDIA_RESOLUTION_LOW } from "./constants.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("fpsForDuration steps down as videos get longer", () => {
  assert.equal(fpsForDuration(30), 1.0);
  assert.equal(fpsForDuration(5 * 60), 1.0);
  assert.equal(fpsForDuration(5 * 60 + 1), 0.5);
  assert.equal(fpsForDuration(15 * 60), 0.5);
  assert.equal(fpsForDuration(15 * 60 + 1), 0.2);
  assert.equal(fpsForDuration(45 * 60), 0.2);
  assert.equal(fpsForDuration(45 * 60 + 1), 0.1);
  assert.equal(fpsForDuration(3 * 60 * 60), 0.1);
});

check("fpsForDuration falls back to DEFAULT_FPS on unusable input", () => {
  assert.equal(fpsForDuration(0), DEFAULT_FPS);
  assert.equal(fpsForDuration(-10), DEFAULT_FPS);
  assert.equal(fpsForDuration(null), DEFAULT_FPS);
  assert.equal(fpsForDuration(undefined), DEFAULT_FPS);
  assert.equal(fpsForDuration("not a number"), DEFAULT_FPS);
  assert.equal(fpsForDuration(NaN), DEFAULT_FPS);
  assert.equal(fpsForDuration(Infinity), DEFAULT_FPS);
});

check("fpsForDuration accepts numeric strings (DynamoDB numbers)", () => {
  assert.equal(fpsForDuration("120"), 1.0);
  assert.equal(fpsForDuration("1500"), 0.2);
});

check("DEFAULT_FPS sits on the ladder and MEDIA_RESOLUTION_LOW is the API enum", () => {
  assert.equal(DEFAULT_FPS, 0.2);
  assert.equal(MEDIA_RESOLUTION_LOW, "MEDIA_RESOLUTION_LOW");
});

console.log(`\n${passed} checks passed`);
