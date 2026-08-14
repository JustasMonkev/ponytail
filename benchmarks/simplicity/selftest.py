#!/usr/bin/env python3
"""Prove the simplicity scorer can still tell the cases apart, before trusting it on a run.

The existing over-engineering metrics in this repo are all SIZE metrics, and every one of
them ranks the validation pair backwards (see SPEC.md). This selftest is the guard against
building the same bug again: it fails if the scorer stops separating tangled from clean,
or stops vetoing shredded code.

No API, no spend.  python3 selftest.py
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "testdata"

# Complexity metrics: lower is better. An arm must win a MAJORITY, not a weighted sum —
# weights fitted to one observed pair are overfitting.
COMPLEXITY = ["peak_cognitive", "max_nest", "max_outcome_sites", "peak_live", "max_fn_statements"]


def build_scorer(tmp: Path) -> Path:
    src = tmp / "gostructure"
    src.mkdir()
    body = (HERE / "gostructure.go").read_text(encoding="utf-8")
    (src / "main.go").write_text(body.replace("//go:build ignore\n", ""), encoding="utf-8")
    (src / "go.mod").write_text("module gostructure\n\ngo 1.24\n", encoding="utf-8")
    binary = tmp / "gostructure-bin"
    subprocess.run(["go", "build", "-o", str(binary), "."], cwd=src, check=True)
    return binary


def score(binary: Path, fixture: str) -> dict:
    raw = subprocess.run([str(binary), str(DATA / f"{fixture}.go")],
                         capture_output=True, text=True, check=True).stdout
    summary = subprocess.run([sys.executable, str(HERE / "summarize.py")],
                             input=raw, capture_output=True, text=True, check=True).stdout
    return json.loads(summary)


def wins(challenger: dict, incumbent: dict) -> int:
    return sum(1 for m in COMPLEXITY if challenger[m] < incumbent[m])


def main() -> int:
    if shutil.which("go") is None:
        print("SKIP: go not installed")
        return 0

    failures = []
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        binary = build_scorer(tmp)
        s = {f: score(binary, f) for f in
             ("validation_baseline", "validation_arm_a", "validation_arm_b", "spaghetti", "shred")}

    base, arm_a, arm_b = s["validation_baseline"], s["validation_arm_a"], s["validation_arm_b"]

    # 1. The validation pair. Arm B is the submission a reader and a judge both preferred;
    #    arm A is the one every size metric prefers. B must win a majority.
    b_over_a = wins(arm_b, arm_a)
    if b_over_a < 3:
        failures.append(f"arm B beat arm A on only {b_over_a}/5 complexity metrics; the "
                        "scorer has lost the discrimination it exists for")

    # 2. Arm A shrank the diff while making the code worse than what it started from.
    #    A scorer that cannot see that is measuring size again.
    if not (arm_a["peak_cognitive"] > base["peak_cognitive"]):
        failures.append("arm A must score WORSE than the baseline it edited "
                        f"(peak_cognitive {arm_a['peak_cognitive']} vs {base['peak_cognitive']})")

    # 3. Tangled control ranks worst on complexity.
    if s["spaghetti"]["peak_cognitive"] <= arm_b["peak_cognitive"]:
        failures.append("the tangled control must score worse than the clean submission")

    # 4. Shred control: complexity metrics ALONE prefer it — that is the point of the
    #    guards. Assert both halves, or the guard silently stops being load-bearing.
    if s["shred"]["peak_cognitive"] > arm_b["peak_cognitive"]:
        failures.append("shred control no longer beats the clean submission on raw "
                        "complexity, so the guards below are no longer being tested")
    if not (s["shred"]["passthrough_fns"] > arm_b["passthrough_fns"]
            and s["shred"]["median_fn_statements"] < arm_b["median_fn_statements"]):
        failures.append("guards failed to flag the shred control: "
                        f"passthrough {s['shred']['passthrough_fns']} vs {arm_b['passthrough_fns']}, "
                        f"median {s['shred']['median_fn_statements']} vs {arm_b['median_fn_statements']}")

    # 5. Good decomposition must NOT trip the guards, or they would veto every real win.
    if arm_b["passthrough_fns"] > arm_a["passthrough_fns"]:
        failures.append("guards fired on the good submission; they would veto real wins")

    for name, m in s.items():
        print(f"  {name:22} peak_cog={m['peak_cognitive']:3} nest={m['max_nest']} "
              f"outcomes={m['max_outcome_sites']} live={m['peak_live']:2} "
              f"max_stmts={m['max_fn_statements']:2} | fns={m['functions']:2} "
              f"median={m['median_fn_statements']:4.1f} passthrough={m['passthrough_fns']}")
    print(f"\n  arm B beats arm A on {b_over_a}/5 complexity metrics")

    if failures:
        print("\nFAIL")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nOK: scorer separates tangled, clean and shredded code, and the guards hold.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
