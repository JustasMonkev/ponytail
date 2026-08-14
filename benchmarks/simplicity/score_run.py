#!/usr/bin/env python3
"""Score an A/B run: correctness gate first, then the structural vector.

The gate is not optional. Structural metrics charge for nesting and branches, which is
also what validation and error handling look like, so an ungated run rewards deleting
them. A cell that fails its seeded test is excluded from the structural comparison and
counted against its arm separately.

  python3 score_run.py <run-dir>        # run-dir holds <arm>/<task>/<rep>/seed.go
"""
import json
import shutil
import statistics
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPLEXITY = ["peak_cognitive", "max_nest", "max_outcome_sites", "peak_live", "max_fn_statements"]
GUARDS = ["passthrough_fns", "median_fn_statements"]


def build_scorer(tmp: Path) -> Path:
    src = tmp / "gostructure"
    src.mkdir()
    body = (HERE / "gostructure.go").read_text(encoding="utf-8")
    (src / "main.go").write_text(body.replace("//go:build ignore\n", ""), encoding="utf-8")
    (src / "go.mod").write_text("module gostructure\n\ngo 1.24\n", encoding="utf-8")
    binary = tmp / "gostructure-bin"
    subprocess.run(["go", "build", "-o", str(binary), "."], cwd=src, check=True)
    return binary


def correct(cell: Path) -> bool:
    try:
        r = subprocess.run(["go", "test", "./..."], cwd=cell,
                           capture_output=True, text=True, timeout=180)
        return r.returncode == 0
    except subprocess.TimeoutExpired:
        return False


def structure(binary: Path, target: Path):
    raw = subprocess.run([str(binary), str(target)], capture_output=True, text=True)
    if raw.returncode != 0:
        return None  # did not parse: treated as a correctness failure upstream
    out = subprocess.run([sys.executable, str(HERE / "summarize.py")],
                         input=raw.stdout, capture_output=True, text=True)
    return json.loads(out.stdout) if out.returncode == 0 else None


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    root = Path(sys.argv[1])
    if shutil.which("go") is None:
        sys.exit("go not installed")

    rows = []
    with tempfile.TemporaryDirectory() as tmpdir:
        binary = build_scorer(Path(tmpdir))
        for target in sorted(root.glob("*/*/*/seed.go")):
            cell = target.parent
            arm, task, rep = cell.parts[-3], cell.parts[-2], cell.parts[-1]
            passed = correct(cell)
            metrics = structure(binary, target) if passed else None
            rows.append({"arm": arm, "task": task, "rep": rep,
                         "correct": passed, **(metrics or {})})

    (root / "scores.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")

    arms = sorted({r["arm"] for r in rows})
    tasks = sorted({r["task"] for r in rows})

    print("=== correctness gate (cells passing seeded tests) ===")
    for arm in arms:
        cells = [r for r in rows if r["arm"] == arm]
        ok = sum(1 for r in cells if r["correct"])
        print(f"  {arm:9} {ok}/{len(cells)}")

    print("\n=== structural medians, correct cells only (lower is better) ===")
    header = "  arm       task          n  " + "  ".join(f"{m[:11]:>11}" for m in COMPLEXITY)
    print(header)
    medians = defaultdict(dict)
    for arm in arms:
        for task in tasks:
            cells = [r for r in rows if r["arm"] == arm and r["task"] == task and r["correct"]]
            if not cells:
                print(f"  {arm:9} {task:12} 0   (no correct cells)")
                continue
            vals = {m: statistics.median(c[m] for c in cells) for m in COMPLEXITY}
            medians[arm][task] = vals
            print(f"  {arm:9} {task:12} {len(cells):2}  " +
                  "  ".join(f"{vals[m]:11.1f}" for m in COMPLEXITY))

    print("\n=== v1 vs v2, per task (metric wins for v2, lower median) ===")
    total_v2, total_v1, total_tie = 0, 0, 0
    for task in tasks:
        if task not in medians.get("v1", {}) or task not in medians.get("v2", {}):
            print(f"  {task:12} incomparable (an arm had no correct cells)")
            continue
        w2 = sum(1 for m in COMPLEXITY if medians["v2"][task][m] < medians["v1"][task][m])
        w1 = sum(1 for m in COMPLEXITY if medians["v1"][task][m] < medians["v2"][task][m])
        total_v2 += w2
        total_v1 += w1
        total_tie += len(COMPLEXITY) - w1 - w2
        print(f"  {task:12} v2 wins {w2}/5, v1 wins {w1}/5, tied {len(COMPLEXITY)-w1-w2}")
    print(f"  TOTAL        v2 {total_v2}, v1 {total_v1}, tied {total_tie}")

    print("\n=== calibration: the tangle arm must be worst on peak_cognitive ===")
    for arm in arms:
        cells = [r for r in rows if r["arm"] == arm and r["correct"]]
        if cells:
            print(f"  {arm:9} median peak_cognitive "
                  f"{statistics.median(c['peak_cognitive'] for c in cells):5.1f}")

    print("\n=== guards (over-decomposition veto) ===")
    for arm in arms:
        cells = [r for r in rows if r["arm"] == arm and r["correct"]]
        if cells:
            print(f"  {arm:9} passthrough_fns median "
                  f"{statistics.median(c['passthrough_fns'] for c in cells):4.1f}   "
                  f"median_fn_statements "
                  f"{statistics.median(c['median_fn_statements'] for c in cells):5.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
