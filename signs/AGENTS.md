# Plant Sale Signs — Agent Primer

## Project Overview

This project builds a **static web app** (`public/index.html`) that generates plant sale signs as a `.pptx` file for a Master Gardener extension fundraiser. The app replaces a manual ChatGPT + Python pipeline with deterministic code and targeted AI calls.

Working directory: `/Users/erik/repos/plant-sale/signs/`

**Background on the original pipeline:** `initial_info/SUMMARY.md` — worth reading for context, but not required for working on the app.

---

## What's Been Built

### `infosheet_converter/` — batch converter from infosheets to plants.csv

```
infosheet_converter/
├── convert.py              — CLI tool; reads all .docx infosheets, writes enriched plants.csv
└── migrate_plants_csv.py   — one-time migration from old format to new SS-first format
```

**Usage (converter):**
```bash
python3 infosheet_converter/convert.py [INFOSHEET_DIR] [--output OUTPUT_CSV] [--skip-bonap] [--bonap-workers N]
```

Defaults: reads `initial_info/email1/2026 plant infosheets/`, writes `~/Downloads/upload/plants.improved.csv`.

**What it does:**
1. Parses each `.docx` infosheet by segmenting labeled fields (`Height:`, `Bloom time and color:`, `Native range:`, etc.)
2. Builds an `attributes_line` deterministically from those fields (no AI)
3. Runs BONAP Piedmont native checks in parallel (default 10 workers) via `piedmont_native_classifier/piedmont_check.py`
4. Computes `flag_for_review` / `reason_for_review` for: BONAP lookup failures, NC native contradictions between infosheet and BONAP, latin names with parentheticals that may not match Squarespace

**Output columns** (new format, loadable by the sign generator app):
`common, piedmont_native, description, flag_for_review, reason_for_review, description_merged, source`

`source` is always `"csv"` for this tool's output. `description_merged` starts as `false`.

**Usage (migration):**
```bash
python3 infosheet_converter/migrate_plants_csv.py [INPUT_CSV]
```
Defaults: reads `~/Downloads/upload/plants.improved.csv`, writes `~/Downloads/upload/plants.improved.<YYYYMMDD_HHMMSS>.csv`.
Converts old `attributes_line` + `highlight_line` → HTML `description` column. Drops `latin`, `sun_levels`, `moisture`, `is_pollinator`, `is_deer_resistant`.

**Why this exists:** the original `plants.csv` was produced by Ali running AI over the infosheets, which introduced hallucinations (e.g. Amorphophallus konjac marked as "NC native"). This tool extracts data directly from the structured infosheet fields.

**BONAP 404s:** some species are missing from BONAP (non-North American plants, or species BONAP hasn't mapped). These default to `piedmont_native: False` and are flagged for review.

**Dependencies:** `pip install pillow numpy` (for BONAP checks)

---

### `piedmont_native_classifier/` — local CLI tool for NC Piedmont native classification

Standalone Python tool that checks whether a plant is native to the NC Piedmont by
fetching its BONAP county distribution map and sampling pixels inside the Piedmont region.

```
piedmont_native_classifier/
├── piedmont_check.py       — CLI entry point
└── bonap_reference_map.png — Andropogon gerardii species map with Piedmont counties
                              painted in red (used to define the sample region)
```

**How it works:**
1. Reads the red-painted blob in `bonap_reference_map.png` to get Piedmont pixel coordinates
2. Fetches the BONAP species county map for the given latin name (`/MapGallery/County/{Genus} {species}.png`)
3. Samples all Piedmont pixels on that map, skipping border/background colors
4. If ≥10% of valid county pixels are dark green, lime green, or golden yellow → **Piedmont native**

**Note on map offsets:** BONAP genus-level maps (`/MapGallery/County/Genus/`) are offset
23px left and 7px up relative to species-level maps. The reference map is a species-level
map (Andropogon gerardii) so no offset correction is needed.

**BONAP color key:**
- `(0, 128, 0)` dark green — bonafide native
- `(0, 255, 0)` lime green — native (present)
- `(173, 142, 0)` golden/yellow — adventive or present
- `(66, 66, 66)` dark gray — not present in this county

**Usage:**
```bash
python3 piedmont_native_classifier/piedmont_check.py "Coreopsis verticillata"
python3 piedmont_native_classifier/piedmont_check.py "Coreopsis verticillata" --show-map
```

`--show-map` fetches the plant's BONAP map, overlays a red outline of the Piedmont region,
and opens it in a temp file for visual verification.

**Dependencies:** `pip install pillow numpy`

**Long-term plan:** batch-process `plants.csv` latin names to populate an `is_piedmont_native`
column, then push that data into Squarespace so it becomes part of the sign source of truth.

---

### `public/` — the app (static site, open `index.html` directly in a browser)

No server, no build step, plain JS split across focused files. Uses **pptxgenjs** via CDN.

```
public/
├── index.html        — HTML structure and script/link tags
├── styles.css        — all styles
└── js/
    ├── config.js     — DEBUG flag, debugState, SLIDE_CONFIG, ICON_CONFIG
    ├── parse.js      — CSV/TSV parsing, legacy matching, Squarespace parsing
    ├── images.js     — fetchForPptx, convertToJpeg, estimateWrappedLines
    ├── pptx.js       — addSignToSlide, generatePPTX, parseAttributes, buildIcons
    └── app.js        — plants[] state, UI handlers, import flow, review table
```

Scripts load in dependency order via plain `<script>` tags at bottom of `<body>`. All globals are shared across files (no modules).

#### App flow

**Step 1 — Import**
- Paste or upload the **Squarespace product export** (TSV or CSV, auto-detected)
- Optionally paste or upload **`plants.csv`** (`plants.improved.*.csv` from a prior run)
- Click Import → parses both, matches plants by name, shows summary
- Squarespace is the single source of truth for tags/categories/photos; plants.csv supplies description + piedmont_native

**Step 2 — AI Enrichment & Description Merge (optional)**
- **Enrich**: fills `description` (HTML) for pending plants via gpt-4o with web search (~$0.03/plant)
- **Merge**: reconciles CSV-derived descriptions against SS data via gpt-4o-mini (~$0.001/plant)
- Both can be done per-row in Step 3 with Auto-enrich / Auto-merge buttons

**Step 3 — Review & Edit**
- Editable table, paginated (10 per page), sorted by: Needs enrichment → AI Enriched → Manually Enriched → plants.csv
- Columns: Source badge, Common Name, Photo, Description (contenteditable HTML), Tags (checkboxes), Categories (checkboxes)
- "Download plants.csv" exports `plants.improved.<datetime>.csv`
- "Download updated SS inventory" exports the original SS export TSV with updated Description/Tags/Categories
- "Generate PPTX (N plants)" button → downloads `.pptx`

#### Key data structures

**Plant object** (app state array `plants[]`):
```js
{
  // From Squarespace (authoritative)
  common, category, tags, photo_urls,
  // Description — HTML; starts as plants.csv description (or SS description if no CSV match)
  description,
  // Original SS description HTML — preserved for merge prompt input only
  ss_description_html,
  // From plants.csv
  piedmont_native, flag_for_review, reason_for_review, description_merged,
  // Derived from SS tags (authoritative)
  sun_levels, moisture, is_pollinator, is_deer_resistant,
  // Enrichment provenance
  source: 'pending' | 'csv' | 'ai_enriched' | 'manually_enriched',
}
```

#### Squarespace export format
- Tab-separated, first row headers
- ~714 unique products (deduplicated by non-empty Title — variant rows have empty Title)
- Key columns: `Title`, `Description` (HTML), `Categories`, `Tags`, `Hosted Image URLs` (space-separated)
- Photos are publicly accessible Squarespace CDN URLs, served as **WebP** — must be converted to JPEG before embedding in PPTX
- Raw rows stored in global `rawSsRows` for the "Download updated SS inventory" function
- All unique tag/category values collected into globals `allSsTags`, `allSsCategories` for checkbox rendering

#### `plants.csv` format
- **New format** (output of "Download plants.csv"): `common, piedmont_native, description, flag_for_review, reason_for_review, description_merged, source`
  - `description` is HTML: `<ul><li><strong>Label:</strong> value</li>...</ul><p>Highlight.</p>`
  - `description_merged` is `true` after AI merge reconciliation
- **Old format** (backward compat — auto-detected by presence of `attributes_line`): `common, attributes_line, highlight_line, ...` — auto-converted to HTML description on load
- Matched to Squarespace by normalized common name (lowercase, alphanumeric only)

---

## PPTX Generation

### Slide layout
- **1 plant per slide**, 7.75" × 4.75" (configurable in `SLIDE_CONFIG`)
- Each slide: photo area (left ~3.0") + content area (right)
- Content: Latin name (italic, small) → Common name (bold, 19pt) → horizontal rule → attribute bullets → highlight text → icon strip

### Key functions
| Function | What it does |
|---|---|
| `addSignToSlide(slide, plant, yOffset, photoData)` | Renders one plant sign onto a slide |
| `parseHtmlToRuns(html)` | Converts HTML description to pptxgenjs run objects (`<ul>/<li>` → bullets, `<p>` → italic paragraph) |
| `estimateWrappedLines(text, widthInches, fontSpec)` | Canvas-based word-wrap line counter (accurate for variable-width fonts) |
| `fetchForPptx(url)` | Fetches CDN image, detects format via magic bytes, converts WebP/GIF → JPEG via Canvas with centered cover crop, returns `"image/jpeg;base64,..."` (no `data:` prefix — pptxgenjs format) |
| `buildIcons(plant)` | Returns icon strip text array from `ICON_CONFIG` |
| `convertToJpeg(dataUri, targetAspect)` | Canvas cover-crop + WebP→JPEG conversion |

### Configuration objects (tune these, not the rendering code)
- `SLIDE_CONFIG` — all dimensions, colors, fonts
- `ICON_CONFIG` — maps sun/moisture/boolean flags to display strings; easy to swap for real images later

### Image fetching
- Squarespace CDN has CORS headers — fetch works from browser
- CDN serves **WebP** regardless of URL extension → must convert via Canvas
- Concurrency limited to **4 parallel fetches** (CPU-bound Canvas conversion; tune `CONCURRENCY` constant)
- Progress bar updates as each image completes

### Common name line wrapping
- Uses `estimateWrappedLines()` with Canvas font metrics (much more accurate than char-count estimates)
- Available width multiplied by **0.88** to compensate for PowerPoint's internal text box padding and slightly wider rendering
- `0.40"` per line height — tune if signs still show overlap

---

## Debug Panel

Controlled by `const DEBUG = true` at top of script. Set to `false` before shipping — hides panel and removes all limits.

Current toggles:
- **Plant limit** — default 15, configurable; skips the rest of the import
- **Pick some with CSV overlap** — when on, fills the limit with `(N−1)` plants.csv-matched plants + 1 pending, so both code paths are testable each run

Adding a new toggle: add a checkbox to the `#debug-panel` HTML, read it in `syncDebugState()`, store in `debugState`.

---

## AI Enrichment & Merge (Step 2)

Built in `js/enrich.js`.

**Three enrichment paths available to users:**
1. **Auto-enrich** — enter OpenAI API key in Step 2, click Enrich; processes all pending plants at concurrency 3 using gpt-4o with web search
2. **Copy prompt + AI** — click "Copy prompt" on a pending row, paste into any AI (Claude/ChatGPT), copy the JSON output, click "Fill from clipboard" to apply
3. **Manual edit** — type/edit HTML directly in the Description field; row becomes "Manually Enriched"

**`buildPrompt(plant)`** — builds the enrichment prompt. Returns JSON with `description` (HTML), `sun_levels` (array), `moisture`, `is_pollinator`, `is_deer_resistant`, `piedmont_native`.

**JSON output shape** (from AI enrichment):
```json
{
  "description": "<ul><li><strong>Size:</strong> 7 ft tall x 2-3 ft wide</li>...</ul><p>Highlight.</p>",
  "sun_levels": ["shade"],
  "moisture": "wet",
  "is_pollinator": true,
  "is_deer_resistant": true,
  "piedmont_native": true
}
```

**Description merge** — `buildMergePrompt(plant)` / `mergeDescription(plant, apiKey)` / `mergeAllUnmerged()`:
- Uses gpt-4o-mini (no web search, ~$0.001/plant)
- Input: `plant.ss_description_html` (truth), `plant.tags`, `plant.category`, `plant.description` (CSV)
- Output: reconciled HTML description; sets `plant.description_merged = true`
- Skips plants already merged (`description_merged === true`) and pending plants (nothing to merge with)

---

## Design Principles

- **Static site** — `public/index.html` opens directly in a browser. No build step, no server, no npm.
- **DEBUG flag** — all dev-only UI behind `const DEBUG = true` in `js/config.js`. Flip to `false` to ship.
- **Deterministic code first** — AI only for non-deterministic tasks (enriching plant descriptions)
- **Icon logic in config** — `ICON_CONFIG` is the single place to change icon behavior
- **Layout constants in config** — `SLIDE_CONFIG` for all dimensions/colors/fonts

---

## Memory Notes

See `/Users/erik/.claude/projects/-Users-erik-repos-plant-sale/memory/` for persistent session notes.
