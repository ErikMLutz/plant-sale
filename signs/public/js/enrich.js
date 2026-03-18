// ─── AI Enrichment ────────────────────────────────────────────────────────────
// Builds direct source URLs for each plant, injects them into the prompt,
// and calls gpt-4o (which has built-in web search) to fetch and extract
// structured data from NCSU, Prairie Moon, USDA, FSUS, and MBG.
// Merge calls use gpt-4o-mini (no web search needed — text processing only).

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
 * Derive NC native label from SS tags/categories.
 * Returns 'NC Piedmont Native', 'NC Native', or null.
 */
function ncNativeLabel(plant) {
  const combined = ((plant.tags || '') + ',' + (plant.category || '')).toLowerCase();
  const tokens   = combined.split(/[,/]/).map(t => t.trim()).filter(Boolean);
  const hasPiedmont = tokens.includes('piedmont-native') || !!plant.piedmont_native;
  const hasNative   = tokens.some(t => t === 'native');
  if (hasPiedmont) return 'NC Piedmont Native';
  if (hasNative)   return 'NC Native';
  return null;
}

/**
 * Build the prompt for gpt-4o with web search.
 * Instructs the model to web search within approved domains only.
 * Returns a JSON object with description (HTML), sun_levels (array),
 * moisture, is_pollinator, is_deer_resistant, piedmont_native.
 */
function buildPrompt(plant) {
  const ncLabel = ncNativeLabel(plant);
  const lines = [
    'You are a botanist filling in plant sale sign data. Search the web and return only valid JSON with no markdown or code fences.',
    '',
    `Plant common name: ${plant.common}`,
    `Squarespace description: ${stripHtml(plant.ss_description_html || plant.description || '')}`,
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
      description: '<ul><li><strong>Size:</strong> H ft tall x W ft wide</li><li><strong>Bloom:</strong> color, season</li><li><strong>Soil:</strong> type</li><li><strong>Native range:</strong> Continent[, NC native]</li><li><strong>USDA zone:</strong> #-#</li><li><strong>Deer Resistance:</strong> yes/moderate/no</li></ul><p>Highlight sentence 1. Highlight sentence 2.</p>',
      sun_levels: ['full_sun'],
      moisture: 'average',
      is_pollinator: true,
      is_deer_resistant: false,
      piedmont_native: false,
    }, null, 2),
    '',
    [
      'Rules:',
      '- description: HTML only. Use <ul><li>...</li></ul> for attribute bullets and <p>...</p> for the highlight paragraph.',
      '- Each <li> must use <strong>Label:</strong> value format. Each value 6 words or fewer.',
      '- Size: full height range × full width range (e.g. "1-3 ft tall x 1-2 ft wide"). Use ft for plants over 1 ft; use in for smaller.',
      '- Bloom color: color + season ONLY — no form descriptors. Allowed colors: white, lavender, purple, pink, red, orange, yellow, blue, green. Two most prominent separated by "/" if multiple (e.g. "white/yellow").',
      '- Bloom season: Spring / early Summer / mid Summer / late Summer / early Fall / Fall. "mid-late Summer" is also valid.',
      '- Soil: texture/drainage first, then notable tolerance if applicable. 6 words or fewer.',
      `- Native range: continent/region of origin${ncLabel ? `, then append ", ${ncLabel}"` : ' only — no NC suffix'}. Never list US states. Examples: "North America${ncLabel ? `, ${ncLabel}` : ''}", "Asia", "Europe".`,
      '- USDA zone: numeric range only, e.g. "4-8".',
      '- Deer Resistance: exactly "yes", "moderate", or "no".',
      '- <p> highlight: two sentences max. First: specific sensory, structural, or unusual trait. Second: wildlife value, ecological role, or landscape use. Name host species when known.',
      '- sun_levels: array — include all that apply: "full_sun", "part_shade", "shade".',
      '- moisture: "wet" = consistently moist or wet; "drought" = drought-tolerant; "average" = typical garden moisture. When in doubt, use "average".',
      '- is_pollinator: true only if documented larval host plant OR primary nectar/pollen source for native bees, butterflies, or hummingbirds.',
      '- is_deer_resistant: true only if Deer Resistance = "yes". "moderate" → false.',
      '- piedmont_native: true only if botanically native to the NC Piedmont region.',
      '- sun_levels, is_pollinator, is_deer_resistant, piedmont_native: must be JSON booleans/arrays (not strings).',
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

  // Extract text from the message item in the output array
  const messageItem = data.output?.find(item => item.type === 'message');
  const content = messageItem?.content?.find(c => c.type === 'output_text')?.text;
  if (!content) throw new Error('Empty response from OpenAI');

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in response');

  const parsed = JSON.parse(unwrapJson(jsonMatch[0]));
  console.log(`[enrich] ✓ ${plant.common} — parsed fields:`, parsed);
  return parsed;
}

/**
 * Enrich a single plant using gpt-4o with web search.
 * Updates description (HTML), sun_levels (array), moisture,
 * is_pollinator, is_deer_resistant, piedmont_native.
 * Never overwrites non-empty existing description.
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

  // description: use AI result if plant has no non-empty description from CSV
  if (aiData.description) {
    merged.description = aiData.description;
  }

  // sun_levels: AI returns an array
  if (Array.isArray(aiData.sun_levels) && aiData.sun_levels.length > 0) {
    merged.sun_levels = aiData.sun_levels;
  } else if (typeof aiData.sun_levels === 'string' && aiData.sun_levels) {
    // Handle legacy single-string sun_level just in case
    merged.sun_levels = [aiData.sun_levels];
  }

  if (aiData.moisture) merged.moisture = aiData.moisture;
  if (aiData.is_pollinator === true)     merged.is_pollinator     = true;
  if (aiData.is_deer_resistant === true) merged.is_deer_resistant = true;
  if (typeof aiData.piedmont_native === 'boolean') merged.piedmont_native = aiData.piedmont_native;

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

  const CONCURRENCY = 10;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker)
  );
}

// ─── AI Description Merge ──────────────────────────────────────────────────────

/**
 * Build the merge prompt for gpt-4o-mini.
 * Input: plant.ss_description_html (authoritative), plant.tags, plant.category,
 *        plant.description (suspect CSV description from enrichment).
 * Instructions: synthesize a reconciled HTML description; remove/fix anything
 * that contradicts SS data; keep useful enrichment from CSV; use same HTML format.
 * Returns only raw HTML (no JSON wrapper).
 */
function buildMergePrompt(plant, ncsuData) {
  const ncLabel = ncNativeLabel(plant);
  const ncsuLines = [];
  if (ncsuData && (ncsuData.distribution || ncsuData.origin)) {
    ncsuLines.push('== NCSU Toolbox data (authoritative for native range) ==');
    if (ncsuData.distribution) ncsuLines.push(`Distribution: ${ncsuData.distribution}`);
    if (ncsuData.origin)       ncsuLines.push(`Country or Region of Origin: ${ncsuData.origin}`);
    ncsuLines.push('');
  }

  const lines = [
    'You are a botanist fact-checking a plant sale sign description. Return only the final HTML — no JSON, no markdown, no code fences.',
    '',
    `Plant common name: ${plant.common}`,
    `Squarespace tags: ${plant.tags || '(none)'}`,
    `Squarespace categories: ${plant.category || '(none)'}`,
    '',
    '== Squarespace description (reference only — use to catch factual errors in the CSV description) ==',
    plant.ss_description_html || '(none)',
    '',
    ...ncsuLines,
    '== CSV description (YOUR BASE — output must be this text with minimal targeted corrections) ==',
    plant.description || '(none)',
    '',
    'Task: Output the CSV description with only the minimum corrections needed to fix factual errors.',
    '',
    'RULES:',
    '- Your output must be nearly identical to the CSV description. Preserve all wording, structure, and flavor text.',

    '- Squarespace often uses shorthand without labels — translate it to identify the attribute it references before applying the rules below:',
    '  · A bare dimension like "2x2\'", "3-4 ft tall", "18in wide" → this is the Size, even if the word "Size" never appears.',
    '  · A color word near a season like "yellow, summer" → this is the Bloom color/season.',
    '- For each <li>: keep the CSV value as-is, EXCEPT in these two cases:',
    '  1. CORRECT: the CSV states a fact that Squarespace contradicts (e.g. CSV Size says "1-3 ft tall x 1-2 ft wide", SS says "2x2\'" → correct Size to "2 ft tall x 2 ft wide"; CSV Bloom says "white", SS says "yellow" → use "yellow").',
    '  2. ENRICH: Squarespace gives a more specific version of something CSV mentions (e.g. CSV says "summer blooms", SS says "yellow summer blooms" → use "yellow summer blooms"). Only add detail about the same attribute.',
    '- Do NOT replace a CSV value with a Squarespace value just because wording differs. Only apply changes that fall under CORRECT or ENRICH above.',
    '- Do NOT add new <li> entries. Do NOT remove <li> entries. Keep the same number of bullets in the same order.',
    '- Copy the <p> highlight paragraph from CSV verbatim. Do NOT rephrase, shorten, or rewrite it. The only permitted change is correcting a direct factual error (wrong species name, wrong region) that is explicitly contradicted by the Squarespace description or NCSU Toolbox data.',
    `- Native range: use NCSU Toolbox data if provided to fill/correct the origin. Then${ncLabel ? ` append ", ${ncLabel}"` : ' do not append any NC suffix — this plant has neither native nor piedmont-native tag'}.`,
    '- Return ONLY the HTML. No explanations, no JSON, no markdown.',
  ];
  return lines.join('\n');
}

/**
 * Call OpenAI chat completions (gpt-4o-mini) for description merge.
 * No web search needed — this is pure text reconciliation.
 * Returns raw HTML string.
 */
async function callOpenAIMerge(plant, apiKey) {
  const ncsuData = await fetchNcsuDistribution(plant.latin || plant.common).catch(() => null);
  const prompt = buildMergePrompt(plant, ncsuData);

  console.groupCollapsed(`[merge] ▶ ${plant.common} — sending merge prompt`);
  console.log('prompt:', prompt);
  console.groupEnd();

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`OpenAI error ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from OpenAI');

  // Strip any markdown code fences the model might add despite instructions
  const html = content.trim()
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  console.log(`[merge] ✓ ${plant.common} — merged HTML:`, html);
  return html;
}

/**
 * Merge description for a single plant using gpt-4o-mini.
 * Updates plant.description and sets plant.description_merged = true.
 * Only runs if plant.description_merged !== true.
 * Mutates plants[idx] in place; returns the updated plant object.
 */
async function mergeDescription(plant, apiKey) {
  if (plant.description_merged === true) return plant;

  let html;
  try {
    html = await callOpenAIMerge(plant, apiKey);
  } catch (err) {
    console.error('[merge] OpenAI failed for', plant.common, '—', err.message);
    return { ...plant, mergeError: true };
  }

  return { ...plant, description: html, description_merged: true, mergeError: false };
}

/**
 * Merge up to `limit` plants that are not yet merged and not pending (concurrency 3).
 * Mutates the global `plants` array in place and calls onProgress after each.
 */
async function mergeAllUnmerged(apiKey, limit, onProgress) {
  // `plants` is a global defined in app.js
  const toMerge = plants
    .map((p, i) => ({ plant: p, idx: i }))
    .filter(({ plant }) => !plant.description_merged && plant.source !== 'pending')
    .slice(0, limit);

  const total = toMerge.length;
  if (total === 0) return;

  let completed = 0;
  let nextJob = 0;

  async function worker() {
    while (nextJob < toMerge.length) {
      const { plant, idx } = toMerge[nextJob++];
      const updated = await mergeDescription(plant, apiKey);
      plants[idx] = updated;
      completed++;
      if (typeof onProgress === 'function') {
        onProgress(completed, total, updated);
      }
    }
  }

  const CONCURRENCY = 30;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, toMerge.length) }, worker)
  );
}
