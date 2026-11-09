"""Runs every fixtures/*/ against python/txg.py and compares with expect.json."""
import json, sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "python"))
import txg  # noqa: E402

key = lambda found: [(f["code"], f["line"], f["severity"]) for f in found]
dirs = sorted(p for p in (root / "fixtures").iterdir() if p.is_dir())
failed = 0
for d in dirs:
    want = json.loads((d / "expect.json").read_text())
    got = txg.lint(str(d / "flow.txg"))
    if key(got) != key(want):
        failed += 1
        print(f"FAIL {d.name}\n  want {key(want)}\n  got  {key(got)}")
print(f"{len(dirs) - failed}/{len(dirs)} fixtures pass (python)")
sys.exit(1 if failed else 0)
