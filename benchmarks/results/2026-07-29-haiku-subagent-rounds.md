# Haiku sub-agent rounds: sibling inputs, client-keyed state, one-check-means-one

*2026-07-29. Haiku 4.5 sub-agents on seeded single-file tasks, ponytail arm = AGENTS.md injected
verbatim, baseline arm = same ticket with no instructions. Deterministic scorers (correctness +
implicit-safety + LOC), n=1 per arm per round.*

Four realistic tickets, safety implicit in the prompt the way a real ticket reads:

- **datefield** — add a required, no-past-dates check-in date to an HTML form (over-build bait:
  a picker lib vs `<input type="date">`).
- **safepath** — finish `save_upload` for filenames from untrusted clients (path traversal).
- **ratelimit** — protect a login endpoint from password-guessing bots (stdlib, single process).
- **bugfix** — `parse_amount` crashes on `"12"`; report names `charge_card` only, but `refund`
  and `invoice_total` share the parser (root-cause probe).

## Round 1 — ponytail vs baseline

| task | baseline | ponytail | both correct+safe? |
|---|---|---|---|
| datefield | 17 LOC | 15 LOC | yes (both used native date input) |
| safepath | 15 LOC | 15 LOC | yes (both `os.path.basename`) |
| ratelimit | 46 LOC | 40 LOC **+ 119-line 5-test suite** | yes |
| bugfix | 13 LOC | 11 LOC | yes (both fixed the shared `parse_amount`) |

Ponytail was shorter or equal everywhere with no safety loss. Three issues survived in *both* arms:

1. **Sibling input shape silently wrong.** Both arms fixed `"12"` but kept `"12.5"` → 1205 cents
   (`int("5")` ≠ 50). No-crash was treated as done; the *value* is wrong.
2. **Unbounded client-keyed state.** Both rate limiters grow a per-IP dict forever under a
   many-IP botnet; cleanup only runs when the same IP returns.
3. **"ONE check" didn't hold.** The ponytail arm shipped a 5-function test suite where the rule
   says one risk-targeted check — the check rule cost more lines than the ladder saved.

## The fix (two iterations)

- Bug-fix directive: *"Inputs have siblings too: the report names one bad shape; run its neighbors
  (shorter, longer, empty, zero, one digit where two are expected) through the fixed line before
  shipping. Each must produce the correct value or an explicit rejection — a silently wrong result
  is worse than the crash you were sent to fix."* (Second sentence added after round 2 showed
  Haiku reading "runs without crashing" as passing.)
- Bound external work: *"Cap or evict state keyed by client-controlled values (IPs, ids, names);
  cleanup that only runs when the same key returns never shrinks the map."* (Reworded from a
  descriptive to an operational form after round 2.)
- One-check rule: *"one small test file with a single test function — one check means one, no
  frameworks or fixtures."*

## Rounds 2–3 — ponytail arm only, same tickets

| probe | round 1 | round 2 | round 3 |
|---|---|---|---|
| ratelimit: test suite | 5 test fns, 119 lines | none | none |
| ratelimit: total shipped lines | 159 | 44 | 38 |
| ratelimit: state after 20k distinct IPs | 20k entries | 20k entries | 20k entries |
| bugfix: `"12.5"` | 1205 (wrong) | 1205 (wrong) | 1205 (wrong) |
| all original correct/safe probes | pass | pass | pass |

## Honest read

- **One-check-means-one landed.** The suite disappeared and total shipped lines on ratelimit
  dropped 159 → 38 with zero loss on the safety probes. This was the biggest single win.
- **The two hard rules did not land on Haiku 4.5** in three phrasings, including one that names
  the exact failure pattern it then reproduced. Small-model ceiling, not wording: Haiku
  pattern-matches "handle the reported shape" and stops. The rules stay — they are correct, cost
  three sentences, and target exactly the corners a stronger model can check cheaply — but do not
  expect them to move Haiku-class agents.
- n=1 per cell; treat LOC deltas as direction, not measurement. The baseline was already minimal
  on the small tasks (consistent with the agentic writeup's "near zero where the code is already
  minimal").
