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
`common, latin, piedmont_native, description, flag_for_review, reason_for_review, description_merged, source`

`source` is always `"csv"` for this tool's output. `description_merged` starts as `false`.

**Usage (migration):**
```bash
python3 infosheet_converter/migrate_plants_csv.py [INPUT_CSV]
```
Defaults: reads `~/Downloads/upload/plants.improved.csv`, writes `~/Downloads/upload/plants.improved.<YYYYMMDD_HHMMSS>.csv`.
Converts old `attributes_line` + `highlight_line` → HTML `description` column. Preserves `latin`. Drops `sun_levels`, `moisture`, `is_pollinator`, `is_deer_resistant`.

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

No server, no build step, plain JS split across focused files. Uses **pptxgenjs**, **JSZip**, and **Quill** via CDN.

```
public/
├── index.html        — HTML structure and script/link tags
├── styles.css        — all styles
└── js/
    ├── config.js     — DEBUG flag, debugState, SLIDE_CONFIG, ICON_CONFIG
    ├── parse.js      — CSV/TSV parsing, legacy matching, Squarespace parsing
    ├── images.js     — fetchForPptx, convertToJpeg, estimateWrappedLines
    ├── pptx.js       — addSignToSlide, generatePPTX, parseAttributes, buildIcons
    ├── enrich.js     — OpenAI enrichment and merge (buildPrompt, enrichPlant, mergeDescription, ...)
    ├── zip.js        — JSZip helpers: readZipFile(), downloadZip(); globals zipSsFileName/Content/OldCsvFiles
    └── app.js        — plants[] state, UI handlers, import flow, review panel
```

Scripts load in dependency order: `config.js → parse.js → images.js → pptx.js → enrich.js → zip.js → app.js`. All globals shared across files (no modules).

#### Intended data flow (long-term architecture)

The app is designed so that **plants.csv is eventually not needed**. The intended cycle is:

1. **Upload** SS inventory + plants.csv zip → plants.csv seeds descriptions and flags for review
2. **Review** (Step 3) → shape what the updated SS inventory should look like: edit descriptions, confirm `piedmont-native` tag, fix tags/categories
3. **Download** (Step 4) → PPTX and updated SS inventory are both built from the reviewed plant objects, not from plants.csv directly

Once you've done one review → export → upload-to-SS cycle, you can drop plants.csv entirely: just upload the SS inventory and download a PPTX.

**Source of truth by field:**
- `description` — plants.csv seeds the Quill editor on first session; after that, SS description is used directly
- `piedmont_native` — SS `piedmont-native` tag is authoritative; on first import (before tag exists in SS) the CSV `piedmont_native` value seeds the checkbox so it's pre-checked for review
- All other PPTX fields (`sun_levels`, `moisture`, `is_pollinator`, `is_deer_resistant`, `common`, `photo_urls`) — always from SS

---

#### App flow

**Step 1 — Upload**
- User uploads a single **`plant-sale-signs-data.*.zip`** file
- `readZipFile()` (zip.js) extracts: the SS inventory (any filename not matching `plants.improved.*.csv`) + all `plants.improved.*.csv` files; picks the latest CSV by filename timestamp
- All files in the zip are preserved in memory (`zipOldCsvFiles`) and re-bundled into the download zip
- The coordinator creates the initial zip from `~/Downloads/upload/` using the shell

**Step 2 — AI Enrichment & Description Merge (optional, collapsed by default)**
- **Enrich**: fills `description` (HTML) for pending plants via gpt-4o with web search (~$0.03/plant)
- **Merge**: reconciles CSV-derived descriptions against SS data via gpt-4o-mini (~$0.001/plant)
- Both available bulk (Step 2) and per-plant (Step 3 action buttons)
- Step 2 is hidden until after import, and collapsed by default — most reviewers skip it

**Step 3 — Review & Edit**
- **Single-plant panel** (not a table): one plant at a time with prev/next navigation
- **Fuzzy search**: Fuse.js v7 search bar above the sort checkboxes; sorts by match score (matched plants float first, all plants always shown — never filtered out); searches common name (weight 3), category (2), tags (2), description text (1), reason_for_review (1)
- **Category sort**: multi-select checkboxes; 1 selected → plants with that category float to top; 2+ selected → sorted by match count descending; within each group, default sort applies
- **Default sort order**: needs enrichment → needs merging (csv + !description_merged) → potential issue (flag_for_review) → unreviewed → reviewed
- **Nav bar**: ← Prev | Plant N of M | ⚪ Unreviewed/✅ Reviewed badge | Source badge | 🟤 Needs merging badge (when not merged) | ⚠ Potential issue badge | plant name | Next →
- **Plant detail**: photo (left, loads async with grey placeholder during load) + content column (right)
- **Content column** (top to bottom): action buttons → flag/reason row → current SS description (read-only) → Quill WYSIWYG editor → tags checkboxes → categories checkboxes
- **SS description preview**: read-only render of `plant.ss_description_html` shown above the editor so reviewers can compare what's in SS vs what will be exported; hidden if no SS description
- **Quill editor**: snow theme, toolbar: bold / italic / bullet list; `setQuillContent(html)` / `readQuillHtml()` are the canonical read/write functions; `setQuillContent` uses `quill.clipboard.convert({ html })` + `quill.setContents(delta, 'silent')` to avoid scroll jumps and spurious text-change events; description flushed to plant object on every text-change and on navigate (but NOT on first load — see `idx !== currentPlantIdx` guard in `navigateTo`)
- **Mark Reviewed**: toggles `plant.reviewed`; also clears `flag_for_review` and `reason_for_review` when marking reviewed. Does NOT re-sort the list. Button styled via `updateMarkReviewedBtn` — `btn-action` (green fill) when unreviewed, `secondary` when already reviewed
- **Tags/Categories**: pill-style checkboxes, fixed 160px width so they align in columns; tags are normalized to lowercase at parse time (Squarespace treats `Sun` and `sun` identically); `piedmont-native` tag and `/piedmont-native` category are always pre-populated (even before they exist in SS) and styled green; checking either one syncs `plant.piedmont_native`, `plant.tags`, and `plant.category` together
- **Button classes**: `btn-action` = green fill, small size (same as `secondary` but filled); used for Mark Reviewed and Download review zip

**Step 4 — Download**
- **Download review zip**: calls `downloadZip(csvText)` — creates new zip with SS inventory + all prior CSVs + new `plants.improved.<datetime>.csv`
- **Generate PPTX**: fetches photos, builds PowerPoint
- **Download updated SS inventory**: exports SS inventory as **CSV** (RFC 4180) with updated Description/Tags/Categories; runs `validateSsInventory()` first — blocks download and alerts if any column other than Description/Tags/Categories changed vs the original

#### Key data structures

**Plant object** (app state array `plants[]`):
```js
{
  // From Squarespace (authoritative)
  common, category, tags, photo_urls,
  // Description — HTML; starts as plants.csv description (or SS description if no CSV match)
  description,
  // Original SS description HTML — shown read-only above editor; input to merge prompt
  ss_description_html,
  // From plants.csv (or derived)
  latin,              // latin/scientific name from CSV; used for SS title matching
  piedmont_native,    // SS tag authoritative; CSV seeds value before first SS upload
  flag_for_review, reason_for_review, description_merged,
  reviewed,   // boolean — set true by "Mark Reviewed"; persisted in plants.csv
  // Derived from SS tags (authoritative)
  sun_levels, moisture, is_pollinator, is_deer_resistant,
  // Enrichment provenance
  source: 'pending' | 'csv' | 'ai_enriched' | 'manually_enriched',
}
```

**Review panel globals** (app.js):
```js
let currentPlantIdx   = 0;       // index into sortedPlantsCache
let sortedPlantsCache = [];      // sorted view of plants[]; rebuilt by rebuildSort()
let quill             = null;    // Quill instance, initialized once in buildReviewPanel()
```

**Zip globals** (zip.js):
```js
let zipSsFileName  = null;   // filename of SS inventory in the zip
let zipSsContent   = null;   // raw text of SS inventory
let zipOldCsvFiles = [];     // [{name, content}] all plants.improved.*.csv from uploaded zip
```

#### Squarespace export format
- Tab-separated, first row headers
- ~714 unique products (deduplicated by non-empty Title — variant rows have empty Title)
- Key columns: `Title`, `Description` (HTML), `Categories`, `Tags`, `Hosted Image URLs` (space-separated)
- Photos are publicly accessible Squarespace CDN URLs, served as **WebP** — must be converted to JPEG before embedding in PPTX
- Raw rows stored in global `rawSsRows` for the "Download updated SS inventory" function
- All unique tag/category values collected into globals `allSsTags`, `allSsCategories` for checkbox rendering; `piedmont-native` and `/piedmont-native` are always injected after parsing so they appear in the review panel before SS has them
- "Download updated SS inventory" adds `piedmont-native` tag and `/piedmont-native` category to any plant with `piedmont_native: true` in CSV; also reads `piedmont-native` tag back from SS on re-import via `inferFromSsTags`

#### `plants.csv` format
- **Current format**: `common, latin, piedmont_native, description, flag_for_review, reason_for_review, description_merged, source, reviewed`
  - `latin` — latin/scientific name; used as the primary match key against SS titles
  - `description` is HTML: `<ul><li><strong>Label:</strong> value</li>...</ul><p>Highlight.</p>`
  - `description_merged` is `true` after AI merge reconciliation
  - `reviewed` is `true` after user clicks "Mark Reviewed"
  - `source` values: `csv` | `ai_enriched` | `manually_enriched` (pending plants are NOT written to CSV)
- **Old format** (backward compat — auto-detected by presence of `attributes_line`): `common, attributes_line, highlight_line, ...` — auto-converted to HTML description on load
- **Matching to Squarespace** (`findCsvMatch`): tries in order:
  1. Latin name contained in SS title (handles `"Genus species (Common name)"` format)
  2. Exact normalized common name
  3. SS title contains CSV common name (or starts with it)
  4. CSV common name contains SS title (or starts with it)
- **Name normalization** (`normalizeName`): lowercase, apostrophes stripped (so `Walker's` = `Walkers`), remaining non-alphanumeric → space, collapse whitespace
- **CSV round-trip**: HTML stored as a double-quoted RFC 4180 field; `parseCsvLine` handles quotes and commas inside HTML correctly; `&nbsp;` stripped from Quill output via `.replace(/&nbsp;/g, ' ')` before storing

#### Zip file format
- Contains: SS inventory file (any name not matching `plants.improved.*.csv` — can be TSV or CSV) + one or more `plants.improved.<YYYYMMDD_HHMMSS>.csv` files
- On upload: latest CSV (by filename sort) is used; all CSVs preserved for re-bundling
- On download: new CSV added; all prior CSVs retained; named `plant-sale-signs-data.<datetime>.zip`
- **Do not modify zip contents manually** — pass as-is between reviewers

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
1. **Auto-enrich** — enter OpenAI API key in Step 2, click Enrich; processes all pending plants at **concurrency 10** using gpt-4o with web search (~$0.03/plant); failed plants stay `source: 'pending'` and can be retried
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
- Uses gpt-4o-mini (no web search, ~$0.001/plant); **concurrency 30**
- Input: `plant.ss_description_html` (truth), `plant.tags`, `plant.category`, `plant.description` (CSV)
- Output: reconciled HTML description; sets `plant.description_merged = true`
- Skips plants already merged (`description_merged === true`) and pending plants (nothing to merge with)
- Prompt instructs: start from CSV as-is, only fix values that contradict SS data, preserve all `<li>` labels and order exactly

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
