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
      // A template literal legally spans lines here too: ending it at the
      // newline exposes a later `https://...` as a comment and eats the line.
      while (j < code.length && code[j] !== quote
        && (quote === '`' || code[j] !== '\n')) j += code[j] === '\\' ? 2 : 1;
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

// Brace-balanced, so a nested object or block inside the handler does not
// truncate the body before the cleanup and settlement calls that follow it —
// and paren-balanced, so a defaulted parameter does not hide the handler.
function namedFunctionBodies(text) {
  const bodyAfterParams = (name, from) => {
    let cursor = from;
    if (/^\s*\(/.test(text.slice(cursor))) {
      const paren = parenAt(text, cursor);
      if (!paren) return null;
      cursor = paren.close + 1;
    } else {
      const word = /^\s*\w+/.exec(text.slice(cursor));
      if (!word) return null;
      cursor += word[0].length;
    }
    return { name, cursor };
  };
  const arrows = [...text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?/g)]
    .map(match => bodyAfterParams(match[1], match.index + match[0].length))
    .filter(entry => entry && /^\s*=>/.test(text.slice(entry.cursor)))
    .map(entry => {
      const arrow = text.indexOf('=>', entry.cursor) + 2;
      // An expression body is a body: `value => (cleanup(), resolve(value))`
      // owns its lifecycle exactly as a braced one does.
      if (/^\s*\{/.test(text.slice(arrow))) return { name: entry.name, body: blockAt(text, arrow) };
      const paren = /^\s*\(/.test(text.slice(arrow)) ? parenAt(text, arrow) : null;
      return {
        name: entry.name,
        body: paren ? text.slice(paren.open, paren.close + 1) : text.slice(arrow).split('\n')[0],
      };
    });
  const declarations = [...text.matchAll(/function\s+(\w+)\s*/g)]
    .map(match => bodyAfterParams(match[1], match.index + match[0].length))
    .filter(entry => entry && /^\s*\{/.test(text.slice(entry.cursor)))
    .map(entry => ({ name: entry.name, body: blockAt(text, entry.cursor) }));
  return [...arrows, ...declarations];
}

// The text with every string literal's contents blanked, preserving length.
// All structural scanning runs over this: a brace or paren inside a message —
// `throw new Error("bad {")` — must not unbalance the block that contains it.
function masked(text) {
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    const quote = chars[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      // A template literal legally spans lines; a quoted string does not, so
      // only backticks stay open past a newline.
      let j = i + 1;
      while (j < chars.length && chars[j] !== quote && (quote === '`' || chars[j] !== '\n')) {
        const step = chars[j] === '\\' ? 2 : 1;
        for (let k = j; k < Math.min(j + step, chars.length); k += 1) chars[k] = ' ';
        j += step;
      }
      i = j + 1;
    } else i += 1;
  }
  return chars.join('');
}

// The `{...}` starting at or after `from`, brace-balanced so nested option
// objects and inner blocks stay inside it.
function blockAt(text, from) {
  const scan = masked(text);
  const open = scan.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < scan.length; i++) {
    if (scan[i] === '{') depth += 1;
    else if (scan[i] === '}' && (depth -= 1) === 0) return text.slice(open, i + 1);
  }
  return '';
}

// The `(...)` starting at or after `from`, paren-balanced, so an argument list
// or an `if` condition survives nested calls, newlines and missing semicolons.
function parenAt(text, from) {
  const scan = masked(text);
  const open = scan.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < scan.length; i += 1) {
    if (scan[i] === '(') depth += 1;
    else if (scan[i] === ')' && (depth -= 1) === 0) {
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

// Conditions a compiler would fold away.
function alwaysFalse(condition) {
  const text = String(condition || '').trim();
  return /^(?:false|0|!\s*true|!\s*1|1\s*===?\s*0|0\s*===?\s*1)$/.test(text)
    || (text.includes('&&') && text.split('&&').some(part => alwaysFalse(part)));
}

function alwaysTrue(condition) {
  return /^\s*(?:true|1|!\s*false|!\s*0)\s*$/.test(String(condition || ''));
}

// The spans no execution can enter: a constant-false body, and the `else` of a
// constant-true one.
function deadRanges(text) {
  const ranges = [];
  for (const branch of branches(text)) {
    if (alwaysFalse(branch.condition)) ranges.push({ start: branch.start, end: branch.end });
    if (!alwaysTrue(branch.condition)) continue;
    const otherwise = /^\s*else\b/.exec(text.slice(branch.end));
    if (!otherwise) continue;
    const body = branchBody(text, branch.end + otherwise[0].length);
    const start = text.indexOf(body, branch.end + otherwise[0].length);
    ranges.push({ start, end: start + body.length });
  }
  return ranges;
}

function reachableAt(text, index) {
  return !deadRanges(text).some(range => index >= range.start && index <= range.end);
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
  if (!hit || !dominates(body, hit.index, body.length)) return false;
  // ...and nothing leaves before it. `if (ignore) return; resolve(value)` never
  // resolves on the ignore path, and an unconditional exit makes it dead code.
  return ![...body.matchAll(/(?<![.\w])(?:return|throw|break|continue)\b/g)]
    .some(exit => exit.index < hit.index && sameScope(body, exit.index, hit.index));
}

// An object literal's own properties, with nested objects blanked out: a
// `signal` inside `headers` is not the request's own signal.
function topLevelOf(block) {
  const text = String(block || '');
  const scan = masked(text);
  const chars = [...text];
  let depth = 0;
  for (let i = 0; i < scan.length; i += 1) {
    const opens = scan[i] === '{';
    const closes = scan[i] === '}';
    if (opens) depth += 1;
    if (depth > 1) chars[i] = ' ';
    if (closes) depth -= 1;
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
  return blockRanges(text, /\btry\b/g).every(range => {
    if (index < range.open || index > range.end) return true;
    if (!/^\s*catch\b/.test(text.slice(range.end))) return true;
    // A catch that rethrows is not a swallow — but only when it rethrows on
    // every path: `catch (error) { if (debug) throw error; }` still swallows.
    return alwaysReaches(blockAt(text, range.end), /\bthrow\b|(?<![.\w])reject\s*\(/);
  });
}

// A call's arguments, split on its own top-level commas.
function splitArgs(inner) {
  const scan = masked(inner);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < scan.length; i += 1) {
    if ('([{'.includes(scan[i])) depth += 1;
    else if (')]}'.includes(scan[i])) depth -= 1;
    else if (scan[i] === ',' && depth === 0) {
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
    // The binding this call actually sees: declared before it and visible on
    // its path. A later helper's own `const options = {...}` is not this one.
    const binding = [...text.matchAll(new RegExp(String.raw`(?:const|let|var)\s+${second}\s*=\s*\{`, 'g'))]
      .filter(match => match.index < paren.open && dominates(text, match.index, paren.open))
      .pop();
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
  // A ternary can skip the statement; `?.` and `??` cannot — reading them as a
  // branch would fail ordinary optional-chaining code for its punctuation.
  return inside(blockRanges(text, SKIPPABLE), index, target)
    && !/\bif\s*\(|(?<!\?)\?(?![.?])/.test(statement);
}

// True when nothing but a function body containing `target` also contains
// `index` — i.e. the two are on the same execution path, not stranded in an
// uncalled helper.
function sameScope(text, index, target) {
  return inside(blockRanges(text, FUNCTIONS), index, target);
}

// The loop or listener that actually consumes the response stream. Counting
// bytes in a later pass over a buffered array is not a ceiling.
function streamConsumer(text, within) {
  const inside = index => !within || (index > within.open && index < within.end);
  // Paren-balanced headers, so `for await (const chunk of response.body.values())`
  // is not cut short at the iterable's own closing paren.
  const braced = [...text.matchAll(/\bwhile\s*(?=\()|\bfor\s+await\s*(?=\()/g)]
    .map(match => {
      const paren = parenAt(text, match.index + match[0].length);
      if (!paren || !/^\s*\{/.test(text.slice(paren.close + 1))) return null;
      return {
        index: match.index,
        header: text.slice(match.index, paren.close + 1),
        body: blockAt(text, paren.close + 1),
      };
    })
    .filter(Boolean)
    .filter(loop => inside(loop.index) && reachableAt(text, loop.index));
  const evented = [...text.matchAll(/\.on\s*\(\s*['"]data['"]\s*,[^{]{0,60}\{/g)]
    .filter(match => inside(match.index) && reachableAt(text, match.index))
    .map(match => ({
      index: match.index,
      header: match[0],
      body: blockAt(text, match.index + match[0].length - 1),
    }));
  return [...braced, ...evented]
    .sort((a, b) => a.index - b.index)
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
    // Paren-balanced, so an earlier default containing a call does not hide the
    // coefficient after it: `def read_c(channel=pick(), beta=3950)`.
    const signatures = [...code.matchAll(/(?:def|function)\s+(\w+)\s*(?=\()/g)]
      .map(match => {
        const paren = parenAt(code, match.index + match[0].length);
        return paren && { name: match[1], params: paren.inner };
      })
      .filter(Boolean);
    const bodyOfName = name => {
      const at = new RegExp(String.raw`(?:def|function)\s+${name}\s*\(`).exec(code);
      if (!at) return '';
      return at[0].startsWith('function') ? blockAt(code, at.index) : suiteAt(code, at.index);
    };
    // ...and it has to be on the path the task asked for. A parameter on a
    // helper the reader never calls calibrates nothing.
    const reader = signatures.find(signature => /read|temp|celsius|thermistor|sensor/i.test(signature.name))
      || signatures[0];
    const readerBody = reader ? bodyOfName(reader.name) : '';
    const readerAt = readerBody ? code.indexOf(readerBody) : -1;
    // A knob only calibrates if the reading uses it: an unreachable or unused
    // `beta = os.getenv("BETA", 3950)` appended to an ideal conversion is not
    // a control, it is decoration.
    const usedByReading = binding => {
      const local = binding.index - readerAt;
      const inReader = readerAt >= 0 && local >= 0 && local < readerBody.length;
      const moduleLevel = code[code.lastIndexOf('\n', binding.index) + 1] === binding[1][0];
      if (!inReader && !moduleLevel) return false;
      const result = returnedBy(readerBody);
      if (!result || !new RegExp(String.raw`\b${binding[1]}\b`).test(result.text)) return false;
      return !inReader || dominates(readerBody, local, result.index);
    };
    const onPath = signature => !reader || signature.name === reader.name
      || resultTokens(reader.name).has(signature.name);
    // ...and the reading has to use it: `def read_temperature(beta=3950):
    // return 25.0` exposes a parameter that changes nothing.
    // The return expression, however it is formatted: `return (` on its own
    // line still owns everything up to its closing paren.
    const returnedBy = body => {
      const at = /\breturn\b/.exec(body);
      if (!at) return null;
      let text = '';
      let depth = 0;
      for (const line of body.slice(at.index + 'return'.length).split('\n')) {
        text += `${line}\n`;
        depth += (line.match(/[([{]/g) || []).length - (line.match(/[)\]}]/g) || []).length;
        if (depth <= 0) break;
      }
      return { text, index: at.index };
    };
    // Everything the reading's value actually depends on, followed through
    // local bindings. A helper mentioned after the return, or one whose result
    // is discarded, never reaches it.
    const resultTokens = owner => {
      const body = bodyOfName(owner);
      const result = returnedBy(body);
      if (!result) return new Set();
      const used = new Set(result.text.match(/[A-Za-z_]\w*/g) || []);
      for (let hop = 0; hop < 3; hop += 1) {
        for (const binding of body.matchAll(/\b([A-Za-z_]\w*)\s*=\s*([^\n;]+)/g)) {
          // A binding after the return never reaches it.
          if (binding.index > result.index) continue;
          if (used.has(binding[1])) (binding[2].match(/[A-Za-z_]\w*/g) || []).forEach(token => used.add(token));
        }
      }
      return used;
    };
    const consumedByResult = (owner, name) => resultTokens(owner).has(name);
    const tunable = signatures.filter(onPath)
      .flatMap(signature => [...signature.params.matchAll(/(\w+)\s*=/g)]
        .map(parameter => ({ name: parameter[1], owner: signature.name })))
      .some(parameter => knob.test(parameter.name)
        && consumedByResult(parameter.owner, parameter.name))
      || [...code.matchAll(/\b([A-Za-z_]\w*)\s*=\s*([^\n;]+)/g)]
        .some(binding => knob.test(binding[1])
          && /environ|getenv|process\.env|\bconfig\b|argparse|args\.|settings\./i.test(binding[2])
          // ...and the binding itself has to be reachable from the reader:
          // inside it, or module-level and referenced by it. The same name
          // read from the environment in an uncalled helper calibrates nothing.
          && (!reader || usedByReading(binding)));
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
    const markers = /pytest\.raises\s*\(|assertRaises\s*\(|assert\.throws\s*\(|toThrow\s*\(|expect\([^\n]*\)\.rejects|assert\s+(?:await\s+)?(?:rejects?|raises?|throws?)\s*\([^)\n]+\)|try\s*:[\s\S]{0,200}\w+\s*\([^)\n]*\)[\s\S]{0,120}(?:\bassert\s+False\b|raise\s+AssertionError)[\s\S]{0,160}except\s+(?!Exception\b|BaseException\b)[\w(]|try\s*:[\s\S]{0,300}\w+\s*\([^)]*\)[\s\S]{0,240}except\b[\s\S]{0,160}else\s*:[\s\S]{0,120}(?:assert\s+False|raise\s+AssertionError)/gi;
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
    // ...and the value under test has to reach the parser. A helper that calls
    // the parser with its own literal proves nothing about the argument the
    // check handed in, so its parameter has to flow into the subject call.
    const forwards = name => {
      const at = new RegExp(String.raw`(?:def|function)\s+${name}\s*\(`).exec(t);
      if (!at) return false;
      const params = parenAt(t, at.index + at[0].length - 1);
      const body = at[0].startsWith('function') ? blockAt(t, at.index) : suiteAt(t, at.index);
      const call = new RegExp(String.raw`(?<!def\s|function\s)\b${subject}\s*\(([^)]*)\)`).exec(body);
      if (!params || !call) return false;
      // ...as the argument itself: `parse(false ? value : '1h')` mentions the
      // parameter but always hands the parser the literal.
      const passed = splitArgs(call[1]);
      return splitArgs(params.inner)
        .map(part => part.split(/[=:]/)[0].trim())
        .filter(Boolean)
        .some(parameter => passed.includes(parameter));
    };
    const reaching = scope => [...scope.matchAll(/\b(\w+)\s*\(([^)]*)\)/g)]
      .filter(call => call[1] === subject || forwards(call[1]))
      .map(call => call[2].trim())
      .filter(Boolean);
    // '1h30m45s' is the task's own valid example: rejecting it is the bug, not
    // the check. The input under test has to be malformed or half-parsed.
    const wellFormed = /^['"]\s*(?:\d+\s*[hms])+\s*['"]$/i;
    // ...whatever it is spelled as: `valid = '1h'` then `parse(valid)` is the
    // task's own example, not an alternate path.
    const literalOf = argument => {
      if (/^['"]/.test(argument)) return argument;
      const bound = new RegExp(String.raw`\b${argument}\s*=\s*(['"][^'"]*['"])`).exec(t);
      return bound ? bound[1] : argument;
    };
    // A check inside `def unused():` is never executed by running or by test
    // discovery, so it is not a check that was left behind.
    const runs = index => {
      const lineStart = t.lastIndexOf('\n', index) + 1;
      const indent = t.slice(lineStart).search(/\S/);
      if (indent <= 0) return true;
      // `if not True`, `if 1 == 0` and `if False or False` are all dead too.
      const never = condition => condition.split(/\bor\b/).every(part => part.split(/\band\b/)
        .some(operand => /^\s*(?:False|0|None|not\s+True|1\s*==\s*0|0\s*==\s*1)\s*$/.test(operand)));
      const owner = [...t.slice(0, lineStart)
        .matchAll(/^([ \t]*)(?:def\s+(\w+)\s*\(|(?:if|while)\s+([^:\n]+):)/gm)]
        .map(match => (match[3] !== undefined && !never(match[3]) ? null : match))
        .filter(Boolean)
        .reverse().find(match => match[1].length < indent);
      if (!owner) return true;
      if (owner[3]) return false;
      // A call inside the helper's own suite is recursion: execution still has
      // no way in, so the check it contains never runs.
      const ownerEnd = owner.index + suiteAt(t, owner.index).length;
      return /^test_/.test(owner[2]) || owner[2] === 'main'
        || [...t.matchAll(new RegExp(String.raw`\b${owner[2]}\s*\(`, 'g'))]
          .some(call => call.index < owner.index || call.index > ownerEnd);
    };
    // ...and so does the sentinel inside it: `if False: raise AssertionError`
    // completes without failing however the parser behaves.
    const sentinelOf = match => /\bassert\s+False\b|raise\s+AssertionError/.exec(match[0]);
    const checksFailure = Boolean(subject) && [...t.matchAll(markers)].some(match => runs(match.index)
      && (!sentinelOf(match) || runs(match.index + sentinelOf(match).index))
      && reaching(`${match[0]}\n${suiteAt(t, match.index)}`).some(arg => !wellFormed.test(literalOf(arg))));
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
      // `current = {}` before the merge empties what the spread preserves.
      const overwritten = new RegExp(String.raw`\b(?:${match[2]}|${match[3]})\s*=(?!=)`, 'g');
      if ([...body.matchAll(overwritten)].some(reset => reset.index < merge.index)) return false;
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
        return !new RegExp(String.raw`^\s*(?:!\s*${match[3]}\b|${match[3]}\s*(?:==|===)\s*(?:null|undefined)|!\s*Object\s*\.\s*keys\s*\(\s*${match[3]}\s*\)\s*\.\s*length|Object\s*\.\s*keys\s*\(\s*${match[3]}\s*\)\s*\.\s*length\s*===?\s*0)\s*$`)
          .test(condition);
      });
    });
    const name = updater && updater[1];
    // A check parked inside a helper nobody calls never runs. Top level, a test
    // entry point, or a function the answer actually invokes.
    // Paren-balanced like every other block scan, so a helper cannot hide an
    // unreachable check behind a defaulted parameter.
    const runs = index => {
      // `if (false) { ... }` never executes, so nothing inside it is evidence.
      if (!reachableAt(t, index)) return false;
      return blockRanges(t, FUNCTIONS).every(range => {
        const head = t.slice(Math.max(0, range.open - 200), range.open);
        const declared = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=)[^;{]*$/.exec(head);
        const naming = declared && (declared[1] || declared[2]);
        const declaredAt = declared ? range.open - (head.length - declared.index) : range.open;
        // A call inside the function's own body is recursion, not an entry:
        // execution has to be able to get in from somewhere else first.
        const called = naming && [...t.matchAll(new RegExp(String.raw`\b${naming}\s*\(`, 'g'))]
          .some(call => call.index < declaredAt || call.index > range.end);
        const entry = /\b(?:test|it|describe|main)\s*\([\s\S]{0,160}$/.test(head);
        return called || entry || index < range.open || index > range.end;
      });
    };
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
    // A fixture stored in a variable is the same fixture: resolve simple object
    // bindings so `const patch = {...}; updateSettings(current, patch)` counts.
    const resolveFixtures = text => splitArgs(String(text || '').replace(/^\(|\)$/g, ''))
      .map(argument => {
        if (argument.startsWith('{')) return argument;
        if (!/^\w+$/.test(argument)) return argument;
        const binding = new RegExp(String.raw`(?:const|let|var)\s+${argument}\s*=\s*\{`).exec(t);
        return binding ? blockAt(t, binding.index) : argument;
      })
      .join(', ');
    const args = resolveFixtures(inlineCall ? structural[2] : assigned && assigned[2]);
    // The falsy values have to be in the patch: that is the argument whose
    // explicit false/0/"" must override truthy existing settings.
    const patch = args && (args.match(/,\s*(\{[\s\S]*\})\s*\)?\s*$/) || [])[1];
    // Which key carries which falsy value matters: asserting that some other
    // field is still `false` would not fail if the updater stopped applying
    // the patch's own explicit `false`, so the check has to name that key.
    const entries = [...String(patch || '').matchAll(/["']?(\w+)["']?\s*:\s*([^,}]+)/g)]
      .map(entry => ({ key: entry[1], value: entry[2].trim() }));
    const kinds = [
      entry => entry.value === 'false',
      entry => /^0$/.test(entry.value),
      entry => /^(?:''|"")$/.test(entry.value),
    ];
    const valueOf = entry => (/^(?:''|"")$/.test(entry.value) ? String.raw`(?:''|"")` : entry.value);
    const falsyPatch = Boolean(patch) && kinds.every(kind => entries.some(kind));
    // Only what runs after the result exists: an assertion placed above the
    // call dies on a ReferenceError without ever reaching the updater.
    // ...and each of them has to run: four assertions inside `if (false)` are
    // no more a regression check than a commented-out one.
    const base = assigned ? assigned.index : 0;
    const lines = [];
    let offset = 0;
    for (const line of (assigned ? t.slice(base) : t).split('\n')) {
      const found = line.match(/(?:console\.)?assert\b.*|\bexpect\(.*|\bit\(.*/);
      if (found && runs(base + offset + line.indexOf(found[0]))) lines.push(found[0]);
      offset += line.length + 1;
    }
    const assertions = lines.join('\n');
    // Infix comparison or a standard assert.equal(result.field, value) call.
    // The call form has to be an equality assertion: `assert.notEqual(result.sound,
    // false)` demands the opposite value and fails against a correct updater.
    // Bare `assert(value, message)` takes a message second, not an expected
    // value, so it is not an equality API however it reads.
    const equality = String.raw`(?<![\w$])(?:equal|strictEqual|deepEqual|deepStrictEqual|toBe|toEqual|toStrictEqual)`;
    // The comparison has to decide the assertion. Conjoined with others it
    // still does; disjoined — `assert(true || result.x === false)` — it never
    // fails, whatever the value turns out to be.
    const decides = entry => {
      const comparison = new RegExp(
        String.raw`${assigned[1]}\s*\.\s*${entry.key}\s*===?\s*${valueOf(entry)}`);
      return [...assertions.matchAll(/(?:console\.)?assert\s*(?=\()/g)]
        .map(match => (parenAt(assertions, match.index + match[0].length) || { inner: '' }).inner)
        .some(argument => !argument.includes('||') && comparison.test(argument))
        || new RegExp(
          String.raw`${equality}\s*\(\s*${assigned[1]}\s*\.\s*${entry.key}\s*,\s*${valueOf(entry)}\s*[,)]`
          + String.raw`|expect\s*\(\s*${assigned[1]}\s*\.\s*${entry.key}\s*\)\s*\.\s*to\w*\s*\(\s*${valueOf(entry)}\s*\)`)
          .test(assertions);
    };
    const perField = Boolean(assigned)
      && kinds.every(kind => entries.filter(kind).some(entry => decides(entry)));
    const expected = onResult ? structural[3] : '';
    const checksFalsy = perField
      || (onResult && kinds.every(kind => entries.filter(kind)
        .some(entry => new RegExp(String.raw`["']?\b${entry.key}\b["']?\s*:\s*${valueOf(entry)}`).test(expected))));
    // "without resetting existing settings" is half the contract: the check has
    // to prove a setting the patch never mentions is still there afterwards.
    // JSON-style quoted keys are ordinary object keys.
    const keysOf = object => [...String(object || '').matchAll(/["']?(\w+)["']?\s*:/g)].map(match => match[1]);
    const untouched = keysOf(args && (args.match(/\(?\s*(\{[\s\S]*?\})\s*,/) || [])[1])
      .filter(key => !keysOf(patch).includes(key));
    const checksPreserved = untouched.some(key => new RegExp(String.raw`["']?\b${key}\b["']?\s*:`).test(expected)
      || new RegExp(String.raw`\.${key}\b`).test(assertions));
    return updater && falsyPatch && checksFalsy && checksPreserved
      && (inlineCall || !assigned || runs(assigned.index))
      && (!onResult || (runs(structural.index)
        && (inlineCall || !assigned || structural.index > assigned.index)))
      ? { pass: true, reason: 'Preserves existing state and checks explicit falsy values.' }
      : { pass: false, reason: 'Does not prove state and explicit false/zero/empty values survive.' };
  },

  // Cancellation must remove every listener it installed, not just reject.
  lifecycle(output) {
    const whole = codeOf(output);
    // Everything below is graded inside waitForDownload itself: a guard in some
    // other helper does not protect the listeners this function installs.
    const implAt = /(?:function\s+waitForDownload\s*\(|(?:const|let|var)\s+waitForDownload\s*=)/.exec(whole);
    // An expression-bodied arrow has no block of its own, so the first `{` in
    // the file belongs to something else — usually its own options object.
    const arrowAt = implAt ? whole.indexOf('=>', implAt.index) : -1;
    const braceAt = implAt ? whole.indexOf('{', implAt.index) : -1;
    const expressionBodied = arrowAt >= 0 && (braceAt < 0 || arrowAt < braceAt)
      && !/^\s*\{/.test(whole.slice(arrowAt + 2));
    const implEnd = () => {
      if (expressionBodied) {
        const line = whole.indexOf('\n', arrowAt);
        return line < 0 ? whole.length : line;
      }
      return braceAt >= 0 ? braceAt + blockAt(whole, braceAt).length : whole.length;
    };
    const t = implAt ? whole.slice(implAt.index, implEnd()) : whole;
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
    // Exactly: `{ signal: signal && other }` starts with the right name and
    // hands the helper a different signal at runtime.
    const signalOption = signalParam === 'signal'
      ? String.raw`\bsignal\s*(?:[,}]|:\s*signal\s*[,}])`
      : String.raw`\bsignal\s*:\s*${signalParam}\s*[,}]`;
    // ...on every path: `if (useNative) return once(...)` leaves the fallback
    // branch leaking, so the delegation has to be the implementation.
    // ...and the helper's result has to be the function's result: a bare
    // `await once(...)` cancels correctly but resolves to undefined instead of
    // the download event the caller asked for.
    // Scanned over the whole answer: an expression-bodied arrow has no braces
    // for the implementation slice to end at, so its call would be cut in half.
    // Scoped to this implementation: a sibling helper that delegates correctly
    // does not stop waitForDownload from leaking its own listener.
    const delegateAt = onceName && !shim
      && new RegExp(String.raw`(?:return\s+(?:await\s+)?|=>\s*(?:await\s+)?)${onceName}\s*(?=\()`).exec(t);
    const delegateArgs = delegateAt && parenAt(t, delegateAt.index + delegateAt[0].length);
    // The options may be written inline or held by a binding, as they may be
    // at any other call site.
    const optionsOf = argument => {
      if (!argument) return '';
      if (argument.startsWith('{')) return argument;
      if (!/^\w+$/.test(argument)) return '';
      // The binding visible at the call: declared before it and on its path.
      const binding = [...t.matchAll(new RegExp(String.raw`(?:const|let|var)\s+${argument}\s*=\s*\{`, 'g'))]
        .filter(match => match.index < delegateAt.index && dominates(t, match.index, delegateAt.index))
        .pop();
      return binding ? blockAt(t, binding.index) : '';
    };
    const delegated = delegateArgs && splitArgs(delegateArgs.inner);
    const delegates = delegated
      && delegated[0] === emitterParam
      && /^['"]download['"]$/.test(delegated[1] || '')
      && new RegExp(signalOption).test(optionsOf(delegated[2]))
      ? delegateAt : null;
    // ...on every path out of the function that delegates, not of the file.
    // ...on this function's own return path. A nested helper that delegates
    // perfectly still leaves waitForDownload returning undefined.
    const bodies = blockRanges(t, FUNCTIONS)
      .sort((first, second) => (second.end - second.open) - (first.end - first.open));
    const outer = bodies[0];
    const buried = delegates && bodies.slice(1)
      .some(range => delegates.index > range.open && delegates.index < range.end);
    // An arrow delegation only counts when the arrow is waitForDownload's own:
    // `const helper = () => once(...)` inside it returns to nobody.
    const arrowForm = delegates && /^\s*=>/.test(delegates[0]);
    const ownArrow = !arrowForm || (expressionBodied
      && delegates.index + delegates[0].indexOf('=>') === arrowAt - implAt.index);
    if (delegates && !buried && ownArrow
      && dominates(t, delegates.index, outer ? outer.end - 1 : t.length))
      return { pass: true, reason: 'Delegates the whole lifecycle to the abort-aware events.once helper.' };
    // An already-aborted signal never fires `abort`, so the guard has to run
    // before any listener is installed or the setup leaks both of them.
    // ...and the branch has to leave: rejecting without returning still falls
    // through and installs both listeners on an already-aborted signal.
    // `{ return reject(reason); }` is the same early exit as the unbraced form.
    // ...and it has to leave on EVERY path through the guard: rejecting without
    // returning falls through, and `if (strict) return reject(...)` nested
    // inside it falls through on the other branch, installing both listeners.
    const settlesEveryPath = body => alwaysReaches(body, /\bthrow\b/)
      || alwaysReaches(body, /return\s+Promise\s*\.\s*reject\s*\(|return\s+(?<![.\w])reject\s*\(/)
      || (alwaysReaches(body, /(?<![.\w])reject\s*\(/) && alwaysReaches(body, /(?<![.\w])return\b/));
    const firstListener = /addEventListener\s*\(\s*['"]abort['"]|\.(?:once|on|addListener)\s*\(\s*['"]download['"]/.exec(t);
    // ...on the executor's own path: a guard inside an uncalled nested helper
    // never runs, and both listeners are installed anyway.
    const abortBranch = branches(t).find(branch =>
      new RegExp(String.raw`^\s*${signalParam}\s*\??\.\s*aborted\s*$`).test(branch.condition)
      && (!firstListener || sameScope(t, branch.index, firstListener.index)));
    // ...on every path to the listeners: `if (strict) signal.throwIfAborted()`
    // installs both of them whenever `strict` is false.
    const throwsIfAbortedAt = new RegExp(String.raw`${signalParam}\s*\.\s*throwIfAborted\s*\(|throwIfAborted\s*\(\s*${signalParam}`).exec(t);
    const throwIfAborted = throwsIfAbortedAt && firstListener
      && dominates(t, throwsIfAbortedAt.index, firstListener.index) ? throwsIfAbortedAt : null;
    const settled = abortBranch && settlesEveryPath(abortBranch.body)
      ? { index: abortBranch.index, text: abortBranch.body } : null;
    // Returning an already-rejected promise is a valid termination — but only
    // outside the executor, where the return value is actually the result.
    const executorAt = t.search(/new\s+Promise\s*\(/);
    const onlyReturnsRejected = settled
      && /return\s+Promise\s*\.\s*reject\s*\(/.test(settled.text)
      && !/\bthrow\b|return\s+(?<![.\w])reject\s*\(/.test(settled.text);
    const guarded = settled && (!onlyReturnsRejected || executorAt < 0 || settled.index < executorAt)
      ? settled : null;
    const guard = throwIfAborted
      ? { index: throwIfAborted.index, text: throwIfAborted[0] }
      : guarded;
    // A guard that throws keeps the promise contract only inside the executor,
    // where the throw becomes a rejection, or in an async function. Thrown
    // synchronously from a plain function it bypasses the caller's `.catch`
    // on exactly the cancellation path under test.
    // ...and a throw the function catches itself terminates nothing: execution
    // falls through and installs both listeners on an already-aborted signal.
    const isAsync = /async\s+function\s+waitForDownload\b|(?:const|let|var)\s+waitForDownload\s*=\s*async\b/.test(whole);
    const inExecutor = index => executorAt >= 0 && index > executorAt;
    const throws = guard && /throwIfAborted|\bthrow\b/.test(guard.text);
    const keepsContract = Boolean(guard
      && (!throws || ((isAsync || inExecutor(guard.index)) && escapesCatch(t, guard.index))));
    const terminates = keepsContract ? guard : null;
    const preAborted = Boolean(terminates && firstListener && terminates.index < firstListener.index);
    const handlers = namedFunctionBodies(t);
    // Which callback is the abort handler is decided by what was registered for
    // 'abort', not by whether its name happens to say so.
    // ...and on the objects the caller handed in: listening to some other
    // emitter means the supplied one never settles this promise.
    const aborts = new RegExp(String.raw`(${signalParam})\s*\.\s*addEventListener\s*\(\s*['"]abort['"]\s*,\s*(\w+)`).exec(t);
    const ownsDownload = new RegExp(String.raw`(${emitterParam})\s*\.\s*(?:once|on|addListener)\s*\(\s*['"]download['"]\s*,\s*(\w+)`).exec(t);
    // Promise.reject() inside the handler settles nothing: the outer promise
    // stays pending, so it has to be the executor's own reject callback.
    // ...and it has to run unconditionally: `if (false) reject(reason)` leaves
    // the promise pending on the one path that matters.
    // Splitting on `;` loses the branch that governs the fragments after it, so
    // `cleanup(); if (strict) { reject(reason); }` would read as settling.
    const settles = (body, call) =>
      alwaysReaches(body, new RegExp(String.raw`(?<![.\w])${call}\s*\(`));
    const abortHandler = aborts && handlers.find(handler => handler.name === aborts[2] && settles(handler.body, 'reject'));
    const downloadHandler = ownsDownload && handlers.find(handler => handler.name === ownsDownload[2] && settles(handler.body, 'resolve'));
    // Cleanup has to run on every settlement path, not behind `if (owned)`.
    const callsCleanup = (body, cleanup) =>
      alwaysReaches(body, new RegExp(String.raw`(?<![.\w])${cleanup}\s*\(\s*\)`));
    const cleanupName = abortHandler && downloadHandler
      && [...abortHandler.body.matchAll(/\b(\w+)\s*\(\s*\)/g)]
        .map(match => match[1])
        .find(name => callsCleanup(abortHandler.body, name) && callsCleanup(downloadHandler.body, name));
    const cleanupHandler = cleanupName && handlers.find(handler => handler.name === cleanupName);
    // A cleanup that removes both listeners and then throws leaves the promise
    // pending, however faithfully each handler calls it.
    const cleanupEscapes = cleanupHandler && alwaysReaches(cleanupHandler.body, /\bthrow\b/);
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
    // ...every one of them: an extra `emitter.on('download', audit)` beside the
    // cleaned-up handler leaks just as surely.
    const installedHandlers = [
      ...[...t.matchAll(new RegExp(String.raw`(${emitterParam})\s*\.\s*(?:once|on|addListener)\s*\(\s*['"]download['"]\s*,\s*(\w+)`, 'g'))]
        .map(match => ({ remove: String.raw`${match[1]}\s*\.\s*(?:off|removeListener)\s*\(\s*['"]download['"]\s*,\s*${match[2]}\b` })),
      ...[...t.matchAll(new RegExp(String.raw`(${signalParam})\s*\.\s*addEventListener\s*\(\s*['"]abort['"]\s*,\s*(\w+)`, 'g'))]
        .map(match => ({ remove: String.raw`${match[1]}\s*\.\s*removeEventListener\s*\(\s*['"]abort['"]\s*,\s*${match[2]}\b` })),
    ];
    const cleansEvery = cleanupHandler
      && installedHandlers.every(listener => alwaysReaches(cleanupHandler.body, new RegExp(listener.remove)));
    const cleansDownload = cleanupHandler && cleansEvery
      && alwaysReaches(cleanupHandler.body,
        new RegExp(`${ownsDownload[1]}\\s*\\.\\s*(?:off|removeListener)\\s*\\(\\s*['"]download['"]\\s*,\\s*${downloadHandler.name}\\b`));
    return preAborted && cleansAbort && cleansDownload && !cleanupEscapes
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
    // ...and the read has to run first: a `const saved = ...` declared after
    // the URL is built throws in the temporal dead zone, before any validation.
    const readAt = new RegExp(String.raw`\b${source}\s*=\s*(?:await\s+)?(?:JSON\.parse|\w*[Rr]ead\w*|require)\s*\(`).exec(t)
      || new RegExp(String.raw`\{[^}]{0,160}\b${source}\b[^}]{0,160}\}\s*=\s*(?:await\s+)?JSON\.parse`).exec(t);
    const persisted = !/^['"]/.test(parsed[2]) && Boolean(readAt)
      && readAt.index < parsed.index && dominates(t, readAt.index, parsed.index);
    if (!persisted) return fail;
    const rejection = /\bthrow\b|(?<![.\w])reject\s*\(|\breturn\s+false\b/;
    // The two halves of the policy are tracked separately: rejecting http while
    // accepting every https host leaves the destination unrestricted, and an
    // allowlist that still permits http leaves the transport unprotected.
    // Anchored: `!allowedHosts.has(url.hostname) === false` contains the
    // negated call but inverts it, throwing for exactly the allowed hosts.
    const whole = inner => String.raw`^\s*\(*\s*(?:${inner})\s*\)*\s*$`;
    const policyOf = (clause, name) =>
      (new RegExp(whole(String.raw`${name}\.protocol\s*!==\s*['"]https:['"]|!\s*\(\s*${name}\.protocol\s*===?\s*['"]https:['"]\s*\)`), 'i').test(clause) ? 'transport'
        : new RegExp(whole(String.raw`!\s*\(*\s*(?:allowedHosts|allowlist)\s*\.\s*(?:has|includes)\s*\(\s*${name}\.hostname\s*\)\s*\)*`), 'i').test(clause) ? 'host'
          : null);
    // `if (!(https && allowed)) throw` is the same policy written positively:
    // distribute the negation before splitting, or both halves are lost.
    const clausesOf = condition => {
      const trimmed = condition.trim();
      // `!(...)` only — `!allowed.has(url.hostname)` negates a call, not a group.
      const opens = /^!\s*\(/.exec(trimmed);
      if (opens) {
        const paren = parenAt(trimmed, opens[0].length - 1);
        // Only a pure conjunction distributes: `!(a && b || bypass)` lets any
        // URL through whenever `bypass` is true.
        if (paren && paren.close === trimmed.length - 1) {
          return /\|\||\?/.test(paren.inner)
            ? [] : paren.inner.split('&&').map(clause => `!(${clause})`);
        }
      }
      return condition.split('||');
    };
    // Each policy must reject on its own. An `&&` clause only rejects when every
    // condition fails, so an allowed host still reaches the network over http.
    const enforcing = (text, name, terminator = rejection) => branches(text)
      // The rejection has to run on the invalid-input path — not nested behind
      // `if (strict)` — and it has to leave: a `try { ... } catch {}` around
      // the guards, inside or outside them, returns normally to the request.
      .filter(branch => {
        const stop = terminator.exec(branch.body);
        return Boolean(stop && dominates(branch.body, stop.index, branch.body.length)
          && escapesCatch(branch.body, stop.index)
          && escapesCatch(text, branch.start + stop.index));
      })
      .flatMap(branch => clausesOf(branch.condition).map(clause => ({ index: branch.index, clause })))
      .filter(guard => !guard.clause.includes('&&'))
      .map(guard => ({ ...guard, policy: policyOf(guard.clause, name) }))
      .filter(guard => guard.policy);
    // A named validator counts only if its own body rejects on the same policy,
    // with the same polarity an inline guard would need.
    const validates = new RegExp(String.raw`(?:^|[;}\n])\s*((?:await|return)\s+)?((?:validate|assert|ensure|checkNetwork)\w*Url)\s*\(\s*${url}\b`, 'im').exec(t);
    // An async validator that is not awaited only produces a rejected promise:
    // the request fires before the policy has said anything.
    const validatorAsync = validates
      && new RegExp(String.raw`async\s+function\s+${validates[2]}\b|(?:const|let|var)\s+${validates[2]}\s*=\s*async\b`).test(t);
    // `return validateWebhookUrl(url)` leaves the sender, so the POST after it
    // never runs; only an awaited validation continues to the request.
    const validatorSettled = Boolean(validates)
      && (!validatorAsync || /await/.test(validates[1] || ''));
    const definition = validatorSettled
      && new RegExp(String.raw`(?:function\s+${validates[2]}\s*\(\s*(\w+)|(?:const|let|var)\s+${validates[2]}\s*=\s*(?:async\s*)?\(?\s*(\w+))`).exec(t);
    // Only the invoked validator's own body counts — not whatever follows it.
    // And a validator that returns false is ignorable, as these callers do
    // ignore it; requiring it to throw is what actually stops the request.
    const validatorBody = definition ? reachable(blockAt(t, definition.index)) : '';
    // A validator that returns false is ignored by these callers, so each of
    // its policy branches has to terminate on its own.
    const validatorPolicies = definition
      ? new Set(enforcing(validatorBody, definition[1] || definition[2], /\bthrow\b|(?<![.\w])reject\s*\(/)
        .map(guard => guard.policy))
      : new Set();
    const enforcingValidator = Boolean(definition
      && /\bthrow\b|\breject\s*\(/.test(validatorBody)
      && validatorPolicies.size > 0);
    // Every request to the persisted destination has to be guarded, not just the
    // first one: a safe HEAD probe followed by an unguarded POST is a bypass.
    // `fetch(url.href, ...)` is the same destination the policy cleared, so a
    // direct serialisation of the validated URL resolves back to its binding.
    const baseOf = argument => (/^(\w+)$/.exec(argument) || /^(\w+)\s*\.\s*href$/.exec(argument)
      || /^(\w+)\s*\.\s*toString\s*\(\s*\)$/.exec(argument)
      || /^String\s*\(\s*(\w+)\s*\)$/.exec(argument) || [])[1];
    const allCalls = [...t.matchAll(/(?:(?:const|let|var)\s+(\w+)\s*=\s*)?(?:await\s+)?\b(fetch|https?\.(?:request|get))\s*\(/g)]
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
          raw: call.args[0],
          target: baseOf(call.args[0]),
          options: call.options,
        };
      })
      .filter(Boolean);
    // Every destination reached has to be one that was parsed and cleared —
    // including one replayed from a manual redirect's Location header.
    const approved = new Map([...t.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*new URL\s*\(/g)]
      .map(match => [match[1], match.index]));
    // ...but only for requests that cross this boundary. An unrelated
    // `fetch(configUrl)` in a config helper never touches the saved webhook.
    const derived = new Set([url]);
    for (let grew = true; grew;) {
      grew = false;
      const add = name => {
        if (!name || derived.has(name)) return;
        derived.add(name);
        grew = true;
      };
      for (const built of t.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*new URL\s*\(\s*([^)]*)\)/g)) {
        if (/headers\s*\.\s*get\s*\(\s*['"]location['"]/i.test(built[2])
          || derived.has(built[2].split(/[.[]/)[0])) add(built[1]);
      }
      // ...and into a helper that takes it: `sendAgain(url)` puts the persisted
      // destination behind whatever that helper's own request does with it.
      for (const call of t.matchAll(/\b(\w+)\s*\(([^()]*)\)/g)) {
        const passed = splitArgs(call[2]).findIndex(argument => derived.has(baseOf(argument)));
        if (passed < 0) continue;
        const declared = new RegExp(
          String.raw`(?:function\s+${call[1]}\s*|(?:const|let|var)\s+${call[1]}\s*=\s*(?:async\s*)?)(?=\()`).exec(t);
        const signature = declared && parenAt(t, declared.index + declared[0].length);
        const parameter = signature && splitArgs(signature.inner)[passed];
        if (parameter && /^\w+$/.test(parameter)) add(parameter);
      }
    }
    const requests = allCalls.filter(request => derived.has(request.target)
      || new RegExp(String.raw`^${source}\b`).test(String(request.raw || '')));
    // Every destination has to be one the policy could have seen: a parsed URL,
    // a redirect replay, or a parameter one of those was handed to. A raw
    // `fetch(saved.webhook)` was never parsed at all.
    if (requests.some(request => !derived.has(request.target))) return fail;
    // Any destination derived from the persisted webhook, including one a
    // helper received as a parameter.
    const urlRequests = requests;
    // The task is to POST a payload: a guarded GET never performs the operation
    // whose trust boundary this probe is measuring, and an `x-body` header is
    // not a payload — it has to be a real body option or a write on the request.
    // `body: null` and `body: undefined` send nothing at all.
    const payload = (options, at) => {
      const value = (/\bbody\s*:\s*([^,}]+)/.exec(options) || [])[1];
      if (value === undefined) {
        if (!/\bbody\s*[,}]/.test(options)) return false;
        // Scoped to the sender: an unrelated `function other(body = null)`
        // says nothing about the payload this request carries.
        const enclosing = blockRanges(t, FUNCTIONS)
          .filter(range => at > range.open && at < range.end)
          .sort((first, second) => (first.end - first.open) - (second.end - second.open))[0];
        const head = enclosing ? t.slice(Math.max(0, enclosing.open - 200), enclosing.open) : '';
        const declaredAt = /(?:async\s+)?(?:function\s+\w*|(?:const|let|var)\s+\w+\s*=)[^{]*$/.exec(head);
        const from = enclosing && declaredAt
          ? enclosing.open - (head.length - declaredAt.index) : enclosing && enclosing.open;
        const scope = enclosing ? t.slice(from, enclosing.end) : t;
        return !/\bbody\s*=\s*(?:null|undefined)\b/.test(scope);
      }
      if (/^\s*(?:null|undefined)\s*$/.test(value)) return false;
      const bound = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(value);
      return !bound
        || !new RegExp(String.raw`\b${bound[1]}\s*=\s*(?:null|undefined)\s*[;\n]`).test(t);
    };
    const fetchCall = urlRequests.find(request => /method\s*:\s*['"]POST['"]/i.test(request.options)
      && (payload(request.options, request.index)
        // A fetch Response has no `write`: only a native request handle does.
        || (request.native && request.handle && (() => {
          const write = new RegExp(
            String.raw`\b${request.handle}\s*\.\s*(?:write|end)\s*\(\s*\w`).exec(t);
          // ...on the sender's own reachable path, not in an uncalled helper.
          return Boolean(write && write.index > request.index
            && reachableAt(t, write.index) && sameScope(t, write.index, request.index));
        })())));
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
    const lastGuardFor = request => guardsFor(request)
      .filter(guard => guard.index < request.index).sort((a, b) => a.index - b.index).pop();
    // A followed redirect re-enters the network with a destination the policy
    // never saw, so each request has to refuse or hand back the 3xx itself.
    // native https does not follow redirects on its own; fetch does.
    const boundsRedirects = requests.length
      && requests.every(request => request.native
        || /redirect\s*:\s*['"](?:manual|error)['"]/.test(request.options));
    // Normalizing before validation is fine; only a change the policy never saw
    // — between the last validation and the request — is a new destination.
    const cleared = fetchCall && lastGuardFor(fetchCall);
    // A URL object is mutable through any binding that points at it, so
    // `const alias = url; alias.protocol = 'http:'` rewrites the destination
    // the policy cleared. Follow direct aliases before deciding it is unchanged.
    // Declared or later-assigned: `let destination; destination = url` binds the
    // same mutable object as `const alias = url`. Closed to a fixpoint so a
    // chain of aliases is followed however it is ordered.
    const aliases = new Set([url]);
    for (let grew = true; grew;) {
      grew = false;
      for (const binding of t.matchAll(/(?:(?:const|let|var)\s+)?(\w+)\s*=\s*(\w+)\s*[;,\n]/g)) {
        if (aliases.has(binding[2]) && !aliases.has(binding[1])) {
          aliases.add(binding[1]);
          grew = true;
        }
      }
    }
    // A property write through any of them rewrites the destination the policy
    // cleared; rebinding `url` itself replaces it outright. Checked per request:
    // a guarded POST, a mutation, then a second POST reuses the stale guards.
    const mutatedBefore = request => {
      const last = lastGuardFor(request);
      if (!last) return true;
      const between = change => change.index > last.index && change.index < request.index;
      return [...aliases].some(name =>
        [...t.matchAll(new RegExp(
          String.raw`\b${name}\s*(?:\.\s*\w+|\[\s*['"]\w+['"]\s*\])\s*=(?!=)`
          + String.raw`|Object\s*\.\s*assign\s*\(\s*${name}\b`, 'g'))].some(between))
        || [...t.matchAll(new RegExp(String.raw`(?<!(?:const|let|var)\s{1,8})\b${url}\s*=(?!=)`, 'g'))].some(between);
    };
    const mutated = requests.some(mutatedBefore);
    // ...and every other request must clear its own destination the same way.
    return fetchCall && boundsRedirects && !mutated && cleared && allGuarded
      ? { pass: true, reason: 'Revalidates persisted URL against a network policy before use.' }
      : fail;
  },

  // A remote response needs both a deadline and an enforced streaming byte ceiling.
  bounds(output) {
    const t = codeOf(output);
    // A deadline has to be a number that can actually elapse: absent, Infinity
    // or a constant bound to Infinity is no deadline at all.
    const finiteDeadline = (value, seen = new Set()) => {
      const text = String(value == null ? '' : value).trim();
      if (!text) return false;
      if (/Infinity|Number\s*\.\s*MAX/.test(text)) return false;
      // `AbortSignal.timeout(-1)` and `timeout(0)` throw or expire immediately.
      if (/^-/.test(text)) return false;
      // `AbortSignal.timeout(0 * 1000)` is `timeout(0)` written longhand.
      if (/^[\d_\s*+()]+$/.test(text)) {
        const evaluated = Function(`"use strict";return (${text.replace(/_/g, '')})`)();
        return Number.isFinite(evaluated) && evaluated > 0;
      }
      if (/^[\d.]+$/.test(text) && Number(text) <= 0) return false;
      // ...and a constant bound to one of those is the same value by another
      // name, so resolve simple bindings and ask again.
      if (/^[A-Za-z_$][\w$]*$/.test(text)) {
        if (seen.has(text)) return true;
        const bound = new RegExp(String.raw`\b${text}\s*=\s*([^;\n,)]+)`).exec(t);
        return !bound || finiteDeadline(bound[1], new Set([...seen, text]));
      }
      return true;
    };
    // Everything below is graded inside the loop that consumes the stream:
    // buffering the whole body first and counting afterwards is no ceiling.
    // The loop that belongs to the requested download, not whichever reader
    // loop a sibling helper happens to define first.
    const named = blockRanges(t, FUNCTIONS).map(range => {
      const head = t.slice(Math.max(0, range.open - 200), range.open);
      const declared = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=)[^;{]*$/.exec(head);
      const signature = /\(([^()]*)\)[^()]*$/.exec(head);
      return {
        ...range,
        name: declared && (declared[1] || declared[2]),
        params: signature ? splitArgs(signature[1]) : [],
      };
    });
    const downloadFn = named.find(range => range.name && /download|report|save|copy|fetchTo/i.test(range.name));
    const consumer = streamConsumer(t, downloadFn);
    const scope = consumer ? consumer.body : '';
    // The deadline has to belong to the request whose response that loop reads,
    // not to some earlier bounded preliminary call, and it has to be armed
    // before the request: a timer set afterwards bounds nothing.
    const reads = consumer && t.slice(Math.max(0, consumer.index - 80), consumer.index)
      + consumer.header + consumer.body;
    const allRequests = [...t.matchAll(/(?:(?:const|let|var)\s+(\w+)\s*=\s*)?(?:await\s+)?\b(fetch|https?\.(?:get|request))\s*\(/g)];
    const timed = allRequests
      .filter(request => {
        // Only this call's own arguments, resolved through a local options
        // binding, and only their top level: an unrelated later block is not
        // proof, and `{ headers: { signal: ... } }` hands fetch no signal.
        const call = callAt(t, request.index + request[0].length - 1);
        const options = call ? call.options : '';
        // `AbortSignal.timeout()` and `AbortSignal.timeout(Infinity)` bound
        // nothing — the first throws before the download even starts.
        const inlineAt = /\bsignal\s*:\s*AbortSignal\s*\.\s*timeout\s*(?=\()/.exec(options);
        const inlineDeadline = inlineAt && parenAt(options, inlineAt.index + inlineAt[0].length);
        const signalRef = inlineAt
          ? (finiteDeadline(inlineDeadline && inlineDeadline.inner) ? 'inline' : null)
          // ...and nothing after it: `signal: timeoutSignal && other` hands the
          // request a different signal whenever the expression is truthy.
          : (/\bsignal\s*:\s*(\w+)\s*\.\s*signal\s*[,}]/.exec(options)
            || /\bsignal\s*:\s*(\w+)\s*[,}]/.exec(options)
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
        request.signalRef = signalRef;
        if (signalRef === 'inline') return true;
        if (!signalRef) return false;
        const preset = armedBefore(String.raw`\b${signalRef}\s*=\s*AbortSignal\s*\.\s*timeout\s*(?=\()`);
        if (preset) {
          const deadline = parenAt(t, preset.index + preset[0].length);
          if (finiteDeadline(deadline && deadline.inner)) return true;
        }
        // A hand-rolled deadline is a resource this function now owns: the
        // timer outlives a download that finishes early, holding the process
        // open and firing a stale abort later. Only a `finally` clears it on
        // success, failure and abort alike — and an unbound handle never can.
        const timer = armedBefore(
          String.raw`(?:(?:const|let|var)\s+(\w+)\s*=\s*)?setTimeout\s*\([\s\S]{0,240}\b${signalRef}\s*\.\s*abort\s*\(`);
        // ...and the abort has to run when it fires: `setTimeout(() => { if
        // (false) controller.abort(); })` never bounds anything.
        const callback = timer && parenAt(t, timer.index + timer[0].indexOf('setTimeout'));
        if (timer && callback && !alwaysReaches(callback.inner,
          new RegExp(String.raw`\b${signalRef}\s*\.\s*abort\s*\(`))) return false;
        // ...unconditionally: `finally { if (debug) clearTimeout(timer) }`
        // still leaks the timer on the path that matters.
        // ...in the finally that guards this request's own try, not one in a
        // sibling helper that never runs.
        const tries = blockRanges(t, /\btry\b/g);
        return Boolean(timer && timer[1] && blockRanges(t, /\bfinally\b/g)
          .some(range => tries.some(guarded => guarded.end <= range.open
            && range.open - guarded.end < 24
            && request.index > guarded.open && request.index < guarded.end)
            && alwaysReaches(t.slice(range.open, range.end),
              new RegExp(String.raw`clearTimeout\s*\(\s*${timer[1]}\s*\)`))));
      });
    // A bounded preliminary call does not excuse an unbounded one beside it:
    // every remote request on the download path needs its own deadline.
    const onDownloadPath = consumer
      ? allRequests.filter(request => sameScope(t, request.index, consumer.index))
      : [];
    const everyRequestTimed = onDownloadPath.length > 0
      && onDownloadPath.every(request => timed.some(other => other.index === request.index));
    let stream = [];
    let linked = null;
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
      linked = request.signalRef;
      nativeRequest = request[2] !== 'fetch';
      return true;
    }));
    // Teardown has to be on the stream this loop reads: `audit.cancel()` leaves
    // the locked reader and its fetch wide open.
    // A fetch Response has no `cancel`: only its reader, its body, or the
    // controller that aborted the request can actually tear this down.
    const readers = [...t.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*([\w.$]+)\s*\.\s*getReader\s*\(/g)]
      .filter(match => stream.includes(match[2].split('.')[0]))
      .map(match => match[1]);
    // ...and only the controller whose signal this request carries: aborting
    // an unrelated one leaves this reader open.
    const controllers = [...t.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*new\s+AbortController\s*\(/g)]
      .map(match => match[1])
      .filter(name => name === linked);
    const webTeardown = [
      ...readers.map(name => String.raw`\b${name}\s*\.\s*cancel\s*\(`),
      ...stream.map(name => String.raw`\b${name}\s*\.\s*body\s*\.\s*cancel\s*\(`),
      ...controllers.map(name => String.raw`\b${name}\s*\.\s*abort\s*\(`),
    ];
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
    const counter = chunk && (
      scope.match(new RegExp(String.raw`\b([A-Za-z_$]\w*)\s*\+=\s*${chunk}\s*\.\s*(?:byteLength|length)\s*[;\n]`))
      // `received = received + chunk.byteLength` is the same accumulation.
      || scope.match(new RegExp(String.raw`\b([A-Za-z_$]\w*)\s*=\s*\1\s*\+\s*${chunk}\s*\.\s*(?:byteLength|length)\s*[;\n]`)));
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
    // An accumulator starting below zero can never reach the ceiling.
    const initAt = counter
      && new RegExp(String.raw`(?:const|let|var)\s+${counter[1]}\s*=\s*0\s*[;\n]`).exec(t);
    // ...declared on the way to this loop: a zero inside an unused helper
    // leaves the outer accumulator undefined and every sum NaN.
    const initialised = Boolean(initAt && consumer && initAt.index < consumer.index
      && sameScope(t, initAt.index, consumer.index)
      && dominates(t, initAt.index, consumer.index));
    // `received += n; received = 0; if (received > MAX)` counts nothing.
    const restarted = counter && [...scope.matchAll(new RegExp(String.raw`\b${counter[1]}\s*=(?!=)`, 'g'))]
      .some(reset => reset.index > counter.index
        && (!limitBranch || reset.index < limitBranch.index));
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
        // ...and leave the handler: destroy() is asynchronous, so execution
        // carries straight on into the write without a return.
        ? (stream.length > 0
          && alwaysReaches(limitBranch.body,
            new RegExp(String.raw`\b(?:${stream.join('|')})[\w.$]*\s*\.\s*(?:destroy|abort|cancel)\s*\(\s*new\s+\w*Error`))
          && alwaysReaches(limitBranch.body, /(?<![.\w])return\b|\bthrow\b/))
        // A reader loop holds the ReadableStream locked and the fetch open;
        // throwing out of it leaves both alive, so the ceiling has to cancel
        // the stream or abort the request as well as fail.
        : alwaysReaches(limitBranch.body, /\bthrow\b|(?<![.\w])reject\s*\(/)
          && webTeardown.length > 0
          && alwaysReaches(limitBranch.body, new RegExp(webTeardown.join('|'))));
    // The write has to be of the chunk just counted, and only after the guard:
    // an unrelated log write past the branch is not the destination write.
    // ...to the destination the task named. `audit.write(chunk)` after the
    // guard is not the report landing in the file it was asked for.
    // ...from the download the probe selected, not from whichever helper the
    // answer happens to declare first.
    const parameters = downloadFn ? downloadFn.params : [];
    // The task hands the destination in as its second argument; the handle is
    // whatever was opened on it. Every destination-shaped name is not enough —
    // `download(url, destination, auditOutput)` would re-open the escape hatch.
    const destination = parameters[1] ? parameters[1].split('=')[0].trim() : null;
    const handles = [...new Set([
      ...(destination ? [destination] : []),
      ...[...t.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?[\w.]*\b(?:open|createWriteStream)\s*\(\s*([^,)]*)/g)]
        .filter(match => !destination || new RegExp(String.raw`\b${destination}\b`).test(match[2]))
        .map(match => match[1]),
    ])].filter(Boolean);
    const writesChunk = chunk && handles.length > 0 && new RegExp(
      String.raw`\b(?:${handles.join('|')})\s*\.\s*write\w*\s*\([^)]*\b${chunk}\b`
      + String.raw`|write\w*\s*\(\s*(?:${handles.join('|')})\s*,[^)]*\b${chunk}\b`);
    const writeAfterLimit = stops && writesChunk
      && alwaysReaches(scope.slice(limitBranch.end), writesChunk)
      && !writesChunk.test(scope.slice(0, limitBranch.index));
    return requestTimeout && writeAfterLimit && initialised && everyRequestTimed && !restarted
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
