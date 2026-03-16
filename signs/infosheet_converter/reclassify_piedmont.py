#!/usr/bin/env python3
"""
Re-run BONAP piedmont-native classification on an existing plants.csv,
updating ONLY the piedmont_native column.

Usage:
  python3 infosheet_converter/reclassify_piedmont.py [INPUT_CSV] [--workers N]

Defaults:
  INPUT_CSV  ~/Downloads/original-updated-full-ai/plants.improved.20260316_152831.csv
  --workers  10

Rows with no latin name are left unchanged.
Rows where BONAP 404s keep their original value and are noted in output.
Output is written to the same directory as INPUT_CSV with a new timestamp suffix.
"""

import csv
import io
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

# Allow importing from sibling directory
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'piedmont_native_classifier'))
from piedmont_check import check

DEFAULT_INPUT = os.path.expanduser(
    '~/Downloads/original-updated-full-ai/plants.improved.20260316_152831.csv'
)
DEFAULT_WORKERS = 10


def reclassify(input_path, n_workers):
    with open(input_path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        rows = list(reader)

    if 'piedmont_native' not in fieldnames:
        sys.exit(f"No 'piedmont_native' column found in {input_path}")

    # Use latin column if present, otherwise fall back to common (which may be "Latin (Common)")
    def get_latin(row):
        return row.get('latin', '').strip() or row.get('common', '').strip()

    # Only process rows that have something to look up
    to_check = [(i, row) for i, row in enumerate(rows) if get_latin(row)]
    skipped  = len(rows) - len(to_check)
    print(f"Rows total: {len(rows)}  |  to classify: {len(to_check)}  |  skipping (no latin): {skipped}")

    results  = {}   # index → new piedmont_native value (bool or original string on error)
    errors   = []   # (index, common, latin, error_msg)
    done     = 0

    def classify_row(idx, row):
        latin = get_latin(row)
        native, non_native, total, ratio, is_native = check(latin)
        return idx, is_native, ratio, total

    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        futures = {pool.submit(classify_row, i, row): (i, row) for i, row in to_check}
        for fut in as_completed(futures):
            i, row = futures[fut]
            done += 1
            try:
                idx, is_native, ratio, total = fut.result()
                old = row['piedmont_native']
                new = str(is_native).lower()   # 'true' / 'false'
                changed = old.lower() not in ('', new)
                results[idx] = new
                flag = ' ← CHANGED' if changed else ''
                print(f"  [{done}/{len(to_check)}] {row['common'] or row['latin']:<45} "
                      f"{'YES' if is_native else 'NO':>3}  ({ratio*100:.0f}%, {total} px)  "
                      f"was={old}{flag}")
            except Exception as e:
                errors.append((i, row.get('common', ''), row.get('latin', ''), str(e)))
                results[i] = row['piedmont_native']  # keep original on error
                print(f"  [{done}/{len(to_check)}] ERROR {row.get('latin', '')}: {e}")

    # Apply results
    for i, row in enumerate(rows):
        if i in results:
            row['piedmont_native'] = results[i]

    # Write output
    stem = os.path.basename(input_path)
    # Strip existing timestamp suffix if present: plants.improved.YYYYMMDD_HHMMSS.csv
    base = stem.rsplit('.', 2)[0] if stem.count('.') >= 2 else stem.rsplit('.', 1)[0]
    ts   = datetime.now().strftime('%Y%m%d_%H%M%S')
    out_name = f"{base}.{ts}.csv"
    out_path = os.path.join(os.path.dirname(input_path), out_name)

    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\nWrote {len(rows)} rows → {out_path}")
    if errors:
        print(f"\n{len(errors)} BONAP errors (original value kept):")
        for _, common, latin, msg in errors:
            print(f"  {common} / {latin}: {msg}")


if __name__ == '__main__':
    args    = [a for a in sys.argv[1:] if not a.startswith('--')]
    workers = DEFAULT_WORKERS
    for i, a in enumerate(sys.argv[1:]):
        if a == '--workers' and i + 2 < len(sys.argv):
            workers = int(sys.argv[i + 2])

    input_path = os.path.expanduser(args[0]) if args else DEFAULT_INPUT
    if not os.path.exists(input_path):
        sys.exit(f"Input not found: {input_path}")

    reclassify(input_path, workers)
