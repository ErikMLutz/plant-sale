# Plant Sale Signs — Agent Primer

## Project Overview

This project builds a **single-file static web app** (`prototype.html`) that generates plant sale signs as a `.pptx` file for a Master Gardener extension fundraiser. The app replaces a manual ChatGPT + Python pipeline with deterministic code and targeted AI calls.

Working directory: `/Users/erik/repos/plant-sale/signs/`

**Background on the original pipeline:** `initial_info/SUMMARY.md` — worth reading for context, but not required for working on the app.

---

## What's Been Built

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
- Optionally paste or upload **`plants.csv`** (legacy enrichment data from Ali's prior work)
- Click Import → parses both, matches plants by name, shows summary

**Step 2 — Review table**
- Editable table showing all plants sorted by: "Needs enrichment" first, then "Legacy" matches
- Columns: Source badge, Common Name, Latin Name (editable), Photo thumbnail, Attributes (editable textarea), Highlight (editable textarea)
- "Generate PPTX (N plants)" button → downloads `.pptx`

#### Key data structures

**Plant object** (app state array `plants[]`):
```js
{
  common: '',           // from Squarespace Title
  description: '',      // HTML-stripped Squarespace description
  category: '',         // Squarespace Categories field
  tags: '',             // Squarespace Tags field
  photo_urls: [],       // array of CDN URLs from Squarespace
  latin: '',            // from legacy CSV match or AI (future)
  attributes_line: '',  // "Size: …; Bloom: …; Soil: …; Native range: …; USDA zone: …; Deer Resistance: …"
  highlight_line: '',   // 1–2 editorial sentences
  sun_level: '',        // 'full_sun' | 'part_shade' | 'shade'
  moisture: '',         // 'wet' | 'average' | 'drought'
  is_pollinator: false,
  is_deer_resistant: false,
  source: 'legacy' | 'pending',
}
```

#### Squarespace export format
- Tab-separated, first row headers
- 714 unique products (deduplicated by non-empty Title — variant rows have empty Title and are skipped)
- Key columns: `Title`, `Description` (HTML), `Categories`, `Tags`, `Hosted Image URLs` (space-separated)
- Photos are publicly accessible Squarespace CDN URLs, served as **WebP** — must be converted to JPEG before embedding in PPTX

#### Legacy `plants.csv` format
- Comma-separated: `latin, common, attributes_line, highlight_line, page, categories, photo_file`
- 229 rows covering the ~200 plants in the sale
- Matched to Squarespace by normalized common name (lowercase, alphanumeric only)
- `categories` column has icon tags like `/sun, /part-shade, /pollinator, /deer, /drought` — parsed into icon flags

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
| `estimateWrappedLines(text, widthInches, fontSpec)` | Canvas-based word-wrap line counter (accurate for variable-width fonts) |
| `fetchForPptx(url)` | Fetches CDN image, detects format via magic bytes, converts WebP/GIF → JPEG via Canvas with centered cover crop, returns `"image/jpeg;base64,..."` (no `data:` prefix — pptxgenjs format) |
| `parseAttributes(line)` | Splits semicolon-delimited attributes string into `{label, value}` pairs |
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
- **Plant limit** — default 10, configurable; skips the rest of the import
- **Pick some with legacy overlap** — when on, fills the limit with `(N−1)` legacy-matched plants + 1 pending, so both code paths are testable each run

Adding a new toggle: add a checkbox to the `#debug-panel` HTML, read it in `syncDebugState()`, store in `debugState`.

---

## What's Next

The remaining major feature is **AI enrichment** — for plants with `source: 'pending'` (no legacy match), call an AI API to fill in the missing fields.

### Step 3 — AI Enrichment (not yet built)

**UI:** An "Enrich with AI" button (or auto-run after import) that:
1. Shows an API key input (Anthropic or OpenAI), stored in `localStorage`
2. Processes each `pending` plant with a single AI call
3. Updates the review table in-place as results come in (same concurrency/progress pattern as photo fetching)

**Per-plant AI call inputs:**
- `plant.common` — common name from Squarespace
- `plant.description` — HTML-stripped Squarespace description (often minimal: "sun, well-drained soil")
- `plant.tags` — Squarespace tags
- `plant.category` — Squarespace category

**Expected AI outputs (structured JSON):**
```json
{
  "latin": "Actaea racemosa",
  "attributes_line": "Size: 7 ft tall x 2-3 ft wide; Bloom: white, mid-late Summer; Soil: Rich woodland, Medium-Wet; Native range: North America, NC native; USDA zone: 4-8; Deer Resistance: yes",
  "highlight_line": "Tall, wand-like spires of fragrant white flowers rise above bold woodland foliage in late summer.",
  "sun_level": "shade",
  "moisture": "wet",
  "is_pollinator": true,
  "is_deer_resistant": true
}
```

**Attributes format** (strict — AI must follow this):
`Size: X ft tall x Y ft wide; Bloom: color, Season; Soil: type; Native range: Continent, NC native; USDA zone: #-#; Deer Resistance: yes/moderate/no`
Each value ≤6 words. See `initial_info/email2/plant_spreadsheet_master_rulebook.txt` for the full rulebook.

**Icon fields:**
- `sun_level`: `'full_sun'` | `'part_shade'` | `'shade'`
- `moisture`: `'wet'` | `'average'` | `'drought'`
- `is_pollinator`: boolean
- `is_deer_resistant`: boolean

Icon display logic lives in `ICON_CONFIG` — designed to be updated in code without touching rendering.

**API preference:** Anthropic (claude-sonnet-4-6 or similar). OpenAI as fallback. Key stored in `localStorage`, entered once via UI.

**Web lookup:** Optionally, if Anthropic's API supports web search / tool use, the AI can look up approved sources (NCSU Plant Toolbox, USDA PLANTS, Prairie Moon). Otherwise use knowledge + description only.

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
