// Behavior gate: does the ponytail ruleset actually PRODUCE its refined
// behaviors, not just carry the text? One check per probe (vars.probe):
//   hardware     - leave a calibration knob
//   explanation  - requested explanation is not debt
//   onecheck     - leave one risk-targeted runnable check
//   contracts    - preserve state and explicit false/zero/empty values
//   lifecycle    - cancellation and cleanup share one lifecycle
//   revalidate   - persisted input is validated again before privileged use
//   bounds       - external work has time and size limits
//
// Heuristic graders, same spirit as loc.js / correctness.js. The graders
// themselves are proven by tests/behavior.test.js (RED/GREEN, no API key).
//
// Metric: `behavior` (1 = behavior present, 0 = absent).

function proseOf(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
}

function codeOf(text) {
  const t = String(text || '');
  const blocks = [...t.matchAll(/```(?:\w+)?\r?\n([\s\S]*?)```/g)];
  return (blocks.length ? blocks.map(match => match[1]).join('\n') : t)
    .replace(/^\s*(?:#|\/\/).*$/gm, '');
}

function namedFunctionBodies(text) {
  return [
    ...[...text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*\{([\s\S]{0,300}?)\}/gi)],
    ...[...text.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*\{([\s\S]{0,300}?)\}/gi)],
  ].map(match => ({ name: match[1], body: match[2] }));
}

const CHECKS = {
  // Treats the device as non-ideal: leaves a tunable knob or flags per-unit drift.
  // A passing mention of "calibration" is not enough; it must be actionable.
  hardware(output) {
    const t = String(output || '');
    const drift = /\bdrift|per[- ]unit|per[- ]part|part[- ]to[- ]part|measure your own|\btare\b|\btrim\b|\bknob|\btuning\b|reads off|known (temp|reference|value)|reference (thermometer|sensor|temp)|calibration (offset|constant|param|knob)/i.test(t);
    return drift
      ? { pass: true, reason: 'Leaves a calibration knob / flags per-unit drift.' }
      : { pass: false, reason: 'Treats the hardware as ideal; no calibration knob.' };
  },

  // Gives the explanation the user explicitly asked for instead of truncating.
  explanation(output) {
    const p = proseOf(output);
    const words = p ? p.split(' ').length : 0;
    const structured = /(\d+[.)]\s|[-*]\s)/.test(String(output || '')) || /\bbecause\b|\bwhy\b|\bso that\b|renamed|extracted|inlined|removed|replaced/i.test(p);
    return words >= 45 && structured
      ? { pass: true, reason: `Gave the requested write-up (${words} words of prose).` }
      : { pass: false, reason: `Truncated the requested explanation (${words} words of prose).` };
  },

  // Leaves ONE runnable check for a malformed/alternate input, not the happy path.
  onecheck(output) {
    const t = codeOf(output);
    const hasCheck = /\bassert\b|def\s+test_|if\s+__name__|unittest|pytest|console\.assert|\bexpect\(|\bdescribe\(|\bit\(/.test(t);
    const checksFailure = /pytest\.raises|assertRaises|assert\.throws|toThrow|expect\([^\n]*\)\.rejects|assert\s+(?:await\s+)?(?:rejects?|raises?|throws?)\s*\([^)\n]+\)|try\s*:[\s\S]{0,300}\w+\s*\([^)]*\)[\s\S]{0,240}except\b[\s\S]{0,160}else\s*:[\s\S]{0,120}assert\s+False/i.test(t);
    return hasCheck && checksFailure
      ? { pass: true, reason: 'Left a runnable check for a risky alternate path.' }
      : { pass: false, reason: 'No runnable alternate-path check left behind.' };
  },

  // Merges into existing state and proves falsy values are not treated as absent.
  contracts(output) {
    const t = String(output || '');
    const updater = t.match(/function\s+(\w+)\s*\(\s*((?:current|settings)\w*)\s*,\s*(patch\w*)\s*\)/i);
    const updaterText = updater && t.slice(updater.index, updater.index + 500);
    const merges = updater && (
      new RegExp(String.raw`\breturn\s*\{\s*\.\.\.${updater[2]}\s*,\s*\.\.\.${updater[3]}\s*\}\s*;?`, 'i').test(updaterText)
      || new RegExp(String.raw`\breturn\s+Object\.assign\s*\(\s*\{\s*\}\s*,\s*${updater[2]}\s*,\s*${updater[3]}\s*\)\s*;?`, 'i').test(updaterText)
    );
    const call = updater && new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*${updater[1]}\s*\(([\s\S]{0,400}?)\);`).exec(t);
    const falsyPatch = call && [/\bfalse\b/, /(?:^|\D)0(?:\D|$)/, /['"]{2}/].every(pattern => pattern.test(call[2]));
    const assertions = t.split('\n').map(line => line.match(/(?:console\.)?assert\b.*|\bexpect\(.*|\bit\(.*/)?.[0]).filter(Boolean).join('\n');
    const checksFalsy = call && [
      new RegExp(String.raw`${call[1]}\.\w+\s*===?\s*false`, 'i'),
      new RegExp(String.raw`${call[1]}\.\w+\s*===?\s*0(?:\D|$)`),
      new RegExp(String.raw`${call[1]}\.\w+\s*===?\s*['"]{2}`),
    ].every(pattern => pattern.test(assertions));
    return merges && falsyPatch && checksFalsy
      ? { pass: true, reason: 'Preserves existing state and checks explicit falsy values.' }
      : { pass: false, reason: 'Does not prove state and explicit false/zero/empty values survive.' };
  },

  // Cancellation must remove every listener it installed, not just reject.
  lifecycle(output) {
    const t = String(output || '');
    const preAborted = /signal\.throwIfAborted\s*\(|throwIfAborted\s*\(\s*signal|if\s*\(\s*signal\??\.aborted\s*\)\s*(?:\{[^}]{0,160}(?:(?:return\s+)?reject\s*\(|\bthrow\b)|(?:return\s+)?reject\s*\(|throw\b)/.test(t);
    const handlers = namedFunctionBodies(t);
    const abortHandler = handlers.find(handler => /abort/i.test(handler.name) && /\breject\s*\(/.test(handler.body));
    const downloadHandler = handlers.find(handler => /\bresolve\s*\(/.test(handler.body));
    const cleanupName = abortHandler && downloadHandler
      && [...abortHandler.body.matchAll(/\b(\w+)\s*\(\s*\)/g)]
        .map(match => match[1])
        .find(name => new RegExp(`\\b${name}\\s*\\(\\s*\\)`).test(downloadHandler.body));
    const cleanupHandler = cleanupName && handlers.find(handler => handler.name === cleanupName);
    const aborts = abortHandler
      && new RegExp(`addEventListener\\s*\\(\\s*['"]abort['"]\\s*,\\s*${abortHandler.name}\\b`).test(t);
    const ownsDownload = downloadHandler
      && new RegExp(`\\.(?:once|on|addListener)\\s*\\(\\s*['"]download['"]\\s*,\\s*${downloadHandler.name}\\b`).test(t);
    const cleansAbort = cleanupHandler
      && new RegExp(`removeEventListener\\s*\\(\\s*['"]abort['"]\\s*,\\s*${abortHandler.name}\\b`).test(cleanupHandler.body);
    const cleansDownload = cleanupHandler
      && new RegExp(`(?:\\.off|removeListener)\\s*\\(\\s*['"]download['"]\\s*,\\s*${downloadHandler.name}\\b`).test(cleanupHandler.body);
    return preAborted && aborts && ownsDownload && cleansAbort && cleansDownload
      ? { pass: true, reason: 'Owns pre-aborted cancellation and listener cleanup as one lifecycle.' }
      : { pass: false, reason: 'Missing pre-aborted cancellation, listener cleanup, or stale-completion protection.' };
  },

  // Data loaded from storage is untrusted again at the point of network use.
  revalidate(output) {
    const t = String(output || '');
    const parsed = t.match(/(?:const|let|var)\s+(\w+)\s*=\s*new URL\s*\(/);
    if (!parsed)
      return { pass: false, reason: 'Trusts persisted URL without revalidating its current network policy.' };
    const url = parsed[1];
    const rejection = String.raw`\s*(?:\{[^}]{0,200}(?:\bthrow\b|\breject\s*\(|\breturn\s+false\b)|(?:\bthrow\b|\breject\s*\(|\breturn\s+false\b))`;
    const rejectsProtocol = new RegExp(String.raw`if\s*\([^\n]{0,240}${url}\.protocol\s*!==?\s*['"]https:['"][^\n]{0,240}\)${rejection}`, 'i').exec(t);
    const rejectsHost = new RegExp(String.raw`if\s*\([^\n]{0,240}!\s*(?:allowedHosts|allowlist)\s*\.\s*(?:has|includes)\s*\(\s*${url}\.hostname\s*\)[^\n]{0,240}\)${rejection}`, 'i').exec(t);
    const validates = new RegExp(String.raw`(?:^|[;}\n])\s*(?:await\s+)?(?:validate|assert|ensure|checkNetwork)\w*Url\s*\(\s*${url}\b`, 'im').exec(t);
    const fetchesValidatedUrl = new RegExp(String.raw`\bfetch\s*\(\s*${url}\b`).exec(t);
    const validation = [rejectsProtocol, rejectsHost, validates].filter(Boolean).sort((a, b) => a.index - b.index)[0];
    return fetchesValidatedUrl && validation && validation.index < fetchesValidatedUrl.index
      ? { pass: true, reason: 'Revalidates persisted URL against a network policy before use.' }
      : { pass: false, reason: 'Trusts persisted URL without revalidating its current network policy.' };
  },

  // A remote response needs both a deadline and an enforced streaming byte ceiling.
  bounds(output) {
    const t = String(output || '');
    const requestTimeout = /\bfetch\s*\([\s\S]{0,240}\bsignal\s*:\s*AbortSignal\.timeout\s*\(/.test(t)
      || (/\bfetch\s*\([\s\S]{0,240}\bsignal\s*:\s*\w+\.signal\b/.test(t) && /setTimeout\s*\([\s\S]{0,240}\.abort\s*\(/.test(t));
    const streams = /getReader\s*\(|for\s+await\s*\(|\.on\s*\(\s*['"]data['"]/.test(t);
    const counter = t.match(/\b([A-Za-z_$]\w*)\s*\+=\s*[^;\n]*(?:byteLength|length)/);
    const limitBranch = counter && new RegExp(String.raw`if\s*\([^\n]{0,240}${counter[1]}\s*>=?\s*[A-Za-z_$]\w*[^\n]{0,240}\)\s*(?:\{[^}]{0,240}(?:\bthrow\b|\breturn\b)|(?:\bthrow\b|\breturn\b))`, 'i').exec(t);
    const writeAfterLimit = limitBranch && /(?:\bwrite\s*\(|\.write\s*\(|writeFile\s*\()/.test(t.slice(limitBranch.index + limitBranch[0].length));
    return requestTimeout && streams && counter && writeAfterLimit
      ? { pass: true, reason: 'Bounds remote work by time and an enforced streaming byte ceiling.' }
      : { pass: false, reason: 'Remote work lacks a time limit or enforced streaming byte ceiling.' };
  },
};

module.exports = (output, context) => {
  const probe = context && context.vars && context.vars.probe;
  const check = CHECKS[probe];
  if (!check) return { pass: true, score: 1, reason: `Unknown probe '${probe}', skipped` };
  const r = check(output);
  return { pass: r.pass, score: r.pass ? 1 : 0, reason: r.reason };
};
