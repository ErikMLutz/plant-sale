#!/usr/bin/env python3
"""Convert plant infosheets (.docx) to plants.csv

Reads every .docx in the infosheet directory, extracts structured fields,
and writes an enriched plants.csv suitable for upload to the sign generator.

Usage:
    python3 convert.py [INFOSHEET_DIR] [--output OUTPUT_CSV] [--skip-bonap] [--bonap-workers N]

Defaults:
    INFOSHEET_DIR  ../initial_info/email1/2026 plant infosheets/
    --output       ~/Downloads/upload/plants.improved.csv
"""

import csv
import re
import sys
import zipfile
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Import the Piedmont native classifier (sibling directory)
sys.path.insert(0, str(Path(__file__).parent.parent / 'piedmont_native_classifier'))
try:
    from piedmont_check import check as _bonap_check
    from piedmont_check import _clean_latin as _bonap_clean_latin
    BONAP_AVAILABLE = True
except ImportError:
    BONAP_AVAILABLE = False
    print('Warning: could not import piedmont_check — BONAP checks disabled', file=sys.stderr)


# ─── docx reading ─────────────────────────────────────────────────────────────

def read_docx(path: Path) -> str:
    """Extract flat text from a .docx file (strips all XML tags)."""
    with zipfile.ZipFile(path) as z:
        with z.open('word/document.xml') as f:
            xml = f.read().decode('utf-8', errors='replace')
    for entity, char in [
        ('&amp;', '&'), ('&lt;', '<'), ('&gt;', '>'),
        ('&apos;', "'"), ('&quot;', '"'), ('&nbsp;', ' '),
    ]:
        xml = xml.replace(entity, char)
    text = re.sub(r'<[^>]+>', ' ', xml)
    return re.sub(r'\s+', ' ', text).strip()


# ─── field segmentation ───────────────────────────────────────────────────────

# Ordered list of all known infosheet field labels (order controls segmentation)
FIELD_LABELS = [
    'Plant Information',
    'Disclaimer',
    'Common name',
    'Life cycle',
    'Height',
    'Width',
    'Plant spacing',
    'Habitat',
    'Distribution',
    'Native range',
    'USDA plant hardiness zone',
    'Sunlight preference',
    'Soil and moisture preferences',
    'Soil & moisture preferences',
    'Bloom time and color',
    'Cultural notes',
    'Seed sowing and germination instructions',
    'Germination code',
    'Propagation instructions',
    'Natural propagation',
    'Pruning instructions',
    'Wildlife value',
    'Deer resistance',
    'Photo Sources',
]


def segment_fields(text: str) -> dict:
    """Return {lowercase_field_name: cleaned_value} for all found fields."""
    # Find the first occurrence of each known field label
    positions = []
    for fn in FIELD_LABELS:
        pattern = rf'(?<!\w){re.escape(fn)}\s*(?:\([^)]*\))?\s*:'
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            positions.append((m.start(), fn, m.end()))
    positions.sort(key=lambda x: x[0])

    fields = {}
    for i, (_, fn, val_start) in enumerate(positions):
        end = positions[i + 1][0] if i + 1 < len(positions) else len(text)
        val = text[val_start:end].strip()
        # Strip "Source:" / "Sources:" citations (can appear multiple times)
        val = re.sub(r'\.?\s*Sources?:.*$', '', val, flags=re.DOTALL | re.IGNORECASE)
        # Strip inline URLs in parens
        val = re.sub(r'\s*\(https?://[^)]+\)', '', val)
        val = re.sub(r'\s+', ' ', val).strip().strip('., ')
        fields[fn.lower()] = val

    return fields


def get(fields: dict, *keys: str) -> str:
    """Return the first non-empty value for any of the given field keys."""
    for k in keys:
        v = fields.get(k.lower(), '')
        if v:
            return v
    return ''


# ─── measurement helper ───────────────────────────────────────────────────────

def clean_measurement(val: str) -> str:
    """Normalize 'Up to ~7 feet', '6-12 in', '3–4 ft' etc. → 'X ft' or 'X-Y ft'."""
    if not val:
        return ''
    val = val.replace('–', '-').replace('—', '-').replace('~', ' ').strip()

    # Inches → feet
    m = re.match(r'(\d+(?:\.\d+)?)\s*-?\s*(\d+(?:\.\d+)?)?\s*(?:in\b|inches?)', val, re.IGNORECASE)
    if m:
        lo = float(m.group(1))
        hi = float(m.group(2)) if m.group(2) else lo

        def fmt(f):
            return str(int(f)) if f == int(f) else f'{f:.1f}'

        return f'{fmt(lo / 12)}-{fmt(hi / 12)} ft' if lo != hi else f'{fmt(lo / 12)} ft'

    # Feet
    m = re.match(
        r'(?:Up\s+to\s+)?(\d+(?:\.\d+)?)\s*(?:-|to)?\s*(\d+(?:\.\d+)?)?\s*(?:ft\b|feet|foot)',
        val, re.IGNORECASE,
    )
    if m:
        lo, hi = m.group(1), m.group(2)
        return f'{lo}-{hi} ft' if hi else f'{lo} ft'

    # Fallback: first token before semicolons/parens
    return val.split(';')[0].split('(')[0].strip().split()[0] if val else ''


# ─── field normalizers ────────────────────────────────────────────────────────

def normalize_size(fields: dict) -> str:
    h = clean_measurement(get(fields, 'height'))
    w = clean_measurement(get(fields, 'width'))
    if h and w:
        return f'{h} tall x {w} wide'
    if h:
        return f'{h} tall'
    return ''


def normalize_bloom(fields: dict) -> str:
    bloom = get(fields, 'bloom time and color')
    if not bloom or 'information not found' in bloom.lower():
        return ''
    # Take the first segment (before semicolons/parentheticals)
    return bloom.split(';')[0].split('(')[0].strip().rstrip('.')


def normalize_soil(fields: dict) -> str:
    soil = get(fields, 'soil and moisture preferences', 'soil & moisture preferences')
    if not soil or 'information not found' in soil.lower():
        return ''
    # First clause only, capped at 7 words
    part = soil.split(';')[0].strip()
    words = part.split()
    return ' '.join(words[:7]) if len(words) > 7 else part


def normalize_native_range(fields: dict) -> tuple[str, bool, bool]:
    """
    Return (display_string, is_north_american, is_nc_native).

    display_string examples: 'North America, NC native', 'North America', 'Asia'
    """
    nr_raw = get(fields, 'native range')
    nr = nr_raw.lower()
    if not nr:
        return '', False, False

    # NC native?
    not_nc = bool(re.search(r'not native to north carolina|native to north carolina[:\s]+no\b', nr))
    is_nc = not not_nc and bool(re.search(r'native to north carolina|nc native|nc regions', nr))

    # Is it North American?
    not_na = bool(re.search(r'not native to north america|native to north america[:\s]+no\b', nr))

    if not_na:
        # Identify actual origin
        for pat, label in [
            (r'(?:east(?:ern)?\s+)?asia|china|japan|korea', 'Asia'),
            (r'mediterranean|western asia', 'western Asia/Mediterranean'),
            (r'europe\b', 'Europe'),
            (r'south\s+america', 'South America'),
            (r'africa\b', 'Africa'),
        ]:
            if re.search(pat, nr):
                return label, False, False
        m = re.search(r'native to ([A-Za-z ,/]+?)(?:\.|;|$)', nr_raw, re.IGNORECASE)
        return (m.group(1).strip() if m else 'Non-native'), False, False

    display = 'North America, NC native' if is_nc else 'North America'
    return display, True, is_nc


def normalize_zone(fields: dict) -> str:
    zone = get(fields, 'usda plant hardiness zone')
    if not zone or 'information not found' in zone.lower() or 'not found' in zone.lower():
        return ''
    zone = zone.replace('–', '-').replace('—', '-')
    # Match range like "3a-9b" or "4-8"
    m = re.search(r'(\d+)[ab]?\s*-\s*(\d+)[ab]?', zone)
    if m:
        return f'{m.group(1)}-{m.group(2)}'
    m = re.search(r'(\d+)', zone)
    return m.group(1) if m else ''


def normalize_deer(fields: dict) -> str:
    """Return 'yes', 'moderate', 'no', or '' if unknown."""
    deer = get(fields, 'deer resistance').lower()
    if not deer or 'information not found' in deer or 'not found' in deer:
        return ''
    if 'moderate' in deer:
        return 'moderate'
    if 'yes' in deer or 'resistant' in deer:
        return 'yes'
    if re.search(r'\bno\b', deer):
        return 'no'
    return ''


def normalize_sun(fields: dict) -> str:
    """Return 'full_sun', 'part_shade', or 'shade'."""
    sun = get(fields, 'sunlight preference').lower()
    if not sun:
        return ''
    has_full = 'full sun' in sun
    has_partial = bool(re.search(r'partial\s*(?:shade|sun)|part[-\s]shade|dappled', sun))
    has_shade = 'shade' in sun

    if has_full and not has_shade:
        return 'full_sun'
    if has_shade and not has_full and not has_partial:
        return 'shade'
    return 'part_shade'


def normalize_moisture(fields: dict) -> str:
    """Return 'wet', 'average', or 'drought'."""
    soil = get(fields, 'soil and moisture preferences', 'soil & moisture preferences').lower()
    if not soil:
        return ''
    if 'drought tolerant' in soil or re.search(r'\bdry\b', soil):
        return 'drought'
    if 'well-drained' in soil or 'well drained' in soil:
        return 'average'
    if re.search(r'\bwet\b', soil) or ('moist' in soil and 'well' not in soil):
        return 'wet'
    return 'average'


def normalize_pollinator(fields: dict) -> bool:
    wv = get(fields, 'wildlife value').lower()
    return bool(re.search(r'bee|butterfl|pollinator|hummingbird|moth|wasp|lepidoptera', wv))


def normalize_common(fields: dict) -> str:
    name = get(fields, 'common name')
    return name.split(';')[0].strip().rstrip('.')


def normalize_latin(fields: dict, filename: str) -> str:
    info = get(fields, 'plant information')
    if info:
        latin = info.split('Disclaimer')[0].strip().rstrip('.')
        if latin:
            return latin
    # Fallback: filename up to "_infosheet"
    stem = Path(filename).stem
    parts = re.split(r'_infosheet', stem, flags=re.IGNORECASE)[0]
    return parts.replace('_', ' ')


def normalize_highlight(fields: dict) -> str:
    """Use Cultural notes as the highlight line (first 1-2 sentences)."""
    notes = get(fields, 'cultural notes')
    if not notes or 'information not found' in notes.lower():
        return ''
    sentences = re.split(r'(?<=[.!?])\s+', notes.strip())
    result = ' '.join(sentences[:2])
    if len(result) > 220:
        result = result[:217].rsplit(' ', 1)[0] + '...'
    return result


def build_attributes_line(fields: dict) -> tuple[str, bool, bool]:
    """Return (attributes_line, is_north_american, is_nc_native)."""
    nat_display, is_na, is_nc = normalize_native_range(fields)
    parts = []
    if size := normalize_size(fields):
        parts.append(f'Size: {size}')
    if bloom := normalize_bloom(fields):
        parts.append(f'Bloom: {bloom}')
    if soil := normalize_soil(fields):
        parts.append(f'Soil: {soil}')
    if nat_display:
        parts.append(f'Native range: {nat_display}')
    if zone := normalize_zone(fields):
        parts.append(f'USDA zone: {zone}')
    if deer := normalize_deer(fields):
        parts.append(f'Deer Resistance: {deer}')
    return '; '.join(parts), is_na, is_nc


# ─── BONAP Piedmont native check ──────────────────────────────────────────────


def bonap_check_plant(latin: str) -> tuple:
    """
    Run the BONAP Piedmont native check.
    Returns (is_native: bool | None, error: str | None).
    Uses only genus + species (first two words) for the lookup.
    """
    words = _bonap_clean_latin(latin).split()
    if len(words) < 2:
        return None, 'Need at least genus + species'

    species_latin = ' '.join(words)

    try:
        _, _, total, _, is_native = _bonap_check(species_latin)
        if total == 0:
            return False, 'No valid county pixels sampled (map may be missing or offset)'
        return is_native, None
    except Exception as e:
        code = getattr(e, 'code', None)
        return False, f'HTTP {code}' if code else str(e)[:80]


# ─── flag computation ─────────────────────────────────────────────────────────

def compute_flags(plant: dict, bonap_native, bonap_error: str | None) -> tuple:
    """
    Return (flag_for_review: bool, reason_for_review: str).

    Flags are raised for:
    - Latin name contains a parenthetical (may not match Squarespace exactly)
    - BONAP lookup failed
    - Infosheet says NC native but BONAP finds no Piedmont presence
    - BONAP finds Piedmont presence but infosheet doesn't claim NC native
      (only raised for North American plants, since non-natives won't be on BONAP)
    """
    reasons = []

    is_nc_native = plant['_is_nc_native']
    is_north_american = plant['_is_north_american']

    # Latin name has parenthetical — may not match Squarespace product title exactly
    if '(' in plant['latin']:
        reasons.append('Latin name has parenthetical; verify Squarespace match')

    if bonap_error:
        reasons.append(f'BONAP lookup failed: {bonap_error}')
    elif bonap_native is not None:
        if is_nc_native and not bonap_native:
            reasons.append('Infosheet says NC native but BONAP shows no Piedmont presence')
        elif is_north_american and not is_nc_native and bonap_native:
            reasons.append('BONAP shows Piedmont presence but infosheet does not claim NC native')

    return bool(reasons), '; '.join(reasons)


# ─── file priority (prefer revised/finalized versions for same latin name) ────

def file_priority(path: Path) -> int:
    """Higher score = preferred when two files share the same latin name."""
    name = path.stem.upper()
    score = 0
    for suffix, pts in [('LIVE', 4), ('STRICT', 3), ('UPDATED', 2), ('FIX', 2), ('REV', 1)]:
        if suffix in name:
            score += pts
    return score


# ─── per-file processor ───────────────────────────────────────────────────────

def process_infosheet(path: Path) -> dict | None:
    text = read_docx(path)
    fields = segment_fields(text)

    latin = normalize_latin(fields, path.name)
    if not latin:
        return None

    deer = normalize_deer(fields)
    attrs, is_na, is_nc = build_attributes_line(fields)

    return {
        'latin':             latin,
        'common':            normalize_common(fields),
        'attributes_line':   attrs,
        'highlight_line':    normalize_highlight(fields),
        'sun_level':         normalize_sun(fields),
        'moisture':          normalize_moisture(fields),
        'is_pollinator':     normalize_pollinator(fields),
        'is_deer_resistant': deer in ('yes', 'moderate'),
        'source':            'infosheet',
        # Internal — used for flag computation, stripped before CSV write
        '_is_north_american': is_na,
        '_is_nc_native':      is_nc,
    }


# ─── main ─────────────────────────────────────────────────────────────────────

def main():
    script_dir = Path(__file__).parent
    default_infosheet_dir = (
        script_dir.parent / 'initial_info' / 'email1' / '2026 plant infosheets'
    )
    default_output = Path.home() / 'Downloads' / 'upload' / 'plants.improved.csv'

    parser = argparse.ArgumentParser(description='Convert plant infosheets to plants.csv')
    parser.add_argument(
        'infosheet_dir', nargs='?', default=str(default_infosheet_dir),
        help=f'Directory of .docx infosheets (default: {default_infosheet_dir})',
    )
    parser.add_argument(
        '--output', '-o', default=str(default_output),
        help=f'Output CSV path (default: {default_output})',
    )
    parser.add_argument(
        '--skip-bonap', action='store_true',
        help='Skip BONAP Piedmont native checks (faster, offline)',
    )
    parser.add_argument(
        '--bonap-workers', type=int, default=50, metavar='N',
        help='Parallel BONAP requests (default: 50)',
    )
    args = parser.parse_args()

    infosheet_dir = Path(args.infosheet_dir)
    output_path = Path(args.output).expanduser()
    run_bonap = BONAP_AVAILABLE and not args.skip_bonap

    if not infosheet_dir.exists():
        print(f'Error: directory not found: {infosheet_dir}', file=sys.stderr)
        sys.exit(1)

    # ── Phase 1: parse all infosheets ─────────────────────────────────────────
    docx_files = sorted(infosheet_dir.glob('*.docx'))
    print(f'Found {len(docx_files)} .docx files in {infosheet_dir.name}/')

    plants_by_latin: dict = {}   # latin → (plant_dict, priority)
    warnings: list[str] = []

    for path in docx_files:
        try:
            plant = process_infosheet(path)
        except Exception as e:
            warnings.append(f'  ERROR {path.name}: {e}')
            continue

        if not plant:
            warnings.append(f'  SKIP  {path.name}: could not determine latin name')
            continue

        latin = plant['latin']
        priority = file_priority(path)

        if latin in plants_by_latin:
            if priority > plants_by_latin[latin][1]:
                print(f'  DUP   replacing "{latin}" with higher-priority {path.name}')
                plants_by_latin[latin] = (plant, priority)
        else:
            plants_by_latin[latin] = (plant, priority)

    plants = [
        p for p, _ in sorted(plants_by_latin.values(), key=lambda x: x[0]['latin'])
    ]
    print(f'Parsed {len(plants)} unique plants')

    # ── Phase 2: BONAP Piedmont native checks ─────────────────────────────────
    if run_bonap:
        workers = args.bonap_workers
        print(f'\nRunning BONAP checks ({len(plants)} plants, {workers} workers)...')

        # Map latin → plant for result assignment
        plant_by_latin = {p['latin']: p for p in plants}
        completed = 0

        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(bonap_check_plant, p['latin']): p['latin']
                for p in plants
            }
            for future in as_completed(futures):
                latin = futures[future]
                bonap_native, bonap_error = future.result()
                plant = plant_by_latin[latin]
                plant['piedmont_native'] = bonap_native
                plant['_bonap_error'] = bonap_error
                completed += 1

                status = 'ERROR' if bonap_error else ('YES' if bonap_native else 'no ')
                print(f'  [{completed:3}/{len(plants)}] {status}  {latin}' +
                      (f'  ({bonap_error})' if bonap_error else ''))
    else:
        reason = '--skip-bonap' if args.skip_bonap else 'piedmont_check not available'
        print(f'\nSkipping BONAP checks ({reason})')
        for plant in plants:
            plant['piedmont_native'] = ''
            plant['_bonap_error'] = None

    # ── Phase 3: compute review flags ────────────────────────────────────────
    for plant in plants:
        flag, reason = compute_flags(plant, plant['piedmont_native'], plant['_bonap_error'])
        plant['flag_for_review'] = flag
        plant['reason_for_review'] = reason

    # ── Phase 4: write CSV ────────────────────────────────────────────────────
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        'latin', 'common', 'attributes_line', 'highlight_line',
        'sun_level', 'moisture', 'is_pollinator', 'is_deer_resistant',
        'piedmont_native', 'flag_for_review', 'reason_for_review', 'source',
    ]
    # Strip internal _ keys before writing
    for plant in plants:
        for k in list(plant):
            if k.startswith('_'):
                del plant[k]

    with open(output_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(plants)

    if warnings:
        print('\nWarnings:')
        for w in warnings:
            print(w)

    flagged = sum(1 for p in plants if p['flag_for_review'])
    print(f'\nWrote {len(plants)} plants ({flagged} flagged for review) → {output_path}')


if __name__ == '__main__':
    main()
