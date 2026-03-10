#!/usr/bin/env python3
"""
Enrichment prompt test harness.

Generates the exact system + user prompts that the production site sends to
the AI, using real NCSU scrapes and the same buildPrompt() logic as enrich.js.
Output is printed for a human or subagent to respond to, then evaluated.

Workflow:
    1. Run this script to generate prompts.
    2. Paste each prompt into a subagent — ask it to respond as the AI would,
       then compare its JSON output to the ground truth printed below each prompt.
    3. Feed the comparison back to Claude for prompt tuning.

Usage:
    python tests/enrich_test.py              # 5 random plants, seed=42
    python tests/enrich_test.py --n 10       # 10 random plants
    python tests/enrich_test.py --seed 7     # different random sample

No API key required. No external dependencies beyond the standard library.

How to keep in sync with enrich.js:
    - SYSTEM_MSG  → system message in callOpenAI()
    - JSON_SHAPE  → JSON shape in buildPrompt()
    - RULES       → rules string in buildPrompt()
    - fetch_ncsu()  mirrors tryFetchText() for NCSU
    - fetch_usda()  mirrors fetchUsdaJson() (POST, not GET)
"""

import argparse
import csv
import json
import random
import re
import sys
import urllib.request
import urllib.parse
from pathlib import Path

PLANTS_CSV = Path(__file__).parent.parent / "initial_info" / "email2" / "plants.csv"

# ── Prompt constants (keep in sync with public/js/enrich.js) ──────────────────

SYSTEM_MSG = (
    "You are a botanist filling in plant sale sign data. "
    "Use the reference data provided from approved sources "
    "(NCSU Plant Toolbox, USDA PLANTS Database, Prairie Moon Nursery, "
    "FSUS, Missouri Botanical Garden) and your own botanical knowledge. "
    "Return only valid JSON, no other text."
)

JSON_SHAPE = {
    "latin": "genus species [cultivar if applicable] — species name only, no taxonomic author citations",
    "attributes_line": "Size: H ft tall x W ft wide; Bloom: color, season; Soil: type; Native range: Continent[, NC native]; USDA zone: #-#; Deer Resistance: yes/moderate/no",
    "highlight_line": "sentence 1: distinctive sensory, structural, or garden trait. sentence 2: ecological or wildlife value.",
    "sun_level": "full_sun OR part_shade OR shade",
    "moisture": "wet OR average OR drought",
    "is_pollinator": "true or false",
    "is_deer_resistant": "true or false",
}

RULES = "\n".join([
    "Rules:",
    '- latin: genus + species only (e.g. "Actaea racemosa"). Include cultivar name in quotes if named cultivar. Never add author citations like "(Pursh) Kuntze".',
    "- attributes_line: each segment 6 words or fewer. Semicolons between segments, no trailing semicolon.",
    '- Size: full height range × full width range from source (e.g. "1-3 ft tall x 1-2 ft wide"). Use ft for plants over 1 ft; use in for smaller dimensions.',
    '- Bloom color: Bloom segment = color + season ONLY — no form descriptors (not "clusters", "button-like", "tubular"). Allowed plain English colors: white, lavender, purple, pink, red, orange, yellow, blue, green. Multiple colors: two most prominent separated by "/" (e.g. "white/yellow"). No modifiers like "pale" or "bright".',
    '- Bloom season: Spring / early Summer / mid Summer / late Summer / early Fall / Fall. "mid-late Summer" valid. Use "early"/"mid"/"late" when bloom < half a season. Multi-season: anchor to peak/starting season — prefer "early Fall" over "late Summer" when bloom continues into fall.',
    '- Soil: texture/drainage first, then notable tolerance (e.g. "moist, well-drained" or "well-drained, drought tolerant"). 6 words or fewer.',
    '- Native range: "North America, NC native" only if botanically NC native. "North America" if continental but not NC. "Asia", "Europe", etc. Never list US states. Sold in NC ≠ NC native.',
    '- USDA zone: numeric range only e.g. "4-8". Trust the source.',
    '- Deer Resistance: exactly "yes", "moderate", or "no".',
    "- highlight_line: 2 sentences. First: specific sensory/structural/unusual trait (fragrance, bloom shape, color, texture). Second: wildlife value, ecological role, cultural/historical use, or landscape use. Name host species when known. May use botanical knowledge beyond scraped data.",
    '- sun_level: dominant light. Full sun + part shade → "part_shade". Full sun only → "full_sun". Part shade or shade only → "shade".',
    '- moisture: "wet"=consistently moist/wet; "drought"=drought-tolerant (not just "occasionally dry"); "average"=typical, occasionally dry, or moist-but-not-wet. When in doubt use "average".',
    "- is_pollinator: true only if documented larval host OR primary nectar/pollen source for native bees, butterflies, or hummingbirds. Vague 'attracts insects' language = false.",
    '- is_deer_resistant: true only if Deer Resistance = "yes". "moderate" → false. false if not mentioned.',
    "- is_pollinator and is_deer_resistant: JSON booleans (true/false, not strings).",
])

# ── Source fetchers (mirror enrich.js fetchAllSources) ────────────────────────

def fetch_text(label: str, url: str, max_chars: int = 1000) -> str:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            html = r.read().decode("utf-8", errors="replace")
        text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL)
        text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"[<>]", " ", text)
        text = re.sub(r"\s+", " ", text).strip()[:max_chars]
        print(f"  ✓ {label}: {len(text)} chars", file=sys.stderr)
        return f"[{label}]\n{text}"
    except Exception as e:
        print(f"  ✗ {label}: {e}", file=sys.stderr)
        return ""


def fetch_usda(latin_name: str) -> str:
    try:
        payload = json.dumps({"Text": latin_name}).encode()
        req = urllib.request.Request(
            "https://plantsservices.sc.egov.usda.gov/api/PlantSearch",
            data=payload,
            headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        results = [r for r in (data.get("PlantResults") or []) if r.get("Symbol")]
        if not results:
            print(f"  ✗ USDA: no results for '{latin_name}'", file=sys.stderr)
            return ""
        p = results[0]
        parts = []
        if p.get("Durations"):    parts.append(f"Duration: {', '.join(p['Durations'])}")
        if p.get("GrowthHabits"): parts.append(f"Growth habit: {', '.join(p['GrowthHabits'])}")
        ch = p.get("Characteristics") or {}
        if ch.get("ShadeTolerance"):   parts.append(f"Shade tolerance: {ch['ShadeTolerance']}")
        if ch.get("MoistureUse"):      parts.append(f"Moisture use: {ch['MoistureUse']}")
        if ch.get("DroughtTolerance"): parts.append(f"Drought tolerance: {ch['DroughtTolerance']}")
        if not parts:
            return ""
        print(f"  ✓ USDA: {len(parts)} fields", file=sys.stderr)
        return f"[USDA Plants API]\n{'; '.join(parts)}"
    except Exception as e:
        print(f"  ✗ USDA: {e}", file=sys.stderr)
        return ""


def fetch_all_sources(plant: dict) -> str:
    latin  = plant.get("latin_query", "")
    slug   = re.sub(r"[^a-z0-9]+", "-", latin.lower()).strip("-")
    common_slug = re.sub(r"[^a-z0-9]+", "-", plant["common"].lower()).strip("-")

    parts = [
        fetch_usda(latin),
        fetch_text("NCSU", f"https://plants.ces.ncsu.edu/plants/{slug}/"),
        fetch_text("NCSU (common)", f"https://plants.ces.ncsu.edu/plants/{common_slug}/"),
        fetch_text("Prairie Moon", f"https://www.prairiemoon.com/{slug}.html"),
        fetch_text("FSUS", f"https://fsus.ncbg.unc.edu/plants/{slug}"),
        fetch_text("MBG", f"https://www.missouribotanicalgarden.org/PlantFinder/PlantFinderListPage.aspx?basic={urllib.parse.quote(latin)}"),
    ]
    return "\n\n".join(p for p in parts if p)


# ── Prompt builder (mirrors buildPrompt() in enrich.js) ───────────────────────

def build_prompt(plant: dict, context: str) -> str:
    lines = [
        f"Plant common name: {plant['common']}",
        f"Squarespace description: {plant.get('description') or '(none)'}",
        f"Tags: {plant.get('tags') or '(none)'}",
    ]
    if context:
        lines.append("\nReference data from approved sources:\n" + context)
    lines += [
        "",
        "Return this exact JSON shape (replace ALL placeholder text with real values):",
        json.dumps(JSON_SHAPE, indent=2),
        "",
        RULES,
    ]
    return "\n".join(lines)


# ── Load plants from plants.csv ───────────────────────────────────────────────

def derive_sun(cats: str) -> str:
    c = cats.lower()
    if "/sun" in c and "/part-shade" in c: return "part_shade"
    if "/part-shade" in c:                 return "part_shade"
    if "/sun" in c:                        return "full_sun"
    if "/shade" in c:                      return "shade"
    return ""

def derive_moisture(cats: str) -> str:
    c = cats.lower()
    if "/drought" in c:                              return "drought"
    if "/rain-garden" in c or "/wet" in c:           return "wet"
    return "average"

def load_plants(n: int, seed: int) -> list:
    rows = []
    with open(PLANTS_CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            latin     = (row.get("latin") or "").strip()
            common    = (row.get("common") or "").strip()
            attrs     = (row.get("attributes_line") or "").strip()
            highlight = (row.get("highlight_line") or "").strip()
            if not latin or not common or not attrs or not highlight:
                continue
            cats = (row.get("categories") or "").strip()
            rows.append({
                "common":       common,
                "latin_query":  latin,
                "description":  attrs[:80],
                "tags":         cats.replace("/", "").replace(",", ", ").strip(", ")
                                if cats and cats != "no info provided" else "",
                "truth": {
                    "latin":            latin,
                    "attributes_line":  attrs,
                    "highlight_line":   highlight,
                    "sun_level":        derive_sun(cats),
                    "moisture":         derive_moisture(cats),
                    "is_pollinator":    "/pollinator" in cats.lower(),
                    "is_deer_resistant":"/deer" in cats.lower(),
                },
            })
    return random.Random(seed).sample(rows, min(n, len(rows)))


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Generate enrichment prompts for subagent testing")
    ap.add_argument("--n",    type=int, default=5,  help="Number of random plants (default: 5)")
    ap.add_argument("--seed", type=int, default=42, help="Random seed (default: 42)")
    args = ap.parse_args()

    plants = load_plants(args.n, args.seed)
    print(f"# Enrichment prompt test — {len(plants)} plants, seed={args.seed}", file=sys.stderr)
    print(f"# Plants: {', '.join(p['common'] for p in plants)}\n", file=sys.stderr)

    for i, plant in enumerate(plants, 1):
        print(f"\n{'='*60}", file=sys.stderr)
        print(f"Fetching sources for {plant['common']}...", file=sys.stderr)

        context = fetch_all_sources(plant)

        # Print the prompt to stdout (for piping / pasting to subagent)
        print(f"\n{'#'*60}")
        print(f"# PLANT {i}/{len(plants)}: {plant['common']}")
        print(f"{'#'*60}\n")
        print(f"SYSTEM:\n{SYSTEM_MSG}\n")
        print(f"USER:\n{build_prompt(plant, context)}\n")
        print("GROUND TRUTH (compare after getting AI response):")
        for k, v in plant["truth"].items():
            print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
