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
    // Remove scripts/styles from the DOM fragment
    div.querySelectorAll('script,style,nav,header,footer').forEach(el => el.remove());
    const text = (div.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 800);
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
    const url = `https://plantsservices.sc.egov.usda.gov/api/PlantSearch?q=${encodeURIComponent(query)}&format=json`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const results = Array.isArray(data) ? data : (data.PlantResults || data.Results || []);
    if (!results.length) return '';
    const p = results[0];
    const parts = [];
    if (p.NativeStatus)       parts.push(`Native status: ${p.NativeStatus}`);
    if (p.Duration)           parts.push(`Duration: ${p.Duration}`);
    if (p.GrowthHabit)        parts.push(`Growth habit: ${p.GrowthHabit}`);
    if (p.ActiveGrowthPeriod) parts.push(`Active growth period: ${p.ActiveGrowthPeriod}`);
    if (p.MinimumTemperature) parts.push(`Min temp (°F): ${p.MinimumTemperature}`);
    if (p.ShadeTolerance)     parts.push(`Shade tolerance: ${p.ShadeTolerance}`);
    if (p.MoistureUse)        parts.push(`Moisture use: ${p.MoistureUse}`);
    if (p.DroughtTolerance)   parts.push(`Drought tolerance: ${p.DroughtTolerance}`);
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

    // Prairie Moon Nursery
    tryFetchText('Prairie Moon', `https://www.prairiemoon.com/plants/${latinSlug}.html`),

    // FSUS
    tryFetchText('FSUS', `https://fsus.ncbg.unc.edu/plants/${latinSlug}`),

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
function buildPrompt(plant, usdaContext) {
  const lines = [
    `Plant: ${plant.common}`,
    `Squarespace description: ${plant.description || '(none)'}`,
    `Tags: ${plant.tags || '(none)'}`,
  ];
  if (usdaContext) lines.push(usdaContext);

  lines.push('');
  lines.push('Return this exact JSON shape:');
  lines.push(JSON.stringify({
    latin: 'full scientific name including cultivar if known',
    attributes_line: 'Size: X ft tall x Y ft wide; Bloom: color, season; Soil: type; Native range: Continent[, NC native if applicable]; USDA zone: #-#; Deer Resistance: yes/moderate/no',
    highlight_line: '1-2 sentences on ecological value, wildlife, or notable traits. Be specific.',
    sun_level: 'full_sun OR part_shade OR shade',
    moisture: 'wet OR average OR drought',
    is_pollinator: true,
    is_deer_resistant: false,
  }, null, 2));

  lines.push('');
  lines.push("Attributes rules: each value 6 words or fewer. Native range format: \"North America, NC native\" or \"Asia\" etc — never list individual states.");

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
