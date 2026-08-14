# Simplicity A/B: does the prompt rewrite produce simpler code?

**Date:** 2026-08-14 · **Model:** Opus (all arms) · **Cells:** 4 arms × 3 tasks × 3 repeats = 36
**Harness:** `benchmarks/simplicity/` · **Verdict: rewrite not validated. Nothing shipped.**

## Question

A single observed case suggested the ponytail skill optimizes the *diff* at the expense of
the *code*: an arm running the skill shrank a diff while raising the function's cognitive
complexity from 32 to 42. A candidate rewrite (`benchmarks/arms/ponytail-v2-SKILL.md`)
re-pointed four rules at resulting structure instead of diff size. This run tests whether
the rewrite helps.

## Arms

| arm | instructions |
|---|---|
| `baseline` | none |
| `v1` | current `skills/ponytail/SKILL.md` |
| `v2` | the candidate rewrite |
| `tangle` | deliberately bad: inline everything, nest rather than combine, repeat rather than factor |

`v1` and `v2` are delivered identically (read from a neutral path), so the comparison varies
wording only. Agents were told not to read this repository, so none could find the eval.

## Correctness gate

9/9 cells passed their seeded test in every arm. Structural numbers below are gated on that.

## Results — peak cognitive complexity per cell (lower is better)

| task | baseline | v1 | v2 | tangle |
|---|---|---|---|---|
| eventfilter | 11, 17, 34 | 16, 17, 17 | 14, 16, 16 | 48, 48, 48 |
| cfgparse | 52, 52, 52 | 18, 18, 18 | 18, 18, 18 | 52, 52, 52 |
| offbyone (control) | 4, 4, 4 | 4, 4, 4 | 4, 4, 4 | 4, 4, 4 |

## 1. The rewrite showed no significant effect — do not ship

Paired on peak cognitive complexity across all 9 (task, repeat) pairs:

> **v2 better in 2/9, v1 better in 0/9, tied 7/9.**

Across the full metric vector it is 1 metric-win each, 13 ties. The direction is mildly
favourable — v2 was never *worse* on any cell — but a sign test needs ≥8/9 one way at
p<0.05 and this is nowhere near. Pre-registered rule was "if v2 does not beat v1 on a
majority of metrics, it is not shipped." It did not. **`skills/ponytail/SKILL.md` is
untouched.** The arm is kept for reproducibility, not as a validated improvement.

## 2. The finding that motivated this did NOT replicate

This is the important result. Across 27 fresh cells the skill **never produced worse
structure than baseline**:

- `cfgparse`: baseline 52 → v1 **18**. The skill replaced an if/else chain with a switch;
  baseline extended the chain. A large, consistent win for the skill.
- `eventfilter`: baseline 11/17/34 → v1 16/17/17. Comparable.
- `offbyone`: identical everywhere (correct — the one-line fix is the right answer, and the
  control confirms no arm refactors gratuitously).

The original "skill makes code worse" observation was **n=1**, on a refactoring/optimization
task, not feature addition. It does not reproduce here. Treat it as a single sample rather
than a property of the skill — the earlier writeup overstated it.

## 3. The skill's measurable effect here is variance, not median

Invisible in a median comparison and arguably the real finding:

| | baseline spread | v1 spread |
|---|---|---|
| eventfilter peak cognitive | 11 → 34 (range **23**) | 16 → 17 (range **1**) |

Baseline sometimes writes excellent structure (11) and sometimes poor (34). The skill
lands tightly in the good region every time. Reliability, not peak quality.

## 4. Two methodology failures, recorded so they are not repeated

**My task was broken.** `eventfilter`'s test expected both `true` and `false` for the same
event, making it unpassable — 0/12 cells in the first run. It surfaced only because an agent
flagged it as self-contradictory instead of working around it. Fixed (`ab0dee1`) and re-run.
One third of the first experiment was void because of an error in the instrument.

**The `tangle` control has no headroom on 2 of 3 tasks.** On `cfgparse` and `offbyone` it
scored *identically to baseline* (52 and 4), because on "add a branch to an already-branchy
function" the unguided answer already is the tangled answer. The control only worked on
`eventfilter` (48 vs baseline 17), which is enough to show the instrument detects a
known-bad arm — but a control that ties on two thirds of the corpus is a weak one. Future
task design must leave the bad arm somewhere worse to go.

## Limits

- **n = 3 per cell, 9 per arm.** Enough for direction, not for significance on any single
  metric. A real verdict on v2 needs ~25+ pairs, or tasks with a larger effect.
- **Go only, 3 tasks, feature-addition shaped.** The motivating case was a refactoring task;
  the corpus does not contain one, which is the most likely reason the effect did not appear.
- **Structure only.** Correctness is gated but not scored; performance, naming and API design
  are not measured.

## Reproduce

```sh
python3 benchmarks/simplicity/selftest.py          # calibrate the scorer, no API
python3 benchmarks/simplicity/score_run.py <dir>   # score a run directory
```
