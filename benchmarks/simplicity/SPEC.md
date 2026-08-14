# Simplicity eval

Measures the **structural complexity of the code an arm leaves behind**, not the size of
the change it made. Companion to `benchmarks/agentic/`, which measures correctness, safety
and size.

## Why this exists

Two Opus agents optimized the same Go function. Both were correct (byte-identical against
a reference implementation over 93,000 adversarial inputs). Arm A ran with the ponytail
skill, arm B without. Measured on the real commits, now checked in as `testdata/`:

| | diff | peak cognitive | max nest | outcome sites | peak live | max fn stmts |
|---|--:|--:|--:|--:|--:|--:|
| baseline (what both edited) | — | 32 | 5 | 4 | 8 | 34 |
| **arm A** | **+39/−11** | **42** | 5 | **5** | 8 | **41** |
| **arm B** | +83/−35 | **17** | **4** | **2** | **7** | **23** |

Arm A produced the smaller diff and **left the function worse than it found it**. Every
over-engineering metric this repo already had — diff LOC, `src_loc`, `src_files`,
`total_loc` — ranks A above B. A human reviewer, an LLM judge, and a 2× performance
difference all ranked B above A.

The skill optimized the measured proxy ("shortest working diff wins") and moved the real
quantity backwards. This eval measures the real quantity.

## Metrics

Per function, from the AST. **Aggregated with MAX, never SUM.** Summing punishes
extracting a helper, which reproduces the original bug in the opposite direction:
summed cognitive complexity over the whole file gives baseline 39, A 47, B 51 — ranking
the best submission worst, because it has more functions.

| metric | definition | lower is better |
|---|---|--:|
| `peak_cognitive` | Cognitive complexity (Campbell): each branch costs 1 + its nesting depth, each boolean-operator chain 1, each non-local jump 1. Max over functions. | ✓ |
| `max_nest` | Deepest block nesting in any function. | ✓ |
| `max_outcome_sites` | Largest group of *identical* terminal statements in one function (returns, loop jumps, accumulator writes). What costs a reader is not having several returns, it is producing **one** outcome from several places. | ✓ |
| `peak_live` | Most bindings live at once in any function (params + locals). | ✓ |
| `max_fn_statements` | Statements in the largest function. | ✓ |

**No weighted composite.** Every design proposal fitted 6–9 metrics with hand-chosen
weights to this single observed A/B pair, which is overfitting: it produces a scorer that
only knows how to rank the example it was built from. An arm must instead win a **majority
of the five**. On the validation pair B wins 5/5.

## Guards (veto, not score)

The obvious counter-exploit to per-function maxima is shredding one clear function into
trivial wrappers. `testdata/shred.go` does exactly that and **wins on every complexity
metric** (peak_cognitive 5, the best of any fixture). It is caught by:

| guard | shred | arm B (good decomposition) |
|---|--:|--:|
| `passthrough_fns` (≤2 statements) | **7** | 1 |
| `median_fn_statements` | **2.0** | 12.0 |

Arm B extracted three *substantial* helpers, so its median function size went **up**
(11.0 → 12.0) and its passthrough count did not move. The guards fire on shredding and
stay silent on real decomposition.

## Calibration

`selftest.py` asserts the instrument still works, with no API spend:

1. Arm B beats arm A on ≥3 of 5 complexity metrics (currently 5/5).
2. Arm A scores **worse than the baseline it edited** — a scorer that cannot see this has
   reverted to measuring size.
3. The tangled control (`spaghetti.go`) scores worse than the clean submission.
4. The shred control still beats the clean submission on raw complexity **and** trips the
   guards — both halves, so the guards cannot silently stop being load-bearing.
5. The guards do **not** fire on the good submission.

Run it before trusting any result: `python3 benchmarks/simplicity/selftest.py`

## What this does NOT measure

Stated plainly so nobody over-reads it:

- **Correctness and safety.** Gated elsewhere (`benchmarks/agentic/`). A submission that
  scores well here and fails there is a failure. Structural metrics charge for nesting and
  branches, which is also what input validation and error handling look like — so this
  eval must never be run without a correctness gate in front of it, or it rewards deleting
  the safety code ponytail explicitly protects.
- **Whether the change was necessary.** A no-op scores perfectly.
- **Runtime performance.** Arm B was also 2× faster; that is measured by
  `go/internal/mcp/bench_test.go`, not here.
- **Naming, comments, or API design.** Load-bearing comments are neither rewarded nor
  punished — several proposals wanted to score comment density, and both critics showed
  that converts comment padding into score.
- **JS/TS.** Python (`ast`) and Go (`go/parser`) have stdlib parsers; JS does not without a
  dependency, and this repo ships zero. Go is implemented; Python is the next language.

## Known gaps

Honest list, from the adversarial review — none of these are fixed yet:

- **n = 1.** The validation pair is a single observed example. Ranking it correctly is
  necessary, not sufficient. Real use needs multiple runs per cell and a variance estimate
  before any difference between arms is called real.
- **No human ground truth.** Validity is currently asserted by construction plus one
  judged case. A labelled corpus of human readability judgements would be stronger.
- **Go only.** The motivating finding is a Go finding, which is the right place to start,
  but one language is not a portability claim.
- **`max_outcome_sites` counts syntactic identity**, so two writes that differ only in a
  variable name are not grouped. It under-reports rather than over-reports.

## Files

| | |
|---|---|
| `gostructure.go` | Go AST scorer, one JSON record per function. Stdlib only. |
| `summarize.py` | Aggregates per-function records into the submission vector. |
| `selftest.py` | Calibration; must pass before a run is trusted. |
| `testdata/validation_*.go` | The real baseline / arm A / arm B sources. |
| `testdata/spaghetti.go` | Tangled control. |
| `testdata/shred.go` | Over-decomposed control. |
