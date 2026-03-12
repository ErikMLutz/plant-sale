#!/usr/bin/env python3
"""
Check whether a plant is an NC Piedmont native using BONAP county maps.

Usage:
  python3 piedmont_check.py "Andropogon gerardii"
  python3 piedmont_check.py "Coreopsis verticillata" --show-map

Reads the Piedmont region from the red blob painted in bonap_reference_map.png,
samples those pixels on the BONAP species map, skips border/background pixels,
and reports native if ≥10% of valid county pixels show a native-presence color.

Flags:
  --show-map   Open the BONAP map with a red Piedmont outline overlaid.

Requires: Pillow, numpy  (pip install pillow numpy)
"""

import io
import os
import sys
import tempfile
import subprocess
import urllib.parse
import urllib.request

try:
    import numpy as np
    from PIL import Image
except ImportError:
    sys.exit("Missing dependencies: pip install pillow numpy")

REF_MAP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bonap_reference_map.png')

# BONAP colors that indicate native / present in a county
NATIVE_COLORS = {
    (0,   128, 0),   # dark green   — bonafide native
    (0,   255, 0),   # lime green   — native (present)
    (173, 142, 0),   # golden/yellow — adventive or present
}

# Colors to skip — map infrastructure, not county fill
BORDER_COLORS = {
    (0,   0,   0  ),  # black         — county borders
    (169, 169, 169),  # medium gray   — Canada/Mexico
    (153, 204, 255),  # light blue    — ocean/water
    (149, 205, 252),  # light blue variant
    (100, 200, 250),  # light blue variant
}

THRESHOLD = 0.10  # ≥10% of valid county pixels must be native-colored


def _red_mask(arr):
    return (arr[:,:,0] > 200) & (arr[:,:,1] < 50) & (arr[:,:,2] < 50)


def load_piedmont_pixels(ref_path=REF_MAP):
    """Return (x, y) coords of all red pixels in the reference map."""
    arr = np.array(Image.open(ref_path).convert('RGB'))
    coords = np.argwhere(_red_mask(arr))  # (row, col)
    return [(int(c), int(r)) for r, c in coords]  # → (x, y)


def get_outline_pixels(ref_path=REF_MAP):
    """Return red pixels that have at least one non-red neighbor."""
    arr = np.array(Image.open(ref_path).convert('RGB'))
    mask = _red_mask(arr)
    # A red pixel is on the outline if any 4-connected neighbor is not red
    shifted_up    = np.pad(mask, ((1,0),(0,0)), mode='constant')[:-1, :]
    shifted_down  = np.pad(mask, ((0,1),(0,0)), mode='constant')[1:,  :]
    shifted_left  = np.pad(mask, ((0,0),(1,0)), mode='constant')[:, :-1]
    shifted_right = np.pad(mask, ((0,0),(0,1)), mode='constant')[:, 1: ]
    all_neighbors_red = shifted_up & shifted_down & shifted_left & shifted_right
    outline_mask = mask & ~all_neighbors_red
    coords = np.argwhere(outline_mask)
    return [(int(c), int(r)) for r, c in coords]  # → (x, y)


def _fetch_bonap(latin):
    words = latin.strip().split()
    if len(words) < 2:
        raise ValueError(f"Need at least genus + species, got: {latin!r}")
    path = urllib.parse.quote(f"{words[0]} {words[1]}.png", safe="")
    url = f"https://bonap.net/MapGallery/County/{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return Image.open(io.BytesIO(resp.read())).convert("RGB")


def check(latin, ref_path=REF_MAP):
    """Return (native, non_native, total, ratio, is_piedmont_native)."""
    pixels = load_piedmont_pixels(ref_path)
    img = _fetch_bonap(latin)

    native = non_native = 0
    for (x, y) in pixels:
        color = img.getpixel((x, y))
        if color in BORDER_COLORS:
            continue
        if color in NATIVE_COLORS:
            native += 1
        else:
            non_native += 1

    total = native + non_native
    ratio = native / total if total > 0 else 0
    return native, non_native, total, ratio, ratio >= THRESHOLD


def show_map(latin, ref_path=REF_MAP):
    """Open the BONAP map with a red Piedmont outline overlaid."""
    img = _fetch_bonap(latin)
    for (x, y) in get_outline_pixels(ref_path):
        img.putpixel((x, y), (255, 0, 0))
    tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
    img.save(tmp.name)
    subprocess.run(['open', tmp.name])
    return tmp.name


if __name__ == "__main__":
    args  = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}

    if not args:
        print(__doc__)
        sys.exit(1)

    latin = " ".join(args)

    if '--show-map' in flags:
        print(f"Opening map for {latin}…")
        show_map(latin)
        sys.exit(0)

    try:
        native, non_native, total, ratio, is_native = check(latin)
    except urllib.error.HTTPError as e:
        sys.exit(f"BONAP returned HTTP {e.code} for {latin!r} — check the species name")
    except Exception as e:
        sys.exit(f"Error: {e}")

    words = latin.strip().split()
    genus_url = f"https://bonap.net/Napa/TaxonMaps/Genus/County/{words[0]}"
    png_url   = f"https://bonap.net/MapGallery/County/{urllib.parse.quote(words[0] + ' ' + words[1])}.png"

    print(f"{latin}")
    print(f"  Valid county pixels: {total}  ({native} native, {non_native} non-native)")
    print(f"  Piedmont native: {'YES' if is_native else 'NO'}  ({ratio*100:.0f}%)")
    print(f"  BONAP genus page: {genus_url}")
    print(f"  BONAP county map: {png_url}")
