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
 * Convert old-format attributes_line + highlight_line to the new HTML description format.
 * Split attributes_line on ';', each segment becomes a <li> with <strong>Label:</strong> value.
 * highlight_line becomes a <p>.
 */
function attributesLineToHtml(attributesLine, highlightLine) {
  const items = (attributesLine || '').split(';').map(s => s.trim()).filter(Boolean);
  let html = '';
  if (items.length > 0) {
    const lis = items.map(item => {
      const colonIdx = item.indexOf(':');
      if (colonIdx === -1) return `<li>${item}</li>`;
      const label = item.slice(0, colonIdx).trim();
      const value = item.slice(colonIdx + 1).trim();
      return `<li><strong>${label}:</strong> ${value}</li>`;
    });
    html += '<ul>' + lis.join('') + '</ul>';
  }
  if (highlightLine && highlightLine.trim()) {
    html += `<p>${highlightLine.trim()}</p>`;
  }
  return html;
}

/**
 * Parse plants.csv into a Map keyed by normalized common name.
 *
 * New format columns: common, piedmont_native, description, flag_for_review,
 *   reason_for_review, description_merged, source
 *
 * Backward compat: if old columns (attributes_line, highlight_line) are present,
 * auto-converts them to HTML description on load so old CSVs still work.
 */
function parsePlantsCsv(text) {
  const map = new Map();
  const rows = parseDelimited(text);
  if (rows.length === 0) return map;

  const firstRow = rows[0] || {};
  const isOldFormat = ('attributes_line' in firstRow) || ('highlight_line' in firstRow);

  const parseBool = v => v === 'true' || v === 'True' || v === '1' || v === 'yes';

  for (const row of rows) {
    const common = row['common'] || '';
    if (!common) continue;

    let description;
    if (isOldFormat) {
      description = attributesLineToHtml(row['attributes_line'] || '', row['highlight_line'] || '');
    } else {
      description = row['description'] || '';
    }

    // Preserve enrichment source type if present, otherwise default to 'csv'
    const rawSource = row['source'] || '';
    const source = ['ai_enriched', 'manually_enriched'].includes(rawSource) ? rawSource : 'csv';

    map.set(normalizeName(common), {
      common,
      description,
      piedmont_native:    parseBool(row['piedmont_native']),
      flag_for_review:    parseBool(row['flag_for_review']),
      reason_for_review:  row['reason_for_review'] || '',
      description_merged: parseBool(row['description_merged']),
      source,
    });
  }
  return map;
}

/**
 * Derive sun_levels, moisture, is_pollinator, is_deer_resistant from
 * Squarespace Categories + Tags. Returns those fields plus a moistureConflict
 * boolean when both drought and rain-garden tags are present simultaneously.
 *
 * moisture is null when no moisture tag is found or when tags conflict.
 * indirect-light and bright-light are houseplant categories and are not
 * mapped to sun_levels.
 */
function inferFromSsTags(category, tags) {
  const raw = (category || '') + ',' + (tags || '');
  const tokens = new Set(
    raw.split(/[,/]/).map(t => t.trim().toLowerCase()).filter(Boolean)
  );

  // Sun — multi-value: all applicable levels
  const sun_levels = [];
  if (tokens.has('sun'))                                                           sun_levels.push('full_sun');
  if (tokens.has('part-shade') || tokens.has('part shade') || tokens.has('part sun')) sun_levels.push('part_shade');
  if (tokens.has('shade'))                                                         sun_levels.push('shade');

  // Moisture — null means unknown (no tag, or conflicting tags)
  const hasDrought    = tokens.has('drought');
  const hasRainGarden = tokens.has('rain-garden') || tokens.has('rain garden');
  const hasRegWater   = tokens.has('reg water');
  let moisture = null, moistureConflict = false;
  if (hasDrought && hasRainGarden) {
    moistureConflict = true;  // contradictory — leave moisture null
  } else if (hasDrought)  { moisture = 'drought'; }
  else if (hasRainGarden) { moisture = 'wet'; }
  else if (hasRegWater)   { moisture = 'average'; }

  const is_pollinator     = tokens.has('pollinator');
  const is_deer_resistant = tokens.has('deer');

  return { sun_levels, moisture, moistureConflict, is_pollinator, is_deer_resistant };
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

// ─── Globals populated by parseSquarespaceRows ────────────────────────────────

/** Raw SS rows from the last import (for building the updated SS inventory TSV). */
let rawSsRows = [];

/** All unique tag values found in the SS export. */
let allSsTags = new Set();

/** All unique category values found in the SS export. */
let allSsCategories = new Set();

/**
 * Parse Squarespace TSV rows into plant objects.
 * Deduplicates by Product ID; skips variant rows (empty Title).
 *
 * Squarespace Categories/Tags are the authoritative source for icon fields
 * (sun_levels, moisture, is_pollinator, is_deer_resistant). plants.csv is
 * used for description + piedmont_native. description falls back to raw SS
 * HTML when no CSV match exists.
 *
 * Populates rawSsRows, allSsTags, allSsCategories globals.
 */
function parseSquarespaceRows(rows, csvMap) {
  rawSsRows = rows;
  allSsTags = new Set();
  allSsCategories = new Set();

  const seen = new Set();
  const result = [];

  for (const row of rows) {
    const productId = row['Product ID [Non Editable]'] || row['Product ID'] || '';
    if (productId && seen.has(productId)) continue;
    if (productId) seen.add(productId);

    const title = row['Title'] || '';
    if (!title) continue;  // skip variant rows

    const ss_description_html = row['Description'] || '';
    const category = row['Categories'] || '';
    const tags     = row['Tags']       || '';
    const photo_urls = (row['Hosted Image URLs'] || '').split(/\s+/).map(u => u.trim()).filter(Boolean);

    // Collect all unique tag/category values
    tags.split(',').map(t => t.trim()).filter(Boolean).forEach(t => allSsTags.add(t));
    category.split(',').map(c => c.trim()).filter(Boolean).forEach(c => allSsCategories.add(c));

    // Derive icon fields from Squarespace tags (primary / authoritative source)
    const ss = inferFromSsTags(category, tags);

    // Build flag/reason starting from SS data quality issues
    let flag_for_review   = false;
    let reason_for_review = '';
    const addReason = msg => {
      flag_for_review = true;
      reason_for_review = reason_for_review ? reason_for_review + '; ' + msg : msg;
    };

    if (ss.moistureConflict) {
      addReason('SS moisture: contradictory drought + rain-garden tags');
    } else if (ss.moisture === null) {
      addReason('missing moisture data in Squarespace');
    }

    // Match against plants.csv for description + piedmont_native
    const match = csvMap ? findCsvMatch(title, csvMap) : null;
    if (match) {
      if (match.flag_for_review) {
        flag_for_review = true;
        if (match.reason_for_review) {
          reason_for_review = reason_for_review
            ? reason_for_review + '; ' + match.reason_for_review
            : match.reason_for_review;
        }
      }
    }

    result.push({
      common:             title,
      category,
      tags,
      photo_urls,
      ss_description_html,
      description:        match ? (match.description || ss_description_html) : ss_description_html,
      sun_levels:         ss.sun_levels,
      moisture:           ss.moisture,
      is_pollinator:      ss.is_pollinator,
      is_deer_resistant:  ss.is_deer_resistant,
      piedmont_native:    match ? !!match.piedmont_native : false,
      flag_for_review,
      reason_for_review,
      description_merged: match ? !!match.description_merged : false,
      source:             match ? (match.source || 'csv') : 'pending',
    });
  }
  return result;
}
