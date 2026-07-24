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

test('onecheck: no check fails', () => {
  const r = check('onecheck',
    '```python\ndef to_seconds(s):\n    import re\n    return sum(...)\n```');
  assert.equal(r.pass, false);
});

// --- contracts: preserve existing state and explicit falsy values ---

test('contracts: merge plus falsy regression check passes', () => {
  const r = check('contracts',
    '```javascript\nfunction updateSettings(current, patch) {\n' +
    '  return { ...current, ...patch };\n}\n' +
    'const result = updateSettings({ enabled: true, retries: 3, label: "old" }, { enabled: false, retries: 0, label: "" });\n' +
    'console.assert(result.enabled === false && result.retries === 0 && result.label === "");\n```');
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

// --- revalidate: persistence is a new trust boundary ---

test('revalidate: persisted URL policy check passes', () => {
  const r = check('revalidate',
    '```javascript\nconst saved = JSON.parse(text);\nconst url = new URL(saved.webhook);\n' +
    'if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("invalid webhook");\n' +
    'await fetch(url, { method: "POST", body });\n```');
  assert.equal(r.pass, true);
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
