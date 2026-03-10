// ─── AI Enrichment ────────────────────────────────────────────────────────────
// Uses USDA Plants Service API (deterministic, no key) then OpenAI gpt-4o-mini
// to fill in data for plants with source === 'pending'.

/**
 * Attempt to fetch plant data from the USDA Plants Service API.
 * Returns a partial context string to inject into the AI prompt, or '' on failure.
 *
 * @param {string} commonName
 * @returns {Promise<string>}
 */
async function fetchUsdaContext(commonName) {
  try {
    const encoded = encodeURIComponent(commonName);
    const url = `https://plantsservices.sc.egov.usda.gov/api/PlantSearch?q=${encoded}&format=json`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // The response is typically an array or an object with a PlantResults array
    const results = Array.isArray(data) ? data : (data.PlantResults || data.Results || []);
    if (!results.length) return '';

    const plant = results[0];
    const parts = [];

    if (plant.NativeStatus)   parts.push(`USDA native status: ${plant.NativeStatus}`);
    if (plant.Duration)       parts.push(`Duration: ${plant.Duration}`);
    if (plant.GrowthHabit)    parts.push(`Growth habit: ${plant.GrowthHabit}`);
    if (plant.ActiveGrowthPeriod) parts.push(`Active growth period: ${plant.ActiveGrowthPeriod}`);
    if (plant.MinimumTemperature) parts.push(`Min temp (°F): ${plant.MinimumTemperature}`);

    if (!parts.length) return '';
    return 'USDA Plants data: ' + parts.join('; ');
  } catch (err) {
    if (typeof DEBUG !== 'undefined' && DEBUG) {
      console.warn('[enrich] USDA fetch failed for', commonName, '—', err.message);
    }
    return '';
  }
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
  const systemMsg = 'You are a botanist filling in plant sale sign data. Return only valid JSON, no other text.';
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
  const usdaContext = await fetchUsdaContext(plant.common);

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
