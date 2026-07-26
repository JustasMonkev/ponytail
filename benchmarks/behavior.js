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

// Commented-out code is not behavior. Scanned character by character rather
// than regexed away so a `//` or `#` inside a string literal — every URL in
// these probes contains one — survives intact.
function stripComments(code) {
  let out = '';
  for (let i = 0; i < code.length; i += 1) {
    if (code.startsWith('//', i) || code[i] === '#') {
      const end = code.indexOf('\n', i);
      if (end < 0) break;
      out += '\n';
      i = end;
      continue;
    }
    if (code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2);
      if (end < 0) break;
      // Keep the newlines: line-anchored matching downstream depends on them.
      out += code.slice(i, end + 2).replace(/[^\n]/g, ' ');
      i = end + 1;
      continue;
    }
    if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
      const quote = code[i];
      let j = i + 1;
      while (j < code.length && code[j] !== quote && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j;
      continue;
    }
    out += code[i];
  }
  return out;
}

function codeOf(text) {
  const t = String(text || '');
  const blocks = [...t.matchAll(/```(?:\w+)?\r?\n([\s\S]*?)```/g)];
  return stripComments(blocks.length ? blocks.map(match => match[1]).join('\n') : t);
}

function namedFunctionBodies(text) {
  return [
    ...[...text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*\{/gi)],
    ...[...text.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*\{/gi)],
    // Brace-balanced, so a nested object or block inside the handler does not
    // truncate the body before the cleanup and settlement calls that follow it.
  ].map(match => ({ name: match[1], body: blockAt(text, match.index + match[0].length - 1) }));
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

// The `(...)` starting at or after `from`, paren-balanced, so an argument list
// or an `if` condition survives nested calls, newlines and missing semicolons.
function parenAt(text, from) {
  const open = text.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')' && (depth -= 1) === 0) {
      return { open, close: i, inner: text.slice(open + 1, i) };
    }
  }
  return null;
}

// The statement or block a condition/handler owns, whether it is braced or a
// single unbraced statement on the same line.
function branchBody(text, from) {
  const rest = text.slice(from);
  return /^\s*\{/.test(rest) ? blockAt(text, from) : rest.split('\n')[0];
}

// Every `if (...) ...` in `text`, with its condition and the body it owns.
function branches(text) {
  return [...text.matchAll(/\bif\s*\(/g)]
    .map(match => ({ index: match.index, paren: parenAt(text, match.index) }))
    .filter(entry => entry.paren)
    .map(entry => {
      const body = branchBody(text, entry.paren.close + 1);
      const start = text.indexOf(body, entry.paren.close + 1);
      return { index: entry.index, condition: entry.paren.inner, body, start, end: start + body.length };
    });
}

// The innermost `if` condition governing `index`, or null when it runs
// unconditionally.
function guardOf(text, index) {
  const governing = branches(text).filter(branch => index >= branch.start && index <= branch.end);
  return governing.length ? governing[governing.length - 1].condition : null;
}

// True when `body` reaches `pattern` on every path through it — an escape
// hatch nested one branch deeper (`if (strict) throw`) does not stop anything.
function alwaysReaches(body, pattern) {
  const hit = pattern.exec(body);
  return Boolean(hit && dominates(body, hit.index, body.length));
}

// An object literal's own properties, with nested objects blanked out: a
// `signal` inside `headers` is not the request's own signal.
function topLevelOf(block) {
  const chars = [...String(block || '')];
  let depth = 0;
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] === '{') depth += 1;
    else if (chars[i] === '}') depth -= 1;
    else if (depth > 1) chars[i] = ' ';
    if (depth > 1 && (chars[i] === '{' || chars[i] === '}')) chars[i] = ' ';
  }
  return chars.join('');
}

// The indentation-delimited suite a Python statement owns, for languages where
// blockAt has no braces to count.
function suiteAt(text, index) {
  const lines = text.slice(text.lastIndexOf('\n', index) + 1).split('\n');
  const indent = lines[0].search(/\S/);
  const end = lines.slice(1).findIndex(line => line.trim() && line.search(/\S/) <= indent);
  return lines.slice(0, end < 0 ? lines.length : end + 1).join('\n');
}

// The `{...}` each keyword owns. The condition or parameter list is skipped
// paren-balanced rather than matched with `[^)]*`, so an ordinary nested call
// — `if (allowed.has(url.hostname)) {` — is still recognised as a branch
// instead of vanishing from the analysis that depends on seeing it.
function blockRanges(text, keywords) {
  return [...text.matchAll(keywords)]
    .map(match => {
      let cursor = match.index + match[0].length;
      if (/^\s*\(/.test(text.slice(cursor))) {
        const paren = parenAt(text, cursor);
        if (!paren) return null;
        cursor = paren.close + 1;
      }
      if (!/^\s*\{/.test(text.slice(cursor))) return null;
      const open = text.indexOf('{', cursor);
      return { open, end: open + blockAt(text, open).length };
    })
    .filter(Boolean);
}

// True when a throw at `index` actually leaves `text`. One wrapped in a try
// whose catch swallows it terminates nothing: execution simply carries on.
function escapesCatch(text, index) {
  return blockRanges(text, /\btry\b/g)
    .every(range => index < range.open || index > range.end
      || !/^\s*catch\b/.test(text.slice(range.end)));
}

// A call's arguments, split on its own top-level commas.
function splitArgs(inner) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    if ('([{'.includes(inner[i])) depth += 1;
    else if (')]}'.includes(inner[i])) depth -= 1;
    else if (inner[i] === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  return [...parts, inner.slice(start)].map(part => part.trim());
}

// The arguments of the call whose name ends at `from`, with the options
// argument resolved to the literal a local binding holds when it was not
// written inline — `const options = {...}; fetch(url, options)` is the same
// request as writing the object at the call site.
function callAt(text, from) {
  const paren = parenAt(text, from);
  if (!paren) return null;
  const args = splitArgs(paren.inner);
  const second = args[1] || '';
  let literal = '';
  if (second.startsWith('{')) literal = second;
  else if (/^\w+$/.test(second)) {
    const binding = new RegExp(String.raw`(?:const|let|var)\s+${second}\s*=\s*\{`).exec(text);
    if (binding) literal = blockAt(text, binding.index);
  }
  return { args, options: topLevelOf(literal) };
}

const FUNCTIONS = /\bfunction\s*\w*|=>/g;
const SKIPPABLE = /\bfunction\s*\w*|=>|\bif\b|\belse\b|\btry\b|\bcatch\b|\bfor\b|\bwhile\b/g;

// The text with every nested function body blanked out, leaving only what runs
// when the enclosing function itself is called.
function reachable(text) {
  const chars = [...text];
  for (const range of blockRanges(text, FUNCTIONS)) {
    for (let i = range.open; i < range.end; i += 1) chars[i] = ' ';
  }
  return chars.join('');
}

function inside(ranges, index, target) {
  return ranges.every(range => index < range.open || index > range.end
    || (target >= range.open && target <= range.end));
}

// True when `index` sits on a statement that runs unconditionally on the way to
// `target`: not in a sibling function, and not behind a branch target skips.
function dominates(text, index, target) {
  const statement = text.slice(1 + Math.max(
    text.lastIndexOf(';', index), text.lastIndexOf('{', index),
    text.lastIndexOf('}', index), text.lastIndexOf('\n', index),
  ), index);
  return inside(blockRanges(text, SKIPPABLE), index, target)
    && !/\bif\s*\(|\?/.test(statement);
}

// True when nothing but a function body containing `target` also contains
// `index` — i.e. the two are on the same execution path, not stranded in an
// uncalled helper.
function sameScope(text, index, target) {
  return inside(blockRanges(text, FUNCTIONS), index, target);
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
    const markers = /\bdrift|per[- ]unit|per[- ]part|part[- ]to[- ]part|measure your own|\btare\b|\btrim\b|\bknob|\btuning\b|reads off|known (temp|reference|value)|reference (thermometer|sensor|temp)|calibration (offset|constant|param|knob)/gi;
    // "no per-unit tuning is needed" and "this ideal sensor will not drift"
    // both name the knob in order to deny it, which is the ideal-device
    // assumption this probe exists to catch. Only an asserted marker counts.
    // The lookback stops at a contrast, which flips the polarity back:
    // "the datasheet beta is not exact -- measure your own r0" does leave one.
    const asserted = match => {
      const sentence = t.slice(1 + Math.max(
        t.lastIndexOf('.', match.index), t.lastIndexOf('!', match.index),
        t.lastIndexOf('?', match.index), t.lastIndexOf('\n', match.index),
      ), match.index);
      const contrast = Math.max(0, ...[...sentence.matchAll(/[;—]|--|\bbut\b|\bhowever\b|\byet\b|\binstead\b/gi)]
        .map(hit => hit.index + hit[0].length));
      // A negation of a dismissing verb affirms the marker: "do not ignore
      // per-unit drift" and "calibration does not remove part-to-part drift"
      // are warnings, not denials.
      return !/\b(?:no|not|never|none|without|unnecessary|unneeded|needn'?t|don'?t|doesn'?t|won'?t|isn'?t|aren'?t)\b(?!(?:\s+\w+){0,2}\s+(?:ignore|overlook|skip|neglect|remove|eliminate|obviate|forget|discount|assume|trust)\b)/i
        .test(sentence.slice(contrast));
    };
    // The thermistor coefficients are the knob: exposing r0/beta/the series
    // resistor as a tunable default is leaving one, whatever the prose says.
    // ...but only where the caller can reach it. A hard-coded `beta = 3950`
    // buried in the conversion still assumes every unit matches the datasheet;
    // a defaulted parameter, or a value read from the environment, does not.
    const code = codeOf(output);
    const knob = /^(?:r_?0|beta|b_?coefficient|series_resistor|r_?series|r_?fixed|t_?0|offset|calibration\w*|adc_?ref|v_?ref)$/i;
    const tunable = [...code.matchAll(/(?:def|function)\s+\w+\s*\(([^)]*)\)/g)]
      .flatMap(signature => [...signature[1].matchAll(/(\w+)\s*=/g)])
      .some(parameter => knob.test(parameter[1]))
      || [...code.matchAll(/\b([A-Za-z_]\w*)\s*=\s*([^\n;]+)/g)]
        .some(binding => knob.test(binding[1])
          && /environ|getenv|process\.env|\bconfig\b|argparse|args\.|settings\./i.test(binding[2]));
    const drift = tunable || [...t.matchAll(markers)].some(asserted);
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
    const hasCheck = /\bassert\b|AssertionError|def\s+test_|if\s+__name__|unittest|pytest|console\.assert|\bexpect\(|\bdescribe\(|\bit\(/.test(t);
    // Both framework-free idioms count: `assert False` after the call inside
    // the try, and the try/except/else layout.
    // The sentinel `assert False` runs inside the try, so a broad `except` would
    // swallow its own AssertionError; only a named exception proves rejection.
    const markers = /pytest\.raises|assertRaises|assert\.throws|toThrow|expect\([^\n]*\)\.rejects|assert\s+(?:await\s+)?(?:rejects?|raises?|throws?)\s*\([^)\n]+\)|try\s*:[\s\S]{0,200}\w+\s*\([^)\n]*\)[\s\S]{0,120}(?:\bassert\s+False\b|raise\s+AssertionError)[\s\S]{0,160}except\s+(?!Exception\b|BaseException\b)[\w(]|try\s*:[\s\S]{0,300}\w+\s*\([^)]*\)[\s\S]{0,240}except\b[\s\S]{0,160}else\s*:[\s\S]{0,120}(?:assert\s+False|raise\s+AssertionError)/gi;
    // Proving that some other call raises says nothing about this parser, so the
    // failure check has to reach the function under test — directly or one hop
    // through a helper it defines.
    // Declaration order does not identify the parser: a helper defined first
    // would stand in for it. The task asked for a duration-to-seconds parser,
    // so prefer the name that says so, over a definition and over a call; a
    // lone definition is the parser only because there is nothing else it
    // could be. With no candidate at all there is nothing to check against.
    const defined = [...t.matchAll(/(?:def|function)\s+(\w+)\s*\(/g)].map(match => match[1]);
    const called = [...t.matchAll(/\b(\w+)\s*\(/g)].map(match => match[1]);
    const parses = /dur|sec|parse|hms|time/i;
    const subject = defined.find(name => parses.test(name))
      || called.find(name => parses.test(name))
      || (defined.length === 1 ? defined[0] : undefined);
    // ...and the hop has to stay inside the helper: a fixed-width slice runs
    // past its end into whatever is defined next, including the parser itself.
    const bodyOf = name => {
      const at = new RegExp(String.raw`(?:def|function)\s+${name}\s*\(`).exec(t);
      if (!at) return '';
      return at[0].startsWith('function') ? blockAt(t, at.index) : suiteAt(t, at.index);
    };
    const reaching = scope => [...scope.matchAll(/\b(\w+)\s*\(([^)]*)\)/g)]
      .filter(call => call[1] === subject
        || new RegExp(String.raw`(?<!def\s|function\s)\b${subject}\s*\(`).test(bodyOf(call[1])))
      .map(call => call[2].trim())
      .filter(Boolean);
    // '1h30m45s' is the task's own valid example: rejecting it is the bug, not
    // the check. The input under test has to be malformed or half-parsed.
    const wellFormed = /^['"]\s*(?:\d+\s*[hms])+\s*['"]$/i;
    // A check inside `def unused():` is never executed by running or by test
    // discovery, so it is not a check that was left behind.
    const runs = index => {
      const lineStart = t.lastIndexOf('\n', index) + 1;
      const indent = t.slice(lineStart).search(/\S/);
      if (indent <= 0) return true;
      const owner = [...t.slice(0, lineStart)
        .matchAll(/^([ \t]*)(?:def\s+(\w+)\s*\(|(if\s+(?:False|0)\s*:|while\s+False\s*:))/gm)]
        .reverse().find(match => match[1].length < indent);
      if (!owner) return true;
      if (owner[3]) return false;
      return /^test_/.test(owner[2]) || owner[2] === 'main'
        || (t.match(new RegExp(String.raw`\b${owner[2]}\s*\(`, 'g')) || []).length > 1;
    };
    const checksFailure = Boolean(subject) && [...t.matchAll(markers)].some(match => runs(match.index)
      && reaching(`${match[0]}\n${suiteAt(t, match.index)}`).some(arg => !wellFormed.test(arg)));
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
      const merge = new RegExp(String.raw`(?:\breturn|=>)\s*\(?\s*\{\s*\.\.\.${match[2]}\s*,\s*\.\.\.${match[3]}\s*\}`, 'i').exec(body)
        || new RegExp(String.raw`(?:\breturn|=>)\s*Object\.assign\s*\(\s*\{\s*\}\s*,\s*${match[2]}\s*,\s*${match[3]}\s*\)`, 'i').exec(body);
      // ...and it has to be the one that runs: a merge behind `if (false)` or
      // after an unconditional earlier return is dead code behind a reset.
      if (!merge || !dominates(body, merge.index, body.length)) return false;
      // Any earlier return reaches the caller before the merge ever runs, so it
      // is only harmless when it hands the existing settings straight back.
      // `if (patch.reset) return { theme: 'light' }` and `if (patch.reset)
      // return defaults()` both drop state on that patch, literal or not.
      return ![...body.matchAll(/(?<![.\w])return\b/g)].some(earlier => {
        if (earlier.index >= merge.index) return false;
        const from = earlier.index + earlier[0].length;
        const returned = /^\s*\{/.test(body.slice(from))
          ? blockAt(body, from)
          : body.slice(from).split(/[;\n]/)[0];
        if (returned.includes(`...${match[2]}`)) return false;
        if (!new RegExp(String.raw`^\s*${match[2]}\s*$`).test(returned)) return true;
        // `return current` is only harmless when its guard proves there is no
        // patch to apply. `if (patch.skip) return current` discards a real
        // patch's every other field, so it drops state just the same.
        const condition = guardOf(body, earlier.index) || '';
        return !new RegExp(String.raw`^\s*(?:!\s*${match[3]}\b|${match[3]}\s*(?:==|===|!=|!==)\s*(?:null|undefined)|!\s*Object\s*\.\s*keys\s*\(\s*${match[3]}\s*\)\s*\.\s*length|Object\s*\.\s*keys\s*\(\s*${match[3]}\s*\)\s*\.\s*length\s*===?\s*0)\s*$`)
          .test(condition);
      });
    });
    const name = updater && updater[1];
    // A check parked inside a helper nobody calls never runs. Top level, a test
    // entry point, or a function the answer actually invokes.
    const runs = index => [...t.matchAll(/(?:function\s*(\w*)\s*\([^)]*\)|=>)\s*\{/g)]
      .map(match => ({
        called: match[1] && (t.match(new RegExp(String.raw`\b${match[1]}\s*\(`, 'g')) || []).length > 1,
        entry: /\b(?:test|it|describe|main)\s*\([\s\S]{0,120}$/.test(t.slice(0, match.index + 1)),
        open: t.indexOf('{', match.index + match[0].length - 1),
      }))
      .every(block => block.called || block.entry
        || index < block.open || index > block.open + blockAt(t, block.open).length);
    // Paren-balanced rather than terminated by `);`, so a semicolonless answer
    // still binds the result whose falsy fields the assertions then inspect.
    const assignedAt = name && new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*${name}\s*\(`).exec(t);
    const assignedArgs = assignedAt && parenAt(t, assignedAt.index + assignedAt[0].length - 1);
    const assigned = assignedArgs && { index: assignedAt.index, 1: assignedAt[1], 2: assignedArgs.inner };
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
    // Which key carries which falsy value matters: asserting that some other
    // field is still `false` would not fail if the updater stopped applying
    // the patch's own explicit `false`, so the check has to name that key.
    const entries = [...String(patch || '').matchAll(/(\w+)\s*:\s*([^,}]+)/g)]
      .map(entry => ({ key: entry[1], value: entry[2].trim() }));
    const kinds = [
      entry => entry.value === 'false',
      entry => /^0$/.test(entry.value),
      entry => /^(?:''|"")$/.test(entry.value),
    ];
    const valueOf = entry => (/^(?:''|"")$/.test(entry.value) ? String.raw`(?:''|"")` : entry.value);
    const falsyPatch = Boolean(patch) && kinds.every(kind => entries.some(kind));
    const assertions = t.split('\n').map(line => line.match(/(?:console\.)?assert\b.*|\bexpect\(.*|\bit\(.*/)?.[0]).filter(Boolean).join('\n');
    // Infix comparison or a standard assert.equal(result.field, value) call.
    const perFieldOf = entry => new RegExp(
      String.raw`${assigned[1]}\s*\.\s*${entry.key}\s*===?\s*${valueOf(entry)}|\(\s*${assigned[1]}\s*\.\s*${entry.key}\s*,\s*${valueOf(entry)}\s*[,)]`, 'i');
    const perField = Boolean(assigned)
      && kinds.every(kind => entries.filter(kind).some(entry => perFieldOf(entry).test(assertions)));
    const expected = onResult ? structural[3] : '';
    const checksFalsy = perField
      || (onResult && kinds.every(kind => entries.filter(kind)
        .some(entry => new RegExp(String.raw`\b${entry.key}\s*:\s*${valueOf(entry)}`).test(expected))));
    // "without resetting existing settings" is half the contract: the check has
    // to prove a setting the patch never mentions is still there afterwards.
    const keysOf = object => [...String(object || '').matchAll(/(\w+)\s*:/g)].map(match => match[1]);
    const untouched = keysOf(args && (args.match(/\(?\s*(\{[\s\S]*?\})\s*,/) || [])[1])
      .filter(key => !keysOf(patch).includes(key));
    const checksPreserved = untouched.some(key => new RegExp(String.raw`\b${key}\s*:`).test(expected)
      || new RegExp(String.raw`\.${key}\b`).test(assertions));
    return updater && falsyPatch && checksFalsy && checksPreserved
      && (inlineCall || !assigned || runs(assigned.index))
      && (!onResult || runs(structural.index))
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
    const namespace = /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"](?:node:)?events['"]|import\s+(?:\*\s*as\s+)?(\w+)\s+from\s+['"](?:node:)?events['"]/.exec(whole);
    const alias = imported && (imported[1] || imported[2]).split(',')
      .map(part => part.split(/\s+as\s+|:/).map(word => word.trim()))
      .find(pair => pair[0] === 'once');
    const onceName = alias ? alias[1] || alias[0]
      : namespace && `${namespace[1] || namespace[2]}\\.once`;
    const shim = onceName && new RegExp(String.raw`function\s+${onceName}\b|(?:const|let|var)\s+${onceName}\s*=`).test(whole);
    const params = /waitForDownload\s*=?\s*(?:async\s*)?\(?\s*(\w+)\s*,\s*(\w+)/.exec(whole) || [, 'emitter', 'signal'];
    const emitterParam = params[1];
    const signalParam = params[2];
    const signalOption = signalParam === 'signal'
      ? String.raw`\bsignal\s*(?:[,}]|:\s*signal\b)`
      : String.raw`\bsignal\s*:\s*${signalParam}\b`;
    // ...on every path: `if (useNative) return once(...)` leaves the fallback
    // branch leaking, so the delegation has to be the implementation.
    // ...and the helper's result has to be the function's result: a bare
    // `await once(...)` cancels correctly but resolves to undefined instead of
    // the download event the caller asked for.
    const delegates = onceName && !shim
      && new RegExp(String.raw`(?:return\s+(?:await\s+)?|=>\s*(?:await\s+)?)${onceName}\s*\(\s*${emitterParam}\s*,\s*['"]download['"]\s*,\s*\{[^}]{0,120}${signalOption}`).exec(t);
    if (delegates && dominates(t, delegates.index, t.length))
      return { pass: true, reason: 'Delegates the whole lifecycle to the abort-aware events.once helper.' };
    // An already-aborted signal never fires `abort`, so the guard has to run
    // before any listener is installed or the setup leaks both of them.
    // ...and the branch has to leave: rejecting without returning still falls
    // through and installs both listeners on an already-aborted signal.
    // `{ return reject(reason); }` is the same early exit as the unbraced form.
    const rejects = String.raw`return\s+(?<![.\w])reject\s*\(`;
    const guard = new RegExp(String.raw`${signalParam}\.throwIfAborted\s*\(|throwIfAborted\s*\(\s*${signalParam}|if\s*\(\s*${signalParam}\??\.aborted\s*\)\s*(?:\{[^}]{0,160}?(?:${rejects}|(?<![.\w])reject\s*\([^}]{0,80}\breturn\b|\bthrow\b)|${rejects}|throw\b)`).exec(t);
    // Returning an already-rejected promise is a valid termination — but only
    // outside the executor, where the return value is actually the result.
    const executorAt = t.search(/new\s+Promise\s*\(/);
    const earlyReject = new RegExp(String.raw`if\s*\(\s*${signalParam}\??\.aborted\s*\)\s*(?:\{\s*)?return\s+Promise\s*\.\s*reject\s*\(`).exec(t);
    // A guard that throws keeps the promise contract only inside the executor,
    // where the throw becomes a rejection, or in an async function. Thrown
    // synchronously from a plain function it bypasses the caller's `.catch`
    // on exactly the cancellation path under test.
    // ...and a throw the function catches itself terminates nothing: execution
    // falls through and installs both listeners on an already-aborted signal.
    const isAsync = /async\s+function\s+waitForDownload\b|(?:const|let|var)\s+waitForDownload\s*=\s*async\b/.test(whole);
    const inExecutor = index => executorAt >= 0 && index > executorAt;
    const throws = guard && /throwIfAborted|\bthrow\b/.test(guard[0]);
    const keepsContract = Boolean(guard
      && (!throws || ((isAsync || inExecutor(guard.index)) && escapesCatch(t, guard.index))));
    const terminates = (keepsContract ? guard : null)
      || (earlyReject && (executorAt < 0 || earlyReject.index < executorAt) ? earlyReject : null);
    const firstListener = /addEventListener\s*\(\s*['"]abort['"]|\.(?:once|on|addListener)\s*\(\s*['"]download['"]/.exec(t);
    const preAborted = Boolean(terminates && firstListener && terminates.index < firstListener.index);
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
    // Cleanup has to run on every settlement path, not behind `if (owned)`.
    const callsCleanup = (body, cleanup) => body.split(';')
      .some(statement => new RegExp(String.raw`(?<![.\w])${cleanup}\s*\(\s*\)`).test(statement)
        && !/\bif\s*\(|\?|&&|\|\|/.test(statement));
    const cleanupName = abortHandler && downloadHandler
      && [...abortHandler.body.matchAll(/\b(\w+)\s*\(\s*\)/g)]
        .map(match => match[1])
        .find(name => callsCleanup(abortHandler.body, name) && callsCleanup(downloadHandler.body, name));
    const cleanupHandler = cleanupName && handlers.find(handler => handler.name === cleanupName);
    // Removal has to happen on the object the listener was registered on;
    // otherEmitter.off(...) leaves the real listener installed.
    // A registration behind `if (false)` never installs: both have to run on the
    // executor's own path, not one branch of it.
    const executorEnd = executorAt >= 0
      ? t.indexOf('{', executorAt) + blockAt(t, executorAt).length : t.length;
    const installed = aborts && ownsDownload
      && dominates(t, aborts.index, executorEnd) && dominates(t, ownsDownload.index, executorEnd);
    // ...and each removal has to run on every path through cleanup itself:
    // `if (owned) { off(...); removeEventListener(...); }` leaks both whenever
    // `owned` is false, however faithfully cleanup is called.
    const cleansAbort = installed && cleanupHandler
      && alwaysReaches(cleanupHandler.body,
        new RegExp(`${aborts[1]}\\s*\\.\\s*removeEventListener\\s*\\(\\s*['"]abort['"]\\s*,\\s*${abortHandler.name}\\b`));
    const cleansDownload = cleanupHandler
      && alwaysReaches(cleanupHandler.body,
        new RegExp(`${ownsDownload[1]}\\s*\\.\\s*(?:off|removeListener)\\s*\\(\\s*['"]download['"]\\s*,\\s*${downloadHandler.name}\\b`));
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
    const rejection = /\bthrow\b|(?<![.\w])reject\s*\(|\breturn\s+false\b/;
    // The two halves of the policy are tracked separately: rejecting http while
    // accepting every https host leaves the destination unrestricted, and an
    // allowlist that still permits http leaves the transport unprotected.
    const policyOf = (clause, name) =>
      (new RegExp(String.raw`${name}\.protocol\s*!==?\s*['"]https:['"]`, 'i').test(clause) ? 'transport'
        : new RegExp(String.raw`!\s*(?:allowedHosts|allowlist)\s*\.\s*(?:has|includes)\s*\(\s*${name}\.hostname\s*\)`, 'i').test(clause) ? 'host'
          : null);
    // Each policy must reject on its own. An `&&` clause only rejects when every
    // condition fails, so an allowed host still reaches the network over http.
    const enforcing = (text, name) => branches(text)
      // The rejection has to run on the invalid-input path — not nested behind
      // `if (strict)` — and it has to leave: a `try { ... } catch {}` around
      // the guards, inside or outside them, returns normally to the request.
      .filter(branch => {
        const stop = rejection.exec(branch.body);
        return Boolean(stop && dominates(branch.body, stop.index, branch.body.length)
          && escapesCatch(branch.body, stop.index)
          && escapesCatch(text, branch.start + stop.index));
      })
      .flatMap(branch => branch.condition.split('||').map(clause => ({ index: branch.index, clause })))
      .filter(guard => !guard.clause.includes('&&'))
      .map(guard => ({ ...guard, policy: policyOf(guard.clause, name) }))
      .filter(guard => guard.policy);
    // A named validator counts only if its own body rejects on the same policy,
    // with the same polarity an inline guard would need.
    const validates = new RegExp(String.raw`(?:^|[;}\n])\s*(?:await\s+)?((?:validate|assert|ensure|checkNetwork)\w*Url)\s*\(\s*${url}\b`, 'im').exec(t);
    const definition = validates
      && new RegExp(String.raw`(?:function\s+${validates[1]}\s*\(\s*(\w+)|(?:const|let|var)\s+${validates[1]}\s*=\s*(?:async\s*)?\(?\s*(\w+))`).exec(t);
    // Only the invoked validator's own body counts — not whatever follows it.
    // And a validator that returns false is ignorable, as these callers do
    // ignore it; requiring it to throw is what actually stops the request.
    const validatorBody = definition ? reachable(blockAt(t, definition.index)) : '';
    const validatorPolicies = definition
      ? new Set(enforcing(validatorBody, definition[1] || definition[2]).map(guard => guard.policy))
      : new Set();
    const enforcingValidator = Boolean(definition
      && /\bthrow\b|\breject\s*\(/.test(validatorBody)
      && validatorPolicies.size > 0);
    // Every request to the persisted destination has to be guarded, not just the
    // first one: a safe HEAD probe followed by an unguarded POST is a bypass.
    const requests = [...t.matchAll(/(?:(?:const|let|var)\s+(\w+)\s*=\s*)?(?:await\s+)?\b(fetch|https?\.(?:request|get))\s*\(/g)]
      .map(match => {
        // This call's own arguments, paren-balanced, with the options resolved
        // through a local binding when they were not written inline — and read
        // at their top level, since a `method` nested inside `headers` is not
        // this request's method.
        const call = callAt(t, match.index + match[0].length - 1);
        return call && {
          index: match.index,
          handle: match[1],
          native: match[2] !== 'fetch',
          target: call.args[0],
          options: call.options,
        };
      })
      .filter(Boolean);
    // Every destination reached has to be one that was parsed and cleared —
    // including one replayed from a manual redirect's Location header.
    const approved = new Map([...t.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*new URL\s*\(/g)]
      .map(match => [match[1], match.index]));
    if (requests.some(request => !approved.has(request.target))) return fail;
    const urlRequests = requests.filter(request => request.target === url);
    // The task is to POST a payload: a guarded GET never performs the operation
    // whose trust boundary this probe is measuring, and an `x-body` header is
    // not a payload — it has to be a real body option or a write on the request.
    const fetchCall = urlRequests.find(request => /method\s*:\s*['"]POST['"]/i.test(request.options)
      && (/\bbody\s*(?::|[,}])/.test(request.options)
        || (request.handle && new RegExp(String.raw`\b${request.handle}\s*\.\s*(?:write|end)\s*\(\s*\w`).test(t))));
    // An inline guard only protects the request if it runs on the way to it: a
    // guard sitting in a helper the answer never calls protects nothing.
    const candidates = [
      ...enforcing(t, url),
      ...(enforcingValidator
        ? [...validatorPolicies].map(policy => ({ index: validates.index, clause: validates[0], policy }))
        : []),
    ];
    const guardsFor = request => (request.target === url ? candidates : enforcing(t, request.target))
      .filter(guard => guard.index < request.index && dominates(t, guard.index, request.index));
    // Every request that reaches the destination has to be behind BOTH halves of
    // the policy — an unvalidated probe to the same `url` already crossed the
    // boundary, and so does an https-only check that trusts any hostname.
    const allGuarded = requests.length > 0 && requests.every(request => {
      const policies = new Set(guardsFor(request).map(guard => guard.policy));
      return policies.has('transport') && policies.has('host');
    });
    const validations = fetchCall ? guardsFor(fetchCall) : [];
    // A followed redirect re-enters the network with a destination the policy
    // never saw, so each request has to refuse or hand back the 3xx itself.
    // native https does not follow redirects on its own; fetch does.
    const boundsRedirects = urlRequests.length
      && urlRequests.every(request => request.native
        || /redirect\s*:\s*['"](?:manual|error)['"]/.test(request.options));
    // Normalizing before validation is fine; only a change the policy never saw
    // — between the last validation and the request — is a new destination.
    const cleared = fetchCall && validations.filter(v => v.index < fetchCall.index)
      .sort((a, b) => a.index - b.index).pop();
    // A URL object is mutable through any binding that points at it, so
    // `const alias = url; alias.protocol = 'http:'` rewrites the destination
    // the policy cleared. Follow direct aliases before deciding it is unchanged.
    // Declared or later-assigned: `let destination; destination = url` binds the
    // same mutable object as `const alias = url`. Closed to a fixpoint so a
    // chain of aliases is followed however it is ordered.
    const aliases = new Set([url]);
    for (let grew = true; grew;) {
      grew = false;
      for (const binding of t.matchAll(/(?:(?:const|let|var)\s+)?(\w+)\s*=\s*(\w+)\s*[;\n]/g)) {
        if (aliases.has(binding[2]) && !aliases.has(binding[1])) {
          aliases.add(binding[1]);
          grew = true;
        }
      }
    }
    const between = change => change.index > cleared.index && change.index < fetchCall.index;
    // A property write through any of them rewrites the destination the policy
    // cleared; rebinding `url` itself replaces it outright.
    const mutated = cleared && ([...aliases].some(name =>
      [...t.matchAll(new RegExp(String.raw`\b${name}\s*\.\s*\w+\s*=(?!=)`, 'g'))].some(between))
      || [...t.matchAll(new RegExp(String.raw`(?<!(?:const|let|var)\s{1,8})\b${url}\s*=(?!=)`, 'g'))].some(between));
    // ...and every other request must clear its own destination the same way.
    return fetchCall && boundsRedirects && !mutated && cleared && allGuarded
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
    const reads = consumer && t.slice(Math.max(0, consumer.index - 80), consumer.index)
      + consumer.header + consumer.body;
    const timed = [...t.matchAll(/(?:(?:const|let|var)\s+(\w+)\s*=\s*)?(?:await\s+)?\b(fetch|https?\.(?:get|request))\s*\(/g)]
      .filter(request => {
        // Only this call's own arguments, resolved through a local options
        // binding, and only their top level: an unrelated later block is not
        // proof, and `{ headers: { signal: ... } }` hands fetch no signal.
        const call = callAt(t, request.index + request[0].length - 1);
        const options = call ? call.options : '';
        const signalRef = /\bsignal\s*:\s*AbortSignal\.timeout\s*\(/.test(options)
          ? 'inline'
          : (/\bsignal\s*:\s*(\w+)\s*\.\s*signal\b/.exec(options)
            || /\bsignal\s*:\s*(\w+)/.exec(options)
            || /\b(signal)\s*[,}]/.exec(options) || [])[1];
        // The initializer has to run on EVERY way to this request, not sit in an
        // uncalled helper or a branch the request's own path can skip — that
        // leaves `signal` undefined, or the request unarmed, when it fires.
        const armedBefore = pattern => {
          const match = new RegExp(pattern).exec(t);
          return match && match.index < request.index
            && dominates(t, match.index, request.index)
            && !/clearTimeout\s*\(/.test(t.slice(match.index, request.index))
            ? match : null;
        };
        if (signalRef === 'inline') return true;
        if (!signalRef) return false;
        if (armedBefore(String.raw`\b${signalRef}\s*=\s*AbortSignal\.timeout\s*\(`)) return true;
        // A hand-rolled deadline is a resource this function now owns: the
        // timer outlives a download that finishes early, holding the process
        // open and firing a stale abort later. Only a `finally` clears it on
        // success, failure and abort alike — and an unbound handle never can.
        const timer = armedBefore(
          String.raw`(?:(?:const|let|var)\s+(\w+)\s*=\s*)?setTimeout\s*\([\s\S]{0,240}\b${signalRef}\s*\.\s*abort\s*\(`);
        return Boolean(timer && timer[1] && blockRanges(t, /\bfinally\b/g)
          .some(range => new RegExp(String.raw`clearTimeout\s*\(\s*${timer[1]}\s*\)`)
            .test(t.slice(range.open, range.end))));
      });
    let stream = [];
    let nativeRequest = false;
    const requestTimeout = Boolean(reads && timed.some(request => {
      // A local `response` in one function is not the `response` another
      // function reads: an unrelated bounded probe elsewhere in the answer must
      // not lend its deadline to this consumer's own unbounded request.
      if (!sameScope(t, request.index, consumer.index)) return false;
      const names = new Set([request[1]].filter(Boolean));
      // https.get(url, options, response => ...) hands the response to a
      // callback rather than binding it, so take the parameter name too.
      const callback = /,\s*(?:async\s*)?\(?\s*(\w+)\s*\)?\s*=>|,\s*function\s*\(\s*(\w+)/
        .exec(t.slice(request.index, request.index + 240));
      if (callback) names.add(callback[1] || callback[2]);
      for (const binding of t.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*([\w.$]+)/g)) {
        if (names.has(binding[2].split('.')[0]) && sameScope(t, binding.index, consumer.index)) {
          names.add(binding[1]);
        }
      }
      if (![...names].some(name => new RegExp(String.raw`\b${name}\b`).test(reads))) return false;
      stream = [...names];
      nativeRequest = request[2] !== 'fetch';
      return true;
    }));
    // A fetch body is a Web ReadableStream, so `.on('data')`/`.destroy()` on it
    // throws at runtime; evented consumption only exists on a native response.
    const evented = Boolean(consumer && /['"]data['"]/.test(consumer.header));
    if (evented && requestTimeout && !nativeRequest)
      return { pass: false, reason: 'Uses Node stream methods on a Web ReadableStream fetch body.' };
    const chunk = (scope.match(/\{[^}]{0,40}\b(?!done\b)(\w+)\s*\}\s*=\s*await\s+\w+\s*\.\s*read\s*\(/)
      || (consumer && consumer.header.match(/for\s+await\s*\(\s*(?:const|let|var)\s+(\w+)\s+of/))
      || (consumer && consumer.header.match(/['"]data['"]\s*,\s*(?:async\s*)?\(?\s*(\w+)/)) || [])[1];
    // The accumulator has to add THIS chunk's actual size: `+= 0 * n`, `+= -n`
    // and `+= destination.length` all count bytes that never reach the ceiling.
    const counter = chunk
      && scope.match(new RegExp(String.raw`\b([A-Za-z_$]\w*)\s*\+=\s*${chunk}\s*\.\s*(?:byteLength|length)\s*[;\n]`));
    // `received + value.byteLength > MAX` rejects the chunk before it is counted
    // or written, which is the same ceiling one statement earlier.
    // The over-limit comparison has to be the whole condition: conjoined with
    // anything else (`received > MAX && false`, `&& strict`) it no longer
    // guarantees that an oversized response enters the terminating branch.
    const overLimit = counter && new RegExp(
      String.raw`^\s*${counter[1]}\s*(\+\s*${chunk}\s*\.\s*(?:byteLength|length)\s*)?>=?\s*([\w.$]+(?:\s*[*+]\s*[\w.$]+)*)\s*$`, 'i');
    const limitBranch = counter && [...scope.matchAll(/\bif\s*\(/g)]
      .map(match => ({ match, paren: parenAt(scope, match.index) }))
      .filter(branch => branch.paren)
      .map(branch => {
        const comparison = overLimit.exec(branch.paren.inner);
        const body = branchBody(scope, branch.paren.close + 1);
        return comparison && {
          index: branch.match.index,
          end: branch.paren.close + 1 + body.length,
          predictive: Boolean(comparison[1]),
          ceiling: comparison[2].trim(),
          body,
        };
      })
      .find(Boolean);
    const predictive = Boolean(limitBranch && limitBranch.predictive);
    const ceiling = limitBranch && limitBranch.ceiling;
    const finite = Boolean(ceiling) && !/Infinity/.test(ceiling)
      && !(/^[\w.$]+$/.test(ceiling)
        && new RegExp(String.raw`\b${ceiling}\s*=\s*(?:Infinity|Number\s*\.\s*(?:MAX_VALUE|MAX_SAFE_INTEGER|POSITIVE_INFINITY))`).test(t));
    // `return` exits one data callback but leaves an evented stream flowing, so
    // the over-limit path has to tear the stream down too.
    // The chunk has to be counted before it is judged, or the last oversized one
    // slips through and the stream ends without ever tripping the limit.
    // An oversized response is a failure, not a short file: a bare `return`
    // resolves with a truncated download. Evented streams fail by destroy(err).
    // ...and the teardown has to run on every path through that branch: an
    // `if (strict) throw` inside it still writes the oversized chunk otherwise.
    const stops = limitBranch && finite && (predictive || counter.index < limitBranch.index)
      && (evented
        ? (stream.length > 0
          && alwaysReaches(limitBranch.body,
            new RegExp(String.raw`\b(?:${stream.join('|')})[\w.$]*\s*\.\s*(?:destroy|abort|cancel)\s*\(\s*new\s+\w*Error`)))
        : alwaysReaches(limitBranch.body, /\bthrow\b|(?<![.\w])reject\s*\(/));
    // The write has to be of the chunk just counted, and only after the guard:
    // an unrelated log write past the branch is not the destination write.
    const writesChunk = chunk && new RegExp(String.raw`write\w*\s*\([^)]*\b${chunk}\b`);
    const writeAfterLimit = stops && writesChunk
      && writesChunk.test(scope.slice(limitBranch.end))
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
