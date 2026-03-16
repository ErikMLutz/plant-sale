#!/usr/bin/env python3
"""
migrate_plants_csv.py — Convert old enriched plants.csv format to new SS-first format.

Input:  ~/Downloads/upload/plants.improved.csv  (old format)
Output: ~/Downloads/upload/plants.improved.<YYYYMMDD_HHMMSS>.csv  (new format)

Old columns kept: common, latin, piedmont_native, flag_for_review, reason_for_review, source
Old columns dropped: sun_levels, moisture, is_pollinator, is_deer_resistant
New columns generated:
  - description: HTML from attributes_line + highlight_line
  - description_merged: false (not yet merged against SS)

HTML format:
  <ul><li><strong>Label:</strong> value</li>...</ul><p>Highlight text.</p>
"""

import csv
import sys
import os
from datetime import datetime
from pathlib import Path


def attributes_line_to_html(attributes_line: str, highlight_line: str) -> str:
    """Convert semicolon-delimited attributes_line + highlight_line to HTML description."""
    items = [s.strip() for s in (attributes_line or '').split(';') if s.strip()]
    html = ''
    if items:
        lis = []
        for item in items:
            colon_idx = item.find(':')
            if colon_idx == -1:
                lis.append(f'<li>{item}</li>')
            else:
                label = item[:colon_idx].strip()
                value = item[colon_idx + 1:].strip()
                lis.append(f'<li><strong>{label}:</strong> {value}</li>')
        html += '<ul>' + ''.join(lis) + '</ul>'
    if highlight_line and highlight_line.strip():
        html += f'<p>{highlight_line.strip()}</p>'
    return html


def migrate(input_path: Path, output_path: Path) -> None:
    print(f'Reading:  {input_path}')

    with open(input_path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    if not rows:
        print('No rows found — nothing to migrate.')
        return

    old_cols = set(rows[0].keys())
    has_old_format = 'attributes_line' in old_cols or 'highlight_line' in old_cols
    if not has_old_format:
        print('File does not appear to be in old format (no attributes_line or highlight_line columns).')
        print('Is this already in the new format?')
        sys.exit(1)

    new_headers = ['common', 'latin', 'piedmont_native', 'description', 'flag_for_review', 'reason_for_review', 'description_merged', 'source']
    out_rows = []

    skipped = 0
    for row in rows:
        common = row.get('common', '').strip()
        if not common:
            skipped += 1
            continue

        description = attributes_line_to_html(
            row.get('attributes_line', ''),
            row.get('highlight_line', ''),
        )

        raw_source = row.get('source', '')
        source = raw_source if raw_source in ('ai_enriched', 'manually_enriched') else 'csv'

        out_rows.append({
            'common':             common,
            'latin':              row.get('latin', '').strip(),
            'piedmont_native':    row.get('piedmont_native', 'false'),
            'description':        description,
            'flag_for_review':    row.get('flag_for_review', 'false'),
            'reason_for_review':  row.get('reason_for_review', ''),
            'description_merged': 'false',
            'source':             source,
        })

    print(f'Migrated {len(out_rows)} rows ({skipped} skipped — no common name).')

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=new_headers)
        writer.writeheader()
        writer.writerows(out_rows)

    print(f'Written:  {output_path}')


def main():
    upload_dir = Path.home() / 'Downloads' / 'upload'
    input_path = upload_dir / 'plants.improved.csv'

    if len(sys.argv) > 1:
        input_path = Path(sys.argv[1]).expanduser()

    if not input_path.exists():
        print(f'Error: input file not found: {input_path}')
        sys.exit(1)

    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    output_path = input_path.parent / f'plants.improved.{timestamp}.csv'

    migrate(input_path, output_path)


if __name__ == '__main__':
    main()
