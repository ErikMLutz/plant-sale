# Plant Sale Signs — Agent Primer

## Project Overview

This project builds a desktop app to automate the creation of plant sale signs for a Master Gardener extension fundraiser. Ali (a team member) built a manual AI-assisted pipeline using ChatGPT + a Python script. We are replacing the manual ChatGPT steps with deterministic code and targeted AI calls to make the process reliable and repeatable.

The working directory is `/Users/erik/repos/plant-sale/signs/`.

**Full process documentation:** `initial_info/SUMMARY.md` — read this before starting any significant work. It covers the complete existing pipeline, all prompts, data formats, and known issues.

---

## The Three-Stage Pipeline

### Stage 1 — Plant Research → Infosheets
- **What:** AI researches each plant from approved websites and fills a structured template into a `.docx` file
- **Current tool:** ChatGPT (manual)
- **Key docs:** `initial_info/email1/rulebook_infosheet_generation.txt`, `initial_info/email1/template_infosheet_blank.txt`
- **Output:** 223 infosheet `.docx` files in `initial_info/email1/2026 plant infosheets/`
- **Approved sources:** NCSU Plant Toolbox, USDA PLANTS, FSUS, Prairie Moon Nursery

### Stage 2 — Infosheets → Structured CSV
- **What:** Extract key attributes from infosheets into a CSV with standardized fields
- **Current tool:** ChatGPT (manual, many cleanup passes)
- **Key docs:** `initial_info/email2/plant_dataset_starter_prompt.txt`, `initial_info/email2/plant_spreadsheet_master_rulebook.txt`
- **Output:** `initial_info/email2/plants.csv` (229 plants, 7 columns)
- **CSV columns:** `latin, common, attributes_line, highlight_line, page, categories, photo_file`
- **Attributes format:** `Size: X ft tall x Y ft wide; Bloom: color, Season; Soil: ...; Native range: Continent, NC native; USDA zone: #-#; Deer Resistance: yes/moderate/no`

### Stage 3 — CSV → PowerPoint Signs
- **What:** Python script fills a PPTX template with plant data (text + photos + icons)
- **Current tool:** `initial_info/email3/make_plant_signs.py` (Python, v3.13.2)
- **Template:** `two_signs_master_icons_layout_fixed.pptx` (2 signs per slide)
- **Dependencies:** `python-pptx`, `lxml`, `Pillow`
- **Run:** `python make_plant_signs.py --csv plants.csv --template batch_template.pptx --photos photos/ --out outputs/signs.pptx`
- **Sign layout rules:** `initial_info/email3/plant_sign_template_rules.txt`

---

## Key Data & Files

| File | Description |
|------|-------------|
| `initial_info/SUMMARY.md` | Full pipeline documentation |
| `initial_info/email2/plants.csv` | Master plant dataset (229 rows) |
| `initial_info/email3/make_plant_signs.py` | PPTX generation script |
| `initial_info/email3/plant_signs_starter-kit_missingphotos.zip` | Full kit including template PPTX |

### Plant Sign Layout
Each slide has 2 signs (top/bottom). Each sign has:
- **Name box:** Latin name (italic 26pt) + common name (regular 26pt)
- **Attributes box:** bulleted list — Size, Bloom, Soil, Native range, USDA zone, Deer Resistance
- **Highlight box:** 1–2 editorial sentences
- **Photo area:** left side, fixed frame (images cropped to fit)
- **Icon strip:** sun level, 3 moisture drops (fill pattern encodes wet/avg/drought), butterfly icon (pollinator), deer icon (deer resistant)

### Known Pain Points
1. **Icons not automated** — `categories` column in CSV is too inconsistent; human must fix icons manually
2. **Photos** — `photo_file` column is mostly empty (`"no info provided"`); script does fuzzy Latin-name filename matching
3. **Text overflow** — some plants have too much text; requires manual adjustment
4. **ChatGPT unreliability** — AI forgets rules mid-session; strict rulebooks were developed to combat this

---

## What We're Building

A desktop app that:
1. Takes `plants.csv` as input (or builds it semi-automatically)
2. Allows viewing/editing plant data
3. Generates the PPTX signs automatically
4. Handles icons based on structured plant attributes (not the messy `categories` column)
5. Potentially: AI-assisted scraping of plant info from approved websites to populate the CSV

### Design Principles
- **Deterministic code first** — only use AI where the task is genuinely non-deterministic (scraping/extracting unstructured web content, writing highlight sentences)
- **Reliable over clever** — the ChatGPT workflow broke because AI is unreliable; code should be predictable
- **Usable by non-technical volunteers** — GUI, not terminal

---

## Memory Notes

See `/Users/erik/.claude/projects/-Users-erik-repos-plant-sale/memory/` for persistent session notes.
