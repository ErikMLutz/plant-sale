// ─── AI Enrichment ────────────────────────────────────────────────────────────
// Builds direct source URLs for each plant, injects them into the prompt,
// and calls gpt-4o-search-preview (which has built-in web search) to fetch
// and extract structured data from NCSU, Prairie Moon, USDA, FSUS, and MBG.

/**
 * Fix soft-wrapped JSON (e.g. from terminal output or copy-paste).
 * Outside strings: newline+whitespace → nothing  (so "t\n  rue" → "true")
 * Inside strings:  newline+whitespace → one space (so "Tie\n  Dye" → "Tie Dye")
 */
function unwrapJson(text) {
  let result = '';
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && inString) {
      result += ch + text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      i++;
      continue;
    }
    if (ch === '\n') {
      // Skip the newline and any following horizontal whitespace
      let j = i + 1;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
      if (inString) result += ' '; // preserve word boundary inside strings
      i = j;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/**
 * Build the prompt for gpt-4o-search-preview.
 * Instructs the model to web search within approved domains only.
 * The model finds the correct pages itself rather than relying on guessed URL slugs.
 */
function buildPrompt(plant) {
  const lines = [
    'You are a botanist filling in plant sale sign data. Search the web and return only valid JSON with no markdown or code fences.',
    '',
    `Plant common name: ${plant.common}`,
    `Squarespace description: ${plant.description || '(none)'}`,
    `Tags: ${plant.tags || '(none)'}`,
    '',
    'Search the web for this plant to find its horticultural data.',
    'Only use results from these approved domains (in priority order):',
    '1. plants.ces.ncsu.edu  (NCSU Extension Gardener Plant Toolbox)',
    '2. fsus.ncbg.unc.edu    (Flora of the Southeastern US)',
    '3. plants.usda.gov      (USDA Plants Database)',
    '4. prairiemoon.com      (Prairie Moon Nursery)',
    '5. missouribotanicalgarden.org  (Missouri Botanical Garden)',
    '',
    'Do not use any other websites. If none of the approved sites have data for this plant, use your botanical training knowledge.',
    '',
    'Return ONLY this exact JSON object (no markdown, no code fences, no extra text):',
    JSON.stringify({
      latin: 'genus species [cultivar if applicable] — species name only, no taxonomic author citations',
      attributes_line: 'Size: H ft tall x W ft wide; Bloom: color, season; Soil: type; Native range: Continent[, NC native]; USDA zone: #-#; Deer Resistance: yes/moderate/no',
      highlight_line: 'sentence 1: distinctive sensory, structural, or garden trait. sentence 2: ecological or wildlife value.',
      sun_level: 'full_sun OR part_shade OR shade',
      moisture: 'wet OR average OR drought',
      is_pollinator: true,
      is_deer_resistant: false,
    }, null, 2),
    '',
    [
      'Rules:',
      '- latin: genus + species only (e.g. "Actaea racemosa"). Include cultivar name in quotes if the plant is a named cultivar. Never add author citations like "(Pursh) Kuntze".',
      '- attributes_line: each segment 6 words or fewer. Semicolons between segments, no trailing semicolon.',
      '- Size: use the full height range × full width range from the source (e.g. "1-3 ft tall x 1-2 ft wide"). Use ft for plants over 1 ft tall/wide; use in for smaller dimensions.',
      '- Bloom color: color + season ONLY — no form descriptors (e.g. not "clusters", "button-like"). Allowed plain English colors: white, lavender, purple, pink, red, orange, yellow, blue, green. If multiple colors, list the two most prominent separated by "/" (e.g. "white/yellow").',
      '- Bloom season: Spring / early Summer / mid Summer / late Summer / early Fall / Fall. "mid-late Summer" is also valid.',
      '- Soil: texture/drainage first, then notable tolerance if applicable (e.g. "moist, well-drained"). 6 words or fewer.',
      '- Native range: "North America, NC native" only if botanically native to NC. "North America" if continental but not NC. "Asia", "Europe", etc. Never list US states.',
      '- USDA zone: numeric range only, e.g. "4-8".',
      '- Deer Resistance: exactly "yes", "moderate", or "no".',
      '- highlight_line: two sentences max. First: a specific sensory, structural, or unusual trait. Second: wildlife value, ecological role, or landscape use. Name host species when known.',
      '- sun_level: "full_sun" if full sun only; "part_shade" if full sun + part shade listed; "shade" if part shade or shade only.',
      '- moisture: "wet" = consistently moist or wet; "drought" = drought-tolerant; "average" = typical garden moisture. When in doubt, use "average".',
      '- is_pollinator: true only if documented larval host plant OR primary nectar/pollen source for native bees, butterflies, or hummingbirds.',
      '- is_deer_resistant: true only if Deer Resistance = "yes". "moderate" → false.',
      '- is_pollinator and is_deer_resistant: must be JSON booleans (true/false), not strings.',
    ].join('\n'),
  ];

  return lines.join('\n');
}

const APPROVED_DOMAINS = [
  'plants.ces.ncsu.edu',
  'fsus.ncbg.unc.edu',
  'plants.usda.gov',
  'prairiemoon.com',
  'missouribotanicalgarden.org',
];

/**
 * Call the OpenAI Responses API with web_search_preview + allowed_domains filter.
 * This forces real web search restricted to approved plant data sources.
 */
async function callOpenAI(plant, apiKey) {
  const prompt = buildPrompt(plant);

  console.groupCollapsed(`[enrich] ▶ ${plant.common} — sending prompt`);
  console.log('prompt:', prompt);
  console.groupEnd();

  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      input: prompt,
      tools: [{ type: 'web_search_preview' }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`OpenAI error ${resp.status}: ${body}`);
  }

  const data = await resp.json();

  // Log full response — output array shows web_search_call steps + final message
  console.groupCollapsed(`[enrich] ▶ ${plant.common} — raw response`);
  console.log('usage:', data.usage);
  if (data.output?.length) {
    data.output.forEach((item, i) => {
      if (item.type === 'web_search_call') {
        console.log(`output[${i}] web_search_call:`, item);
      } else if (item.type === 'message') {
        console.log(`output[${i}] message:`, item.content);
      } else {
        console.log(`output[${i}]:`, item);
      }
    });
  }
  console.groupEnd();

  // output_text is the concatenated text from all message output items
  const content = data.output_text;
  if (!content) throw new Error('Empty response from OpenAI');

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in response');

  const parsed = JSON.parse(unwrapJson(jsonMatch[0]));
  console.log(`[enrich] ✓ ${plant.common} — parsed fields:`, parsed);
  return parsed;
}

/**
 * Enrich a single plant using gpt-4o-search-preview with direct source URLs.
 * Never overwrites non-empty existing fields.
 */
async function enrichPlant(plant, apiKey) {
  let aiData;
  try {
    aiData = await callOpenAI(plant, apiKey);
  } catch (err) {
    console.error('[enrich] OpenAI failed for', plant.common, '—', err.message);
    return { ...plant, enrichError: true, source: 'pending' };
  }

  const merged = { ...plant };

  const stringFields = ['latin', 'attributes_line', 'highlight_line', 'sun_level', 'moisture'];
  for (const field of stringFields) {
    if (!merged[field] && aiData[field]) {
      merged[field] = aiData[field];
    }
  }

  if (!merged.is_pollinator && aiData.is_pollinator === true) {
    merged.is_pollinator = true;
  }
  if (!merged.is_deer_resistant && aiData.is_deer_resistant === true) {
    merged.is_deer_resistant = true;
  }

  merged.enrichError = false;
  merged.source = 'ai_enriched';

  return merged;
}

/**
 * Enrich up to `limit` plants with source === 'pending' (concurrency 3).
 * Pass Infinity to enrich all pending plants.
 * Mutates the global `plants` array in place and calls onProgress after each.
 */
async function enrichAllPending(apiKey, limit, onProgress) {
  // `plants` is a global defined in app.js
  const pending = plants
    .map((p, i) => ({ plant: p, idx: i }))
    .filter(({ plant }) => plant.source === 'pending')
    .slice(0, limit);

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
