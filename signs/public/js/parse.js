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
 * Parse legacy plants.csv into a Map keyed by normalized common name.
 * Expected headers: latin, common, attributes_line, highlight_line, page, categories, photo_file
 */
function parseLegacyCsv(text) {
  const map = new Map();
  const rows = parseDelimited(text);
  if (rows.length === 0) return map;

  for (const row of rows) {
    const common = row['common'] || '';
    if (!common) continue;

    const cats = (row['categories'] || '').toLowerCase();

    let sun_level = '';
    if (cats.includes('/sun') && cats.includes('/part-shade')) sun_level = 'part_shade';
    else if (cats.includes('/part-shade')) sun_level = 'part_shade';
    else if (cats.includes('/sun'))        sun_level = 'full_sun';
    else if (cats.includes('/shade'))      sun_level = 'shade';

    let moisture = 'average';
    if (cats.includes('/drought'))                              moisture = 'drought';
    else if (cats.includes('/rain-garden') || cats.includes('/wet')) moisture = 'wet';

    map.set(normalizeName(common), {
      latin:           row['latin']           || '',
      common,
      attributes_line: row['attributes_line'] || '',
      highlight_line:  row['highlight_line']  || '',
      categories:      row['categories']      || '',
      photo_file:      row['photo_file']      || '',
      sun_level,
      moisture,
      is_pollinator:    cats.includes('/pollinator'),
      is_deer_resistant: cats.includes('/deer'),
    });
  }
  return map;
}

/**
 * Find the best legacy match for a Squarespace title.
 * Tries: exact normalized match, then partial containment in either direction.
 */
function findLegacyMatch(title, legacyMap) {
  const normTitle = normalizeName(title);
  if (legacyMap.has(normTitle)) return legacyMap.get(normTitle);
  for (const [key, entry] of legacyMap) {
    if (normTitle.startsWith(key) || normTitle.includes(key)) return entry;
  }
  for (const [key, entry] of legacyMap) {
    if (key.startsWith(normTitle) || key.includes(normTitle)) return entry;
  }
  return null;
}

/**
 * Parse Squarespace TSV rows into plant objects.
 * Deduplicates by Product ID; skips variant rows (empty Title).
 */
function parseSquarespaceRows(rows, legacyMap) {
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

    const legacy = legacyMap ? findLegacyMatch(title, legacyMap) : null;

    result.push({
      common:           title,
      description,
      category,
      tags,
      photo_urls,
      latin:            legacy ? legacy.latin           : '',
      attributes_line:  legacy ? legacy.attributes_line : '',
      highlight_line:   legacy ? legacy.highlight_line  : '',
      sun_level:        legacy ? legacy.sun_level        : '',
      moisture:         legacy ? legacy.moisture         : 'average',
      is_pollinator:    legacy ? legacy.is_pollinator    : false,
      is_deer_resistant: legacy ? legacy.is_deer_resistant : false,
      source: legacy ? 'legacy' : 'pending',
    });
  }
  return result;
}
