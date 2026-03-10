# Enrichment Test Suite — Agent Primer

Tests the AI enrichment prompt in `public/js/enrich.js` against ground truth from `initial_info/email2/plants.csv`.

## How to run

```bash
cd /Users/erik/repos/plant-sale/signs

# Generate prompts for 5 random plants (no AI call — paste output into a subagent):
python3 tests/enrich_test.py --dry-run

# Different sample sizes / seeds:
python3 tests/enrich_test.py --n 10 --seed 7 --dry-run

# With an Anthropic API key (runs AI calls directly):
python3 tests/enrich_test.py --api-key sk-ant-...
# or: export ANTHROPIC_API_KEY=sk-ant-... && python3 tests/enrich_test.py
```

Requires: `pip install anthropic` (only needed for non-dry-run mode).

### Subagent workflow (no API key needed)
1. Run `python3 tests/enrich_test.py --dry-run` to get the system + user prompts
2. Spawn a subagent with each prompt, asking it to:
   - Output the JSON it would produce (acting as the AI model)
   - Compare field-by-field to the ground truth shown
   - List any remaining prompt issues
3. Synthesize findings and update the prompt constants in both `enrich.js` and `enrich_test.py`

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

The `plants.csv` `categories` column is inconsistently filled. For `Virginia snakeroot`, the ground truth has `is_pollinator: false` and `is_deer_resistant: false` because the category boxes were left unchecked — but NCSU clearly identifies it as deer-resistant and a larval host for pipevine swallowtail. **The AI output may be more accurate than the ground truth for these fields.**

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
