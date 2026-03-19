#!/usr/bin/env python3
"""
verify_native_range_merge.py — sanity-check the native-range-merge output

Three checks:

  CHECK 1 — new vs original (lissa-edits-with-highlights.plant)
    For every plant: only target plants (auto-merged, unreviewed, non-AI) may differ.
    For target plants: only the 'description' field may differ.
    All other fields on every row must be byte-identical.

  CHECK 2 — new vs no-merges (lissa-edits-with-highlights-and-no-merges.plant)
    For target plants: the description must differ only in the Native range bullet.
    Every other <li> and the <p> highlight must be identical.

  CHECK 3 — native range actually changed
    For every target plant whose description changed: confirm the native range bullet
    in the new file is different from the no-merges file (i.e. the AI did something).

Usage:
    python3 infosheet_converter/verify_native_range_merge.py
"""

import csv
import io
import re
import sys
import zipfile
from pathlib import Path

DOWNLOADS   = Path.home() / 'Downloads'
ORIGINAL    = DOWNLOADS / 'lissa-edits-with-highlights.plant'
NO_MERGES   = DOWNLOADS / 'lissa-edits-with-highlights-and-no-merges.plant'
NEW         = DOWNLOADS / 'lissa-edits-with-highlights-and-native-range-merges.plant'

# ── helpers ───────────────────────────────────────────────────────────────────

def get_latest_csv(plant_file):
    with zipfile.ZipFile(plant_file) as z:
        csvs = sorted([n for n in z.namelist()
                       if re.match(r'plants\.improved\.\d{8}_\d{6}\.csv$', n, re.I)])
        if not csvs:
            raise ValueError(f'No plants.improved.*.csv in {plant_file}')
        return csvs[-1], z.read(csvs[-1]).decode('utf-8')


def read_rows(plant_file):
    _, text = get_latest_csv(plant_file)
    return list(csv.DictReader(io.StringIO(text)))


def normalize_latin(s):
    s = re.sub(r"\s*[('\"(].*", '', s.lower()).strip()
    return re.sub(r'\s+', ' ', s).strip()


def parse_description(html):
    """Return {'li': [text, ...], 'p': text|None} with HTML tags stripped from values."""
    lis = re.findall(r'<li>(.*?)</li>', html, re.DOTALL | re.IGNORECASE)
    ps  = re.findall(r'<p>(.*?)</p>',  html, re.DOTALL | re.IGNORECASE)
    return {
        'li': [re.sub(r'<[^>]+>', '', li).strip() for li in lis],
        'p':  re.sub(r'<[^>]+>', '', ps[0]).strip() if ps else None,
    }


def native_range_from_desc(html):
    """Extract the native range bullet value, or None."""
    m = re.search(r'<li><strong>Native range:</strong>\s*(.*?)</li>', html,
                  re.IGNORECASE | re.DOTALL)
    return re.sub(r'<[^>]+>', '', m.group(1)).strip() if m else None


def li_without_native_range(parsed):
    """Return the list of <li> texts with the Native range entry removed."""
    return [li for li in parsed['li']
            if not li.lower().startswith('native range:')]


# ── colour helpers ────────────────────────────────────────────────────────────

def ok(msg):   print(f'  \033[32m✓\033[0m {msg}')
def warn(msg): print(f'  \033[33m⚠\033[0m {msg}')
def err(msg):  print(f'  \033[31m✗\033[0m {msg}')


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    for f in (ORIGINAL, NO_MERGES, NEW):
        if not f.exists():
            print(f'ERROR: not found: {f}', file=sys.stderr)
            sys.exit(1)

    orig_rows     = read_rows(ORIGINAL)
    no_merge_rows = read_rows(NO_MERGES)
    new_rows      = read_rows(NEW)

    # Index by normalized latin
    def by_latin(rows):
        return {normalize_latin(r.get('latin', '') or r.get('common', '')): r
                for r in rows}

    orig_idx     = by_latin(orig_rows)
    no_merge_idx = by_latin(no_merge_rows)
    new_idx      = by_latin(new_rows)

    # Identify targets: auto-merged, unreviewed, non-AI in the ORIGINAL
    targets = {
        normalize_latin(r.get('latin', '') or r.get('common', ''))
        for r in orig_rows
        if r.get('source', '') != 'ai_enriched'
        and r.get('description_merged', '').lower() == 'true'
        and r.get('reviewed', '').lower() != 'true'
        and (r.get('latin', '') or r.get('common', '')).strip()
    }

    print(f'Files loaded:')
    print(f'  original  : {ORIGINAL.name}  ({len(orig_rows)} rows)')
    print(f'  no-merges : {NO_MERGES.name}  ({len(no_merge_rows)} rows)')
    print(f'  new       : {NEW.name}  ({len(new_rows)} rows)')
    print(f'  targets   : {len(targets)} auto-merged unreviewed non-AI plants\n')

    errors   = 0
    warnings = 0

    # ── CHECK 1: new vs original ──────────────────────────────────────────────
    print('═' * 60)
    print('CHECK 1 — new vs original: only target descriptions may differ')
    print('═' * 60)

    if set(new_idx) != set(orig_idx):
        extra   = set(new_idx) - set(orig_idx)
        missing = set(orig_idx) - set(new_idx)
        if extra:
            err(f'New file has extra plants: {extra}'); errors += 1
        if missing:
            err(f'New file is missing plants: {missing}'); errors += 1
    else:
        ok(f'Same set of {len(new_idx)} plants in both files')

    non_target_diffs = 0
    target_extra_field_diffs = 0
    target_desc_changed = 0
    target_desc_unchanged = 0

    # Collect per-plant field info for summary
    field_diff_details = []   # (latin, field, orig_val, new_val) for unexpected diffs

    for latin, orig_row in orig_idx.items():
        new_row = new_idx.get(latin)
        if new_row is None:
            continue

        is_target = latin in targets
        fields = list(orig_row.keys())

        for field in fields:
            orig_val = orig_row.get(field, '')
            new_val  = new_row.get(field, '')
            if orig_val == new_val:
                continue

            if not is_target:
                err(f'NON-TARGET changed — {orig_row.get("latin","?")} [{field}]')
                err(f'  was: {orig_val[:120]}')
                err(f'  now: {new_val[:120]}')
                errors += 1
                non_target_diffs += 1
            elif field == 'description':
                target_desc_changed += 1
            else:
                err(f'TARGET non-description field changed — {orig_row.get("latin","?")} [{field}]')
                err(f'  was: {orig_val[:120]}')
                err(f'  now: {new_val[:120]}')
                errors += 1
                target_extra_field_diffs += 1

        if is_target:
            orig_desc = orig_row.get('description', '')
            new_desc  = new_row.get('description', '')
            if orig_desc == new_desc:
                target_desc_unchanged += 1

    if non_target_diffs == 0:
        ok('No non-target plants were modified')
    if target_extra_field_diffs == 0:
        ok('No non-description fields changed on target plants')
    ok(f'{target_desc_changed} target plants have a changed description')
    if target_desc_unchanged:
        warn(f'{target_desc_unchanged} target plants have an UNCHANGED description '
             f'(auto-merge may not have run on them)')
        warnings += 1

    print()

    # ── CHECK 2: new vs no-merges — only native range bullet may differ ───────
    print('═' * 60)
    print('CHECK 2 — new vs no-merges: only Native range bullet may differ')
    print('═' * 60)

    nr_changed   = 0
    nr_unchanged = 0
    other_li_changed = 0
    highlight_changed = 0
    bullet_count_changed = 0

    for latin in targets:
        nm_row  = no_merge_idx.get(latin)
        new_row = new_idx.get(latin)
        if nm_row is None or new_row is None:
            warn(f'Could not find {latin} in both files for CHECK 2')
            warnings += 1
            continue

        nm_desc  = nm_row.get('description', '')
        new_desc = new_row.get('description', '')

        nm_parsed  = parse_description(nm_desc)
        new_parsed = parse_description(new_desc)

        latin_display = new_row.get('latin', latin)

        # Bullet count
        if len(nm_parsed['li']) != len(new_parsed['li']):
            err(f'{latin_display}: bullet count changed '
                f'({len(nm_parsed["li"])} → {len(new_parsed["li"])})')
            errors += 1
            bullet_count_changed += 1
            continue

        # Non-native-range bullets
        nm_other  = li_without_native_range(nm_parsed)
        new_other = li_without_native_range(new_parsed)
        if nm_other != new_other:
            err(f'{latin_display}: non-native-range bullets differ')
            for a, b in zip(nm_other, new_other):
                if a != b:
                    err(f'  was: {a}')
                    err(f'  now: {b}')
            errors += 1
            other_li_changed += 1

        # Highlight <p>
        if nm_parsed['p'] != new_parsed['p']:
            err(f'{latin_display}: highlight paragraph changed')
            err(f'  was: {nm_parsed["p"]}')
            err(f'  now: {new_parsed["p"]}')
            errors += 1
            highlight_changed += 1

        # Native range
        nm_nr  = native_range_from_desc(nm_desc)
        new_nr = native_range_from_desc(new_desc)
        if nm_nr != new_nr:
            nr_changed += 1
        else:
            nr_unchanged += 1

    if other_li_changed == 0:
        ok('No non-native-range bullets changed')
    if highlight_changed == 0:
        ok('No highlight paragraphs changed')
    if bullet_count_changed == 0:
        ok('Bullet counts are identical for all target plants')
    ok(f'{nr_changed} plants have an updated Native range bullet')
    if nr_unchanged:
        warn(f'{nr_unchanged} target plants have an UNCHANGED native range '
             f'(auto-merge may not have run, or AI returned the same value)')
        warnings += 1

    print()

    # ── CHECK 3: show native range before/after for all targets ──────────────
    print('═' * 60)
    print('CHECK 3 — Native range values (no-merges → new)')
    print('═' * 60)

    rows_changed   = []
    rows_unchanged = []

    for latin in sorted(targets):
        nm_row  = no_merge_idx.get(latin)
        new_row = new_idx.get(latin)
        if nm_row is None or new_row is None:
            continue
        nm_nr  = native_range_from_desc(nm_row.get('description', ''))
        new_nr = native_range_from_desc(new_row.get('description', ''))
        latin_display = new_row.get('latin', latin)
        if nm_nr != new_nr:
            rows_changed.append((latin_display, nm_nr, new_nr))
        else:
            rows_unchanged.append((latin_display, nm_nr))

    for latin_display, before, after in rows_changed:
        print(f'  {latin_display}')
        print(f'    before : {before}')
        print(f'    after  : {after}')

    if rows_unchanged:
        print(f'\n  Unchanged ({len(rows_unchanged)}):')
        for latin_display, nr in rows_unchanged:
            print(f'    {latin_display} — {nr}')

    print()

    # ── Summary ───────────────────────────────────────────────────────────────
    print('═' * 60)
    if errors == 0 and warnings == 0:
        print('\033[32mALL CHECKS PASSED\033[0m')
    elif errors == 0:
        print(f'\033[33mPASSED with {warnings} warning(s)\033[0m')
    else:
        print(f'\033[31mFAILED: {errors} error(s), {warnings} warning(s)\033[0m')
    print('═' * 60)

    sys.exit(1 if errors else 0)


if __name__ == '__main__':
    main()
