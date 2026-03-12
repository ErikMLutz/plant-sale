// ─── Parsing utilities ────────────────────────────────────────────────────────

function normalizeName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

/** Auto-detect delimiter: count tabs vs commas in the first line. */
function detectDelimiter(text) {
  const firstLine = (text || '').split('\n')[0];
  const tabs   = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g)  || []).length;
  return tabs >= commas ? '\t' : ',';
}

/** Parse a CSV line respecting quoted fields (RFC 4180 subset). */
function parseCsvLine(line) {
  const fields = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === ',' && !inQuote) {
      fields.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map(f => f.trim());
}

/**
 * Parse a delimited string (CSV or TSV — auto-detected) into an array of
 * row objects keyed by header name. First row is treated as headers.
 */
function parseDelimited(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];
  const delim = detectDelimiter(text);
  const splitLine = delim === '\t'
    ? line => line.split('\t').map(f => f.trim())
    : line => parseCsvLine(line);
  const headers = splitLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = splitLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h.trim()] = (cols[idx] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

/**
 * Parse plants.csv into a Map keyed by normalized common name.
 * Supports:
 *   - Original format: categories column with /tag flags
 *   - Enriched format: direct sun_level / sun_levels, moisture, is_pollinator,
 *     is_deer_resistant, piedmont_native, flag_for_review, reason_for_review columns
 *
 * sun_levels is stored as pipe-separated (e.g. "full_sun|part_shade") in the
 * enriched CSV. The older sun_level single-value column is also accepted and
 * wrapped into an array for backward compatibility.
 */
function parsePlantsCsv(text) {
  const map = new Map();
  const rows = parseDelimited(text);
  if (rows.length === 0) return map;

  // Detect whether this CSV has direct icon columns (enriched format) or old categories column
  const firstRow = rows[0] || {};
  const hasDirectIconCols = 'sun_level' in firstRow || 'sun_levels' in firstRow;

  for (const row of rows) {
    const common = row['common'] || '';
    if (!common) continue;

    let sun_levels, moisture, is_pollinator, is_deer_resistant;

    if (hasDirectIconCols) {
      // Enriched CSV format: direct columns
      if ('sun_levels' in row) {
        // New pipe-separated format
        sun_levels = (row['sun_levels'] || '').split('|').map(s => s.trim()).filter(Boolean);
      } else {
        // Old single-value sun_level — wrap in array
        const sl = row['sun_level'] || '';
        sun_levels = sl ? [sl] : [];
      }
      moisture          = row['moisture']          || 'average';
      is_pollinator     = row['is_pollinator']     === 'true';
      is_deer_resistant = row['is_deer_resistant'] === 'true';
    } else {
      // Original format: derive from categories tag column
      const cats = (row['categories'] || '').toLowerCase();
      sun_levels = [];
      if (cats.includes('/sun'))        sun_levels.push('full_sun');
      if (cats.includes('/part-shade')) sun_levels.push('part_shade');
      if (cats.includes('/shade') && !cats.includes('/part-shade')) sun_levels.push('shade');

      moisture = 'average';
      if (cats.includes('/drought'))                                   moisture = 'drought';
      else if (cats.includes('/rain-garden') || cats.includes('/wet')) moisture = 'wet';

      is_pollinator     = cats.includes('/pollinator');
      is_deer_resistant = cats.includes('/deer');
    }

    const parseBool = v => v === 'true' || v === 'True' || v === '1' || v === 'yes';

    // Preserve enrichment source type if present, otherwise default to 'csv'
    const rawSource = row['source'] || '';
    const source = ['ai_enriched', 'manually_enriched'].includes(rawSource) ? rawSource : 'csv';

    map.set(normalizeName(common), {
      latin:            row['latin']            || '',
      common,
      attributes_line:  row['attributes_line']  || '',
      highlight_line:   row['highlight_line']   || '',
      categories:       row['categories']       || '',
      photo_file:       row['photo_file']       || '',
      sun_levels,
      moisture,
      is_pollinator,
      is_deer_resistant,
      piedmont_native:   parseBool(row['piedmont_native']),
      flag_for_review:   parseBool(row['flag_for_review']),
      reason_for_review: row['reason_for_review'] || '',
      source,
    });
  }
  return map;
}

/**
 * Compare plants.csv icon flags against Squarespace Categories/Tags for a matched plant.
 * When contradictions are found, sets flag_for_review=true and appends to reason_for_review.
 * Modifies plant in-place; no-ops for pending plants (no CSV data to compare).
 */
function checkCsvVsSquarespaceContradictions(plant) {
  if (plant.source === 'pending') return;

  const combined = ((plant.category || '') + ' ' + (plant.tags || '')).toLowerCase();
  const ssCat = s => combined.includes(s);
  const reasons = [];

  // Pollinator
  const ssPollinator = ssCat('/pollinator');
  if (ssPollinator !== plant.is_pollinator) {
    reasons.push(
      `pollinator: Squarespace=${ssPollinator ? 'yes' : 'no'}, CSV=${plant.is_pollinator ? 'yes' : 'no'}`
    );
  }

  // Deer resistant
  const ssDeer = ssCat('/deer');
  if (ssDeer !== plant.is_deer_resistant) {
    reasons.push(
      `deer resistant: Squarespace=${ssDeer ? 'yes' : 'no'}, CSV=${plant.is_deer_resistant ? 'yes' : 'no'}`
    );
  }

  // Sun — only compare if both sides have explicit data
  const ssSun = [];
  if (ssCat('/sun') && !ssCat('/part-shade')) ssSun.push('full_sun');
  if (ssCat('/part-shade'))                   ssSun.push('part_shade');
  if (ssCat('/shade') && !ssCat('/part-shade')) ssSun.push('shade');
  const csvSun = plant.sun_levels || [];
  if (ssSun.length > 0 && csvSun.length > 0) {
    const mismatch = ssSun.some(v => !csvSun.includes(v)) || csvSun.some(v => !ssSun.includes(v));
    if (mismatch) {
      reasons.push(`sun: Squarespace=[${ssSun.join(',')}], CSV=[${csvSun.join(',')}]`);
    }
  }

  // Moisture — only compare if Squarespace has an explicit moisture category
  const ssMoisture = ssCat('/drought') ? 'drought'
    : (ssCat('/rain-garden') || ssCat('/wet')) ? 'wet'
    : null;
  if (ssMoisture && plant.moisture && ssMoisture !== plant.moisture) {
    reasons.push(`moisture: Squarespace=${ssMoisture}, CSV=${plant.moisture}`);
  }

  if (reasons.length > 0) {
    plant.flag_for_review = true;
    const existing = plant.reason_for_review ? plant.reason_for_review + '; ' : '';
    plant.reason_for_review = existing + 'SS vs CSV: ' + reasons.join('; ');
  }
}

/**
 * Find the best match for a Squarespace title in the plants.csv map.
 * Tries: exact normalized match, then partial containment in either direction.
 */
function findCsvMatch(title, csvMap) {
  const normTitle = normalizeName(title);
  if (csvMap.has(normTitle)) return csvMap.get(normTitle);
  for (const [key, entry] of csvMap) {
    if (normTitle.startsWith(key) || normTitle.includes(key)) return entry;
  }
  for (const [key, entry] of csvMap) {
    if (key.startsWith(normTitle) || key.includes(normTitle)) return entry;
  }
  return null;
}

/**
 * Parse Squarespace TSV rows into plant objects.
 * Deduplicates by Product ID; skips variant rows (empty Title).
 */
function parseSquarespaceRows(rows, csvMap) {
  const seen = new Set();
  const result = [];

  for (const row of rows) {
    const productId = row['Product ID [Non Editable]'] || row['Product ID'] || '';
    if (productId && seen.has(productId)) continue;
    if (productId) seen.add(productId);

    const title = row['Title'] || '';
    if (!title) continue;  // skip variant rows

    const description = stripHtml(row['Description'] || '').trim();
    const category    = row['Categories'] || '';
    const tags        = row['Tags']       || '';
    const photo_urls  = (row['Hosted Image URLs'] || '').split(/\s+/).map(u => u.trim()).filter(Boolean);

    const match = csvMap ? findCsvMatch(title, csvMap) : null;

    result.push({
      common:            title,
      description,
      category,
      tags,
      photo_urls,
      latin:             match ? match.latin             : '',
      attributes_line:   match ? match.attributes_line   : '',
      highlight_line:    match ? match.highlight_line    : '',
      sun_levels:        match ? (match.sun_levels || []) : [],
      moisture:          match ? match.moisture           : '',
      is_pollinator:     match ? match.is_pollinator      : false,
      is_deer_resistant: match ? match.is_deer_resistant  : false,
      piedmont_native:   match ? !!match.piedmont_native  : false,
      flag_for_review:   match ? !!match.flag_for_review  : false,
      reason_for_review: match ? (match.reason_for_review || '') : '',
      source: match ? (match.source || 'csv') : 'pending',
    });
  }
  return result;
}
