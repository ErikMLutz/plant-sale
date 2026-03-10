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

The `plants.csv` was hand-assembled and has several known errors. When comparing AI output to ground truth, check these before marking a field wrong:

| Plant | Field | GT value | Correct value | Notes |
|---|---|---|---|---|
| Virginia snakeroot | `attributes_line` width | `1-15 ft` | `1-2 ft` | Typo for 1–1.5 ft; NCSU says 1–2 ft |
| Virginia snakeroot | USDA zone | `4-8` | `5-9` | NCSU reports 5a–9b |
| Virginia snakeroot | `is_pollinator` | `false` | `true` | NCSU explicitly lists larval host for pipevine swallowtail |
| Virginia snakeroot | `is_deer_resistant` | `false` | `true` | NCSU explicitly lists deer resistance |
| Anise hyssop | Native range | `North America` | `North America` | GT correct — plant is Midwest native, not NC native despite being sold here |
| Black cohosh | `is_pollinator` | `false` | debated | NCSU notes bumblebee attraction; per tightened definition (general attraction ≠ pollinator), false is defensible |
| Black cohosh | USDA zone | `4-8` | `3-8` or `4-8` | NCSU lists 3a–8b; GT clips to 4–8 as a conservative estimate |

**General rule:** When AI output differs from GT and the AI cites source data (NCSU), the AI is likely correct. The GT categories column is the least reliable field.

## Alternative: subagent testing (no API key needed)

If the Anthropic API key is unavailable, spawn a subagent with the exact system + user prompt and ask it to:
1. Output the JSON response it would produce
2. Compare to ground truth
3. List remaining issues

Use the output of `build_prompt()` (printed by the test script) as the prompt to pass to the subagent.

## Current known issues / prompt status

After round 1 of tuning (March 2026):
- ✅ Latin name: no taxonomic authority appended
- ✅ Bloom color: plain English enforced
- ✅ Bloom season: early/late prefix rule added
- ✅ Highlight structure: sensory first, wildlife second
- ✅ is_pollinator / is_deer_resistant: explicit JSON boolean rule
- ⚠️ USDA API: POST works but returns empty results for most plants — NCSU is the main working source
- ⚠️ Prairie Moon / FSUS / MBG: all return 404 or are down — no data from these currently
- ⚠️ NCSU raw HTML: browser DOM stripping removes nav better than Python regex; the 1000-char window may cut off useful content
- ⚠️ USDA zone: NCSU reports zone 5–9 for some plants, ground truth expects 4–8 — prefer wider range when sources conflict
