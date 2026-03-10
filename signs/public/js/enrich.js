// ─── AI Enrichment ────────────────────────────────────────────────────────────
// Attempts to scrape all approved sources (USDA, NCSU, Prairie Moon, FSUS, MBG)
// then passes whatever was gathered to OpenAI gpt-4o-mini for structured extraction.
// Each source fetch is wrapped in try/catch — CORS failures are logged and skipped.

const APPROVED_SOURCES = [
  'NCSU Plant Toolbox (plants.ces.ncsu.edu)',
  'USDA PLANTS Database (plants.usda.gov)',
  'Prairie Moon Nursery (prairiemoon.com)',
  'FSUS / Flora of the Southeastern US (fsus.ncbg.unc.edu)',
  'Missouri Botanical Garden (missouribotanicalgarden.org)',
];

/**
 * Derive a URL slug from a latin or common name.
 * e.g. "Actaea racemosa" → "actaea-racemosa"
 */
function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Try to fetch a URL and return stripped plain text (first ~800 chars of body text).
 * Logs all failures to console so CORS issues are visible during debugging.
 * Returns '' on any error.
 */
async function tryFetchText(label, url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    // Strip tags and collapse whitespace; take first 800 chars of useful content
    const div = document.createElement('div');
    div.innerHTML = html;
    // Remove boilerplate elements before extracting text
    div.querySelectorAll('script,style,nav,header,footer,button,a[href],noscript').forEach(el => el.remove());
    const text = (div.textContent || '')
      .replace(/[<>]/g, ' ')         // remove stray angle brackets
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000);
    if (text) console.log(`[enrich] ✓ ${label}: fetched ${text.length} chars`);
    return text ? `[${label}]\n${text}` : '';
  } catch (err) {
    // Always log so CORS failures are visible in DevTools
    console.warn(`[enrich] ✗ ${label} (${url}): ${err.message}`);
    return '';
  }
}

/**
 * Attempt to fetch plant data from the USDA Plants Service JSON API.
 * Returns structured key/value context string, or '' on failure.
 */
async function fetchUsdaJson(commonName, latinName) {
  const query = latinName || commonName;
  try {
    // API requires POST with JSON body; GET returns 405
    const resp = await fetch('https://plantsservices.sc.egov.usda.gov/api/PlantSearch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Text: query }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const results = data.PlantResults || data.Results || (Array.isArray(data) ? data : []);
    // Filter out empty placeholder results (API returns 1 empty result when nothing found)
    const valid = results.filter(r => r.Symbol);
    if (!valid.length) return '';
    const p = valid[0];
    const parts = [];
    // Array fields
    if (p.Durations?.length)    parts.push(`Duration: ${p.Durations.join(', ')}`);
    if (p.GrowthHabits?.length) parts.push(`Growth habit: ${p.GrowthHabits.join(', ')}`);
    if (p.NativeStatuses?.length) parts.push(`Native status: ${p.NativeStatuses.map(s => s.Status || s).join(', ')}`);
    // Scalar fields from Characteristics sub-object
    const ch = p.Characteristics || {};
    if (ch.ShadeTolerance)   parts.push(`Shade tolerance: ${ch.ShadeTolerance}`);
    if (ch.MoistureUse)      parts.push(`Moisture use: ${ch.MoistureUse}`);
    if (ch.DroughtTolerance) parts.push(`Drought tolerance: ${ch.DroughtTolerance}`);
    if (!parts.length) return '';
    console.log(`[enrich] ✓ USDA JSON API: ${parts.length} fields`);
    return `[USDA Plants API]\n${parts.join('; ')}`;
  } catch (err) {
    console.warn(`[enrich] ✗ USDA JSON API: ${err.message}`);
    return '';
  }
}

/**
 * Try all approved sources for a plant and return combined context string.
 * All fetches run in parallel; failures are logged and skipped.
 */
async function fetchAllSources(plant) {
  const latin  = plant.latin  || '';
  const common = plant.common || '';
  const latinSlug  = toSlug(latin);
  const commonSlug = toSlug(common);

  const attempts = [
    // USDA structured JSON API (best data quality when it works)
    fetchUsdaJson(common, latin),

    // NCSU Plant Toolbox — try latin slug, then common slug
    tryFetchText('NCSU Plant Toolbox', `https://plants.ces.ncsu.edu/plants/${latinSlug}/`),
    tryFetchText('NCSU Plant Toolbox (common)', `https://plants.ces.ncsu.edu/plants/${commonSlug}/`),

    // Prairie Moon Nursery — try both latin and common slug patterns
    tryFetchText('Prairie Moon', `https://www.prairiemoon.com/${latinSlug}.html`),
    tryFetchText('Prairie Moon', `https://www.prairiemoon.com/${latinSlug}-${commonSlug}.html`),

    // FSUS — try both slug patterns
    tryFetchText('FSUS', `https://fsus.ncbg.unc.edu/plants/${latinSlug}`),
    tryFetchText('FSUS', `https://fsus.ncbg.unc.edu/search?q=${encodeURIComponent(latin || common)}`),

    // Missouri Botanical Garden (useful for non-natives)
    tryFetchText('Missouri Botanical Garden',
      `https://www.missouribotanicalgarden.org/PlantFinder/PlantFinderListPage.aspx?basic=${encodeURIComponent(latin || common)}`),
  ];

  const results = await Promise.all(attempts);
  return results.filter(Boolean).join('\n\n');
}

/**
 * Build the compact prompt for gpt-4o-mini.
 *
 * @param {object} plant
 * @param {string} usdaContext
 * @returns {string}
 */
function buildPrompt(plant, context) {
  const lines = [
    `Plant common name: ${plant.common}`,
    `Squarespace description: ${plant.description || '(none)'}`,
    `Tags: ${plant.tags || '(none)'}`,
  ];
  if (context) lines.push('\nReference data from approved sources:\n' + context);

  lines.push('');
  lines.push('Return this exact JSON shape (replace ALL placeholder text with real values):');
  lines.push(JSON.stringify({
    latin: 'genus species [cultivar if applicable] — species name only, no taxonomic author citations',
    attributes_line: 'Size: H ft tall x W ft wide; Bloom: color, season; Soil: type; Native range: Continent[, NC native]; USDA zone: #-#; Deer Resistance: yes/moderate/no',
    highlight_line: 'sentence 1: distinctive sensory, structural, or garden trait. sentence 2: ecological or wildlife value.',
    sun_level: 'full_sun OR part_shade OR shade',
    moisture: 'wet OR average OR drought',
    is_pollinator: 'true or false',
    is_deer_resistant: 'true or false',
  }, null, 2));

  lines.push('');
  lines.push([
    'Rules:',
    '- latin: genus + species only (e.g. "Actaea racemosa"). Include cultivar name in quotes if the plant is a named cultivar. Never add author citations like "(Pursh) Kuntze".',
    '- attributes_line: each segment 6 words or fewer. Semicolons between segments, no trailing semicolon.',
    '- Size: use maximum typical height × a representative width range (e.g. "7 ft tall x 2-4 ft wide"). If the source gives a spread range, include it.',
    '- Bloom color: plain English only — white, purple, yellow, pink, red, orange, blue, green. Avoid compound terms like "lavender-blue"; use the closest simple color.',
    '- Bloom season: Spring / early Summer / mid Summer / late Summer / early Fall / Fall. "mid-late Summer" is also valid. Use "early", "mid", or "late" prefix when bloom spans less than half a season. When bloom spans multiple seasons (e.g. July–October), anchor to the peak or starting season — prefer "early Fall" over "late Summer" when bloom continues into fall.',
    '- Soil: describe texture/drainage first, then notable tolerance if applicable (e.g. "moist, well-drained" or "well-drained, drought tolerant"). 6 words or fewer.',
    '- Native range: continent or region only — "North America, NC native" if the plant is botanically native to North Carolina specifically, "North America" if native to the continent but not NC, "Asia", "Europe", etc. Never list US states individually. Being sold at an NC plant sale does not make a plant NC native.',
    '- USDA zone: numeric range only, e.g. "4-8". Trust the reference source over other estimates.',
    '- Deer Resistance: exactly "yes", "moderate", or "no".',
    '- highlight_line: two sentences max. First sentence: a specific sensory, structural, or unusual trait (fragrance, bloom shape, color, texture). Second sentence: wildlife value, ecological role, notable cultural/historical use, or landscape use. Be specific — name host species or animal relationships when known. You may use verified botanical knowledge beyond the scraped reference data.',
    '- sun_level: pick the dominant light condition. When light range spans deep shade to partial shade, use "part_shade". If full sun is listed alongside part shade, use "part_shade".',
    '- moisture: "wet" for consistently moist/wet soils, "drought" for drought-tolerant, "average" for typical garden moisture.',
    '- is_pollinator: true only if the plant is a documented larval host plant OR a primary nectar/pollen source for native bees or hummingbirds. General insect attraction or occasional bee visits = false.',
    '- is_deer_resistant: true if the reference source explicitly states deer resistance or deer resistant. false if not mentioned.',
    '- is_pollinator and is_deer_resistant: must be exactly true or false (JSON booleans, not strings).',
  ].join('\n'));

  return lines.join('\n');
}

/**
 * Call OpenAI gpt-4o-mini and return parsed JSON, or throw on failure.
 *
 * @param {object} plant
 * @param {string} apiKey
 * @param {string} usdaContext
 * @returns {Promise<object>}
 */
async function callOpenAI(plant, apiKey, usdaContext) {
  const systemMsg = `You are a botanist filling in plant sale sign data. Use the reference data provided from approved sources (${APPROVED_SOURCES.join(', ')}) and your own botanical knowledge. Return only valid JSON, no other text.`;
  const userMsg = buildPrompt(plant, usdaContext);

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user',   content: userMsg   },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`OpenAI error ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from OpenAI');

  const parsed = JSON.parse(content);
  return parsed;
}

/**
 * Enrich a single plant using USDA + OpenAI.
 * Never overwrites non-empty existing fields.
 *
 * @param {object} plant   - plant object (not mutated; a merged copy is returned)
 * @param {string} apiKey  - OpenAI API key
 * @returns {Promise<object>} - updated plant object
 */
async function enrichPlant(plant, apiKey) {
  const usdaContext = await fetchAllSources(plant);

  let aiData;
  try {
    aiData = await callOpenAI(plant, apiKey, usdaContext);
  } catch (err) {
    console.error('[enrich] OpenAI failed for', plant.common, '—', err.message);
    return { ...plant, enrichError: true, source: 'pending' };
  }

  // Merge: only fill in fields that are currently empty / falsy
  const merged = { ...plant };

  const stringFields = ['latin', 'attributes_line', 'highlight_line', 'sun_level', 'moisture'];
  for (const field of stringFields) {
    if (!merged[field] && aiData[field]) {
      merged[field] = aiData[field];
    }
  }

  // Boolean fields: only set if not already explicitly true
  if (!merged.is_pollinator && aiData.is_pollinator === true) {
    merged.is_pollinator = true;
  }
  if (!merged.is_deer_resistant && aiData.is_deer_resistant === true) {
    merged.is_deer_resistant = true;
  }

  merged.enrichError = false;

  return merged;
}

/**
 * Enrich all plants with source === 'pending' in parallel (concurrency 3).
 * Mutates the global `plants` array in place and calls onProgress after each.
 *
 * @param {string}   apiKey      - OpenAI API key
 * @param {Function} onProgress  - called as onProgress(completed, total, updatedPlant)
 * @returns {Promise<void>}
 */
async function enrichAllPending(apiKey, onProgress) {
  // `plants` is a global defined in app.js
  const pending = plants
    .map((p, i) => ({ plant: p, idx: i }))
    .filter(({ plant }) => plant.source === 'pending');

  const total = pending.length;
  if (total === 0) return;

  let completed = 0;
  let nextJob = 0;

  async function worker() {
    while (nextJob < pending.length) {
      const { plant, idx } = pending[nextJob++];
      const updated = await enrichPlant(plant, apiKey);
      plants[idx] = updated;
      completed++;
      if (typeof onProgress === 'function') {
        onProgress(completed, total, updated);
      }
    }
  }

  const CONCURRENCY = 3;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker)
  );
}
