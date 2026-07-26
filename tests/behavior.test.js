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

test('hardware: denying that calibration is needed is not a knob', () => {
  const r = check('hardware',
    '```python\ndef read_c():\n    return adc.read(0) * 0.1\n```\n' +
    'Notes: this sensor is linear and will not drift.\n' +
    'No per-unit tuning is needed, and no calibration knob is required.');
  assert.equal(r.pass, false);
});

test('hardware: a negated datasheet claim followed by a knob still passes', () => {
  const r = check('hardware',
    '```python\ndef read_c(r0=10000):\n    ...\n```\n' +
    'Notes: the datasheet r0 is not exact -- measure your own r0 at a known temp.');
  assert.equal(r.pass, true);
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

test('onecheck: an AssertionError sentinel passes', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    ...\n\ntry:\n    to_seconds("abc")\nexcept ValueError:\n    pass\n' +
    'else:\n    raise AssertionError("expected rejection")\n```');
  assert.equal(r.pass, true);
});

test('onecheck: a check inside an uncalled helper is never run', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    ...\n\ndef unused():\n    try:\n        to_seconds("abc")\n' +
    '    except ValueError:\n        pass\n    else:\n        assert False\n```');
  assert.equal(r.pass, false);
});

test('onecheck: a check under a dead branch runs nothing', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    ...\n\nif False:\n    try:\n        to_seconds("abc")\n' +
    '    except ValueError:\n        pass\n    else:\n        assert False\n```');
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

test('contracts: a merge behind if (false) is unreachable', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  if (false) return { ...current, ...patch };\n  return { theme: "light" };\n}\n' +
    'const result = updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    'console.assert(result.theme === "dark" && result.enabled === false && result.retries === 0 && result.label === "");\n```');
  assert.equal(r.pass, false);
});

test('contracts: a check parked in an uncalled helper never runs', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
    'function demo() {\n' +
    '  const result = updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    '  console.assert(result.theme === "dark" && result.enabled === false && result.retries === 0 && result.label === "");\n}\n```');
  assert.equal(r.pass, false);
});

test('contracts: a check inside a test() callback passes', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
    'test("preserves falsy values", () => {\n' +
    '  const result = updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    '  console.assert(result.theme === "dark" && result.enabled === false && result.retries === 0 && result.label === "");\n});\n```');
  assert.equal(r.pass, true);
});

test('contracts: a conditional reset before the merge drops state', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  if (patch.reset) return { theme: "light" };\n  return { ...current, ...patch };\n}\n' +
    'const result = updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    'console.assert(result.theme === "dark" && result.enabled === false && result.retries === 0 && result.label === "");\n```');
  assert.equal(r.pass, false);
});

test('contracts: an assertion parked in an uncalled helper never runs', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
    'const result = updateSettings({ theme: "dark", enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    'function check() { assert.deepStrictEqual(result, { theme: "dark", enabled: false, retries: 0, label: "" }); }\n```');
  assert.equal(r.pass, false);
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

test('lifecycle: an abort registration behind a dead branch never installs', () => {
  const r = check('lifecycle',
    '```javascript\nreturn new Promise((resolve, reject) => {\n' +
    '  if (signal.aborted) return reject(signal.reason);\n' +
    '  const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '  const done = value => { cleanup(); resolve(value); };\n' +
    '  const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '  emitter.once("download", done);\n  if (false) { signal.addEventListener("abort", aborted); }\n});\n```');
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

test('lifecycle: an early rejected promise outside the executor passes', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  if (signal.aborted) return Promise.reject(signal.reason);\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n  });\n}\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: conditional cleanup leaves listeners on the other path', () => {
  const r = check('lifecycle',
    '```javascript\nreturn new Promise((resolve, reject) => {\n' +
    '  if (signal.aborted) return reject(signal.reason);\n' +
    '  const aborted = () => { if (owned) cleanup(); reject(signal.reason); };\n' +
    '  const done = value => { if (owned) cleanup(); resolve(value); };\n' +
    '  const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '  emitter.once("download", done); signal.addEventListener("abort", aborted);\n});\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: a namespace import of events.once passes', () => {
  const r = check('lifecycle',
    '```javascript\nimport * as events from "node:events";\n' +
    'const waitForDownload = (emitter, signal) => events.once(emitter, "download", { signal });\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: native delegation behind a branch leaves the other path leaking', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once } = require("node:events");\n' +
    'function waitForDownload(emitter, signal) {\n' +
    '  if (useNative) { return once(emitter, "download", { signal }); }\n' +
    '  return new Promise(resolve => emitter.on("download", resolve));\n}\n```');
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
    '  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
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
    'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
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

test('revalidate: options taken from a later unrelated block do not count', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") throw new Error("bad");\nawait fetch(url, options);\n' +
    'function other() { return { method: "POST", body, redirect: "error" }; }\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a conditionally skipped validator call fails', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(candidate) { if (candidate.protocol !== "https:") throw new Error("bad"); }\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (shouldValidate) { validateWebhookUrl(url); }\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a policy trapped in an uncalled nested helper fails', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(candidate) {\n' +
    '  function inner() { if (candidate.protocol !== "https:") throw new Error("bad"); }\n  return true;\n}\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nvalidateWebhookUrl(url);\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a multiline policy condition passes', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (\n  url.protocol !== "https:"\n  || !allowedHosts.has(url.hostname)\n) throw new Error("bad");\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, true);
});

test('revalidate: normalizing before validating is safe ordering', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nurl.hash = "";\n' +
    'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, true);
});

test('revalidate: replaying a manual redirect unvalidated fails', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") throw new Error("bad");\n' +
    'const response = await fetch(url, { method: "POST", body, redirect: "manual" });\n' +
    'const next = response.headers.get("location");\nawait fetch(next, { method: "POST", body });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: reassigning the validated binding fails', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nlet url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") throw new Error("bad");\nurl = new URL(untrustedValue);\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: an unvalidated probe before the guard fails', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'await fetch(url, { method: "HEAD", redirect: "error" });\n' +
    'if (url.protocol !== "https:") throw new Error("bad");\n' +
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
    '  if (candidate.protocol !== "https:" || !allowedHosts.has(candidate.hostname)) throw new Error("insecure webhook");\n}\n' +
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
    'const file = await open(destination, "w");\n' +
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
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet downloaded = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\ndownloaded += value.byteLength;\n' +
    '  if (downloaded > MAX_DOWNLOAD_SIZE) { await reader.cancel(); throw new Error("too large"); }\n' +
    'await file.write(value);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: multiline fetch options pass', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, {\n  method: "GET",\n  signal: AbortSignal.timeout(10_000),\n});\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: returning from a data callback does not stop the stream', () => {
  const r = check('bounds',
    '```javascript\nconst response = await https.get(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'let received = 0;\nresponse.body.on("data", chunk => {\n  received += chunk.length;\n' +
    '  if (received > MAX_BYTES) return;\n  file.write(chunk);\n});\n```');
  assert.equal(r.pass, false);
});

test('bounds: Node stream methods on a fetch body fail at runtime', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'let received = 0;\nresponse.body.on("data", chunk => {\n  received += chunk.length;\n' +
    '  if (received > MAX_BYTES) { response.body.destroy(new Error("too large")); return; }\n' +
    '  file.write(chunk);\n});\n```');
  assert.equal(r.pass, false);
});

test('bounds: pre-created timeout signal passes', () => {
  const r = check('bounds',
    '```javascript\nconst signal = AbortSignal.timeout(10_000);\nconst response = await fetch(url, { signal });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: nested fetch options still expose the timeout signal', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, {\n  headers: { Accept: "text/csv" },\n' +
    '  signal: AbortSignal.timeout(10_000),\n});\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
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
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: checking the ceiling before counting the chunk fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const file = await open(destination, "w");\n' +
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
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a literal byte ceiling passes', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > 10 * 1024 * 1024) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: awaiting https.get yields a ClientRequest, not the body', () => {
  const r = check('bounds',
    '```javascript\nconst response = await https.get(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const file = createWriteStream(destination);\n' +
    'let received = 0;\nresponse.on("data", chunk => {\n  received += chunk.length;\n' +
    '  if (received > MAX_BYTES) { response.destroy(new Error("too large")); return; }\n' +
    '  file.write(chunk);\n});\n```');
  assert.equal(r.pass, false);
});

test('bounds: a signal assigned after the request does not bound it', () => {
  const r = check('bounds',
    '```javascript\nlet signal;\nconst response = await fetch(url, { signal });\n' +
    'signal = AbortSignal.timeout(10_000);\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: writing the chunk before the guard fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const file = await open(destination, "w");\n' +
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
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: returning a truncated download instead of failing fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); return; }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a commented-out byte guard is not a ceiling', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  // if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: tearing down an unrelated object does not stop the stream', () => {
  const r = check('bounds',
    '```javascript\nconst response = await https.get(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const file = createWriteStream(destination);\n' +
    'let received = 0;\nresponse.on("data", chunk => {\n  received += chunk.length;\n' +
    '  if (received > MAX_BYTES) { otherController.abort(new Error("too large")); return; }\n' +
    '  file.write(chunk);\n});\n```');
  assert.equal(r.pass, false);
});

test('bounds: a timeout armed only in an uncalled helper fails', () => {
  const r = check('bounds',
    '```javascript\nlet signal;\nfunction unused() { signal = AbortSignal.timeout(10_000); }\n' +
    'const response = await fetch(url, { signal });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: an accumulator that never grows fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += 0 * value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: an Infinity ceiling is not a ceiling', () => {
  const r = check('bounds',
    '```javascript\nconst MAX_BYTES = Infinity;\n' +
    'const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: counting an unrelated value is not counting the chunk', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += destination.length;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a predictive byte guard passes', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\n' +
    '  if (received + value.byteLength > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\n' +
    'received += value.byteLength;\n  await file.write(value);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: a for-await consumer links to its timed request', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10_000) });\n' +
    'const file = await open(destination, "w");\n' +
    'let received = 0;\nfor await (const chunk of response.body) {\n  received += chunk.byteLength;\n' +
    '  if (received > MAX_BYTES) { await response.body.cancel(); throw new Error("too large"); }\n' +
    '  await file.write(chunk);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: a timer cleared before the request bounds nothing', () => {
  const r = check('bounds',
    '```javascript\nconst controller = new AbortController();\n' +
    'const timer = setTimeout(() => controller.abort(), 10_000);\nclearTimeout(timer);\n' +
    'const response = await fetch(url, { signal: controller.signal });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a callback-style native https download passes', () => {
  const r = check('bounds',
    '```javascript\nconst file = createWriteStream(destination);\n' +
    'https.get(url, { signal: AbortSignal.timeout(10_000) }, response => {\n' +
    '  let received = 0;\n  response.on("data", chunk => {\n    received += chunk.length;\n' +
    '    if (received > MAX_BYTES) { response.destroy(new Error("too large")); return; }\n' +
    '    file.write(chunk);\n  });\n});\n```');
  assert.equal(r.pass, true);
});

test('bounds: a timeout in an unrelated later block does not bound the request', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url);\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const opts = { signal: AbortSignal.timeout(10_000) };\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: unbounded fetch fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url);\nawait writeFile(destination, await response.arrayBuffer());\n```');
  assert.equal(r.pass, false);
});

// --- comments are not behavior, but strings are not comments ---

test('contracts: a block-commented check is not a runnable one', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
    '/* const result = updateSettings({ theme: "dark", sound: true, label: "x" },\n' +
    '  { sound: false, volume: 0, label: "" });\n' +
    'console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
    'console.assert(result.label === ""); console.assert(result.theme === "dark"); */\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a block-commented policy guard is not a guard', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    '/* if (url.protocol !== "https:") throw new Error("invalid webhook"); */\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('bounds: a trailing-comment byte guard is not a ceiling', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  await file.write(value); // if (received > MAX_BYTES) throw new Error("too large");\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a policy guard quoting "//" in a URL still counts', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("expected https://host form");\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, true);
});

// --- structure, not formatting: balanced bodies and optional semicolons ---

test('lifecycle: a nested object before cleanup does not truncate the handler', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    if (signal.aborted) return reject(signal.reason);\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    const done = value => { const result = { value, at: Date.now() }; cleanup(); resolve(result); };\n' +
    '    const aborted = () => { const reason = { cause: signal.reason }; cleanup(); reject(reason); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted, { once: true });\n' +
    '  });\n}\n```');
  assert.equal(r.pass, true);
});

test('contracts: a semicolonless result assignment still binds the result', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch } }\n' +
    'const result = updateSettings({ theme: "dark", sound: true, label: "x" },\n' +
    '  { sound: false, volume: 0, label: "" })\n' +
    'console.assert(result.sound === false)\nconsole.assert(result.volume === 0)\n' +
    'console.assert(result.label === "")\nconsole.assert(result.theme === "dark")\n```');
  assert.equal(r.pass, true);
});

// --- every path, every request ---

test('contracts: a conditional non-literal reset before the merge drops state', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  if (patch.reset) return defaults();\n  return { ...current, ...patch };\n}\n' +
    'const result = updateSettings({ theme: "dark", sound: true, label: "x" },\n' +
    '  { sound: false, volume: 0, label: "" });\n' +
    'console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
    'console.assert(result.label === ""); console.assert(result.theme === "dark");\n```');
  assert.equal(r.pass, false);
});

test('contracts: an early return of the existing settings still merges every patch', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  if (!patch) return current;\n  return { ...current, ...patch };\n}\n' +
    'const result = updateSettings({ theme: "dark", sound: true, label: "x" },\n' +
    '  { sound: false, volume: 0, label: "" });\n' +
    'console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
    'console.assert(result.label === ""); console.assert(result.theme === "dark");\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: a synchronous throwIfAborted breaks the promise contract', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  signal.throwIfAborted();\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n' +
    '  });\n}\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: an async throwIfAborted still returns a rejected promise', () => {
  const r = check('lifecycle',
    '```javascript\nasync function waitForDownload(emitter, signal) {\n' +
    '  signal.throwIfAborted();\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n' +
    '  });\n}\n```');
  assert.equal(r.pass, true);
});

test('revalidate: mutating the cleared URL through an alias bypasses the policy', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") throw new Error("invalid webhook");\n' +
    'const alias = url;\nalias.protocol = "http:";\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('bounds: a timeout armed only in a branch does not bound the request', () => {
  const r = check('bounds',
    '```javascript\nlet controller;\nif (enforceDeadline) {\n' +
    '  controller = new AbortController();\n  setTimeout(() => controller.abort(), 10000);\n}\n' +
    'const response = await fetch(url, { signal: controller.signal });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a bounded request in another function does not bound this reader', () => {
  const r = check('bounds',
    '```javascript\nasync function probe(url) {\n' +
    '  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
    '  return response.status;\n}\n' +
    'async function download(url, file) {\n' +
    '  const response = await fetch(url);\n' +
    '  const file = await open(destination, "w");\n' +
    '  const reader = response.body.getReader();\n  let received = 0;\n  while (true) {\n' +
    '    const { done, value } = await reader.read(); if (done) break;\n    received += value.byteLength;\n' +
    '    if (received > MAX_BYTES) throw new Error("too large");\n    await file.write(value);\n  }\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a conjunction that disables the byte ceiling fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES && strictMode) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

// --- an escape hatch one branch deeper is not enforcement ---

test('lifecycle: conditional listener removal leaks on the other path', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    if (signal.aborted) return reject(signal.reason);\n' +
    '    const cleanup = () => { if (owned) { emitter.off("download", done); signal.removeEventListener("abort", aborted); } };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n' +
    '  });\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a nested conditional throw does not reject the invalid path', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") { if (strict) throw new Error("bad"); }\n' +
    'if (!allowedHosts.has(url.hostname)) throw new Error("bad host");\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('bounds: a conditional throw in the over-limit branch still writes', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { if (strict) throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

// --- the evidence has to be the thing the task asked for ---

test('contracts: a conditional return of current skips the rest of the patch', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  if (patch.skip) return current;\n  return { ...current, ...patch };\n}\n' +
    'const result = updateSettings({ theme: "dark", sound: true, label: "x" },\n' +
    '  { skip: false, sound: false, volume: 0, label: "" });\n' +
    'console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
    'console.assert(result.label === ""); console.assert(result.theme === "dark");\n```');
  assert.equal(r.pass, false);
});

test('contracts: returning current when there is no patch is not a reset', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  if (!patch) return current;\n  return { ...current, ...patch };\n}\n' +
    'const result = updateSettings({ theme: "dark", sound: true, label: "x" },\n' +
    '  { sound: false, volume: 0, label: "" });\n' +
    'console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
    'console.assert(result.label === ""); console.assert(result.theme === "dark");\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: a bare awaited native once discards the download event', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once } = require("node:events");\n' +
    'async function waitForDownload(emitter, signal) {\n' +
    '  await once(emitter, "download", { signal });\n}\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: a returned awaited native once passes', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once } = require("node:events");\n' +
    'async function waitForDownload(emitter, signal) {\n' +
    '  return await once(emitter, "download", { signal });\n}\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: a braced early rejection terminates before installing listeners', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    if (signal.aborted) { return reject(signal.reason); }\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n' +
    '  });\n}\n```');
  assert.equal(r.pass, true);
});

test('onecheck: a rejection proved for a helper defined first is not the parser', () => {
  const r = check('onecheck',
    '```python\ndef helper(s):\n    raise ValueError(s)\n\ndef to_seconds(s):\n    return 0\n\n' +
    'with pytest.raises(ValueError):\n    helper("bad")\n```');
  assert.equal(r.pass, false);
});

test('onecheck: a rejection check with no function to check against fails', () => {
  const r = check('onecheck',
    '```python\nwith pytest.raises(ValueError):\n    int("bad")\n```');
  assert.equal(r.pass, false);
});

test('revalidate: an https-only policy leaves the hostname unrestricted', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:") throw new Error("bad");\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: an allowlist that still permits http leaves the transport open', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (!allowedHosts.has(url.hostname)) throw new Error("bad host");\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: an alias created by later assignment is still the same URL', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
    'let destination;\ndestination = url;\ndestination.protocol = "http:";\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('bounds: a signal nested in headers is not the request signal', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { headers: { signal: AbortSignal.timeout(10000) } });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('hardware: a negated dismissal still warns about drift', () => {
  const r = check('hardware',
    '```python\ndef read_c(adc):\n    return adc.read(0) * 0.1\n```\n' +
    'Do not ignore per-unit drift. Calibration does not remove part-to-part spread.');
  assert.equal(r.pass, true);
});

test('hardware: exposed thermistor coefficients are the knob', () => {
  const r = check('hardware',
    '```python\ndef read_c(adc, r0=10000, beta=3950, series_resistor=10000):\n' +
    '    return _steinhart(adc.read(0), r0, beta, series_resistor)\n```\n' +
    'Returns degrees Celsius.');
  assert.equal(r.pass, true);
});

// --- a branch is a branch even when its condition contains a call ---

test('revalidate: policy checks behind a call-shaped condition do not dominate', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (opts.get("strict")) {\n' +
    '  if (url.protocol !== "https:") throw new Error("bad");\n' +
    '  if (!allowedHosts.has(url.hostname)) throw new Error("bad host");\n}\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('bounds: a timeout behind a call-shaped condition does not bound the request', () => {
  const r = check('bounds',
    '```javascript\nlet controller;\nif (config.get("strict")) {\n' +
    '  controller = new AbortController();\n  setTimeout(() => controller.abort(), 10000);\n}\n' +
    'const response = await fetch(url, { signal: controller.signal });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: cleanup behind a call-shaped condition still leaks', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    if (signal.aborted) return reject(signal.reason);\n' +
    '    const cleanup = () => { if (owners.has(emitter)) { emitter.off("download", done); signal.removeEventListener("abort", aborted); } };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n' +
    '  });\n}\n```');
  assert.equal(r.pass, false);
});

// --- a rejection the answer catches itself rejects nothing ---

test('lifecycle: a pre-abort throw the function catches terminates nothing', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    try { if (signal.aborted) throw signal.reason; } catch {}\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n' +
    '  });\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a validator that catches its own policy failures fails', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(candidate) {\n  try {\n' +
    '    if (candidate.protocol !== "https:") throw new Error("insecure");\n' +
    '    if (!allowedHosts.has(candidate.hostname)) throw new Error("bad host");\n' +
    '  } catch {}\n}\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nvalidateWebhookUrl(url);\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

// --- the knob has to be reachable, the timer has to be released ---

test('hardware: hard-coded coefficients inside the conversion are not a knob', () => {
  const r = check('hardware',
    '```python\ndef read_c(adc):\n    beta = 3950\n    r0 = 10000\n' +
    '    return _steinhart(adc.read(0), r0, beta)\n```\n' +
    'Returns degrees Celsius.');
  assert.equal(r.pass, false);
});

test('bounds: a manual abort timer that is never cleared leaks', () => {
  const r = check('bounds',
    '```javascript\nconst controller = new AbortController();\n' +
    'const timer = setTimeout(() => controller.abort(), 10000);\n' +
    'const response = await fetch(url, { signal: controller.signal });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a manual abort timer cleared in finally passes', () => {
  const r = check('bounds',
    '```javascript\nconst controller = new AbortController();\n' +
    'const timer = setTimeout(() => controller.abort(), 10000);\ntry {\n' +
    '  const response = await fetch(url, { signal: controller.signal });\n' +
    '  const file = await open(destination, "w");\n' +
    '  const reader = response.body.getReader();\n  let received = 0;\n  while (true) {\n' +
    '    const { done, value } = await reader.read(); if (done) break;\n    received += value.byteLength;\n' +
    '    if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\n    await file.write(value);\n  }\n' +
    '} finally {\n  clearTimeout(timer);\n}\n```');
  assert.equal(r.pass, true);
});

// --- options and assertions have to name what they claim ---

test('revalidate: request options held by a local binding still count', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
    'const options = { method: "POST", body: JSON.stringify(payload), redirect: "error" };\n' +
    'await fetch(url, options);\n```');
  assert.equal(r.pass, true);
});

test('contracts: asserting falsy fields the patch never supplied proves nothing', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
    'const result = updateSettings({ theme: "dark", muted: false, retries: 0, note: "" },\n' +
    '  { sound: false, volume: 0, label: "" });\n' +
    'console.assert(result.muted === false); console.assert(result.retries === 0);\n' +
    'console.assert(result.note === ""); console.assert(result.theme === "dark");\n```');
  assert.equal(r.pass, false);
});

// --- a brace inside a message is not a brace ---

test('lifecycle: an unbalanced brace in an error message does not truncate', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    if (signal.aborted) return reject(signal.reason);\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const aborted = () => { cleanup(); reject(new Error("aborted {")); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n' +
    '  });\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: an unbalanced brace in an error message does not truncate', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large {"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, true);
});

test('revalidate: an unbalanced brace in an error message does not truncate', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad {");\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, true);
});

test('revalidate: a catch that rethrows still rejects the invalid URL', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(candidate) {\n  try {\n' +
    '    if (candidate.protocol !== "https:") throw new Error("insecure");\n' +
    '    if (!allowedHosts.has(candidate.hostname)) throw new Error("bad host");\n' +
    '  } catch (error) { throw new Error("webhook rejected", { cause: error }); }\n}\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nvalidateWebhookUrl(url);\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, true);
});

test('revalidate: optional chaining is not a branch', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved?.webhook);\n' +
    'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, true);
});

// --- a defaulted parameter does not hide a function ---

test('lifecycle: a handler with a defaulted parameter is still the handler', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    if (signal.aborted) return reject(signal.reason);\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    const done = (value = fallback()) => { cleanup(); resolve(value); };\n' +
    '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n' +
    '  });\n}\n```');
  assert.equal(r.pass, true);
});

test('contracts: a defaulted parameter does not make an uncalled helper run', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
    'function unused(seed = compute()) {\n' +
    '  const result = updateSettings({ theme: "dark", sound: true, label: "x" },\n' +
    '    { sound: false, volume: 0, label: "" });\n' +
    '  console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
    '  console.assert(result.label === ""); console.assert(result.theme === "dark");\n}\n```');
  assert.equal(r.pass, false);
});

// --- round 4: escape hatches, scope, and syntax the answer may legally use ---

test('revalidate: a catch that rethrows only sometimes still swallows', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(candidate) {\n  try {\n' +
    '    if (candidate.protocol !== "https:") throw new Error("insecure");\n' +
    '    if (!allowedHosts.has(candidate.hostname)) throw new Error("bad host");\n' +
    '  } catch (error) { if (debug) throw error; }\n}\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nvalidateWebhookUrl(url);\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('bounds: a later helper’s options do not bound this request', () => {
  const r = check('bounds',
    '```javascript\nconst options = makeOptions();\n' +
    'const response = await fetch(url, options);\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n' +
    'function elsewhere() {\n  const options = { signal: AbortSignal.timeout(10000) };\n  return options;\n}\n```');
  assert.equal(r.pass, false);
});

test('hardware: a balanced parameter list still exposes the coefficient', () => {
  const r = check('hardware',
    '```python\ndef read_temperature(channel=default_channel(), beta=3950):\n' +
    '    return _steinhart(channel, beta)\n```\nReturns degrees Celsius.');
  assert.equal(r.pass, true);
});

test('hardware: a knob on a helper the reader never calls is not a knob', () => {
  const r = check('hardware',
    '```python\ndef read_temperature(adc):\n    return adc.read(0) * 0.1\n\n' +
    'def helper(beta=3950):\n    return beta\n```\nReturns degrees Celsius.');
  assert.equal(r.pass, false);
});

test('lifecycle: a brace in a multiline template literal does not truncate', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    if (signal.aborted) return reject(signal.reason);\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const aborted = () => { cleanup(); reject(new Error(`aborted\n{`)); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n' +
    '  });\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: a for-await header containing a call is still a consumer', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
    'const file = await open(destination, "w");\nlet received = 0;\n' +
    'for await (const chunk of response.body.values()) {\n  received += chunk.byteLength;\n' +
    '  if (received > MAX_BYTES) { await response.body.cancel(); throw new Error("too large"); }\n' +
    '  await file.write(chunk);\n}\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: a pre-abort guard that only sometimes rejects falls through', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    if (signal.aborted) { if (strict) return reject(signal.reason); }\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n' +
    '  });\n}\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: a conditionally settling handler leaves the promise pending', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n' +
    '  return new Promise((resolve, reject) => {\n' +
    '    if (signal.aborted) return reject(signal.reason);\n' +
    '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
    '    const done = value => { cleanup(); resolve(value); };\n' +
    '    const aborted = () => { cleanup(); if (strict) { log(); reject(signal.reason); } };\n' +
    '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n' +
    '  });\n}\n```');
  assert.equal(r.pass, false);
});

test('contracts: a negative assertion API proves the opposite contract', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
    'const result = updateSettings({ theme: "dark", sound: true, label: "x" },\n' +
    '  { sound: false, volume: 0, label: "" });\n' +
    'assert.notEqual(result.sound, false); assert.notEqual(result.volume, 0);\n' +
    'assert.notEqual(result.label, ""); assert.notEqual(result.theme, "dark");\n```');
  assert.equal(r.pass, false);
});

test('contracts: quoted property names are ordinary keys', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
    'const result = updateSettings({ "theme": "dark", "sound": true, "label": "x" },\n' +
    '  { "sound": false, "volume": 0, "label": "" });\n' +
    'console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
    'console.assert(result.label === ""); console.assert(result.theme === "dark");\n```');
  assert.equal(r.pass, true);
});

test('onecheck: a helper that parses its own literal never tests the input', () => {
  const r = check('onecheck',
    '```python\ndef parse_duration(s):\n    return 0\n\ndef check_failure(s):\n    try:\n' +
    '        parse_duration("1h")\n    except ValueError:\n        return True\n' +
    '    raise ValueError("nope")\n\nwith pytest.raises(ValueError):\n    check_failure("malformed")\n```');
  assert.equal(r.pass, false);
});

test('revalidate: an unawaited async validator does not gate the request', () => {
  const r = check('revalidate',
    '```javascript\nasync function validateWebhookUrl(candidate) {\n' +
    '  if (candidate.protocol !== "https:") throw new Error("insecure");\n' +
    '  if (!allowedHosts.has(candidate.hostname)) throw new Error("bad host");\n}\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nvalidateWebhookUrl(url);\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: an awaited async validator does gate the request', () => {
  const r = check('revalidate',
    '```javascript\nasync function validateWebhookUrl(candidate) {\n' +
    '  if (candidate.protocol !== "https:") throw new Error("insecure");\n' +
    '  if (!allowedHosts.has(candidate.hostname)) throw new Error("bad host");\n}\n' +
    'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nawait validateWebhookUrl(url);\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, true);
});

test('revalidate: a positive allow condition is the same policy', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (!(url.protocol === "https:" && allowedHosts.has(url.hostname))) throw new Error("bad");\n' +
    'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, true);
});

test('revalidate: the validated URL’s href is the same destination', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
    'await fetch(url.href, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, true);
});

test('bounds: an absent timeout argument is not a deadline', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout() });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: an infinite timeout argument is not a deadline', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(Infinity) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: an explicit accumulator assignment counts the same bytes', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\n' +
    'received = received + value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: throwing without cancelling leaves the stream open', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) throw new Error("too large");\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: writing the chunk somewhere other than the destination fails', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
    'const file = await open(destination, "w");\n' +
    'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
    '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
    '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\naudit.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

// --- round 5: every path in, every path out, and the right object ---

test('lifecycle: an early return before settlement leaves the promise pending', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n  return new Promise((resolve, reject) => {\n    if (signal.aborted) return reject(signal.reason);\n' + '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
  '    const done = value => { if (ignore) return; cleanup(); resolve(value); };\n' +
  '    const aborted = () => { cleanup(); reject(signal.reason); };\n' + '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n  });\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a negated expression with a bypass clause is not the policy', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
  'if (!(url.protocol === "https:" && allowedHosts.has(url.hostname) || bypass)) throw new Error("bad");\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: returning the validator exits before the request', () => {
  const r = check('revalidate',
    '```javascript\nasync function validateWebhookUrl(candidate) {\n  if (candidate.protocol !== "https:") throw new Error("x");\n  if (!allowedHosts.has(candidate.hostname)) throw new Error("y");\n}\n' +
  'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nreturn validateWebhookUrl(url);\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('contracts: bare assert takes a message, not an expected value', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
  'const result = updateSettings({ theme: "dark", sound: true, label: "x" }, { sound: false, volume: 0, label: "" });\n' +
  'assert(result.sound, false); assert(result.volume, 0);\nassert(result.label, ""); assert(result.theme, "dark");\n```');
  assert.equal(r.pass, false);
});

test('bounds: tearing down an unrelated object leaves the reader open', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\nconst file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
  '  if (received > MAX_BYTES) { await audit.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: a URL inside a multiline template is not a comment', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n  return new Promise((resolve, reject) => {\n    if (signal.aborted) return reject(signal.reason);\n' + '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
  '    const done = value => { log(`start\nhttps://example.com`); cleanup(); resolve(value); };\n' +
  '    const aborted = () => { cleanup(); reject(signal.reason); };\n' + '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n  });\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: an options binding in a branch does not bound the request', () => {
  const r = check('bounds',
    '```javascript\nlet options;\nif (useDeadline) { options = { signal: AbortSignal.timeout(1000) }; }\n' +
  'const response = await fetch(url, options);\nconst file = await open(destination, "w");\n' +
  'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
  '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a destination-shaped parameter is not the destination', () => {
  const r = check('bounds',
    '```javascript\nasync function download(url, destination, auditOutput) {\n' +
  '  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
  '  const audit = createWriteStream(auditOutput);\n' +
  '  const reader = response.body.getReader();\n  let received = 0;\n  while (true) {\n' +
  '    const { done, value } = await reader.read(); if (done) break;\n    received += value.byteLength;\n' +
  '    if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\n    await audit.write(value);\n  }\n}\n```');
  assert.equal(r.pass, false);
});

test('hardware: an environment knob in an uncalled helper is unreachable', () => {
  const r = check('hardware',
    '```python\ndef read_temperature(adc):\n    beta = 3950\n    return _steinhart(adc.read(0), beta)\n\n' +
  'def unused():\n    beta = os.environ["BETA"]\n    return beta\n```\nReturns Celsius.');
  assert.equal(r.pass, false);
});

test('onecheck: a self-recursive helper is still never entered', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    return 0\n\ndef unused():\n    try:\n        to_seconds("abc")\n    except ValueError:\n        pass\n    else:\n        assert False\n    unused()\n```');
  assert.equal(r.pass, false);
});

test('bounds: a negative timeout throws before the request starts', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(-1) });\nconst file = await open(destination, "w");\n' +
  'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
  '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a mutation before a second POST reuses stale guards', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
  'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\nurl.hostname = "evil.example";\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: a conditional throwIfAborted installs listeners anyway', () => {
  const r = check('lifecycle',
    '```javascript\nasync function waitForDownload(emitter, signal) {\n  if (strict) signal.throwIfAborted();\n' +
  '  return new Promise((resolve, reject) => {\n' + '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
  '    const done = value => { cleanup(); resolve(value); };\n' +
  '    const aborted = () => { cleanup(); reject(signal.reason); };\n' + '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n  });\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a bounded probe does not excuse an unbounded download', () => {
  const r = check('bounds',
    '```javascript\nconst meta = await fetch(metaUrl, { signal: AbortSignal.timeout(5000) });\n' +
  'const response = await fetch(url);\nconst file = await open(destination, "w");\n' +
  'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
  '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: an accumulator starting below zero never trips the ceiling', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\nconst file = await open(destination, "w");\n' +
  'const reader = response.body.getReader();\nlet received = -Infinity;\nwhile (true) {\n  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
  '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a fetch Response has no write, so no payload was sent', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
  'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  'const response = await fetch(url, { method: "POST", redirect: "error" });\nresponse.write(body);\n```');
  assert.equal(r.pass, false);
});

test('contracts: a check inside if (false) never runs', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
  'if (false) {\n  const result = updateSettings({ theme: "dark", sound: true, label: "x" }, { sound: false, volume: 0, label: "" });\n' +
  '  console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
  '  console.assert(result.label === ""); console.assert(result.theme === "dark");\n}\n```');
  assert.equal(r.pass, false);
});

test('onecheck: a helper forwarding a ternary never passes the input on', () => {
  const r = check('onecheck',
    '```python\ndef parse_duration(s):\n    return 0\n\ndef helper(value):\n    return parse_duration("1h" if True else value)\n\n' +
  'with pytest.raises(ValueError):\n    helper("bad")\n```');
  assert.equal(r.pass, false);
});

// --- round 6: the right receiver, the right order, the right value ---

test('bounds: a conditional clearTimeout in finally still leaks the timer', () => {
  const r = check('bounds',
    '```javascript\nconst controller = new AbortController();\nconst timer = setTimeout(() => controller.abort(), 10000);\ntry {\n' +
  'const response = await fetch(url, { signal: controller.signal });\n' + 'const file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n' +
  '} finally { if (debug) clearTimeout(timer); }\n```');
  assert.equal(r.pass, false);
});

test('bounds: a deadline bound to zero is not a deadline', () => {
  const r = check('bounds',
    '```javascript\nconst deadline = 0;\nconst response = await fetch(url, { signal: AbortSignal.timeout(deadline) });\n' + 'const file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n' + '```');
  assert.equal(r.pass, false);
});

test('bounds: an accumulator zeroed in an unused helper leaves NaN', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
  'const file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received;\nwhile (true) {\n' +
  '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
  '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n' +
  'function unused() { let received = 0; return received; }\n```');
  assert.equal(r.pass, false);
});

test('bounds: a fetch Response has no cancel, so nothing is torn down', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
  'const file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
  '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
  '  if (received > MAX_BYTES) { await response.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('contracts: an assertion above the call dies on a ReferenceError', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
  'console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
  'console.assert(result.label === ""); console.assert(result.theme === "dark");\n' +
  'const result = updateSettings({ theme: "dark", sound: true, label: "x" }, { sound: false, volume: 0, label: "" });\n```');
  assert.equal(r.pass, false);
});

test('hardware: an unreachable env knob after return calibrates nothing', () => {
  const r = check('hardware',
    '```python\ndef read_temperature(adc):\n    return adc.read(0) * 0.1\n    beta = os.getenv("BETA", 3950)\n```\nReturns Celsius.');
  assert.equal(r.pass, false);
});

test('hardware: an env knob the reading consumes is a real knob', () => {
  const r = check('hardware',
    '```python\ndef read_temperature(adc):\n    beta = os.getenv("BETA", 3950)\n    return _steinhart(adc.read(0), beta)\n```\nReturns Celsius.');
  assert.equal(r.pass, true);
});

test('revalidate: a replayed request must refuse redirects too', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
  'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  'const first = await fetch(url, { method: "POST", body, redirect: "manual" });\n' +
  'const redirected = new URL(first.headers.get("location"));\n' +
  'if (redirected.protocol !== "https:" || !allowedHosts.has(redirected.hostname)) throw new Error("bad");\n' +
  'await fetch(redirected, { method: "POST", body });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: an inverted host clause throws for the allowed hosts', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
  'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) === false) throw new Error("bad");\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a null body sends no payload at all', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
  'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  'await fetch(url, { method: "POST", body: null, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: native once options held by a binding still delegate', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once } = require("node:events");\n' +
  'function waitForDownload(emitter, signal) {\n  const options = { signal };\n  return once(emitter, "download", options);\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: an unbounded fetch in a sibling helper is not this download', () => {
  const r = check('bounds',
    '```javascript\nasync function download(url, destination) {\n' +
  '  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
  '  const file = await open(destination, "w");\n  const reader = response.body.getReader();\n  let received = 0;\n  while (true) {\n' +
  '    const { done, value } = await reader.read(); if (done) break;\n    received += value.byteLength;\n' +
  '    if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\n    await file.write(value);\n  }\n}\n' +
  'async function unrelated(u) { return fetch(u); }\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: listeners on another emitter never settle this promise', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n  return new Promise((resolve, reject) => {\n' +
  '    if (signal.aborted) return reject(signal.reason);\n' +
  '    const cleanup = () => { other.off("download", done); otherSignal.removeEventListener("abort", aborted); };\n' +
  '    const done = value => { cleanup(); resolve(value); };\n' +
  '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
  '    other.once("download", done); otherSignal.addEventListener("abort", aborted);\n  });\n}\n```');
  assert.equal(r.pass, false);
});

test('onecheck: a sentinel under a dead branch never fails', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    return 0\n\ntry:\n    to_seconds("abc")\n    if False:\n        raise AssertionError\nexcept AssertionError:\n    pass\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a read declared after the URL throws before validating', () => {
  const r = check('revalidate',
    '```javascript\nconst url = new URL(saved.webhook);\n' +
  'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\n' +
  'const saved = JSON.parse(text);\n```');
  assert.equal(r.pass, false);
});

// --- round 7: whose function, whose request, whose object ---

test('hardware: a knob parameter the reading ignores changes nothing', () => {
  const r = check('hardware',
    '```python\ndef read_temperature(beta=3950):\n    return 25.0\n```\nReturns Celsius.');
  assert.equal(r.pass, false);
});

test('lifecycle: a sibling that delegates does not fix waitForDownload', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once } = require("node:events");\n' +
  'function helper(emitter, signal) { return once(emitter, "download", { signal }); }\n' +
  'function waitForDownload(emitter, signal) {\n  return new Promise(resolve => emitter.on("download", resolve));\n}\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: a shadowed local options object is the one that counts', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once } = require("node:events");\nconst options = { signal };\n' +
  'function waitForDownload(emitter, signal) {\n  const options = { signal: otherSignal };\n' +
  '  return once(emitter, "download", options);\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: an unrelated config fetch does not cross this boundary', () => {
  const r = check('revalidate',
    '```javascript\nfunction loadConfig() { return fetch(configUrl); }\n' +
  'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' + 'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, true);
});

test('bounds: aborting an unrelated controller leaves this reader open', () => {
  const r = check('bounds',
    '```javascript\nconst unrelated = new AbortController();\n' +
  'const response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
  'const file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
  '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
  '  if (received > MAX_BYTES) { unrelated.abort(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('onecheck: a rejection marker that owns no call checks nothing', () => {
  const r = check('onecheck',
    '```python\ndef parse_duration(s):\n    return 0\n\npytest.raises; parse_duration("bad")\n```');
  assert.equal(r.pass, false);
});

test('contracts: assertions inside if (false) are not a regression check', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
  'const result = updateSettings({ theme: "dark", sound: true, label: "x" }, { sound: false, volume: 0, label: "" });\n' +
  'if (false) {\n  console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
  '  console.assert(result.label === ""); console.assert(result.theme === "dark");\n}\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: a cleanup that throws never lets the handler settle', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n  return new Promise((resolve, reject) => {\n' +
  '    if (signal.aborted) return reject(signal.reason);\n' +
  '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); throw new Error("x"); };\n' +
  '    const done = value => { cleanup(); resolve(value); };\n' +
  '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
  '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n  });\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a validator that returns false is ignored by its caller', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(candidate) {\n' +
  '  if (candidate.protocol !== "https:") return false;\n  if (!allowedHosts.has(candidate.hostname)) return false;\n' +
  '  if (debug) throw new Error("debug");\n  return true;\n}\n' +
  'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nvalidateWebhookUrl(url);\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('bounds: a destination write in a dead branch never runs', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
  'const file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
  '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
  '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nif (false) await file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('onecheck: `if not True` is as dead as `if False`', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    return 0\n\nif not True:\n    try:\n        to_seconds("abc")\n    except ValueError:\n        pass\n    else:\n        assert False\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: expression-bodied handlers own the lifecycle too', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n  return new Promise((resolve, reject) => {\n' +
  '    if (signal.aborted) return reject(signal.reason);\n' +
  '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
  '    const done = value => (cleanup(), resolve(value));\n' +
  '    const aborted = () => (cleanup(), reject(signal.reason));\n' +
  '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n  });\n}\n```');
  assert.equal(r.pass, true);
});

test('revalidate: a shorthand body defaulted to null sends no payload', () => {
  const r = check('revalidate',
    '```javascript\nasync function send(text, body = null) {\n  const saved = JSON.parse(text);\n  const url = new URL(saved.webhook);\n' +
  '  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  '  await fetch(url, { method: "POST", body, redirect: "error" });\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a bounded sibling does not bound the requested download', () => {
  const r = check('bounds',
    '```javascript\nasync function probe(u, destination) {\n' +
  '  const response = await fetch(u, { signal: AbortSignal.timeout(5000) });\n' +
  '  const file = await open(destination, "w");\n  const reader = response.body.getReader();\n  let received = 0;\n  while (true) {\n' +
  '    const { done, value } = await reader.read(); if (done) break;\n    received += value.byteLength;\n' +
  '    if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\n    await file.write(value);\n  }\n}\n' +
  'async function download(url, destination) {\n  const response = await fetch(url);\n' +
  '  const out = await open(destination, "w");\n  const reader = response.body.getReader();\n  let total = 0;\n  while (true) {\n' +
  '    const { done, value } = await reader.read(); if (done) break;\n    total += value.byteLength;\n    await out.write(value);\n  }\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a timer cleared in a sibling finally is never cleared here', () => {
  const r = check('bounds',
    '```javascript\nconst controller = new AbortController();\nconst timer = setTimeout(() => controller.abort(), 10000);\n' +
  'const response = await fetch(url, { signal: controller.signal });\n' + 'const file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n' +
  'function unrelated() { try { work(); } finally { clearTimeout(timer); } }\n```');
  assert.equal(r.pass, false);
});

// --- round 8: through the helper, across the lines, into the result ---

test('revalidate: a helper handed the webhook must guard its own request', () => {
  const r = check('revalidate',
    '```javascript\nfunction sendAgain(target) { return fetch(target, { method: "POST", body }); }\n' +
  'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' + 'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\nsendAgain(url);\n```');
  assert.equal(r.pass, false);
});

test('bounds: a helper declared first does not supply the destination', () => {
  const r = check('bounds',
    '```javascript\nfunction format(value, options) { return String(value); }\n' +
  'async function download(url, destination) {\n' +
  '  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
  '  const file = await open(destination, "w");\n  const reader = response.body.getReader();\n  let received = 0;\n  while (true) {\n' +
  '    const { done, value } = await reader.read(); if (done) break;\n    received += value.byteLength;\n' +
  '    if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\n    await file.write(value);\n  }\n}\n```');
  assert.equal(r.pass, true);
});

test('hardware: a knob used in a multiline return is still used', () => {
  const r = check('hardware',
    '```python\ndef read_temperature(adc, beta=3950):\n    return (\n        _steinhart(adc.read(0), beta)\n    )\n```\nReturns Celsius.');
  assert.equal(r.pass, true);
});

test('onecheck: \'if False and True\' is dead', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    return 0\n\nif False and True:\n    try:\n        to_seconds("abc")\n    except ValueError:\n        pass\n    else:\n        assert False\n```');
  assert.equal(r.pass, false);
});

test('contracts: \'if (!true)\' is as dead as \'if (false)\'', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
  'const result = updateSettings({ theme: "dark", sound: true, label: "x" }, { sound: false, volume: 0, label: "" });\n' +
  'if (!true) {\n  console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
  '  console.assert(result.label === ""); console.assert(result.theme === "dark");\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: an alias declared alongside others still aliases the URL', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' + 'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  'const alias = url, marker = 1;\nalias.protocol = "http:";\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('contracts: returning current for a real patch discards it', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n  if (patch != null) return current;\n  return { ...current, ...patch };\n}\n' +
  'const result = updateSettings({ theme: "dark", sound: true, label: "x" }, { sound: false, volume: 0, label: "" });\n' +
  'console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
  'console.assert(result.label === ""); console.assert(result.theme === "dark");\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a sibling\'s body default does not empty this payload', () => {
  const r = check('revalidate',
    '```javascript\nfunction unrelated(body = null) { return body; }\n' +
  'async function send(text, body) {\n  const saved = JSON.parse(text);\n  const url = new URL(saved.webhook);\n' +
  '  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  '  await fetch(url, { method: "POST", body, redirect: "error" });\n}\n```');
  assert.equal(r.pass, true);
});

test('bounds: a constant expression evaluating to zero is no deadline', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(0 * 1000) });\n' + 'const file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n' + '```');
  assert.equal(r.pass, false);
});

test('lifecycle: a compound signal expression is not this function\'s signal', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once } = require("node:events");\n' +
  'function waitForDownload(emitter, signal) {\n  return once(emitter, "download", { signal: signal && otherSignal });\n}\n```');
  assert.equal(r.pass, false);
});

test('hardware: a helper mentioned after the return never calibrates', () => {
  const r = check('hardware',
    '```python\ndef calibrate(beta=3950):\n    return beta\n\ndef read_temperature(adc):\n    return 25.0\n    calibrate()\n```\nReturns Celsius.');
  assert.equal(r.pass, false);
});

test('lifecycle: a guard in an uncalled nested helper guards nothing', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n  return new Promise((resolve, reject) => {\n' +
  '    const unused = () => { if (signal.aborted) return reject(signal.reason); };\n' +
  '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
  '    const done = value => { cleanup(); resolve(value); };\n' +
  '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
  '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n  });\n}\n```');
  assert.equal(r.pass, false);
});

test('contracts: fixtures stored in variables prove the same contract', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
  'const current = { theme: "dark", sound: true, label: "x" };\n' +
  'const patch = { sound: false, volume: 0, label: "" };\n' +
  'const result = updateSettings(current, patch);\n' +
  'console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
  'console.assert(result.label === ""); console.assert(result.theme === "dark");\n```');
  assert.equal(r.pass, true);
});

test('revalidate: \'!url.protocol === "https:"\' lets http through', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
  'if (!url.protocol === "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

// --- round 9: reachable, exclusive, and complete ---

test('lifecycle: a delegation buried in a nested helper returns to nobody', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once } = require("node:events");\n' +
  'function waitForDownload(emitter, signal) {\n  const helper = () => once(emitter, "download", { signal });\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a payload write in an uncalled helper sends nothing', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' + 'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  'const request = https.request(url, { method: "POST" });\n' +
  'function unused() { request.end(payload); }\n```');
  assert.equal(r.pass, false);
});

test('bounds: a compound signal expression does not bound the request', () => {
  const r = check('bounds',
    '```javascript\nconst timeoutSignal = AbortSignal.timeout(10000);\n' +
  'const response = await fetch(url, { signal: timeoutSignal && otherSignal });\n' + 'const file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n' + '```');
  assert.equal(r.pass, false);
});

test('bounds: destroy() without returning still writes the oversized chunk', () => {
  const r = check('bounds',
    '```javascript\nconst response = await https.get(url, { signal: AbortSignal.timeout(10000) });\n' +
  'const file = createWriteStream(destination);\nlet received = 0;\nresponse.on("data", chunk => {\n  received += chunk.length;\n' +
  '  if (received > MAX_BYTES) { response.destroy(new Error("too large")); }\n  file.write(chunk);\n});\n```');
  assert.equal(r.pass, false);
});

test('hardware: a knob assigned after the return never reaches it', () => {
  const r = check('hardware',
    '```python\ndef read_temperature(raw, beta=3950):\n    result = raw * 0.1\n    return result\n    result = raw * beta\n```\nReturns Celsius.');
  assert.equal(r.pass, false);
});

test('contracts: the else of `if (true)` is dead', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
  'const result = updateSettings({ theme: "dark", sound: true, label: "x" }, { sound: false, volume: 0, label: "" });\n' +
  'if (true) {} else {\n  console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
  '  console.assert(result.label === ""); console.assert(result.theme === "dark");\n}\n```');
  assert.equal(r.pass, false);
});

test('onecheck: expecting rejection of a valid fixture is not an alternate path', () => {
  const r = check('onecheck',
    '```python\ndef parse_duration(s):\n    return 0\n\nvalid = "1h"\nwith pytest.raises(ValueError):\n    parse_duration(valid)\n```');
  assert.equal(r.pass, false);
});

test('contracts: a disjoined comparison never fails the assertion', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) { return { ...current, ...patch }; }\n' +
  'const result = updateSettings({ theme: "dark", sound: true, label: "x" }, { sound: false, volume: 0, label: "" });\n' +
  'console.assert(true || result.sound === false); console.assert(true || result.volume === 0);\n' +
  'console.assert(true || result.label === ""); console.assert(true || result.theme === "dark");\n```');
  assert.equal(r.pass, false);
});

test('bounds: a consumer parked in a dead branch consumes nothing', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
  'const file = createWriteStream(destination);\nlet received = 0;\nif (false) {\n' +
  '  response.on("data", chunk => {\n    received += chunk.length;\n' +
  '    if (received > MAX_BYTES) { response.destroy(new Error("too large")); return; }\n    file.write(chunk);\n  });\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a helper that guards its own POST is the POST', () => {
  const r = check('revalidate',
    '```javascript\nfunction sendAgain(target) {\n' +
  '  if (target.protocol !== "https:" || !allowedHosts.has(target.hostname)) throw new Error("bad");\n' +
  '  return fetch(target, { method: "POST", body, redirect: "error" });\n}\n' +
  'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' + 'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' + 'sendAgain(url);\n```');
  assert.equal(r.pass, true);
});

test('contracts: a merge after resetting current preserves nothing', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n  current = {};\n  return { ...current, ...patch };\n}\n' +
  'const result = updateSettings({ theme: "dark", sound: true, label: "x" }, { sound: false, volume: 0, label: "" });\n' +
  'console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
  'console.assert(result.label === ""); console.assert(result.theme === "dark");\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: an extra listener beside the cleaned-up one still leaks', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n  return new Promise((resolve, reject) => {\n' +
  '    if (signal.aborted) return reject(signal.reason);\n' +
  '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
  '    const done = value => { cleanup(); resolve(value); };\n' +
  '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
  '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n' +
  '    emitter.on("download", audit);\n  });\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a bracketed property write mutates the cleared URL', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' + 'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  'url["protocol"] = "http:";\nawait fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('bounds: an accumulator reset before the check never trips', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
  'const file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
  '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\nreceived = 0;\n' +
  '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: a timer callback that never aborts bounds nothing', () => {
  const r = check('bounds',
    '```javascript\nconst controller = new AbortController();\n' +
  'const timer = setTimeout(() => { if (false) controller.abort(); }, 10000);\ntry {\n' +
  'const response = await fetch(url, { signal: controller.signal });\n' + 'const file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n' +
  '} finally { clearTimeout(timer); }\n```');
  assert.equal(r.pass, false);
});

// --- round 10: the exact binding, the top level, and the freshest guard ---

test('revalidate: a mutation between the guards leaves one stale', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
  'if (url.protocol !== "https:") throw new Error("bad");\nurl.protocol = "http:";\n' +
  'if (!allowedHosts.has(url.hostname)) throw new Error("bad host");\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: a nested signal is not the once option Node reads', () => {
  const r = check('lifecycle',
    '```javascript\nconst { once } = require("node:events");\n' +
  'function waitForDownload(emitter, signal) {\n  return once(emitter, "download", { metadata: { signal } });\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: tearing down a name the stream merely prefixes stops nothing', () => {
  const r = check('bounds',
    '```javascript\nhttps.get(url, { signal: AbortSignal.timeout(10000) }, response => {\n' +
  '  const file = createWriteStream(destination);\n  let received = 0;\n  response.on("data", chunk => {\n' +
  '    received += chunk.length;\n' +
  '    if (received > MAX_BYTES) { responseAudit.destroy(new Error("too large")); return; }\n' +
  '    file.write(chunk);\n  });\n});\n```');
  assert.equal(r.pass, false);
});

test('lifecycle: a cleanup that can throw leaves the promise pending', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n  return new Promise((resolve, reject) => {\n' +
  '    if (signal.aborted) return reject(signal.reason);\n' +
  '    const cleanup = () => { emitter.off("download", done); signal.removeEventListener("abort", aborted); if (debug) throw new Error("x"); };\n' +
  '    const done = value => { cleanup(); resolve(value); };\n' +
  '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
  '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n  });\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a bare reject settles but does not stop the request', () => {
  const r = check('revalidate',
    '```javascript\nreturn new Promise((resolve, reject) => {\n' +
  '  const saved = JSON.parse(text);\n  const url = new URL(saved.webhook);\n' +
  '  if (url.protocol !== "https:") reject(new Error("bad"));\n' +
  '  if (!allowedHosts.has(url.hostname)) reject(new Error("bad host"));\n' +
  '  fetch(url, { method: "POST", body, redirect: "error" }).then(resolve);\n});\n```');
  assert.equal(r.pass, false);
});

test('bounds: a NaN ceiling can never be exceeded', () => {
  const r = check('bounds',
    '```javascript\nconst MAX = NaN;\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
  'const file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
  '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
  '  if (received > MAX) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a serialised URL handed to a helper is the same destination', () => {
  const r = check('revalidate',
    '```javascript\nfunction sendAgain(target) { return fetch(target, { method: "POST", body }); }\n' +
  'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' + 'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\nsendAgain(url.toString());\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a validator that rebinds its parameter checks something else', () => {
  const r = check('revalidate',
    '```javascript\nfunction validateWebhookUrl(candidate) {\n  candidate = new URL("https://allowed.example");\n' +
  '  if (candidate.protocol !== "https:") throw new Error("x");\n' +
  '  if (!allowedHosts.has(candidate.hostname)) throw new Error("y");\n}\n' +
  'const saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\nvalidateWebhookUrl(url);\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, false);
});

test('bounds: awaiting https.get yields a request, not the body', () => {
  const r = check('bounds',
    '```javascript\nconst response = await https.get(url, { signal: AbortSignal.timeout(10000) });\n' +
  'const file = createWriteStream(destination);\nlet received = 0;\nresponse.on("data", chunk => {\n' +
  '  received += chunk.length;\n' +
  '  if (received > MAX_BYTES) { response.destroy(new Error("too large")); return; }\n  file.write(chunk);\n});\n```');
  assert.equal(r.pass, false);
});

test('hardware: the temperature reader outranks a generic read helper', () => {
  const r = check('hardware',
    '```python\ndef read_adc(channel):\n    return channel\n\ndef read_temperature(adc, beta=3950):\n' +
  '    return _steinhart(read_adc(0), beta)\n```\nReturns Celsius.');
  assert.equal(r.pass, true);
});

// --- round 11: control that arrives, bindings that still hold ---

test('bounds: an early return means none of the bounded code runs', () => {
  const r = check('bounds',
    '```javascript\nasync function download(url, destination) {\n  return;\n' +
  '  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
  '  const file = await open(destination, "w");\n  const reader = response.body.getReader();\n  let received = 0;\n  while (true) {\n' +
  '    const { done, value } = await reader.read(); if (done) break;\n    received += value.byteLength;\n' +
  '    if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\n    await file.write(value);\n  }\n}\n```');
  assert.equal(r.pass, false);
});

test('revalidate: a mutation in an uncalled helper does not stale the guards', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' + 'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("bad");\n' +
  'function unused() { url.protocol = "http:"; }\n' +
  'await fetch(url, { method: "POST", body, redirect: "error" });\n```');
  assert.equal(r.pass, true);
});

test('lifecycle: a reassigned once import is not the native helper', () => {
  const r = check('lifecycle',
    '```javascript\nlet { once } = require("node:events");\nonce = () => Promise.resolve("fake");\n' +
  'function waitForDownload(emitter, signal) {\n  return once(emitter, "download", { signal });\n}\n```');
  assert.equal(r.pass, false);
});

test('onecheck: pytest.raises called rather than entered owns no call', () => {
  const r = check('onecheck',
    '```python\ndef parse_duration(s):\n    return 0\n\npytest.raises(ValueError); parse_duration("garbage")\n```');
  assert.equal(r.pass, false);
});

test('bounds: a data handler on another emitter never reads the response', () => {
  const r = check('bounds',
    '```javascript\nhttps.get(url, { signal: AbortSignal.timeout(10000) }, response => {\n' +
  '  const file = createWriteStream(destination);\n  let received = 0;\n  audit.on("data", chunk => {\n' +
  '    received += chunk.length;\n' +
  '    if (received > MAX_BYTES) { response.destroy(new Error("too large")); return; }\n' +
  '    file.write(chunk);\n  });\n});\n```');
  assert.equal(r.pass, false);
});

test('hardware: a denial following the marker denies it just the same', () => {
  const r = check('hardware',
    '```python\ndef read_c(adc):\n    return adc.read(0) * 0.1\n```\n' +
  'Per-unit drift is impossible, so no calibration is needed.');
  assert.equal(r.pass, false);
});

test('hardware: naming the knob to call it unnecessary is not leaving one', () => {
  const r = check('hardware',
    '```python\ndef read_c(adc):\n    return adc.read(0) * 0.1\n```\nCalibration offset is unnecessary.');
  assert.equal(r.pass, false);
});

test('lifecycle: an unawaited async cleanup settles before removing listeners', () => {
  const r = check('lifecycle',
    '```javascript\nfunction waitForDownload(emitter, signal) {\n  return new Promise((resolve, reject) => {\n' +
  '    if (signal.aborted) return reject(signal.reason);\n' +
  '    const cleanup = async () => { await flush(); emitter.off("download", done); signal.removeEventListener("abort", aborted); };\n' +
  '    const done = value => { cleanup(); resolve(value); };\n' +
  '    const aborted = () => { cleanup(); reject(signal.reason); };\n' +
  '    emitter.once("download", done); signal.addEventListener("abort", aborted);\n  });\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: options rewritten after the literal are not what fetch receives', () => {
  const r = check('bounds',
    '```javascript\nconst options = { signal: AbortSignal.timeout(10000) };\noptions.signal = undefined;\n' +
  'const response = await fetch(url, options);\nconst file = await open(destination, "w");\n' +
  'const reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
  '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
  '  if (received > MAX_BYTES) { await reader.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('bounds: body.cancel() throws while a reader holds the lock', () => {
  const r = check('bounds',
    '```javascript\nconst response = await fetch(url, { signal: AbortSignal.timeout(10000) });\n' +
  'const file = await open(destination, "w");\nconst reader = response.body.getReader();\nlet received = 0;\nwhile (true) {\n' +
  '  const { done, value } = await reader.read(); if (done) break;\nreceived += value.byteLength;\n' +
  '  if (received > MAX_BYTES) { await response.body.cancel(); throw new Error("too large"); }\nawait file.write(value);\n}\n```');
  assert.equal(r.pass, false);
});

test('contracts: a property write on the patch corrupts the merge', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n  patch.sound = true;\n  return { ...current, ...patch };\n}\n' +
  'const result = updateSettings({ theme: "dark", sound: true, label: "x" }, { sound: false, volume: 0, label: "" });\n' +
  'console.assert(result.sound === false); console.assert(result.volume === 0);\n' +
  'console.assert(result.label === ""); console.assert(result.theme === "dark");\n```');
  assert.equal(r.pass, false);
});

// --- unknown probe is skipped, not failed ---

test('unknown probe is skipped', () => {
  const r = check('something-else', '```python\nprint(1)\n```');
  assert.equal(r.pass, true);
  assert.match(r.reason, /skipped/i);
});
