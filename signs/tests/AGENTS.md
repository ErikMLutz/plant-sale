# Enrichment Test Suite — Agent Primer

Tests the AI enrichment prompt in `public/js/enrich.js` against ground truth from `initial_info/email2/plants.csv`.

## How to run

```bash
cd /Users/erik/repos/plant-sale/signs

# Generate prompts for 5 random plants:
python3 tests/enrich_test.py

# Different sample sizes / seeds:
python3 tests/enrich_test.py --n 10 --seed 7
```

No API key required. No external dependencies.

### Testing workflow
1. Run the script — prompts print to stdout, fetch status to stderr
2. For each plant, spawn a subagent with the printed SYSTEM + USER prompt, asking it to:
   - Output the JSON it would produce (acting as the production AI)
   - Compare field-by-field to the ground truth printed below
   - List remaining prompt issues
3. Synthesize findings across all plants
4. Update prompt constants in **both** `enrich.js` and `enrich_test.py`
5. Re-run with a different `--seed` to validate on a fresh sample

## What it tests

For each test plant it:
1. Fetches NCSU Plant Toolbox (same URL as the browser does)
2. Attempts USDA PlantSearch POST API
3. Builds the exact same prompt as `buildPrompt()` in `enrich.js`
4. Calls `claude-sonnet-4-6` at `temperature=0` (simulating `gpt-4o-mini` at `temperature=0.2`)
5. Compares field-by-field against ground truth from `plants.csv`

## Keeping enrich.js and enrich_test.py in sync

**When you change the prompt in `enrich.js`, update these constants in `enrich_test.py` to match:**

| `enrich.js` | `enrich_test.py` |
|---|---|
| `SYSTEM_MSG` string in `callOpenAI()` | `SYSTEM_MSG` constant |
| `JSON_SHAPE` object in `buildPrompt()` | `JSON_SHAPE` constant |
| Rules string in `buildPrompt()` | `RULES` constant |
| `fetch_ncsu()` URL pattern | `fetch_ncsu()` function |
| `fetchUsdaJson()` POST logic | `fetch_usda()` function |

## Test plants

| Plant | Why chosen |
|---|---|
| Black cohosh (*Actaea racemosa*) | Common sale plant, NC native, shade/wet |
| Anise hyssop (*Agastache foeniculum*) | Has rich categories data (pollinator, deer, drought) |
| Virginia snakeroot (*Aristolochia serpentaria*) | Unusual plant, ground truth has known data quality issues (categories blank despite being deer-resistant/larval host) |

## Known ground truth caveats

`plants.csv` was hand-assembled and has several known errors. When comparing AI output to GT, check these first:

| Plant | Field | GT value | Correct value | Notes |
|---|---|---|---|---|
| Virginia snakeroot | width | `1-15 ft` | `1-2 ft` | Typo for 1–1.5 ft; NCSU says 1–2 ft |
| Virginia snakeroot | USDA zone | `4-8` | `5-9` | NCSU reports 5a–9b |
| Virginia snakeroot | `is_pollinator` | `false` | `true` | NCSU lists larval host for pipevine swallowtail |
| Virginia snakeroot | `is_deer_resistant` | `false` | `true` | NCSU explicitly lists deer resistance |
| Piedmont Barbara's Buttons | width | `12-18 ft` | `12-18 in` | Unit typo; plant is 1-2 ft tall |
| Piedmont Barbara's Buttons | highlight color | `White` | pink/lavender | GT says "White, daisy-like" — plant is actually pink/lavender |
| Piedmont Barbara's Buttons | Deer Resistance | `moderate` | `no` | No source confirms deer resistance; attributes and boolean contradict |
| Hollow Joe-Pye Weed | `moisture` | `average` | `wet` | Source says "consistently moist/moist to wet" — clearly wet |
| Hollow Joe-Pye Weed | `is_pollinator` | `false` | `true` | NCSU: "major nectar source for monarchs, swallowtails, native bees" |
| Hollow Joe-Pye Weed | `is_deer_resistant` | `false` | `false` | Correct — "moderate" resistance maps to false per rule |
| Lady Banks' rose | Native range | `North America` | `Asia` | Rosa banksiae is native to China; NCSU confirms |
| Lady Banks' rose | `is_deer_resistant` | `false` | `true` | GT attributes_line says "yes" — boolean contradicts text |
| Black cohosh | `is_pollinator` | `false` | `false` | Correct — "attracts bees" is general; not a primary source |
| Black cohosh | USDA zone | `4-8` | debated | NCSU 3a–8b; GT conservatively clips to 4–8 |
| Various | `sun_level` | (blank) | inferred | GT often left blank; AI should infer from NCSU source |

**General rule:** When AI output cites NCSU data and differs from GT, the AI is likely correct. `categories` column and boolean fields (`is_pollinator`, `is_deer_resistant`) are the least reliable GT fields.

## Alternative: subagent testing (no API key needed)

If the Anthropic API key is unavailable, spawn a subagent with the exact system + user prompt and ask it to:
1. Output the JSON response it would produce
2. Compare to ground truth
3. List remaining issues

Use the output of `build_prompt()` (printed by the test script) as the prompt to pass to the subagent.

## Current prompt status (after round 2 tuning, March 2026)

### ✅ Fixed
- Latin name: no taxonomic authority
- Bloom color: plain English list now includes `lavender`; Bloom = color + season ONLY (no form descriptors)
- Bloom color multi: "/" separator for two colors (e.g. "white/yellow")
- Bloom season: early/mid/late prefix; multi-season anchoring
- Size: full range (1-3 ft), not max-only
- Soil: texture/drainage + tolerance; 6-word cap
- Native range: botanically NC native only; "USA" not valid
- moisture: "occasionally dry" → `average`; "consistently moist" → `wet`
- is_pollinator: now explicitly includes butterflies; vague "attracts" language = false
- is_deer_resistant: "moderate" Deer Resistance → false (now explicit)
- sun_level: "full sun only → full_sun" case added
- Highlight: sensory → wildlife/cultural/landscape; may use botanical knowledge

### ⚠️ Still limited by data sources
- USDA API: POST endpoint works but returns empty for most plants — NCSU is the primary working source
- Prairie Moon / FSUS / MBG: 404 or down — no data currently
- NCSU HTML: Python regex stripping leaves nav artifacts; browser version strips better via DOM
- GT has many blank sun_level fields — AI infers from source, which is correct behavior
