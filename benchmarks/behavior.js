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

// The `{...}` starting at or after `from`, brace-balanced so nested option
// objects and inner blocks stay inside it.
function blockAt(text, from) {
  const open = text.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && (depth -= 1) === 0) return text.slice(open, i + 1);
  }
  return '';
}

// The indentation-delimited suite a Python statement owns, for languages where
// blockAt has no braces to count.
function suiteAt(text, index) {
  const lines = text.slice(text.lastIndexOf('\n', index) + 1).split('\n');
  const indent = lines[0].search(/\S/);
  const end = lines.slice(1).findIndex(line => line.trim() && line.search(/\S/) <= indent);
  return lines.slice(0, end < 0 ? lines.length : end + 1).join('\n');
}

// True when nothing but a function body containing `target` also contains
// `index` — i.e. the two are on the same execution path, not stranded in an
// uncalled helper.
function sameScope(text, index, target) {
  return [...text.matchAll(/(?:function\s*\w*\s*\([^)]*\)|=>)\s*\{/g)]
    .map(match => text.indexOf('{', match.index + match[0].length - 1))
    .map(open => ({ open, end: open + blockAt(text, open).length }))
    .every(range => index < range.open || index > range.end
      || (target >= range.open && target <= range.end));
}

// The loop or listener that actually consumes the response stream. Counting
// bytes in a later pass over a buffered array is not a ceiling.
function streamConsumer(text) {
  return [...text.matchAll(/(?:while\s*\([^)]{0,80}\)|for\s+await\s*\([^)]{0,120}\)|\.on\s*\(\s*['"]data['"]\s*,[^{]{0,60})\s*\{/g)]
    .map(match => ({ index: match.index, header: match[0], body: blockAt(text, match.index + match[0].length - 1) }))
    .find(loop => /\.read\s*\(/.test(loop.body) || /for\s+await|['"]data['"]/.test(loop.header));
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
    // The sentinel `assert False` runs inside the try, so a broad `except` would
    // swallow its own AssertionError; only a named exception proves rejection.
    const markers = /pytest\.raises|assertRaises|assert\.throws|toThrow|expect\([^\n]*\)\.rejects|assert\s+(?:await\s+)?(?:rejects?|raises?|throws?)\s*\([^)\n]+\)|try\s*:[\s\S]{0,200}\w+\s*\([^)\n]*\)[\s\S]{0,120}\bassert\s+False\b[\s\S]{0,160}except\s+(?!Exception\b|BaseException\b)[\w(]|try\s*:[\s\S]{0,300}\w+\s*\([^)]*\)[\s\S]{0,240}except\b[\s\S]{0,160}else\s*:[\s\S]{0,120}assert\s+False/gi;
    // Proving that some other call raises says nothing about this parser, so the
    // failure check has to reach the function under test — directly or one hop
    // through a helper it defines.
    const subject = (t.match(/(?:def|function)\s+(\w+)\s*\(/) || [])[1];
    const reaching = scope => [...scope.matchAll(/\b(\w+)\s*\(([^)]*)\)/g)]
      .filter(call => call[1] === subject
        || new RegExp(String.raw`\b${subject}\s*\(`)
          .test((t.match(new RegExp(String.raw`(?:def|function)\s+${call[1]}\s*\([\s\S]{0,400}`)) || [''])[0]))
      .map(call => call[2].trim())
      .filter(Boolean);
    // '1h30m45s' is the task's own valid example: rejecting it is the bug, not
    // the check. The input under test has to be malformed or half-parsed.
    const wellFormed = /^['"]\s*(?:\d+\s*[hms])+\s*['"]$/i;
    const checksFailure = [...t.matchAll(markers)].some(match => !subject
      || reaching(`${match[0]}\n${suiteAt(t, match.index)}`).some(arg => !wellFormed.test(arg)));
    return hasCheck && checksFailure
      ? { pass: true, reason: 'Left a runnable check for a risky alternate path.' }
      : { pass: false, reason: 'No runnable alternate-path check left behind.' };
  },

  // Merges into existing state and proves falsy values are not treated as absent.
  contracts(output) {
    // Comment-stripped: a carried-over check in a comment is not a runnable one.
    const t = codeOf(output);
    // Parameter names are not part of the contract, but the function name is:
    // the task hands the answer a broken `updateSettings` to fix, so a correct
    // sibling merger alongside the untouched original is not a fix.
    const updater = [
      ...t.matchAll(/function\s+(\w+)\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/g),
      ...t.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>/g),
    ].filter(match => match[1] === 'updateSettings').find(match => {
      const block = blockAt(t, match.index);
      const body = block ? t.slice(match.index, t.indexOf('{', match.index) + block.length) : '';
      return new RegExp(String.raw`(?:\breturn|=>)\s*\(?\s*\{\s*\.\.\.${match[2]}\s*,\s*\.\.\.${match[3]}\s*\}`, 'i').test(body)
        || new RegExp(String.raw`(?:\breturn|=>)\s*Object\.assign\s*\(\s*\{\s*\}\s*,\s*${match[2]}\s*,\s*${match[3]}\s*\)`, 'i').test(body);
    });
    const name = updater && updater[1];
    const assigned = name && new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*${name}\s*\(([\s\S]{0,400}?)\);`).exec(t);
    // One structural assertion proves the same three contracts, whether it runs
    // the updater inline or names the variable the call was assigned to.
    const structural = name && (
      new RegExp(String.raw`(?:deepStrictEqual|deepEqual)\s*\(\s*(\w+)\s*(\([\s\S]{0,300}?\))?\s*,\s*(\{[\s\S]{0,400}?\})`).exec(t)
      || new RegExp(String.raw`expect\s*\(\s*(\w+)\s*(\([\s\S]{0,300}?\))?\s*\)\s*\.\s*to(?:Strict)?Equal\s*\(\s*(\{[\s\S]{0,400}?\})`).exec(t));
    const inlineCall = structural && structural[2] && structural[1] === name;
    const onResult = inlineCall || Boolean(structural && assigned && structural[1] === assigned[1]);
    const args = inlineCall ? structural[2] : assigned && assigned[2];
    // The falsy values have to be in the patch: that is the argument whose
    // explicit false/0/"" must override truthy existing settings.
    const patch = args && (args.match(/,\s*(\{[\s\S]*\})\s*\)?\s*$/) || [])[1];
    const falsyPatch = patch && [/\bfalse\b/, /(?:^|\D)0(?:\D|$)/, /['"]{2}/].every(pattern => pattern.test(patch));
    const assertions = t.split('\n').map(line => line.match(/(?:console\.)?assert\b.*|\bexpect\(.*|\bit\(.*/)?.[0]).filter(Boolean).join('\n');
    const perField = assigned && [
      new RegExp(String.raw`${assigned[1]}\.\w+\s*===?\s*false`, 'i'),
      new RegExp(String.raw`${assigned[1]}\.\w+\s*===?\s*0(?:\D|$)`),
      new RegExp(String.raw`${assigned[1]}\.\w+\s*===?\s*['"]{2}`),
    ].every(pattern => pattern.test(assertions));
    const expected = onResult ? structural[3] : '';
    const checksFalsy = perField
      || (onResult && [/:\s*false\b/, /:\s*0\b/, /:\s*(?:''|"")/].every(pattern => pattern.test(expected)));
    // "without resetting existing settings" is half the contract: the check has
    // to prove a setting the patch never mentions is still there afterwards.
    const keysOf = object => [...String(object || '').matchAll(/(\w+)\s*:/g)].map(match => match[1]);
    const untouched = keysOf(args && (args.match(/\(?\s*(\{[\s\S]*?\})\s*,/) || [])[1])
      .filter(key => !keysOf(patch).includes(key));
    const checksPreserved = untouched.some(key => new RegExp(String.raw`\b${key}\s*:`).test(expected)
      || new RegExp(String.raw`\.${key}\b`).test(assertions));
    return updater && falsyPatch && checksFalsy && checksPreserved
      ? { pass: true, reason: 'Preserves existing state and checks explicit falsy values.' }
      : { pass: false, reason: 'Does not prove state and explicit false/zero/empty values survive.' };
  },

  // Cancellation must remove every listener it installed, not just reject.
  lifecycle(output) {
    const whole = codeOf(output);
    // Everything below is graded inside waitForDownload itself: a guard in some
    // other helper does not protect the listeners this function installs.
    const implAt = /(?:function\s+waitForDownload\s*\(|(?:const|let|var)\s+waitForDownload\s*=)/.exec(whole);
    const implBlock = implAt && blockAt(whole, implAt.index);
    const t = implBlock
      ? whole.slice(implAt.index, whole.indexOf('{', implAt.index) + implBlock.length)
      : whole;
    // events.once(emitter, 'download', { signal }) is the platform's own answer:
    // it rejects a pre-aborted signal and removes its listeners either way. Only
    // the real one counts, so resolve the local binding it was imported under,
    // and require it to receive this function's own signal parameter.
    const imported = /(?:const|let|var)\s*\{([^}]{0,160})\}\s*=\s*require\s*\(\s*['"](?:node:)?events['"]|import\s*\{([^}]{0,160})\}\s*from\s*['"](?:node:)?events['"]/.exec(whole);
    const namespace = /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"](?:node:)?events['"]|import\s+(\w+)\s+from\s+['"](?:node:)?events['"]/.exec(whole);
    const alias = imported && (imported[1] || imported[2]).split(',')
      .map(part => part.split(/\s+as\s+|:/).map(word => word.trim()))
      .find(pair => pair[0] === 'once');
    const onceName = alias ? alias[1] || alias[0]
      : namespace && `${namespace[1] || namespace[2]}\\.once`;
    const shim = onceName && new RegExp(String.raw`function\s+${onceName}\b|(?:const|let|var)\s+${onceName}\s*=`).test(whole);
    const signalParam = (/waitForDownload\s*=?\s*(?:async\s*)?\(?\s*\w+\s*,\s*(\w+)/.exec(whole) || [, 'signal'])[1];
    const signalOption = signalParam === 'signal'
      ? String.raw`\bsignal\s*(?:[,}]|:\s*signal\b)`
      : String.raw`\bsignal\s*:\s*${signalParam}\b`;
    if (onceName && !shim
      && new RegExp(String.raw`(?:return|await|=>)\s*${onceName}\s*\(\s*\w+\s*,\s*['"]download['"]\s*,\s*\{[^}]{0,120}${signalOption}`).test(t))
      return { pass: true, reason: 'Delegates the whole lifecycle to the abort-aware events.once helper.' };
    // An already-aborted signal never fires `abort`, so the guard has to run
    // before any listener is installed or the setup leaks both of them.
    const guard = new RegExp(String.raw`${signalParam}\.throwIfAborted\s*\(|throwIfAborted\s*\(\s*${signalParam}|if\s*\(\s*${signalParam}\??\.aborted\s*\)\s*(?:\{[^}]{0,160}(?:(?:return\s+)?reject\s*\(|\bthrow\b)|(?:return\s+)?reject\s*\(|throw\b)`).exec(t);
    const firstListener = /addEventListener\s*\(\s*['"]abort['"]|\.(?:once|on|addListener)\s*\(\s*['"]download['"]/.exec(t);
    const preAborted = Boolean(guard && firstListener && guard.index < firstListener.index);
    const handlers = namedFunctionBodies(t);
    // Which callback is the abort handler is decided by what was registered for
    // 'abort', not by whether its name happens to say so.
    const aborts = /(\w+)\s*\.\s*addEventListener\s*\(\s*['"]abort['"]\s*,\s*(\w+)/.exec(t);
    const ownsDownload = /(\w+)\s*\.\s*(?:once|on|addListener)\s*\(\s*['"]download['"]\s*,\s*(\w+)/.exec(t);
    // Promise.reject() inside the handler settles nothing: the outer promise
    // stays pending, so it has to be the executor's own reject callback.
    // ...and it has to run unconditionally: `if (false) reject(reason)` leaves
    // the promise pending on the one path that matters.
    const settles = (body, call) => body.split(';')
      .some(statement => new RegExp(String.raw`(?<![.\w])${call}\s*\(`).test(statement)
        && !/\bif\s*\(|\?|&&|\|\|/.test(statement));
    const abortHandler = aborts && handlers.find(handler => handler.name === aborts[2] && settles(handler.body, 'reject'));
    const downloadHandler = ownsDownload && handlers.find(handler => handler.name === ownsDownload[2] && settles(handler.body, 'resolve'));
    const cleanupName = abortHandler && downloadHandler
      && [...abortHandler.body.matchAll(/\b(\w+)\s*\(\s*\)/g)]
        .map(match => match[1])
        .find(name => new RegExp(`\\b${name}\\s*\\(\\s*\\)`).test(downloadHandler.body));
    const cleanupHandler = cleanupName && handlers.find(handler => handler.name === cleanupName);
    // Removal has to happen on the object the listener was registered on;
    // otherEmitter.off(...) leaves the real listener installed.
    const cleansAbort = cleanupHandler
      && new RegExp(`${aborts[1]}\\s*\\.\\s*removeEventListener\\s*\\(\\s*['"]abort['"]\\s*,\\s*${abortHandler.name}\\b`).test(cleanupHandler.body);
    const cleansDownload = cleanupHandler
      && new RegExp(`${ownsDownload[1]}\\s*\\.\\s*(?:off|removeListener)\\s*\\(\\s*['"]download['"]\\s*,\\s*${downloadHandler.name}\\b`).test(cleanupHandler.body);
    return preAborted && cleansAbort && cleansDownload
      ? { pass: true, reason: 'Owns pre-aborted cancellation and listener cleanup as one lifecycle.' }
      : { pass: false, reason: 'Missing pre-aborted cancellation, listener cleanup, or stale-completion protection.' };
  },

  // Data loaded from storage is untrusted again at the point of network use.
  revalidate(output) {
    const t = codeOf(output);
    const fail = { pass: false, reason: 'Trusts persisted URL without revalidating its current network policy.' };
    const parsed = t.match(/(?:const|let|var)\s+(\w+)\s*=\s*new URL\s*\(\s*([\w.[\]'"]+)/);
    if (!parsed) return fail;
    const url = parsed[1];
    // The probe is about persisted input: a URL built from a literal proves
    // nothing about the saved webhook the task actually has to send to.
    const source = parsed[2].split(/[.[]/)[0];
    const persisted = !/^['"]/.test(parsed[2]) && (
      new RegExp(String.raw`\b${source}\s*=\s*(?:await\s+)?(?:JSON\.parse|\w*[Rr]ead\w*|require)\s*\(`).test(t)
      || new RegExp(String.raw`\{[^}]{0,160}\b${source}\b[^}]{0,160}\}\s*=\s*(?:await\s+)?JSON\.parse`).test(t));
    if (!persisted) return fail;
    const rejection = String.raw`\s*(?:\{[^}]{0,200}(?:\bthrow\b|\breject\s*\(|\breturn\s+false\b)|(?:\bthrow\b|\breject\s*\(|\breturn\s+false\b))`;
    // Each policy must reject on its own. An `&&` clause only rejects when every
    // condition fails, so an allowed host still reaches the network over http.
    const enforcing = (text, name) => [...text.matchAll(new RegExp(String.raw`if\s*\(([^\n]{0,300}?)\)${rejection}`, 'gi'))]
      .flatMap(match => match[1].split('||').map(clause => ({ index: match.index, clause })))
      .filter(guard => !guard.clause.includes('&&'))
      .filter(guard => new RegExp(String.raw`${name}\.protocol\s*!==?\s*['"]https:['"]`, 'i').test(guard.clause)
        || new RegExp(String.raw`!\s*(?:allowedHosts|allowlist)\s*\.\s*(?:has|includes)\s*\(\s*${name}\.hostname\s*\)`, 'i').test(guard.clause));
    // A named validator counts only if its own body rejects on the same policy,
    // with the same polarity an inline guard would need.
    const validates = new RegExp(String.raw`(?:^|[;}\n])\s*(?:await\s+)?((?:validate|assert|ensure|checkNetwork)\w*Url)\s*\(\s*${url}\b`, 'im').exec(t);
    const definition = validates
      && new RegExp(String.raw`(?:function\s+${validates[1]}\s*\(\s*(\w+)|(?:const|let|var)\s+${validates[1]}\s*=\s*(?:async\s*)?\(?\s*(\w+))`).exec(t);
    // Only the invoked validator's own body counts — not whatever follows it.
    // And a validator that returns false is ignorable, as these callers do
    // ignore it; requiring it to throw is what actually stops the request.
    const validatorBody = definition ? blockAt(t, definition.index) : '';
    const enforcingValidator = Boolean(definition
      && /\bthrow\b|\breject\s*\(/.test(validatorBody)
      && enforcing(validatorBody, definition[1] || definition[2]).length > 0);
    // Every request to the persisted destination has to be guarded, not just the
    // first one: a safe HEAD probe followed by an unguarded POST is a bypass.
    const requests = [...t.matchAll(/(?:(?:const|let|var)\s+(\w+)\s*=\s*)?(?:await\s+)?\b(fetch|https?\.(?:request|get))\s*\(\s*([^,)]{0,80}?)\s*[,)]/g)]
      .map(match => ({
        index: match.index,
        handle: match[1],
        native: match[2] !== 'fetch',
        target: match[3],
        options: blockAt(t, match.index).slice(0, 400),
      }));
    if (requests.some(request => request.target.startsWith(parsed[2]))) return fail;
    const urlRequests = requests.filter(request => request.target === url);
    // The task is to POST a payload: a guarded GET never performs the operation
    // whose trust boundary this probe is measuring, and an `x-body` header is
    // not a payload — it has to be a real body option or a write on the request.
    const fetchCall = urlRequests.find(request => /method\s*:\s*['"]POST['"]/i.test(request.options)
      && (/\bbody\s*(?::|[,}])/.test(request.options)
        || (request.handle && new RegExp(String.raw`\b${request.handle}\s*\.\s*(?:write|end)\s*\(\s*\w`).test(t))));
    // An inline guard only protects the request if it runs on the way to it: a
    // guard sitting in a helper the answer never calls protects nothing.
    const validations = [
      ...enforcing(t, url).filter(guard => fetchCall && sameScope(t, guard.index, fetchCall.index)),
      ...(enforcingValidator ? [validates] : []),
    ];
    // A followed redirect re-enters the network with a destination the policy
    // never saw, so each request has to refuse or hand back the 3xx itself.
    // native https does not follow redirects on its own; fetch does.
    const boundsRedirects = urlRequests.length
      && urlRequests.every(request => request.native
        || /redirect\s*:\s*['"](?:manual|error)['"]/.test(request.options));
    return fetchCall && boundsRedirects && validations.some(v => v.index < fetchCall.index)
      ? { pass: true, reason: 'Revalidates persisted URL against a network policy before use.' }
      : fail;
  },

  // A remote response needs both a deadline and an enforced streaming byte ceiling.
  bounds(output) {
    const t = codeOf(output);
    // Everything below is graded inside the loop that consumes the stream:
    // buffering the whole body first and counting afterwards is no ceiling.
    const consumer = streamConsumer(t);
    const scope = consumer ? consumer.body : '';
    // The deadline has to belong to the request whose response that loop reads,
    // not to some earlier bounded preliminary call, and it has to be armed
    // before the request: a timer set afterwards bounds nothing.
    const reads = consumer && t.slice(Math.max(0, consumer.index - 80), consumer.index) + consumer.body;
    const timed = [...t.matchAll(/(?:(?:const|let|var)\s+(\w+)\s*=\s*)?(?:await\s+)?\b(?:fetch|https?\.(?:get|request))\s*\(/g)]
      .filter(request => {
        const options = blockAt(t, request.index).slice(0, 400);
        const signalRef = /\bsignal\s*:\s*AbortSignal\.timeout\s*\(/.test(options)
          ? 'inline'
          : (/\bsignal\s*:\s*(\w+)\s*\.\s*signal\b/.exec(options)
            || /\bsignal\s*:\s*(\w+)/.exec(options)
            || /\b(signal)\s*[,}]/.exec(options) || [])[1];
        // The initializer has to run on the way to this request, not sit in an
        // uncalled helper that leaves `signal` undefined when the request fires.
        const armedBefore = pattern => {
          const match = new RegExp(pattern).exec(t);
          return Boolean(match && match.index < request.index
            && sameScope(t, match.index, request.index));
        };
        return signalRef === 'inline'
          || Boolean(signalRef && (armedBefore(String.raw`\b${signalRef}\s*=\s*AbortSignal\.timeout\s*\(`)
            || armedBefore(String.raw`setTimeout\s*\([\s\S]{0,240}\b${signalRef}\s*\.\s*abort\s*\(`)));
      });
    let stream = [];
    const requestTimeout = Boolean(reads && timed.some(request => {
      const names = new Set([request[1]].filter(Boolean));
      for (const binding of t.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*([\w.$]+)/g))
        if (names.has(binding[2].split('.')[0])) names.add(binding[1]);
      if (![...names].some(name => new RegExp(String.raw`\b${name}\b`).test(reads))) return false;
      stream = [...names];
      return true;
    }));
    const evented = Boolean(consumer && /['"]data['"]/.test(consumer.header));
    // The accumulator has to add the chunk's actual size: `+= 0 * n` and
    // `+= -n` count bytes that never reach the ceiling.
    const counter = scope.match(/\b([A-Za-z_$]\w*)\s*\+=\s*([\w.$]+\.(?:byteLength|length))\s*[;\n]/);
    const limitBranch = counter && new RegExp(String.raw`if\s*\([^\n]{0,240}${counter[1]}\s*>=?\s*[\w.$]+(?:\s*[*+]\s*[\w.$]+)*[^\n]{0,240}?\)\s*(\{[^}]{0,240}\}|[^\n]{0,160})`, 'i').exec(scope);
    // `return` exits one data callback but leaves an evented stream flowing, so
    // the over-limit path has to tear the stream down too.
    // The chunk has to be counted before it is judged, or the last oversized one
    // slips through and the stream ends without ever tripping the limit.
    // An oversized response is a failure, not a short file: a bare `return`
    // resolves with a truncated download. Evented streams fail by destroy(err).
    const stops = limitBranch && counter.index < limitBranch.index
      && (evented
        ? (stream.length > 0
          && new RegExp(String.raw`\b(?:${stream.join('|')})[\w.$]*\s*\.\s*(?:destroy|abort|cancel)\s*\(\s*new\s+\w*Error`).test(limitBranch[1]))
        : /\bthrow\b|(?<![.\w])reject\s*\(/.test(limitBranch[1]));
    // The write has to be of the chunk just counted, and only after the guard:
    // an unrelated log write past the branch is not the destination write.
    const chunk = (scope.match(/\{[^}]{0,40}\b(?!done\b)(\w+)\s*\}\s*=\s*await\s+\w+\s*\.\s*read\s*\(/)
      || (consumer && consumer.header.match(/for\s+await\s*\(\s*(?:const|let|var)\s+(\w+)\s+of/))
      || (consumer && consumer.header.match(/['"]data['"]\s*,\s*(?:async\s*)?\(?\s*(\w+)/)) || [])[1];
    const writesChunk = chunk && new RegExp(String.raw`write\w*\s*\([^)]*\b${chunk}\b`);
    const writeAfterLimit = stops && writesChunk
      && writesChunk.test(scope.slice(limitBranch.index + limitBranch[0].length))
      && !writesChunk.test(scope.slice(0, limitBranch.index));
    return requestTimeout && writeAfterLimit
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
