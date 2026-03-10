// ─── App state ────────────────────────────────────────────────────────────────
let plants = [];

// ─── API key helpers ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('openai_api_key');
  if (saved) {
    const el = document.getElementById('openai-key');
    if (el) {
      el.value = saved;
      document.getElementById('key-status').textContent = '✓ Saved';
    }
  }
});

function saveApiKey() {
  const key = document.getElementById('openai-key').value.trim();
  localStorage.setItem('openai_api_key', key);
  document.getElementById('key-status').textContent = '✓ Saved';
}

// ─── File input handlers ──────────────────────────────────────────────────────

function handleSsFile(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById('ss-file-name').textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => { document.getElementById('ss-textarea').value = e.target.result; };
  reader.readAsText(file);
}

function handlePlantsFile(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById('plants-file-name').textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => { document.getElementById('plants-textarea').value = e.target.result; };
  reader.readAsText(file);
}

// ─── Import action ────────────────────────────────────────────────────────────

function runImport() {
  const statusEl = document.getElementById('import-status');

  const ssText = document.getElementById('ss-textarea').value.trim();
  if (!ssText) {
    statusEl.style.color = '#c0392b';
    statusEl.textContent = 'Please paste or upload the Squarespace export first.';
    return;
  }

  statusEl.style.color = '#555';
  statusEl.textContent = 'Parsing…';

  try {
    const csvText = document.getElementById('plants-textarea').value.trim();
    const csvMap  = csvText ? parsePlantsCsv(csvText) : new Map();
    const rows    = parseDelimited(ssText);

    if (rows.length === 0) {
      statusEl.style.color = '#c0392b';
      statusEl.textContent = 'No rows found — check that the file is tab-separated.';
      return;
    }

    plants = parseSquarespaceRows(rows, csvMap);

    // Apply debug plant limit
    if (DEBUG && debugState.limitEnabled && plants.length > debugState.limitValue) {
      if (debugState.pickOverlap && csvMap.size > 0) {
        // Fill limit with (N-1) CSV matches + 1 pending so both code paths are tested.
        const csvPlants = plants.filter(p => p.source === 'csv');
        const pending   = plants.filter(p => p.source === 'pending');
        const nCsv = Math.min(csvPlants.length, debugState.limitValue - (pending.length > 0 ? 1 : 0));
        plants = [...csvPlants.slice(0, nCsv), ...pending.slice(0, debugState.limitValue - nCsv)];
      } else {
        plants = plants.slice(0, debugState.limitValue);
      }
    }

    if (plants.length === 0) {
      statusEl.style.color = '#c0392b';
      statusEl.textContent = 'Parsed rows but found no valid plants (missing Title column?).';
      return;
    }

    const csvCount = plants.filter(p => p.source === 'csv').length;
    statusEl.style.color = '#2d5a27';
    statusEl.textContent =
      `Imported ${plants.length} plants. ` +
      (csvMap.size > 0
        ? `${csvCount} matched from plants.csv, ${plants.length - csvCount} need enrichment.`
        : 'No plants.csv provided — all plants need enrichment.');

    buildReviewTable();

    const pendingCount = plants.filter(p => p.source === 'pending').length;
    const enrichSection = document.getElementById('enrich-section');
    if (pendingCount > 0) {
      enrichSection.style.display = 'block';
      document.getElementById('enrich-btn').textContent = `Enrich ${pendingCount} pending plants`;
      document.getElementById('enrich-status').textContent = '';
      document.getElementById('enrich-progress-wrap').style.display = 'none';
      document.getElementById('enrich-progress-bar').style.width = '0%';
    } else {
      enrichSection.style.display = 'none';
    }

    document.getElementById('review-section').style.display = 'block';
    document.getElementById('review-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    statusEl.style.color = '#c0392b';
    statusEl.textContent = 'Parse error: ' + err.message;
    console.error(err);
  }
}

// ─── Review table ─────────────────────────────────────────────────────────────

const SOURCE_BADGE = {
  csv:                { cls: 'badge-csv',               text: '🟢 plants.csv' },
  pending:            { cls: 'badge-pending',           text: '🟡 Needs enrichment' },
  ai_enriched:        { cls: 'badge-ai-enriched',       text: '🔵 AI Enriched' },
  manually_enriched:  { cls: 'badge-manually-enriched', text: '🟣 Manually Enriched' },
};

const SOURCE_ORDER = { pending: 0, ai_enriched: 1, manually_enriched: 2, csv: 3 };
const PAGE_SIZE = 10;
let currentPage = 1;

function applyBadge(badge, source) {
  const { cls, text } = SOURCE_BADGE[source] || SOURCE_BADGE.pending;
  badge.className   = 'badge ' + cls;
  badge.textContent = text;
}

function markManuallyEnriched(idx, tr) {
  if (plants[idx].source === 'pending') return;  // pending stays pending
  plants[idx].source = 'manually_enriched';
  const badge = tr.querySelector('.badge');
  if (badge) applyBadge(badge, 'manually_enriched');
}

function getSortedPlants() {
  return [...plants].sort((a, b) => {
    const ao = SOURCE_ORDER[a.source] ?? 99;
    const bo = SOURCE_ORDER[b.source] ?? 99;
    return ao - bo;
  });
}

function buildReviewTable() {
  currentPage = 1;
  renderPage();
  document.getElementById('gen-btn').textContent = `Generate PPTX (${plants.length} plants)`;
}

function renderPage() {
  const sorted    = getSortedPlants();
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const pageItems = sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const tbody = document.getElementById('review-tbody');
  tbody.innerHTML = '';

  pageItems.forEach((plant) => {
    // Find the real index in the `plants` array so in-place updates work correctly
    const idx = plants.indexOf(plant);
    const tr = document.createElement('tr');
    tr.dataset.idx = idx;

    // Pre-declare all editable input refs so the fill-from-clipboard handler
    // (built in the source cell, first) can close over them.
    let latinInput, attribArea, highlightArea, sunSelect, moistureSelect, pollinatorCheck, deerCheck;

    // ── Source badge + action buttons ──────────────────────────────────────────
    const tdSource = document.createElement('td');
    tdSource.className = 'td-source';
    const badge    = document.createElement('span');
    applyBadge(badge, plant.source);
    tdSource.appendChild(badge);

    if (plant.source === 'pending') {
      const copyBtn = document.createElement('button');
      copyBtn.className   = 'secondary copy-prompt-btn';
      copyBtn.textContent = 'Copy prompt';
      copyBtn.addEventListener('click', async () => {
        const prompt = buildPrompt(plant, '');
        try {
          await navigator.clipboard.writeText(prompt);
          copyBtn.textContent = 'Copied!';
        } catch (e) {
          copyBtn.textContent = 'Failed';
        }
        setTimeout(() => { copyBtn.textContent = 'Copy prompt'; }, 2000);
      });
      tdSource.appendChild(copyBtn);

      const fillBtn = document.createElement('button');
      fillBtn.className   = 'secondary copy-prompt-btn';
      fillBtn.textContent = 'Fill from clipboard';
      fillBtn.addEventListener('click', async () => {
        let text;
        try {
          text = await navigator.clipboard.readText();
        } catch (e) {
          fillBtn.textContent = 'No access';
          setTimeout(() => { fillBtn.textContent = 'Fill from clipboard'; }, 2000);
          return;
        }

        text = text.trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/, '')
          .trim()
          .replace(/\n\s+/g, ' ');

        let data;
        try { data = JSON.parse(text); }
        catch (e) {
          fillBtn.textContent = 'Invalid JSON';
          setTimeout(() => { fillBtn.textContent = 'Fill from clipboard'; }, 2000);
          return;
        }

        if (data.latin)           { plants[idx].latin           = data.latin;           latinInput.value     = data.latin; }
        if (data.attributes_line) { plants[idx].attributes_line = data.attributes_line; attribArea.value     = data.attributes_line; }
        if (data.highlight_line)  { plants[idx].highlight_line  = data.highlight_line;  highlightArea.value  = data.highlight_line; }
        if (data.sun_level)       { plants[idx].sun_level       = data.sun_level;       sunSelect.value      = data.sun_level; }
        if (data.moisture)        { plants[idx].moisture        = data.moisture;        moistureSelect.value = data.moisture; }
        if (typeof data.is_pollinator     === 'boolean') { plants[idx].is_pollinator     = data.is_pollinator;     pollinatorCheck.checked = data.is_pollinator; }
        if (typeof data.is_deer_resistant === 'boolean') { plants[idx].is_deer_resistant = data.is_deer_resistant; deerCheck.checked       = data.is_deer_resistant; }

        plants[idx].source = 'ai_enriched';
        applyBadge(badge, 'ai_enriched');
        copyBtn.remove();
        fillBtn.remove();
      });
      tdSource.appendChild(fillBtn);
    }

    tr.appendChild(tdSource);

    // ── Common name (read-only) ─────────────────────────────────────────────────
    const tdCommon = document.createElement('td');
    tdCommon.style.minWidth = '120px';
    tdCommon.textContent    = plant.common;
    tr.appendChild(tdCommon);

    // ── Latin name ──────────────────────────────────────────────────────────────
    const tdLatin = document.createElement('td');
    tdLatin.style.minWidth = '140px';
    latinInput = document.createElement('input');
    latinInput.type        = 'text';
    latinInput.value       = plant.latin;
    latinInput.placeholder = 'Latin name…';
    latinInput.addEventListener('input', () => { plants[idx].latin = latinInput.value; markManuallyEnriched(idx, tr); });
    tdLatin.appendChild(latinInput);
    tr.appendChild(tdLatin);

    // ── Photo thumbnail ─────────────────────────────────────────────────────────
    const tdPhoto = document.createElement('td');
    tdPhoto.style.minWidth = '60px';
    if (plant.photo_urls?.[0]) {
      const img     = document.createElement('img');
      img.src       = plant.photo_urls[0];
      img.className = 'thumb';
      img.alt       = plant.common;
      img.onerror   = () => img.replaceWith(noPhotoSpan());
      tdPhoto.appendChild(img);
    } else {
      tdPhoto.appendChild(noPhotoSpan());
    }
    tr.appendChild(tdPhoto);

    // ── Attributes ──────────────────────────────────────────────────────────────
    const tdAttribs = document.createElement('td');
    tdAttribs.style.minWidth = '200px';
    attribArea = document.createElement('textarea');
    attribArea.value       = plant.attributes_line;
    attribArea.placeholder = 'Size: …; Bloom: …; Soil: …';
    attribArea.addEventListener('input', () => { plants[idx].attributes_line = attribArea.value; markManuallyEnriched(idx, tr); });
    tdAttribs.appendChild(attribArea);
    tr.appendChild(tdAttribs);

    // ── Highlight ───────────────────────────────────────────────────────────────
    const tdHighlight = document.createElement('td');
    tdHighlight.style.minWidth = '200px';
    highlightArea = document.createElement('textarea');
    highlightArea.value       = plant.highlight_line;
    highlightArea.placeholder = 'Editorial highlight text…';
    highlightArea.addEventListener('input', () => { plants[idx].highlight_line = highlightArea.value; markManuallyEnriched(idx, tr); });
    tdHighlight.appendChild(highlightArea);
    tr.appendChild(tdHighlight);

    // ── Icon fields: sun, moisture, pollinator, deer ────────────────────────────
    const tdIcons = document.createElement('td');
    tdIcons.style.minWidth = '130px';
    tdIcons.className = 'icon-fields';

    sunSelect = document.createElement('select');
    [['', '— sun —'], ['full_sun', 'Full sun'], ['part_shade', 'Part shade'], ['shade', 'Shade']].forEach(([v, l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l; sunSelect.appendChild(o);
    });
    sunSelect.value = plant.sun_level || '';
    sunSelect.addEventListener('change', () => { plants[idx].sun_level = sunSelect.value; markManuallyEnriched(idx, tr); });

    moistureSelect = document.createElement('select');
    [['', '— moisture —'], ['wet', 'Wet'], ['average', 'Average'], ['drought', 'Drought']].forEach(([v, l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l; moistureSelect.appendChild(o);
    });
    moistureSelect.value = plant.moisture || '';
    moistureSelect.addEventListener('change', () => { plants[idx].moisture = moistureSelect.value; markManuallyEnriched(idx, tr); });

    const makeCheckRow = (label, checked, onChange) => {
      const row = document.createElement('label');
      row.className = 'icon-check-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = checked;
      cb.addEventListener('change', () => { onChange(cb.checked); markManuallyEnriched(idx, tr); });
      row.appendChild(cb);
      row.append(' ' + label);
      return { row, cb };
    };

    const { row: pollinatorRow, cb: _pollinatorCheck } = makeCheckRow('Pollinator', plant.is_pollinator, v => { plants[idx].is_pollinator = v; });
    pollinatorCheck = _pollinatorCheck;
    const { row: deerRow, cb: _deerCheck } = makeCheckRow('Deer resistant', plant.is_deer_resistant, v => { plants[idx].is_deer_resistant = v; });
    deerCheck = _deerCheck;

    tdIcons.appendChild(sunSelect);
    tdIcons.appendChild(moistureSelect);
    tdIcons.appendChild(pollinatorRow);
    tdIcons.appendChild(deerRow);
    tr.appendChild(tdIcons);

    tbody.appendChild(tr);
  });

  // Pagination controls
  const pg = document.getElementById('pagination');
  pg.innerHTML = '';
  if (totalPages > 1) {
    const prev = document.createElement('button');
    prev.className = 'secondary';
    prev.textContent = '← Prev';
    prev.disabled = currentPage === 1;
    prev.addEventListener('click', () => { currentPage--; renderPage(); });

    const info = document.createElement('span');
    info.className   = 'pagination-info';
    info.textContent = `Page ${currentPage} of ${totalPages}`;

    const next = document.createElement('button');
    next.className = 'secondary';
    next.textContent = 'Next →';
    next.disabled = currentPage === totalPages;
    next.addEventListener('click', () => { currentPage++; renderPage(); });

    pg.appendChild(prev);
    pg.appendChild(info);
    pg.appendChild(next);
  }
}

function noPhotoSpan() {
  const span       = document.createElement('span');
  span.className   = 'no-photo';
  span.textContent = 'No photo';
  return span;
}

// ─── Download enriched CSV ────────────────────────────────────────────────────

function downloadEnrichedCsv() {
  if (!plants.length) return;

  function csvEscape(val) {
    const s = String(val ?? '').replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ');
    return (s.includes(',') || s.includes('"'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }

  const headers = ['latin', 'common', 'attributes_line', 'highlight_line', 'sun_level', 'moisture', 'is_pollinator', 'is_deer_resistant', 'source'];
  const rows = [headers.join(',')];
  for (const p of plants) {
    rows.push([
      csvEscape(p.latin),
      csvEscape(p.common),
      csvEscape(p.attributes_line),
      csvEscape(p.highlight_line),
      csvEscape(p.sun_level),
      csvEscape(p.moisture),
      csvEscape(p.is_pollinator),
      csvEscape(p.is_deer_resistant),
      csvEscape(p.source),
    ].join(','));
  }

  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'plants.enriched.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── Enrichment UI ────────────────────────────────────────────────────────────

async function startEnrichment() {
  const apiKey = document.getElementById('openai-key').value.trim();
  if (!apiKey) {
    const s = document.getElementById('enrich-status');
    s.style.color = '#c0392b';
    s.textContent = 'Please enter an OpenAI API key first.';
    return;
  }

  const btn          = document.getElementById('enrich-btn');
  const statusEl     = document.getElementById('enrich-status');
  const progressWrap = document.getElementById('enrich-progress-wrap');
  const progressBar  = document.getElementById('enrich-progress-bar');
  const progressLabel= document.getElementById('enrich-progress-label');

  btn.disabled = true;
  statusEl.textContent = '';
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';

  let errors = 0;

  await enrichAllPending(apiKey, (completed, total, updatedPlant) => {
    // Update progress bar
    const pct = Math.round((completed / total) * 100);
    progressBar.style.width = pct + '%';
    progressLabel.textContent = `Enriching… ${completed} / ${total}`;

    if (updatedPlant.enrichError) { errors++; return; }

    // Update the row in the review table in-place
    const tr = document.querySelector(`tr[data-idx="${plants.indexOf(updatedPlant)}"]`);
    if (!tr) return;

    const badge = tr.querySelector('.badge');
    if (badge) applyBadge(badge, 'ai_enriched');
    tr.querySelectorAll('.copy-prompt-btn').forEach(b => b.remove());
    const inputs    = tr.querySelectorAll('input[type="text"]');
    const textareas = tr.querySelectorAll('textarea');
    const selects   = tr.querySelectorAll('.icon-fields select');
    const checks    = tr.querySelectorAll('.icon-fields input[type="checkbox"]');
    if (inputs[0])    inputs[0].value    = updatedPlant.latin           || '';
    if (textareas[0]) textareas[0].value = updatedPlant.attributes_line || '';
    if (textareas[1]) textareas[1].value = updatedPlant.highlight_line  || '';
    if (selects[0])   selects[0].value   = updatedPlant.sun_level       || '';
    if (selects[1])   selects[1].value   = updatedPlant.moisture        || '';
    if (checks[0])    checks[0].checked  = !!updatedPlant.is_pollinator;
    if (checks[1])    checks[1].checked  = !!updatedPlant.is_deer_resistant;
  });

  progressWrap.style.display = 'none';
  statusEl.style.color = errors ? '#c0392b' : '#2d5a27';
  statusEl.textContent = errors
    ? `Done — ${errors} plant(s) failed to enrich. Check console for details.`
    : `✓ All pending plants enriched successfully.`;
  btn.disabled = false;
}
