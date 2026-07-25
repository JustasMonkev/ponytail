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
    // Both framework-free idioms count: `assert False` after the call inside
    // the try, and the try/except/else layout.
    const checksFailure = /pytest\.raises|assertRaises|assert\.throws|toThrow|expect\([^\n]*\)\.rejects|assert\s+(?:await\s+)?(?:rejects?|raises?|throws?)\s*\([^)\n]+\)|try\s*:[\s\S]{0,200}\w+\s*\([^)\n]*\)[\s\S]{0,120}\bassert\s+False\b[\s\S]{0,160}except\b|try\s*:[\s\S]{0,300}\w+\s*\([^)]*\)[\s\S]{0,240}except\b[\s\S]{0,160}else\s*:[\s\S]{0,120}assert\s+False/i.test(t);
    return hasCheck && checksFailure
      ? { pass: true, reason: 'Left a runnable check for a risky alternate path.' }
      : { pass: false, reason: 'No runnable alternate-path check left behind.' };
  },

  // Merges into existing state and proves falsy values are not treated as absent.
  contracts(output) {
    // Comment-stripped: a carried-over check in a comment is not a runnable one.
    const t = codeOf(output);
    // Parameter names are not part of the contract; find the two-arg function
    // that actually returns the merge, whatever its parameters are called.
    const updater = [...t.matchAll(/function\s+(\w+)\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/g)].find(match => {
      const body = t.slice(match.index, match.index + 500);
      return new RegExp(String.raw`\breturn\s*\{\s*\.\.\.${match[2]}\s*,\s*\.\.\.${match[3]}\s*\}\s*;?`, 'i').test(body)
        || new RegExp(String.raw`\breturn\s+Object\.assign\s*\(\s*\{\s*\}\s*,\s*${match[2]}\s*,\s*${match[3]}\s*\)\s*;?`, 'i').test(body);
    });
    const merges = Boolean(updater);
    const call = updater && new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*${updater[1]}\s*\(([\s\S]{0,400}?)\);`).exec(t);
    const falsyPatch = call && [/\bfalse\b/, /(?:^|\D)0(?:\D|$)/, /['"]{2}/].every(pattern => pattern.test(call[2]));
    const assertions = t.split('\n').map(line => line.match(/(?:console\.)?assert\b.*|\bexpect\(.*|\bit\(.*/)?.[0]).filter(Boolean).join('\n');
    const perField = call && [
      new RegExp(String.raw`${call[1]}\.\w+\s*===?\s*false`, 'i'),
      new RegExp(String.raw`${call[1]}\.\w+\s*===?\s*0(?:\D|$)`),
      new RegExp(String.raw`${call[1]}\.\w+\s*===?\s*['"]{2}`),
    ].every(pattern => pattern.test(assertions));
    // One structural assertion on the result proves the same three contracts.
    const deep = call && new RegExp(String.raw`(?:deepStrictEqual|deepEqual)\s*\(\s*${call[1]}\s*,\s*\{([\s\S]{0,400}?)\}|expect\s*\(\s*${call[1]}\s*\)\s*\.\s*to(?:Strict)?Equal\s*\(\s*\{([\s\S]{0,400}?)\}`).exec(t);
    const expected = deep ? deep[1] || deep[2] || '' : '';
    const checksFalsy = perField
      || [/:\s*false\b/, /:\s*0\b/, /:\s*(?:''|"")/].every(pattern => pattern.test(expected));
    return merges && falsyPatch && checksFalsy
      ? { pass: true, reason: 'Preserves existing state and checks explicit falsy values.' }
      : { pass: false, reason: 'Does not prove state and explicit false/zero/empty values survive.' };
  },

  // Cancellation must remove every listener it installed, not just reject.
  lifecycle(output) {
    const t = String(output || '');
    // events.once(emitter, 'download', { signal }) is the platform's own answer:
    // it rejects a pre-aborted signal and removes its listeners either way. Only
    // the real one counts, so it has to come from node:events, not a local shim.
    const fromEvents = /(?:require\s*\(\s*['"](?:node:)?events['"]\s*\)|from\s+['"](?:node:)?events['"])/.test(t)
      && !/function\s+once\b|(?:const|let|var)\s+once\s*=/.test(t);
    if (fromEvents && /\bonce\s*\(\s*\w+\s*,\s*['"]download['"]\s*,\s*\{[^}]{0,120}\bsignal\b/.test(t))
      return { pass: true, reason: 'Delegates the whole lifecycle to the abort-aware events.once helper.' };
    // An already-aborted signal never fires `abort`, so the guard has to run
    // before any listener is installed or the setup leaks both of them.
    const guard = /signal\.throwIfAborted\s*\(|throwIfAborted\s*\(\s*signal|if\s*\(\s*signal\??\.aborted\s*\)\s*(?:\{[^}]{0,160}(?:(?:return\s+)?reject\s*\(|\bthrow\b)|(?:return\s+)?reject\s*\(|throw\b)/.exec(t);
    const firstListener = /addEventListener\s*\(\s*['"]abort['"]|\.(?:once|on|addListener)\s*\(\s*['"]download['"]/.exec(t);
    const preAborted = Boolean(guard && firstListener && guard.index < firstListener.index);
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
    const fail = { pass: false, reason: 'Trusts persisted URL without revalidating its current network policy.' };
    const parsed = t.match(/(?:const|let|var)\s+(\w+)\s*=\s*new URL\s*\(/);
    if (!parsed) return fail;
    const url = parsed[1];
    const rejection = String.raw`\s*(?:\{[^}]{0,200}(?:\bthrow\b|\breject\s*\(|\breturn\s+false\b)|(?:\bthrow\b|\breject\s*\(|\breturn\s+false\b))`;
    // Each policy must reject on its own. An `&&` clause only rejects when every
    // condition fails, so an allowed host still reaches the network over http.
    const clauses = [...t.matchAll(new RegExp(String.raw`if\s*\(([^\n]{0,300}?)\)${rejection}`, 'gi'))]
      .flatMap(match => match[1].split('||').map(clause => ({ index: match.index, clause })))
      .filter(guard => !guard.clause.includes('&&'));
    const enforces = guard =>
      new RegExp(String.raw`${url}\.protocol\s*!==?\s*['"]https:['"]`, 'i').test(guard.clause)
      || new RegExp(String.raw`!\s*(?:allowedHosts|allowlist)\s*\.\s*(?:has|includes)\s*\(\s*${url}\.hostname\s*\)`, 'i').test(guard.clause);
    const validates = new RegExp(String.raw`(?:^|[;}\n])\s*(?:await\s+)?(?:validate|assert|ensure|checkNetwork)\w*Url\s*\(\s*${url}\b`, 'im').exec(t);
    const validations = [...clauses.filter(enforces), ...(validates ? [validates] : [])];
    const fetchCall = new RegExp(String.raw`\bfetch\s*\(\s*${url}\b([\s\S]{0,300})`).exec(t);
    // A followed redirect re-enters the network with a destination the policy
    // never saw, so the fetch has to refuse or hand back the 3xx itself.
    const boundsRedirects = fetchCall && /redirect\s*:\s*['"](?:manual|error)['"]/.test(fetchCall[1]);
    return fetchCall && boundsRedirects && validations.some(v => v.index < fetchCall.index)
      ? { pass: true, reason: 'Revalidates persisted URL against a network policy before use.' }
      : fail;
  },

  // A remote response needs both a deadline and an enforced streaming byte ceiling.
  bounds(output) {
    const t = String(output || '');
    // The deadline has to reach the request, whether it is built inline, held in
    // a variable, or passed as a controller's signal.
    const options = (/\bfetch\s*\([^,)]{0,120},\s*(\{[\s\S]{0,400}?\})/.exec(t) || ['', ''])[1];
    const signalRef = /\bsignal\s*:\s*AbortSignal\.timeout\s*\(/.test(options)
      ? 'inline'
      : (/\bsignal\s*:\s*(\w+)\s*\.\s*signal\b/.exec(options)
        || /\bsignal\s*:\s*(\w+)/.exec(options)
        || /\b(signal)\s*[,}]/.exec(options) || [])[1];
    const requestTimeout = signalRef === 'inline'
      || Boolean(signalRef && (new RegExp(String.raw`\b${signalRef}\s*=\s*AbortSignal\.timeout\s*\(`).test(t)
        || /setTimeout\s*\([\s\S]{0,240}\.abort\s*\(/.test(t)));
    const loops = /getReader\s*\(|for\s+await\s*\(/.test(t);
    const evented = /\.on\s*\(\s*['"]data['"]/.test(t);
    const counter = t.match(/\b([A-Za-z_$]\w*)\s*\+=\s*[^;\n]*(?:byteLength|length)/);
    const limitBranch = counter && new RegExp(String.raw`if\s*\([^\n]{0,240}${counter[1]}\s*>=?\s*[A-Za-z_$]\w*[^\n]{0,240}?\)\s*(\{[^}]{0,240}\}|[^\n]{0,160})`, 'i').exec(t);
    // `return` exits one data callback but leaves an evented stream flowing, so
    // the over-limit path has to tear the stream down too.
    const stops = limitBranch && /\bthrow\b|\breturn\b/.test(limitBranch[1])
      && (loops || /\b(?:destroy|abort|cancel|unpipe)\s*\(/.test(limitBranch[1]));
    const writeAfterLimit = stops && /(?:\bwrite\s*\(|\.write\s*\(|writeFile\s*\()/.test(t.slice(limitBranch.index + limitBranch[0].length));
    return requestTimeout && (loops || evented) && counter && writeAfterLimit
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
