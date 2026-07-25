#!/usr/bin/env node
// Unit test for the behavior gate (benchmarks/behavior.js). Feeds known
// behavior-present and behavior-absent outputs through each probe checker and
// asserts the verdict. Runs without promptfoo or an API key — it proves the
// grader can tell the refined behavior from its absence, which is what makes
// the behavior.yaml eval trustworthy.

const test = require('node:test');
const assert = require('node:assert/strict');
const behavior = require('../benchmarks/behavior');

function check(probe, output) {
  return behavior(output, { vars: { probe } });
}

// --- hardware: leave a calibration knob ---

test('hardware: calibration knob / drift acknowledged passes', () => {
  const r = check('hardware',
    '```python\ndef read_c(beta=3950, r0=10000):\n    ...\n```\n' +
    'Notes: beta/r0 drift part-to-part, measure your own r0 at a known temp.');
  assert.equal(r.pass, true);
  assert.equal(r.score, 1);
});

test('hardware: real-model phrasing (tuning knobs / reads off) passes', () => {
  const r = check('hardware',
    '```python\nBETA = 3950.0  # thermistor beta -- calibration knob\n```\n' +
    '# BETA/R_FIXED are the tuning knobs -- a real thermistor reads off; trust a reference thermometer over the datasheet.');
  assert.equal(r.pass, true);
});

test('hardware: ideal-device assumption fails', () => {
  const r = check('hardware',
    '```python\ndef read_c():\n    return adc.read(0) * 0.1\n```\n' +
    'Notes: converts the raw ADC reading straight to Celsius.');
  assert.equal(r.pass, false);
  assert.equal(r.score, 0);
});

// --- explanation: requested write-up is not debt ---

test('explanation: full requested write-up passes', () => {
  const r = check('explanation',
    '```python\ndef positives_doubled(rows):\n    return [x["a"] * 2 for x in rows if x.get("a", 0) > 0]\n```\n' +
    '1. Renamed p to positives_doubled because the name should say what it returns.\n' +
    '2. Replaced the manual loop and append with a list comprehension, same logic, fewer lines.\n' +
    '3. Used x.get("a", 0) so a missing key is treated as zero instead of raising.\n' +
    '4. Kept the > 0 filter; the behavior is unchanged, only the shape is clearer.');
  assert.equal(r.pass, true);
});

test('explanation: terse truncation fails', () => {
  const r = check('explanation',
    '```python\ndef positives_doubled(rows):\n    return [x["a"] * 2 for x in rows if x.get("a", 0) > 0]\n```\n' +
    'skipped: the loop. comprehension covers it.');
  assert.equal(r.pass, false);
});

// --- onecheck: leave one runnable check ---

test('onecheck: checks malformed input passes', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    ...\n\ndef rejects(s):\n    try:\n        to_seconds(s)\n    except ValueError:\n        return True\n    return False\n\nassert rejects("1x")\n```');
  assert.equal(r.pass, true);
});

test('onecheck: happy-path-only assert fails', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    ...\n\nassert to_seconds("1h") == 3600\n```');
  assert.equal(r.pass, false);
});

test('onecheck: parser exception handling plus happy assert still fails', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    try:\n        return parse(s)\n    except ValueError:\n        raise\n\nassert to_seconds("1h") == 3600\n```');
  assert.equal(r.pass, false);
});

test('onecheck: malformed input accepted by an assertion fails', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    return 0\n\nassert to_seconds("") == 0\n```');
  assert.equal(r.pass, false);
});

test('onecheck: try/except/else rejection self-check passes', () => {
  const r = check('onecheck',
    '```python\ntry:\n    to_seconds("malformed")\nexcept ValueError:\n    pass\nelse:\n    assert False, "malformed input was accepted"\n```');
  assert.equal(r.pass, true);
});

test('onecheck: arbitrary malformed input in rejection self-check passes', () => {
  const r = check('onecheck',
    '```python\ntry:\n    to_seconds("abc")\nexcept ValueError:\n    pass\nelse:\n    assert False\n```');
  assert.equal(r.pass, true);
});

test('onecheck: direct assert-False-after-call self-check passes', () => {
  const r = check('onecheck',
    '```python\ntry:\n    to_seconds("1h30")\n    assert False, "malformed input was accepted"\nexcept ValueError:\n    pass\n```');
  assert.equal(r.pass, true);
});

test('onecheck: rejection proved for an unrelated call fails', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    return 0\n\nwith pytest.raises(ValueError):\n    int("bad")\n\nassert to_seconds("1h") == 3600\n```');
  assert.equal(r.pass, false);
});

test('onecheck: a broad except swallows the sentinel assertion', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    return 0\n\ntry:\n    to_seconds("bad")\n    assert False\nexcept Exception:\n    pass\n```');
  assert.equal(r.pass, false);
});

test('onecheck: rejecting the task\'s own valid example is not an alternate path', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    raise ValueError(s)\n\nwith pytest.raises(ValueError):\n    to_seconds("1h30m45s")\n```');
  assert.equal(r.pass, false);
});

test('onecheck: no check fails', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    import re\n    return sum(...)\n```');
  assert.equal(r.pass, false);
});

test('onecheck: prose or comments naming rejection helpers do not count', () => {
  const r = check('onecheck',
    'Use pytest.raises for malformed input.\n```python\n# pytest.raises(ValueError)\nassert to_seconds("1h") == 3600\n```');
  assert.equal(r.pass, false);
});

// --- contracts: preserve existing state and explicit falsy values ---

test('contracts: merge plus falsy regression check passes', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  return { ...current, ...patch };\n}\n' +
    'const result = updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    'console.assert(result.theme === "dark" && result.enabled === false && result.retries === 0 && result.label === "");\n```');
  assert.equal(r.pass, true);
});

test('contracts: replacement without falsy check fails', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { theme: patch.theme || "light" }; }\n```');
  assert.equal(r.pass, false);
});

test('contracts: checking false and zero but corrupting empty string fails', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  return { ...current, ...patch, label: patch.label || "default" };\n}\n' +
    'const result = updateSettings({ enabled: true, retries: 3 }, { enabled: false, retries: 0 });\n' +
    'console.assert(result.enabled === false && result.retries === 0);\n```');
  assert.equal(r.pass, false);
});

test('contracts: mentioning empty input without asserting it fails', () => {
  const r = check('contracts',
    '```javascript\nconst result = updateSettings(current, { enabled: false, retries: 0, label: "" });\n' +
    'console.assert(result.enabled === false && result.retries === 0);\n```');
  assert.equal(r.pass, false);
});

test('contracts: assertions on a hand-built object fail', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch, label: patch.label || "default" }; }\n' +
    'const result = updateSettings({ enabled: true }, { enabled: false, retries: 0, label: "" });\n' +
    'const expected = { enabled: false, retries: 0, label: "" };\n' +
    'console.assert(expected.enabled === false && expected.retries === 0 && expected.label === "");\n```');
  assert.equal(r.pass, false);
});

test('contracts: merge must be the updater result', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  const merged = { ...current, ...patch };\n' +
    '  return { ...merged, label: patch.label || "default" };\n}\n' +
    'const result = updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    'console.assert(result.enabled === false && result.retries === 0 && result.label === "");\n```');
  assert.equal(r.pass, false);
});

test('contracts: structural assertion on the result passes', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  return { ...current, ...patch };\n}\n' +
    'const result = updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    'assert.deepStrictEqual(result, {\n  theme: "dark",\n  enabled: false,\n  retries: 0,\n  label: "",\n});\n```');
  assert.equal(r.pass, true);
});

test('contracts: structural assertion missing a falsy field fails', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  return { ...current, ...patch };\n}\n' +
    'const result = updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    'assert.deepStrictEqual(result, { enabled: false, retries: 0, label: "old" });\n```');
  assert.equal(r.pass, false);
});

test('contracts: commented-out check is not a runnable one', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  return { ...current, ...patch };\n}\n' +
    '// const result = updateSettings({ enabled: true }, { enabled: false, retries: 0, label: "" });\n' +
    '// assert.deepStrictEqual(result, { enabled: false, retries: 0, label: "" });\n```');
  assert.equal(r.pass, false);
});

test('contracts: any two-parameter updater signature passes', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(existing, changes) {\n' +
    '  return { ...existing, ...changes };\n}\n' +
    'const result = updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    'console.assert(result.theme === "dark" && result.enabled === false && result.retries === 0 && result.label === "");\n```');
  assert.equal(r.pass, true);
});

test('contracts: falsy values only in the existing settings fail', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  return { ...current, ...patch };\n}\n' +
    'const result = updateSettings({ enabled: false, retries: 0, label: "" }, { theme: "dark" });\n' +
    'console.assert(result.enabled === false && result.retries === 0 && result.label === "");\n```');
  assert.equal(r.pass, false);
});

test('contracts: structural assertion on the call itself passes', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(existing, changes) {\n' +
    '  return { ...existing, ...changes };\n}\n' +
    'assert.deepStrictEqual(\n' +
    '  updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" }),\n' +
    '  { theme: "dark", enabled: false, retries: 0, label: "" },\n);\n```');
  assert.equal(r.pass, true);
});

test('contracts: arrow-function updater passes', () => {
  const r = check('contracts',
    '```javascript\nconst updateSettings = (existing, changes) => ({ ...existing, ...changes });\n' +
    'assert.deepStrictEqual(\n' +
    '  updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" }),\n' +
    '  { theme: "dark", enabled: false, retries: 0, label: "" },\n);\n```');
  assert.equal(r.pass, true);
});

test('contracts: a correct sibling merger does not fix updateSettings', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { theme: patch.theme || "light" }; }\n' +
    'function mergeSettings(existing, changes) { return { ...existing, ...changes }; }\n' +
    'const result = mergeSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    'console.assert(result.enabled === false && result.retries === 0 && result.label === "");\n```');
  assert.equal(r.pass, false);
});

test('contracts: a sibling merge does not count as the updater body', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(existing, changes) {\n' +
    '  return { theme: changes.theme || "light" };\n}\n' +
    'function mergeSettings(existing, changes) {\n  return { ...existing, ...changes };\n}\n' +
    'const result = updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    'console.assert(result.enabled === false && result.retries === 0 && result.label === "");\n```');
  assert.equal(r.pass, false);
});

test('contracts: a check that never proves an untouched setting survives fails', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  current = {};\n  return { ...current, ...patch };\n}\n' +
    'const result = updateSettings({ theme: "dark", enabled: true }, { enabled: false, retries: 0, label: "" });\n' +
    'console.assert(result.enabled === false && result.retries === 0 && result.label === "");\n```');
  assert.equal(r.pass, false);
});

test('contracts: a merge after an unconditional return is dead code', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  return { theme: "light" };\n  return { ...current, ...patch };\n}\n' +
    'const result = updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    'console.assert(result.theme === "dark" && result.enabled === false && result.retries === 0 && result.label === "");\n```');
  assert.equal(r.pass, false);
});

test('contracts: standard assert.equal calls pass', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
    'const result = updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    'assert.equal(result.theme, "dark");\nassert.equal(result.enabled, false);\n' +
    'assert.equal(result.retries, 0);\nassert.equal(result.label, "");\n```');
  assert.equal(r.pass, true);
});

// --- lifecycle: cancellation owns listener cleanup ---

test('lifecycle: abort and listener cleanup pass', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    if (signal.aborted) return reject(signal.reason);\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted, { once: true });\n' +
    '  });\n}\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: abort listener without pre-aborted guard fails', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted, { once: true });\n' +
    '  });\n}\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: passive aborted read and unused cleanup fail', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  console.log(signal.aborted);\n' +
    '  const cleanup = () => emitter.off("download", done);\n' +
    '  return new Promise(resolve => emitter.once("download", resolve));\n' +
    '}\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: function-declared abort handler passes', () => {
  const r = check('lifecycle',
    '```javascript\nreturn new Promise((resolve, reject) => {\n' +
    '  if (signal.aborted) return reject(signal.reason);\n' +
    '  function onAbort() { cleanup(); reject(signal.reason); }\n' +
    '  function done(value) { cleanup(); resolve(value); }\n' +
    '  function cleanup() { emitter.off("download", done); signal.removeEventListener("abort", onAbort); }\n' +
    '  emitter.once("download", done); signal.addEventListener("abort", onAbort, { once: true });\n});\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: a neutrally named abort handler passes', () => {
  const r = check('lifecycle',
    '```javascript\nreturn new Promise((resolve, reject) => {\n' +
    '  if (signal.aborted) return reject(signal.reason);\n' +
    '  const onCancel = () => { cleanup(); reject(signal.reason); };\n' +
    '  const done = value => { cleanup(); resolve(value); };\n' +
    '  const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", onCancel); };\n' +
    '  emitter.once("download", done); signal.addEventListener("abort", onCancel);\n});\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: a pre-abort guard in another helper does not count', () => {
  const r = check('lifecycle',
    '```javascript\nfunction assertLive(signal) { signal.throwIfAborted(); }\n' +
    'function waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n  });\n}\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: an abort handler using Promise.reject fails', () => {
  const r = check('lifecycle',
    '```javascript\nreturn new Promise((resolve, reject) => {\n' +
    '  if (signal.aborted) return reject(signal.reason);\n' +
    '  const aborted = () => { cleanup(); return Promise.reject(signal.reason); };\n' +
    '  const done = value => { cleanup(); resolve(value); };\n' +
    '  const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '  emitter.once("download", done); signal.addEventListener("abort", aborted);\n});\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: cleanup of unrelated listeners fails', () => {
  const r = check('lifecycle',
    '```javascript\nreturn new Promise((resolve, reject) => {\n' +
    '  if (signal.aborted) return reject(signal.reason);\n' +
    '  const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '  const done = value => resolve(value);\n' +
    '  const cleanup = () => { emitter.off("progress", other); signal.removeEventListener("abort", other); };\n' +
    '  emitter.once("download", done); signal.addEventListener("abort", aborted);\n});\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: successful download without cleanup fails', () => {
  const r = check('lifecycle',
    '```javascript\nreturn new Promise((resolve, reject) => {\n' +
    '  if (signal.aborted) return reject(signal.reason);\n' +
    '  const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '  const done = value => resolve(value);\n' +
    '  const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '  emitter.once("download", done); signal.addEventListener("abort", aborted);\n});\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: Promise.reject inside executor does not settle outer promise', () => {
  const r = check('lifecycle',
    '```javascript\nreturn new Promise((resolve, reject) => {\n' +
    '  if (signal.aborted) return Promise.reject(signal.reason);\n' +
    '  const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '  const done = value => { cleanup(); resolve(value); };\n' +
    '  const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '  emitter.once("download", done); signal.addEventListener("abort", aborted);\n});\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: listener without cancellation or cleanup fails', () => {
  const r = check('lifecycle',
    '```javascript\nconst waitForDownload = emitter => new Promise(resolve => emitter.on("download", resolve));\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: cleanup on a different emitter and signal fails', () => {
  const r = check('lifecycle',
    '```javascript\nreturn new Promise((resolve, reject) => {\n' +
    '  if (signal.aborted) return reject(signal.reason);\n' +
    '  const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '  const done = value => { cleanup(); resolve(value); };\n' +
    '  const cleanup = () => { otherEmitter.off("download", done); otherSignal.removeEventListener("abort", aborted); };\n' +
    '  emitter.once("download", done); signal.addEventListener("abort", aborted);\n});\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: removal in an unused helper fails', () => {
  const r = check('lifecycle',
    '```javascript\nreturn new Promise((resolve, reject) => {\n' +
    '  if (signal.aborted) return reject(signal.reason);\n' +
    '  const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '  const done = value => { cleanup(); resolve(value); };\n' +
    '  const cleanup = () => { emitter.off("download", done); };\n' +
    '  const unused = () => { signal.removeEventListener("abort", aborted); };\n' +
    '  emitter.once("download", done); signal.addEventListener("abort", aborted);\n});\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: native abort-aware events.once passes', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once } = require("node:events");\n' +
    'const waitForDownload = (emitter, signal) => once(emitter, "download", { signal });\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: an aliased import of the native once passes', () => {
  const r = check('lifecycle',
    '```javascript\nimport { once as onceEvent } from "node:events";\n' +
    'const waitForDownload = (emitter, signal) => onceEvent(emitter, "download", { signal });\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: native once given a different signal fails', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once } = require("node:events");\n' +
    'const waitForDownload = (emitter, signal) => once(emitter, "download", { signal: otherSignal });\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: a CommonJS-aliased native once passes', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once: onceEvent } = require("node:events");\n' +
    'const waitForDownload = (emitter, signal) => onceEvent(emitter, "download", { signal });\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: a renamed signal parameter still passes', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, abortSignal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    if (abortSignal.aborted) return reject(abortSignal.reason);\n' +
    '    const aborted = () => { cleanup(); reject(abortSignal.reason); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const cleanup = () => { emitter.off("download", done); abortSignal.removeEventListener("abort", aborted); };\n' +
    '    emitter.once("download", done); abortSignal.addEventListener("abort", aborted);\n  });\n}\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: handlers that never settle on their live path fail', () => {
  const r = check('lifecycle',
    '```javascript\nreturn new Promise((resolve, reject) => {\n' +
    '  if (signal.aborted) return reject(signal.reason);\n' +
    '  const aborted = () => { cleanup(); if (false) reject(signal.reason); };\n' +
    '  const done = value => { cleanup(); if (false) resolve(value); };\n' +
    '  const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '  emitter.once("download", done); signal.addEventListener("abort", aborted);\n});\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: rejecting without returning still installs the listeners', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    if (signal.aborted) reject(signal.reason);\n' +
    '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n  });\n}\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: native once on a different emitter fails', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once } = require("node:events");\n' +
    'const waitForDownload = (emitter, signal) => once(otherEmitter, "download", { signal });\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: a local once shim is not the native helper', () => {
  const r = check('lifecycle',
    '```javascript\nfunction once(emitter, event, options) {\n' +
    '  return new Promise(resolve => emitter.on(event, resolve));\n}\n' +
    'const waitForDownload = (emitter, signal) => once(emitter, "download", { signal });\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: an unused native once example does not carry the implementation', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once } = require("node:events");\n' +
    '// Example: once(emitter, "download", { signal })\n' +
    'function waitForDownload(emitter, signal) {\n' +
    '  return new Promise(resolve => emitter.on("download", resolve));\n}\n' +
    'once(emitter, "download", { signal });\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: pre-abort guard after listener installation fails', () => {
  const r = check('lifecycle',
    '```javascript\nreturn new Promise((resolve, reject) => {\n' +
    '  const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '  const done = value => { cleanup(); resolve(value); };\n' +
    '  const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '  emitter.once("download", done); signal.addEventListener("abort", aborted);\n' +
    '  signal.throwIfAborted();\n});\n```');
  assert.equal(r.pass, false);
});

// --- revalidate: persistence is a new trust boundary ---

test('revalidate: persisted URL policy check passes', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("invalid webhook");\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, true);
});

test('revalidate: policies AND-ed together leave each one unenforced', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:" && !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
    'await fetch(url, { redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: following redirects past the policy fails', () => {
  const r = check('revalidate',
    '```javascript\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") throw new Error("bad");\n' +
    'await fetch(url, { method: "POST", body });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: validating a literal URL instead of the saved one fails', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL("https://safe.example");\n' +
    'if (url.protocol !== "https:") throw new Error("bad");\n' +
    'await fetch(url, { redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: an inverted validator policy fails', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(candidate) {\n' +
    '  if (candidate.protocol === "https:") throw new Error("bad");\n}\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nvalidateWebhookUrl(url);\n' +
    'await fetch(url, { redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a policy guard in an uncalled helper fails', () => {
  const r = check('revalidate',
    '```javascript\nfunction unused(url) {\n' +
    '  if (url.protocol !== "https:") throw new Error("bad");\n}\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'await fetch(url, { redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: guard and fetch inside the same function passes', () => {
  const r = check('revalidate',
    '```javascript\nasync function postWebhook(text, body) {\n' +
    '  const saved = JSON.parse(text);\n  const url = new URL(saved.webhook);\n' +
    '  if (url.protocol !== "https:") throw new Error("bad");\n' +
    '  await fetch(url, { method: "POST", body, redirect: "error" });\n}\n```');
  assert.equal(r.pass, true);
});

test('revalidate: a validator whose failure is only a return value fails', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(candidate) {\n' +
    '  if (candidate.protocol !== "https:") return false;\n  return true;\n}\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nvalidateWebhookUrl(url);\n' +
    'await fetch(url, { redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a guarded probe followed by an unguarded POST fails', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") throw new Error("bad");\n' +
    'await fetch(url, { method: "HEAD", redirect: "error" });\n' +
    'await fetch(saved.webhook, { method: "POST", body });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a guarded GET does not perform the requested POST', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") throw new Error("bad");\n' +
    'await fetch(url, { redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a native https POST passes', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") throw new Error("bad");\n' +
    'const request = https.request(url, { method: "POST" });\nrequest.end(payload);\n```');
  assert.equal(r.pass, true);
});

test('revalidate: a policy guard in an unused sibling of the validator fails', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(candidate) { return true; }\n' +
    'function unused(candidate) { if (candidate.protocol !== "https:") throw new Error("bad"); }\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nvalidateWebhookUrl(url);\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a POST with no payload fails', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") throw new Error("bad");\n' +
    'await fetch(url, { method: "POST", headers: { "x-body": "none" }, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a validator called only from an uncalled helper fails', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(candidate) { if (candidate.protocol !== "https:") throw new Error("bad"); }\n' +
    'function unused() { validateWebhookUrl(url); }\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a guard that swallows its own throw fails', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") { try { throw new Error("bad"); } catch {} }\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: mutating the URL after validating it fails', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") throw new Error("bad");\nurl.protocol = "http:";\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: direct use of persisted URL fails', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nawait fetch(saved.webhook, { method: "POST", body });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: reading hostname without enforcing policy fails', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'console.log(url.hostname);\ntry { await fetch(url); } catch (error) { throw error; }\n```');
  assert.equal(r.pass, false);
});

test('revalidate: policy warning plus unrelated fetch rejection fails', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") console.log("bad");\n' +
    'try { await fetch(url); } catch (error) { throw error; }\n```');
  assert.equal(r.pass, false);
});

test('revalidate: validating one URL but fetching persisted input fails', () => {
  const r = check('revalidate',
    '```javascript\nconst url = new URL("https://safe.example");\n' +
    'if (url.protocol !== "https:") throw new Error("bad");\nawait fetch(saved.webhook);\n```');
  assert.equal(r.pass, false);
});

test('revalidate: inverted allow policy fails', () => {
  const r = check('revalidate',
    '```javascript\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol === "https:" || allowedHosts.has(url.hostname)) throw new Error("bad");\nawait fetch(url);\n```');
  assert.equal(r.pass, false);
});

test('revalidate: validation after fetch fails', () => {
  const r = check('revalidate',
    '```javascript\nconst url = new URL(saved.webhook);\nawait fetch(url);\nvalidateWebhookUrl(url);\n```');
  assert.equal(r.pass, false);
});

test('revalidate: an invoked validator that enforces nothing fails', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(url) { return true; }\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nvalidateWebhookUrl(url);\n' +
    'await fetch(url, { redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: an invoked validator that rejects on policy passes', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(candidate) {\n' +
    '  if (candidate.protocol !== "https:") throw new Error("insecure webhook");\n}\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nvalidateWebhookUrl(url);\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, true);
});

test('revalidate: validator declaration without invocation fails', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(url) { return true; }\n' +
    'const url = new URL(saved.webhook);\nawait fetch(url);\n```');
  assert.equal(r.pass, false);
});

// --- bounds: remote work needs time and byte ceilings ---

test('bounds: timeout and enforced streaming byte ceiling pass', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const maxBytes = 10 * 1024 * 1024;\n' +
    'const reader = response.body.getReader();\nlet receivedBytes = 0;\n' +
    'while (true) {\n  const { done, value } = await reader.read();\n  if (done) break;\n' +
    '  receivedBytes += value.byteLength;\n  if (receivedBytes > maxBytes) { await reader.cancel(); throw new Error("too large"); }\n' +
    '  await file.write(value);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: content-length check without streamed counting fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const maxBytes = 10 * 1024 * 1024;\n' +
    'if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("too large");\n' +
    'await writeFile(destination, await response.arrayBuffer());\n```');
  assert.equal(r.pass, false);
});

test('bounds: size warning plus unrelated HTTP throw fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const reader = response.body.getReader();\nlet receivedBytes = 0;\n' +
    'while (true) {\n  const { done, value } = await reader.read();\n  if (done) break;\n' +
    '  receivedBytes += value.byteLength;\n  if (receivedBytes > maxBytes) { console.warn("too large"); }\n' +
    '  if (!response.ok) throw new Error("HTTP error");\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: unrelated timeout does not bound fetch', () => {
  const r = check('bounds',
    '```javascript\nconst timeout = 10_000;\nsetTimeout(showSpinner, timeout);\nconst response = await fetch(url);\n' +
    'const reader = response.body.getReader();\nlet receivedBytes = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceivedBytes += value.byteLength;\n' +
    '  if (receivedBytes > maxBytes) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: cancelling without stopping before write fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const reader = response.body.getReader();\nlet receivedBytes = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceivedBytes += value.byteLength;\n' +
    '  if (receivedBytes > maxBytes) { reader.cancel(); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: arbitrary accumulator and ceiling names pass', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const reader = response.body.getReader();\nlet downloaded = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\ndownloaded += value.byteLength;\n' +
    '  if (downloaded > MAX_DOWNLOAD_SIZE) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: multiline fetch options pass', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, {\n  method: "GET",\n  signal: AbortSignal.timeout(10_000),\n});\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: returning from a data callback does not stop the stream', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'let received = 0;\nresponse.body.on("data", chunk => {\n  received += chunk.length;\n' +
    '  if (received > MAX_BYTES) return;\n  file.write(chunk);\n});\n```');
  assert.equal(r.pass, false);
});

test('bounds: destroying the evented stream at the ceiling passes', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'let received = 0;\nresponse.body.on("data", chunk => {\n  received += chunk.length;\n' +
    '  if (received > MAX_BYTES) { response.body.destroy(new Error("too large")); return; }\n' +
    '  file.write(chunk);\n});\n```');
  assert.equal(r.pass, true);
});

test('bounds: pre-created timeout signal passes', () => {
  const r = check('bounds',
    '```javascript\nconst signal = AbortSignal.timeout(10_000);\nconst response = await fetch(url, { signal });\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: nested fetch options still expose the timeout signal', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, {\n  headers: { Accept: "text/csv" },\n' +
    '  signal: AbortSignal.timeout(10_000),\n});\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: counting after buffering the whole body fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const reader = response.body.getReader();\nconst chunks = [];\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\n  chunks.push(value);\n}\n' +
    'let received = 0;\nfor (const chunk of chunks) {\n  received += chunk.byteLength;\n' +
    '  if (received > MAX_BYTES) throw new Error("too large");\n  await file.write(chunk);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a timer aborting a different controller does not bound the fetch', () => {
  const r = check('bounds',
    '```javascript\nconst controller = new AbortController();\n' +
    'setTimeout(() => otherController.abort(), 10_000);\n' +
    'const response = await fetch(url, { signal: controller.signal });\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: checking the ceiling before counting the chunk fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\n' +
    '  if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n' +
    '  received += value.byteLength;\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a timer armed after the request does not bound it', () => {
  const r = check('bounds',
    '```javascript\nconst controller = new AbortController();\n' +
    'const response = await fetch(url, { signal: controller.signal });\n' +
    'setTimeout(() => controller.abort(), 10_000);\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a literal byte ceiling passes', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > 10 * 1024 * 1024) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: a bounded native https download passes', () => {
  const r = check('bounds',
    '```javascript\nconst response = await https.get(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'let received = 0;\nresponse.on("data", chunk => {\n  received += chunk.length;\n' +
    '  if (received > MAX_BYTES) { response.destroy(new Error("too large")); return; }\n' +
    '  file.write(chunk);\n});\n```');
  assert.equal(r.pass, true);
});

test('bounds: a signal assigned after the request does not bound it', () => {
  const r = check('bounds',
    '```javascript\nlet signal;\nconst response = await fetch(url, { signal });\n' +
    'signal = AbortSignal.timeout(10_000);\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: writing the chunk before the guard fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  await file.write(value);\n  if (received > MAX_BYTES) throw new Error("too large");\n' +
    '  log.write("chunk done");\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a bounded probe does not bound the unbounded report request', () => {
  const r = check('bounds',
    '```javascript\nawait fetch(metaUrl, { signal: AbortSignal.timeout(2_000) });\n' +
    'const response = await fetch(url);\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: returning a truncated download instead of failing fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); return; }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a commented-out byte guard is not a ceiling', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  // if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: tearing down an unrelated object does not stop the stream', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'let received = 0;\nresponse.on("data", chunk => {\n  received += chunk.length;\n' +
    '  if (received > MAX_BYTES) { otherController.abort(new Error("too large")); return; }\n' +
    '  file.write(chunk);\n});\n```');
  assert.equal(r.pass, false);
});

test('bounds: a timeout armed only in an uncalled helper fails', () => {
  const r = check('bounds',
    '```javascript\nlet signal;\nfunction unused() { signal = AbortSignal.timeout(10_000); }\n' +
    'const response = await fetch(url, { signal });\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: an accumulator that never grows fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += 0 * value.byteLength;\n' +
    '  if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: an Infinity ceiling is not a ceiling', () => {
  const r = check('bounds',
    '```javascript\nconst MAX_BYTES = Infinity;\n' +
    'const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: unbounded fetch fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url);\nawait writeFile(destination, await response.arrayBuffer());\n```');
  assert.equal(r.pass, false);
});

// --- unknown probe is skipped, not failed ---

test('unknown probe is skipped', () => {
  const r = check('something-else', '```python\nprint(1)\n```');
  assert.equal(r.pass, true);
  assert.match(r.reason, /skipped/i);
});
