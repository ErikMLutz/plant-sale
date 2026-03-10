#!/usr/bin/env python3
"""
Enrichment prompt test harness.

Tests the AI enrichment pipeline against known ground truth from plants.csv.
Mirrors the exact logic in public/js/enrich.js — update both in sync.

Usage:
    python tests/enrich_test.py              # 5 random plants, seed=42
    python tests/enrich_test.py --n 10       # 10 random plants
    python tests/enrich_test.py --seed 7     # different random sample
    python tests/enrich_test.py --n 3 --seed 99

Requirements:
    pip install anthropic

How to keep in sync with enrich.js:
    - SYSTEM_MSG corresponds to the system message in callOpenAI()
    - JSON_SHAPE corresponds to the shape in buildPrompt()
    - RULES corresponds to the rules string in buildPrompt()
    - fetch_ncsu() mirrors tryFetchText() for NCSU
    - fetch_usda() mirrors fetchUsdaJson() — note: needs POST, not GET
    When you change the prompt in enrich.js, update those constants here
    and re-run to verify quality holds.
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

import anthropic

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
    "- Size: use maximum typical height x a representative width range (e.g. '7 ft tall x 2-4 ft wide').",
    "- Bloom color: plain English only — white, purple, yellow, pink, red, orange, blue, green. Avoid compound terms like 'lavender-blue'.",
    '- Bloom season: Spring / early Summer / mid Summer / late Summer / early Fall / Fall. "mid-late Summer" is also valid. Use "early", "mid", or "late" prefix when bloom < half a season. When bloom spans multiple seasons (e.g. July-October), anchor to peak/starting season — prefer "early Fall" over "late Summer" when bloom continues into fall.',
    '- Soil: texture/drainage first, then notable tolerance if applicable (e.g. "moist, well-drained" or "well-drained, drought tolerant"). 6 words or fewer.',
    '- Native range: "North America, NC native" only if botanically native to NC specifically. "North America" if native to continent but not NC. "Asia", "Europe", etc. Never list US states. Being sold at an NC plant sale does not make a plant NC native.',
    '- USDA zone: numeric range only e.g. "4-8". Trust the reference source.',
    '- Deer Resistance: exactly "yes", "moderate", or "no".',
    "- highlight_line: two sentences max. First: specific sensory/structural/unusual trait (fragrance, bloom shape, color, texture). Second: wildlife value, ecological role, notable cultural/historical use, or landscape use. Name host species when known. You may use verified botanical knowledge beyond scraped data.",
    '- sun_level: dominant light. When light spans deep shade to partial shade, use "part_shade". If full sun + part shade listed, use "part_shade".',
    '- moisture: "wet"=moist/wet, "drought"=drought-tolerant, "average"=typical.',
    "- is_pollinator: true only if documented larval host plant OR primary nectar/pollen source for native bees or hummingbirds. General insect attraction = false.",
    "- is_deer_resistant: true only if source explicitly states deer resistance. false if not mentioned.",
    "- is_pollinator and is_deer_resistant: JSON booleans (true/false, not strings).",
])

# ── Source fetchers (mirror enrich.js fetchAllSources) ────────────────────────

def fetch_ncsu(slug: str, max_chars: int = 1000) -> str:
    url = f"https://plants.ces.ncsu.edu/plants/{slug}/"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            html = r.read().decode("utf-8", errors="replace")
        text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL)
        text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()[:max_chars]
        print(f"  ✓ NCSU: {len(text)} chars")
        return f"[NCSU Plant Toolbox]\n{text}"
    except Exception as e:
        print(f"  ✗ NCSU ({url}): {e}")
        return ""


def fetch_usda(latin_name: str) -> str:
    """POST to USDA PlantSearch. Returns structured context string."""
    url = "https://plantsservices.sc.egov.usda.gov/api/PlantSearch"
    try:
        payload = json.dumps({"Text": latin_name}).encode()
        req = urllib.request.Request(
            url, data=payload,
            headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        results = data.get("PlantResults", [])
        if not results or not results[0].get("Symbol"):
            print(f"  ✗ USDA: no results for '{latin_name}'")
            return ""
        p = results[0]
        parts = []
        for key, label in [
            ("Durations",        "Duration"),
            ("GrowthHabits",     "Growth habit"),
            ("NativeStatuses",   "Native status"),
            ("ShadeTolerance",   "Shade tolerance"),
            ("MoistureUse",      "Moisture use"),
            ("DroughtTolerance", "Drought tolerance"),
            ("MinimumTemperature", "Min temp (°F)"),
        ]:
            val = p.get(key)
            if val:
                parts.append(f"{label}: {val}")
        if not parts:
            return ""
        print(f"  ✓ USDA: {len(parts)} fields")
        return f"[USDA Plants API]\n{'; '.join(parts)}"
    except Exception as e:
        print(f"  ✗ USDA: {e}")
        return ""


def fetch_all_sources(plant: dict) -> str:
    """Try all approved sources; return combined context string."""
    slug = plant.get("slug", "")
    latin = plant.get("latin_query", plant.get("common", ""))
    parts = []
    parts.append(fetch_usda(latin))
    parts.append(fetch_ncsu(slug))
    # Prairie Moon, FSUS, MBG — add here when URL formats are confirmed
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


# ── AI call ───────────────────────────────────────────────────────────────────

def call_ai(prompt: str) -> dict:
    client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=700,
        temperature=1,  # Anthropic requires temperature=1 with extended thinking; use default for regular
        system=SYSTEM_MSG,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response.content[0].text
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            return json.loads(m.group())
        raise ValueError(f"Could not parse JSON from response: {raw[:200]}")


# ── Comparison ────────────────────────────────────────────────────────────────

def compare(result: dict, truth: dict) -> dict:
    scores = {}

    # Exact / near-exact string fields
    for field in ["latin", "sun_level", "moisture"]:
        got = str(result.get(field, "")).strip().lower()
        exp = str(truth.get(field, "")).strip().lower()
        scores[field] = "✓" if got == exp else "✗"

    # Boolean fields
    for field in ["is_pollinator", "is_deer_resistant"]:
        scores[field] = "✓" if result.get(field) == truth.get(field) else "✗"

    # attributes_line: check each segment is present
    attr_got = result.get("attributes_line", "").lower()
    attr_scores = {}
    for seg in truth.get("attributes_line", "").split(";"):
        seg = seg.strip()
        key = seg.split(":")[0].strip()
        val_words = seg.split(":", 1)[1].strip().lower().split() if ":" in seg else []
        # Check key present and at least half the value words present
        key_found = key.lower() in attr_got
        val_found = sum(1 for w in val_words if w in attr_got) >= max(1, len(val_words) // 2)
        attr_scores[key] = "✓" if key_found and val_found else "✗"
    scores["attributes"] = attr_scores

    return scores


# ── Load test plants from plants.csv ─────────────────────────────────────────

def derive_sun(cats: str) -> str:
    c = cats.lower()
    if "/sun" in c and "/part-shade" in c:   return "part_shade"
    if "/part-shade" in c:                   return "part_shade"
    if "/sun" in c:                          return "full_sun"
    if "/shade" in c:                        return "shade"
    return ""

def derive_moisture(cats: str) -> str:
    c = cats.lower()
    if "/drought" in c:                             return "drought"
    if "/rain-garden" in c or "/wet" in c:          return "wet"
    return "average"

def load_test_plants(n: int, seed: int) -> list:
    """Load n random plants from plants.csv with enough ground truth data."""
    rows = []
    with open(PLANTS_CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            latin = (row.get("latin") or "").strip()
            common = (row.get("common") or "").strip()
            attrs = (row.get("attributes_line") or "").strip()
            highlight = (row.get("highlight_line") or "").strip()
            if not latin or not common or not attrs or not highlight:
                continue
            cats = (row.get("categories") or "").strip()
            slug = re.sub(r"[^a-z0-9]+", "-", latin.lower()).strip("-")
            rows.append({
                "common": common,
                "slug": slug,
                "latin_query": latin,
                # Simulate minimal Squarespace description from attributes/categories
                "description": attrs[:80] if attrs else "",
                "tags": cats.replace("/", "").replace(",", ", ").strip(", ") if cats and cats != "no info provided" else "",
                "truth": {
                    "latin": latin,
                    "attributes_line": attrs,
                    "highlight_line": highlight,
                    "sun_level": derive_sun(cats),
                    "moisture": derive_moisture(cats),
                    "is_pollinator": "/pollinator" in cats.lower(),
                    "is_deer_resistant": "/deer" in cats.lower(),
                },
            })
    rng = random.Random(seed)
    return rng.sample(rows, min(n, len(rows)))


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Test enrichment prompt against plants.csv ground truth")
    ap.add_argument("--n",        type=int,  default=5,     help="Number of random plants to test (default: 5)")
    ap.add_argument("--seed",     type=int,  default=42,    help="Random seed for plant selection (default: 42)")
    ap.add_argument("--dry-run",  action="store_true",      help="Print prompts only — no AI calls. Paste output into a subagent.")
    ap.add_argument("--api-key",  type=str,  default=None,  help="Anthropic API key (overrides ANTHROPIC_API_KEY env var)")
    args = ap.parse_args()

    import os
    if args.api_key:
        os.environ["ANTHROPIC_API_KEY"] = args.api_key

    test_plants = load_test_plants(args.n, args.seed)
    print(f"Testing {len(test_plants)} plants (seed={args.seed}): {', '.join(p['common'] for p in test_plants)}\n")

    total_checks = 0
    total_pass = 0

    for plant in test_plants:
        print(f"\n{'='*60}")
        print(f"PLANT: {plant['common']}")

        context = fetch_all_sources(plant)
        prompt = build_prompt(plant, context)
        print(f"  Prompt: {len(prompt)} chars, context: {len(context)} chars")

        if args.dry_run:
            print(f"\n--- SYSTEM ---\n{SYSTEM_MSG}\n--- USER ---\n{prompt}\n--- GROUND TRUTH ---")
            for k, v in plant["truth"].items():
                print(f"  {k}: {v}")
            continue

        result = call_ai(prompt)
        scores = compare(result, plant["truth"])

        print("\n  Field results:")
        for field in ["latin", "sun_level", "moisture", "is_pollinator", "is_deer_resistant"]:
            mark = scores[field]
            print(f"    {mark} {field}: got={result.get(field)!r}  expected={plant['truth'][field]!r}")
            total_checks += 1
            if mark == "✓":
                total_pass += 1

        print("  attributes_line segments:")
        for seg, mark in scores["attributes"].items():
            total_checks += 1
            if mark == "✓":
                total_pass += 1
            print(f"    {mark} {seg}")

        print(f"  highlight (AI): {result.get('highlight_line', '')[:110]}")
        print(f"  highlight (GT): {plant['truth']['highlight_line'][:110]}")

    if args.dry_run:
        print("\n(dry-run: no AI calls made. Paste the prompts above into a subagent to test.)")
        return 0

    print(f"\n{'='*60}")
    pct = (100 * total_pass // total_checks) if total_checks else 0
    print(f"OVERALL: {total_pass}/{total_checks} checks passed ({pct}%)")
    return 0 if total_pass == total_checks else 1


if __name__ == "__main__":
    sys.exit(main())
