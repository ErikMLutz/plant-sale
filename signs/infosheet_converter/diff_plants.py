#!/usr/bin/env python3
"""
diff_plants.py — show a per-plant colored diff between two .plant files.

Usage:
  python3 diff_plants.py <file_a.plant> <file_b.plant>

Exit code 1 if there are any differences, 0 if identical.
"""

import csv
import difflib
import io
import os
import re
import sys
import zipfile


# ── ANSI colors ───────────────────────────────────────────────────────────────

RED    = "\033[31m"
GREEN  = "\033[32m"
CYAN   = "\033[36m"
YELLOW = "\033[33m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

def colorize_diff(lines):
    out = []
    for line in lines:
        if line.startswith("---") or line.startswith("+++"):
            out.append(BOLD + line + RESET)
        elif line.startswith("@@"):
            out.append(CYAN + line + RESET)
        elif line.startswith("-"):
            out.append(RED + line + RESET)
        elif line.startswith("+"):
            out.append(GREEN + line + RESET)
        else:
            out.append(line)
    return out


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


# ── Matching ──────────────────────────────────────────────────────────────────

def normalize(s):
    s = re.sub(r"[''`]", "", s.lower())
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]", " ", s)).strip()

def build_index(rows):
    by_latin  = {}
    by_common = {}
    for row in rows:
        latin  = normalize(row.get("latin",  ""))
        common = normalize(row.get("common", ""))
        if latin:
            by_latin[latin] = row
        if common:
            by_common[common] = row
    return by_latin, by_common

def find_match(row, by_latin, by_common):
    latin  = normalize(row.get("latin",  ""))
    common = normalize(row.get("common", ""))
    if latin and latin in by_latin:
        return by_latin[latin]
    if common and common in by_common:
        return by_common[common]
    return None


# ── Main ──────────────────────────────────────────────────────────────────────

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

    by_latin_b, by_common_b = build_index(rows_b)
    by_latin_a, by_common_a = build_index(rows_a)

    # Track which b rows were matched
    matched_b = set()

    has_diff = False
    output   = []

    def sort_key(r):
        return (normalize(r.get("latin", "") or r.get("common", "")))

    for row_a in sorted(rows_a, key=sort_key):
        row_b = find_match(row_a, by_latin_b, by_common_b)

        if row_b is not None:
            matched_b.add(normalize(row_b.get("latin", "") or row_b.get("common", "")))

        text_a = render_plant(row_a)
        text_b = render_plant(row_b) if row_b is not None else None

        if row_b is None:
            # Only in A
            has_diff = True
            header = YELLOW + BOLD + f"Only in {os.path.basename(file_a)}: {row_a.get('common','')}" + RESET
            block  = "\n".join(RED + f"- {l}" + RESET for l in text_a.splitlines())
            output.append(header + "\n" + block)
            continue

        if text_a == text_b:
            continue

        # Differ per plant
        has_diff = True
        diff_lines = list(difflib.unified_diff(
            text_a.splitlines(keepends=True),
            text_b.splitlines(keepends=True),
            fromfile=label_a,
            tofile=label_b,
            n=3,
        ))
        common_name = row_a.get("common", "")
        header = BOLD + f"=== {common_name} ===" + RESET
        output.append(header + "\n" + "".join(colorize_diff(diff_lines)))

    # Plants only in B
    for row_b in sorted(rows_b, key=sort_key):
        key = normalize(row_b.get("latin", "") or row_b.get("common", ""))
        if key in matched_b:
            continue
        has_diff = True
        text_b = render_plant(row_b)
        header = YELLOW + BOLD + f"Only in {os.path.basename(file_b)}: {row_b.get('common','')}" + RESET
        block  = "\n".join(GREEN + f"+ {l}" + RESET for l in text_b.splitlines())
        output.append(header + "\n" + block)

    if not has_diff:
        print("No differences.")
        sys.exit(0)

    print("\n\n".join(output))
    sys.exit(1)


if __name__ == "__main__":
    main()
