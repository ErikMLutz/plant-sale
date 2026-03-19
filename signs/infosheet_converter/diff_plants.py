#!/usr/bin/env python3
"""
diff_plants.py — show a per-plant colored diff between two .plant files.

Usage:
  python3 diff_plants.py <file_a.plant> <file_b.plant>

Exit code 1 if there are any differences, 0 if identical.
"""

import csv
import io
import os
import re
import subprocess
import sys
import tempfile
import zipfile


# ── HTML parsing ──────────────────────────────────────────────────────────────

def parse_description(html):
    bullets = []
    for li in re.findall(r"<li>(.*?)</li>", html, re.DOTALL):
        text = re.sub(r"<[^>]+>", "", li).strip()
        bullets.append(re.sub(r"\s+", " ", text))

    highlights = re.findall(r"<p>(.*?)</p>", html, re.DOTALL)
    highlight = None
    if highlights:
        text = re.sub(r"<[^>]+>", "", highlights[0]).strip()
        highlight = re.sub(r"\s+", " ", text)

    return bullets, highlight


# ── Plant rendering ───────────────────────────────────────────────────────────

def render_plant(row):
    lines = []

    common = row.get("common", "").strip()
    latin  = row.get("latin",  "").strip()
    header = common
    if latin:
        header += f"  ({latin})"
    lines.append(header)

    reviewed        = row.get("reviewed",          "").strip().lower()
    source          = row.get("source",            "").strip()
    piedmont_native = row.get("piedmont_native",   "").strip().lower()
    desc_merged     = row.get("description_merged","").strip().lower()

    meta = []
    meta.append(f"reviewed: {'yes' if reviewed == 'true' else 'no'}")
    meta.append(f"source: {source or '—'}")
    meta.append(f"piedmont_native: {'yes' if piedmont_native == 'true' else 'no'}")
    if desc_merged == "true":
        meta.append("description_merged: yes")
    lines.append("  ".join(meta))

    flag   = row.get("flag_for_review",   "").strip().lower()
    reason = row.get("reason_for_review", "").strip()
    if flag == "true":
        lines.append(f"FLAG: {reason or '(no reason given)'}")

    bullets, highlight = parse_description(row.get("description", ""))
    lines.append("")
    for b in bullets:
        lines.append(f"  - {b}")
    if not bullets:
        lines.append("  (no description)")
    if highlight:
        lines.append("")
        lines.append(f"  {highlight}")

    tags = sorted(t.strip() for t in row.get("tags", "").split(",") if t.strip())
    lines.append("")
    lines.append("tags:")
    for t in tags:
        lines.append(f"  - {t}")
    if not tags:
        lines.append("  (none)")

    cats = sorted(c.strip() for c in row.get("category", "").split(",") if c.strip())
    lines.append("categories:")
    for c in cats:
        lines.append(f"  - {c}")
    if not cats:
        lines.append("  (none)")

    return "\n".join(lines)


# ── Zip loading ───────────────────────────────────────────────────────────────

def load_latest_csv(plant_file):
    with zipfile.ZipFile(plant_file) as z:
        csvs = sorted([n for n in z.namelist()
                       if re.match(r"plants\.improved\.\d{8}_\d{6}\.csv$", n, re.I)])
        if not csvs:
            raise ValueError(f"No plants.improved.*.csv found in {plant_file}")
        text = z.read(csvs[-1]).decode("utf-8")
        return list(csv.DictReader(io.StringIO(text))), csvs[-1]


# ── Main ──────────────────────────────────────────────────────────────────────

def normalize(s):
    s = re.sub(r"[''`]", "", s.lower())
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]", " ", s)).strip()

def render_all(rows):
    def sort_key(r):
        return normalize(r.get("latin", "") or r.get("common", ""))
    blocks = [render_plant(r) for r in sorted(rows, key=sort_key)]
    return "\n\n".join(blocks) + "\n"


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {os.path.basename(sys.argv[0])} <file_a.plant> <file_b.plant>",
              file=sys.stderr)
        sys.exit(2)

    file_a, file_b = sys.argv[1], sys.argv[2]
    for f in (file_a, file_b):
        if not os.path.exists(f):
            print(f"ERROR: file not found: {f}", file=sys.stderr)
            sys.exit(2)

    rows_a, csv_name_a = load_latest_csv(file_a)
    rows_b, csv_name_b = load_latest_csv(file_b)

    label_a = f"{os.path.basename(file_a)} ({csv_name_a})"
    label_b = f"{os.path.basename(file_b)} ({csv_name_b})"

    with tempfile.NamedTemporaryFile("w", suffix=".txt", prefix="plants_a_", delete=False) as fa, \
         tempfile.NamedTemporaryFile("w", suffix=".txt", prefix="plants_b_", delete=False) as fb:
        fa.write(render_all(rows_a))
        fb.write(render_all(rows_b))
        tmp_a, tmp_b = fa.name, fb.name

    try:
        result = subprocess.run(
            ["git", "diff", "--word-diff=color", "--word-diff-regex=.",
             f"--src-prefix={label_a}/", f"--dst-prefix={label_b}/",
             tmp_a, tmp_b],
            capture_output=False,
        )
    finally:
        os.unlink(tmp_a)
        os.unlink(tmp_b)

    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
