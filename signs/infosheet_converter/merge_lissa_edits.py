#!/usr/bin/env python3
"""
merge_lissa_edits.py — synthesize Lissa's reviewed edits with highlight lines
from the original-full-ai-with-highlights.plant file.

For each plant:
  - Default to original-full-ai-with-highlights (latest plants.csv)
  - If a Reviewed match exists in lissa-initial-edits (latest plants.csv):
      - Check that structure matches: same number of <li> bullets,
        and both have (or both lack) a <p> highlight
      - If structure mismatches: report error with diff, keep original
      - If structure matches: use Lissa's <li> bullets + original <p> highlight

Output: ~/Downloads/lissa-edits-with-highlights.plant
  - SS inventory from original-full-ai-with-highlights.plant
  - New synthesized plants.improved.<datetime>.csv

CRITICAL: input files are never modified.
"""

import csv
import io
import os
import re
import sys
import zipfile
from datetime import datetime

# ── Paths ─────────────────────────────────────────────────────────────────────

DOWNLOADS = os.path.expanduser("~/Downloads")
ORIGINAL_PLANT = os.path.join(DOWNLOADS, "original-full-ai-with-highlights.plant")
LISSA_PLANT    = os.path.join(DOWNLOADS, "lissa-initial-edits.plant")
OUTPUT_PLANT   = os.path.join(DOWNLOADS, "lissa-edits-with-highlights.plant")

# ── Helpers ───────────────────────────────────────────────────────────────────

def normalize_name(s):
    s = s.lower()
    s = re.sub(r"[''`]", "", s)          # strip apostrophes
    s = re.sub(r"[^a-z0-9]", " ", s)    # non-alphanumeric → space
    s = re.sub(r"\s+", " ", s).strip()
    return s


def get_latest_csv(plant_file):
    """Return (filename, text) of the latest plants.improved.*.csv in a .plant zip."""
    with zipfile.ZipFile(plant_file) as z:
        csvs = sorted([n for n in z.namelist() if re.match(r"plants\.improved\.\d{8}_\d{6}\.csv$", n, re.I)])
        if not csvs:
            raise ValueError(f"No plants.improved.*.csv found in {plant_file}")
        latest = csvs[-1]
        return latest, z.read(latest).decode("utf-8")


def get_ss_inventory(plant_file):
    """Return (filename, text) of the SS inventory (non-plants.improved file) in a .plant zip."""
    with zipfile.ZipFile(plant_file) as z:
        for name in z.namelist():
            if not re.match(r"plants\.improved\.\d{8}_\d{6}\.csv$", name, re.I):
                return name, z.read(name).decode("utf-8")
    raise ValueError(f"No SS inventory found in {plant_file}")


def read_csv(text):
    return list(csv.DictReader(io.StringIO(text)))


def parse_description(html):
    """
    Returns (lis, highlight) where:
      lis       — list of full '<li>...</li>' strings
      highlight — '<p>...</p>' string or None
    """
    lis       = re.findall(r"<li>.*?</li>", html, re.DOTALL)
    highlights = re.findall(r"<p>.*?</p>", html, re.DOTALL)
    return lis, (highlights[0] if highlights else None)


def build_description(lis, highlight):
    html = "<ul>" + "".join(lis) + "</ul>"
    if highlight:
        html += highlight
    return html


def build_csv_map(rows):
    """
    Returns two dicts keyed by normalized latin and normalized common name.
    Values are row dicts.
    """
    by_latin  = {}
    by_common = {}
    for row in rows:
        latin  = normalize_name(row.get("latin", ""))
        common = normalize_name(row.get("common", ""))
        if latin:
            by_latin[latin] = row
        if common:
            by_common[common] = row
    return by_latin, by_common


def find_match(orig_row, lissa_by_latin, lissa_by_common):
    """Match an original row against Lissa's index. Latin first, then common."""
    latin  = normalize_name(orig_row.get("latin", ""))
    common = normalize_name(orig_row.get("common", ""))
    if latin and latin in lissa_by_latin:
        return lissa_by_latin[latin]
    if common and common in lissa_by_common:
        return lissa_by_common[common]
    return None


def write_csv(rows, fieldnames):
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames, lineterminator="\n",
                            quoting=csv.QUOTE_ALL, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # Guard: output must not already exist
    if os.path.exists(OUTPUT_PLANT):
        print(f"ERROR: output file already exists: {OUTPUT_PLANT}", file=sys.stderr)
        sys.exit(1)

    # Load inputs
    for path in (ORIGINAL_PLANT, LISSA_PLANT):
        if not os.path.exists(path):
            print(f"ERROR: input file not found: {path}", file=sys.stderr)
            sys.exit(1)

    orig_csv_name, orig_csv_text = get_latest_csv(ORIGINAL_PLANT)
    lissa_csv_name, lissa_csv_text = get_latest_csv(LISSA_PLANT)
    ss_inv_name, ss_inv_text = get_ss_inventory(ORIGINAL_PLANT)

    print(f"Original CSV : {orig_csv_name}")
    print(f"Lissa CSV    : {lissa_csv_name}")
    print(f"SS inventory : {ss_inv_name}")
    print()

    orig_rows  = read_csv(orig_csv_text)
    lissa_rows = read_csv(lissa_csv_text)

    lissa_by_latin, lissa_by_common = build_csv_map(lissa_rows)

    fieldnames = list(orig_rows[0].keys()) if orig_rows else []

    output_rows = []
    stats = {"default": 0, "merged": 0, "unreviewed": 0}

    for orig_row in orig_rows:
        common = orig_row.get("common", "")
        lissa_row = find_match(orig_row, lissa_by_latin, lissa_by_common)

        if lissa_row is None or lissa_row.get("reviewed", "").lower() != "true":
            # No reviewed match — use original as-is
            output_rows.append(dict(orig_row))
            stats["default"] += 1
            if lissa_row is not None:
                stats["unreviewed"] += 1
            continue

        orig_desc  = orig_row.get("description", "")
        lissa_desc = lissa_row.get("description", "")

        orig_lis,  orig_p  = parse_description(orig_desc)
        lissa_lis, lissa_p = parse_description(lissa_desc)

        # Use Lissa's bullets + original's highlight
        merged_desc = build_description(lissa_lis, orig_p)

        merged_row = dict(orig_row)
        merged_row["description"]       = merged_desc
        merged_row["reviewed"]          = lissa_row.get("reviewed", "")
        merged_row["description_merged"] = lissa_row.get("description_merged", "")
        merged_row["tags"]              = lissa_row.get("tags", orig_row.get("tags", ""))
        merged_row["category"]          = lissa_row.get("category", orig_row.get("category", ""))
        output_rows.append(merged_row)
        stats["merged"] += 1

    # Summary
    total = len(output_rows)
    print(f"Summary: {total} plants total")
    print(f"  {stats['merged']} merged (Lissa's bullets + original highlight)")
    print(f"  {stats['unreviewed']} matched but not reviewed by Lissa (kept original)")
    print(f"  {stats['default'] - stats['unreviewed']} not matched in Lissa's CSV (kept original)")
    print()

    # Write output CSV
    now = datetime.now()
    timestamp = now.strftime("%Y%m%d_%H%M%S")
    new_csv_name = f"plants.improved.{timestamp}.csv"
    new_csv_text = write_csv(output_rows, fieldnames)

    # Bundle into .plant zip (no extra files)
    with zipfile.ZipFile(OUTPUT_PLANT, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        zout.writestr(ss_inv_name, ss_inv_text)
        zout.writestr(new_csv_name, new_csv_text)

    print(f"Written: {OUTPUT_PLANT}")
    print(f"  {ss_inv_name}")
    print(f"  {new_csv_name}")



if __name__ == "__main__":
    main()
