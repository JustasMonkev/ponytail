#!/usr/bin/env python3
"""Aggregate per-function structural metrics into the per-submission vector.

Aggregation is the load-bearing decision. Summing any per-function metric punishes
extracting a helper, which is the exact inversion this suite exists to catch, so
every complexity metric aggregates with MAX. The two guard metrics aggregate with
median/count instead: they exist to catch the opposite failure, shredding one clear
function into trivial wrappers to drive the maximum down.

There is deliberately no weighted composite. Weights fitted to a single observed
example are overfitting; an arm must win a majority of the metrics instead.

  gostructure <files...> | summarize.py [--label NAME]
"""
import json
import statistics
import sys

# A helper this small with a single caller is a passthrough, not a decomposition.
PASSTHROUGH_STATEMENTS = 2


def summarize(functions):
    if not functions:
        return None
    cognitive = [f["cognitive"] for f in functions]
    statements = [f["statements"] for f in functions]
    return {
        # Complexity: MAX. Lower is better.
        "peak_cognitive": max(cognitive),
        "max_nest": max(f["max_nest"] for f in functions),
        "max_outcome_sites": max(f["outcome_sites"] for f in functions),
        "peak_live": max(f["live_max"] for f in functions),
        "max_fn_statements": max(statements),
        # Guards against over-decomposition. Not scored; they veto a win.
        "functions": len(functions),
        "median_fn_statements": statistics.median(statements),
        "passthrough_fns": sum(1 for s in statements if s <= PASSTHROUGH_STATEMENTS),
    }


def main():
    label = ""
    if "--label" in sys.argv:
        label = sys.argv[sys.argv.index("--label") + 1]
    result = summarize(json.load(sys.stdin))
    if result is None:
        sys.exit("no functions parsed")
    if label:
        result = {"label": label, **result}
    json.dump(result, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
