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

  // Leaves ONE runnable check behind for non-trivial logic.
  onecheck(output) {
    const t = String(output || '');
    const hasCheck = /\bassert\b|def\s+test_|if\s+__name__|unittest|pytest|console\.assert|\bexpect\(|\bdescribe\(|\bit\(/.test(t);
    return hasCheck
      ? { pass: true, reason: 'Left a runnable check (assert/test/demo).' }
      : { pass: false, reason: 'No runnable check left behind.' };
  },

  // Merges into existing state and proves falsy values are not treated as absent.
  contracts(output) {
    const t = String(output || '');
    const merges = /\{\s*\.\.\.[^,}]+,\s*\.\.\.[^}]+\}|Object\.assign\s*\(/.test(t);
    const falsy = [/\bfalse\b/, /(?:^|[^\d])0(?:[^\d]|$)/, /['"]{2}/].filter((r) => r.test(t)).length >= 2;
    const hasCheck = /console\.assert|\bassert\b|\bexpect\(|\bit\(/.test(t);
    return merges && falsy && hasCheck
      ? { pass: true, reason: 'Preserves existing state and checks explicit falsy values.' }
      : { pass: false, reason: 'Does not prove state and explicit false/zero/empty values survive.' };
  },

  // Cancellation must remove every listener it installed, not just reject.
  lifecycle(output) {
    const t = String(output || '');
    const cancellation = /\bAbortSignal\b|\bsignal\b|abort/i.test(t);
    const cleanup = /\.off\s*\(|removeListener\s*\(|removeEventListener\s*\(/.test(t);
    const singleShot = /\.once\s*\(|\bsettled\b|\bcleanup\b/.test(t);
    return cancellation && cleanup && singleShot
      ? { pass: true, reason: 'Owns cancellation and listener cleanup as one lifecycle.' }
      : { pass: false, reason: 'Missing cancellation, listener cleanup, or stale-completion protection.' };
  },

  // Data loaded from storage is untrusted again at the point of network use.
  revalidate(output) {
    const t = String(output || '');
    const parsesUrl = /\bnew URL\s*\(|urlparse\s*\(/.test(t);
    const checksPolicy = /protocol|scheme|hostname|host\b|allowlist|allowed_hosts|https:/i.test(t);
    const rejects = /\bthrow\b|\breject\b|\braise\b|\breturn false\b/i.test(t);
    return parsesUrl && checksPolicy && rejects
      ? { pass: true, reason: 'Revalidates persisted URL against a network policy before use.' }
      : { pass: false, reason: 'Trusts persisted URL without revalidating its current network policy.' };
  },

  // A remote response needs both a deadline and a byte ceiling.
  bounds(output) {
    const t = String(output || '');
    const timeBound = /AbortSignal\.timeout|setTimeout|timeout\s*[:=]|deadline/i.test(t);
    const sizeBound = /max(?:imum)?[_A-Z -]?bytes|content-length|byteLength|bytesRead|size\s*>/i.test(t);
    return timeBound && sizeBound
      ? { pass: true, reason: 'Bounds remote work by time and response size.' }
      : { pass: false, reason: 'Remote work lacks a time limit or byte ceiling.' };
  },
};

module.exports = (output, context) => {
  const probe = context && context.vars && context.vars.probe;
  const check = CHECKS[probe];
  if (!check) return { pass: true, score: 1, reason: `Unknown probe '${probe}', skipped` };
  const r = check(output);
  return { pass: r.pass, score: r.pass ? 1 : 0, reason: r.reason };
};
