#!/usr/bin/env python3
"""
revert_unreviewed.py — create lissa-edits-with-highlights-and-no-merges.plant

For each auto-merged, unreviewed, non-ai-enriched plant in lissa-edits-with-highlights.plant:
  - Reverts description to the original infosheet text (no AI enrichment)
  - Sets description_merged=false so the site's auto-merge will update native range only
    (the site uses gpt-4o-mini via the OpenAI key already entered there)

All other plants (reviewed, ai_enriched, unmatched infosheets) are kept as-is.

Output: ~/Downloads/lissa-edits-with-highlights-and-no-merges.plant

Usage:
    python3 infosheet_converter/revert_unreviewed.py
"""

import csv
import io
import re
import sys
import zipfile
from datetime import datetime
from pathlib import Path

# ── Path setup ───────────────────────────────────────────────────────────────

SCRIPT_DIR    = Path(__file__).parent
REPO_ROOT     = SCRIPT_DIR.parent
INFOSHEET_DIR = REPO_ROOT / 'initial_info' / 'email1' / '2026 plant infosheets'
DOWNLOADS     = Path.home() / 'Downloads'
INPUT_PLANT   = DOWNLOADS / 'lissa-edits-with-highlights.plant'
OUTPUT_PLANT  = DOWNLOADS / 'lissa-edits-with-highlights-and-no-merges.plant'

# Add convert.py to sys.path
sys.path.insert(0, str(SCRIPT_DIR))
from convert import (
    read_docx, segment_fields,
    build_attributes_line, normalize_highlight,
    file_priority,
)

# ── CSV helpers ───────────────────────────────────────────────────────────────


def get_latest_csv(plant_file):
    with zipfile.ZipFile(plant_file) as z:
        csvs = sorted([n for n in z.namelist()
                       if re.match(r'plants\.improved\.\d{8}_\d{6}\.csv$', n, re.I)])
        if not csvs:
            raise ValueError(f'No plants.improved.*.csv found in {plant_file}')
        return csvs[-1], z.read(csvs[-1]).decode('utf-8')


def get_ss_inventory(plant_file):
    with zipfile.ZipFile(plant_file) as z:
        for name in z.namelist():
            if not re.match(r'plants\.improved\.\d{8}_\d{6}\.csv$', name, re.I):
                return name, z.read(name).decode('utf-8')
    raise ValueError(f'No SS inventory found in {plant_file}')


def read_csv_rows(text):
    return list(csv.DictReader(io.StringIO(text)))


def write_csv(rows, fieldnames):
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames, lineterminator='\n',
                            quoting=csv.QUOTE_ALL, extrasaction='ignore')
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()


# ── Name normalization ────────────────────────────────────────────────────────


def normalize_latin_key(s):
    """Lowercase, strip cultivar/parens, collapse whitespace."""
    s = re.sub(r"\s*[('\"(].*", '', s.lower()).strip()
    return re.sub(r'\s+', ' ', s).strip()


def latin_from_filename(path: Path) -> str:
    """Extract genus+species from filename: 'Asarum_canadense_infosheet_2026.docx' → 'Asarum canadense'."""
    stem = path.stem
    parts = re.split(r'_infosheet', stem, flags=re.IGNORECASE)[0]
    return parts.replace('_', ' ').strip()


# ── HTML builder (mirrors parse.js attributesLineToHtml) ─────────────────────


def attributes_line_to_html(attributes_line, highlight_line):
    items = [s.strip() for s in (attributes_line or '').split(';') if s.strip()]
    html = ''
    if items:
        lis = []
        for item in items:
            colon = item.find(':')
            if colon == -1:
                lis.append(f'<li>{item}</li>')
            else:
                label = item[:colon].strip()
                value = item[colon + 1:].strip()
                lis.append(f'<li><strong>{label}:</strong> {value}</li>')
        html += '<ul>' + ''.join(lis) + '</ul>'
    if highlight_line and highlight_line.strip():
        html += f'<p>{highlight_line.strip()}</p>'
    return html


# ── Main ──────────────────────────────────────────────────────────────────────


def main():
    if OUTPUT_PLANT.exists():
        print(f'ERROR: output already exists: {OUTPUT_PLANT}', file=sys.stderr)
        sys.exit(1)

    if not INPUT_PLANT.exists():
        print(f'ERROR: input not found: {INPUT_PLANT}', file=sys.stderr)
        sys.exit(1)

    if not INFOSHEET_DIR.exists():
        print(f'ERROR: infosheet directory not found: {INFOSHEET_DIR}', file=sys.stderr)
        sys.exit(1)

    # ── Load input .plant file ────────────────────────────────────────────────
    csv_name, csv_text = get_latest_csv(str(INPUT_PLANT))
    ss_inv_name, ss_inv_text = get_ss_inventory(str(INPUT_PLANT))
    rows = read_csv_rows(csv_text)
    fieldnames = list(rows[0].keys())

    print(f'Input CSV    : {csv_name}')
    print(f'SS inventory : {ss_inv_name}')
    print(f'Total plants : {len(rows)}')

    # ── Identify targets (auto-merged, unreviewed, non-ai-enriched) ───────────
    target_latin_keys = set()
    for r in rows:
        if (r.get('source', '') != 'ai_enriched'
                and r.get('description_merged', '').lower() == 'true'
                and r.get('reviewed', '').lower() != 'true'):
            latin = r.get('latin', '').strip()
            if latin:
                target_latin_keys.add(normalize_latin_key(latin))

    print(f'Targets      : {len(target_latin_keys)} auto-merged unreviewed (non-AI) plants\n')

    # ── Build infosheet index by latin key (from filename) ────────────────────
    print(f'Indexing infosheets from {INFOSHEET_DIR.name}/ ...')
    infosheet_index = {}  # latin_key → (path, priority)
    for path in sorted(INFOSHEET_DIR.glob('*.docx')):
        raw_latin = latin_from_filename(path)
        priority  = file_priority(path)
        words     = normalize_latin_key(raw_latin).split()
        keys      = [' '.join(words[:2])] if len(words) >= 2 else []
        if len(words) >= 3:
            keys.append(' '.join(words))
        for key in keys:
            if key not in infosheet_index or priority > infosheet_index[key][1]:
                infosheet_index[key] = (path, priority)

    print(f'Indexed {len(infosheet_index)} infosheet keys\n')

    # ── Process each target ───────────────────────────────────────────────────
    stats = {'reverted': 0, 'no_infosheet': 0}

    for row in rows:
        latin_raw = row.get('latin', '').strip()
        latin_key = normalize_latin_key(latin_raw)

        if latin_key not in target_latin_keys:
            continue

        # Find infosheet — try full key, then genus+species only
        infosheet_path = None
        words = latin_key.split()
        for candidate in ([latin_key] if len(words) <= 2 else [latin_key, ' '.join(words[:2])]):
            if candidate in infosheet_index:
                infosheet_path = infosheet_index[candidate][0]
                break

        if not infosheet_path:
            print(f'  NO INFOSHEET : {latin_raw} — keeping original, clearing merge flag')
            stats['no_infosheet'] += 1
            row['description_merged'] = 'false'
            continue

        # Parse infosheet and build original description HTML
        try:
            text   = read_docx(infosheet_path)
            fields = segment_fields(text)
        except Exception as e:
            print(f'  PARSE ERROR  : {infosheet_path.name}: {e} — keeping original')
            stats['no_infosheet'] += 1
            row['description_merged'] = 'false'
            continue

        attrs, _is_na, _is_nc = build_attributes_line(fields)
        highlight = normalize_highlight(fields)

        row['description']        = attributes_line_to_html(attrs, highlight)
        row['description_merged'] = 'false'   # site will do native-range-only merge
        stats['reverted'] += 1
        print(f'  REVERTED     : {latin_raw}')

    # ── Write output .plant ───────────────────────────────────────────────────
    timestamp    = datetime.now().strftime('%Y%m%d_%H%M%S')
    new_csv_name = f'plants.improved.{timestamp}.csv'
    new_csv_text = write_csv(rows, fieldnames)

    with zipfile.ZipFile(str(OUTPUT_PLANT), 'w', compression=zipfile.ZIP_DEFLATED) as zout:
        zout.writestr(ss_inv_name, ss_inv_text)
        zout.writestr(new_csv_name, new_csv_text)

    print(f'\nSummary:')
    print(f'  {stats["reverted"]} plants reverted to infosheet descriptions (description_merged=false)')
    print(f'  {stats["no_infosheet"]} had no matching infosheet (kept original, cleared merge flag)')
    print(f'  Native range will be updated by the site auto-merge (OpenAI key required)')
    print(f'\nWritten : {OUTPUT_PLANT}')
    print(f'  {ss_inv_name}')
    print(f'  {new_csv_name}')


if __name__ == '__main__':
    main()
