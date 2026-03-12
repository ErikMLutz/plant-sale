// ─── App state ────────────────────────────────────────────────────────────────
let plants = [];

// ─── API key helpers ──────────────────────────────────────────────────────────

function syncRowEnrichBtns() {
  const key = document.getElementById('openai-key')?.value.trim() || '';
  document.querySelectorAll('.row-enrich-btn').forEach(b => { b.disabled = !key; });
}

document.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('openai_api_key');
  if (saved) {
    const el = document.getElementById('openai-key');
    if (el) {
      el.value = saved;
      document.getElementById('key-status').textContent = '✓ Saved';
      syncRowEnrichBtns();
    }
  }
});

function saveApiKey() {
  const key = document.getElementById('openai-key').value.trim();
  localStorage.setItem('openai_api_key', key);
  document.getElementById('key-status').textContent = '✓ Saved';
  syncRowEnrichBtns();
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

    // Apply import filters before parsing (mirrors download_images.py filtering)
    let filteredRows = rows;
    if (appSettings.filterVisible) {
      filteredRows = filteredRows.filter(r =>
        (r['Visible'] || '').trim().toLowerCase() === 'yes'
      );
    }
    if (appSettings.excludedPages.length > 0) {
      const excluded = new Set(appSettings.excludedPages);
      filteredRows = filteredRows.filter(r =>
        !excluded.has((r['Product Page'] || '').trim().toLowerCase())
      );
    }

    plants = parseSquarespaceRows(filteredRows, csvMap);
    if (csvMap.size > 0) plants.forEach(checkCsvVsSquarespaceContradictions);

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

    const csvCount    = plants.filter(p => p.source === 'csv').length;
    const reviewCount = plants.filter(p => p.flag_for_review).length;
    statusEl.style.color = '#2d5a27';
    statusEl.textContent =
      `Imported ${plants.length} plants. ` +
      (csvMap.size > 0
        ? `${csvCount} matched from plants.csv, ${plants.length - csvCount} need enrichment.`
        : 'No plants.csv provided — all plants need enrichment.') +
      (reviewCount > 0 ? ` ${reviewCount} flagged for review.` : '');

    buildReviewTable();

    const pendingCount = plants.filter(p => p.source === 'pending').length;
    const enrichSection = document.getElementById('enrich-section');
    if (pendingCount > 0) {
      enrichSection.style.display = 'block';
      document.getElementById('enrich-btn-all').textContent = `Enrich all (${pendingCount}) pending plants`;
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

const REVIEW_BADGE = { cls: 'badge-review-needed', text: '🔴 Review needed' };

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
  const badge = tr.querySelector('.source-badge');
  if (badge) applyBadge(badge, 'manually_enriched');
  renderSummary();
}

function getSortedPlants() {
  return [...plants].sort((a, b) => {
    // flag_for_review always sorts first
    if (a.flag_for_review !== b.flag_for_review) return a.flag_for_review ? -1 : 1;
    const ao = SOURCE_ORDER[a.source] ?? 99;
    const bo = SOURCE_ORDER[b.source] ?? 99;
    return ao - bo;
  });
}

function renderSummary() {
  const el = document.getElementById('review-summary');
  if (!el) return;
  if (!plants.length) { el.innerHTML = ''; return; }

  const review   = plants.filter(p => p.flag_for_review).length;
  const pending  = plants.filter(p => p.source === 'pending').length;
  const csv      = plants.filter(p => p.source === 'csv').length;
  const ai       = plants.filter(p => p.source === 'ai_enriched').length;
  const manual   = plants.filter(p => p.source === 'manually_enriched').length;

  const chips = [
    { show: review,  cls: 'badge-review-needed',     label: `🔴 ${review} review needed` },
    { show: pending, cls: 'badge-pending',            label: `🟡 ${pending} needs enrichment` },
    { show: csv,     cls: 'badge-csv',                label: `🟢 ${csv} from plants.csv` },
    { show: ai,      cls: 'badge-ai-enriched',        label: `🔵 ${ai} AI enriched` },
    { show: manual,  cls: 'badge-manually-enriched',  label: `🟣 ${manual} manually enriched` },
  ];

  el.innerHTML = chips
    .filter(c => c.show > 0)
    .map(c => `<span class="badge ${c.cls} summary-chip">${c.label}</span>`)
    .join('');
}

function buildReviewTable() {
  currentPage = 1;
  renderPage();
  renderSummary();
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

    // Pre-declare refs for fill-from-clipboard handler
    let latinInput, attribArea, highlightArea, moistureSelect, pollinatorCheck, deerCheck;
    // Sun is now multi-select checkboxes; track by value key
    const sunChecks = {};

    // ── Source badge + action buttons ──────────────────────────────────────────
    const tdSource = document.createElement('td');
    tdSource.className = 'td-source';

    // Review needed badge (shown above source badge when flagged)
    if (plant.flag_for_review) {
      const reviewBadge = document.createElement('span');
      reviewBadge.className   = 'badge ' + REVIEW_BADGE.cls;
      reviewBadge.textContent = REVIEW_BADGE.text;
      if (plant.reason_for_review) {
        reviewBadge.title = plant.reason_for_review;
      }
      tdSource.appendChild(reviewBadge);
      if (plant.reason_for_review) {
        const reasonEl = document.createElement('div');
        reasonEl.className   = 'review-reason';
        reasonEl.textContent = plant.reason_for_review;
        tdSource.appendChild(reasonEl);
      }
    }

    const badge = document.createElement('span');
    badge.className = 'source-badge';
    applyBadge(badge, plant.source);
    tdSource.appendChild(badge);

    const rowEnrichBtn = document.createElement('button');
    rowEnrichBtn.className   = 'secondary row-enrich-btn';
    rowEnrichBtn.textContent = 'Auto-enrich';
    rowEnrichBtn.disabled    = !(document.getElementById('openai-key')?.value.trim());
    rowEnrichBtn.addEventListener('click', async () => {
      const apiKey = document.getElementById('openai-key').value.trim();
      if (!apiKey) return;
      rowEnrichBtn.disabled = true;
      rowEnrichBtn.textContent = 'Enriching…';
      const updated = await enrichPlant(plant, apiKey);
      plants[idx] = updated;
      if (!updated.enrichError) {
        applyEnrichedDataToRow(tr, badge, updated);
        renderSummary();
        const pendingCount = plants.filter(p => p.source === 'pending').length;
        document.getElementById('enrich-btn-all').textContent = `Enrich all (${pendingCount}) pending plants`;
      }
      rowEnrichBtn.textContent = updated.enrichError ? 'Failed' : 'Done';
      setTimeout(() => {
        rowEnrichBtn.textContent = 'Auto-enrich';
        rowEnrichBtn.disabled = !(document.getElementById('openai-key')?.value.trim());
      }, 2000);
    });
    tdSource.appendChild(rowEnrichBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className   = 'secondary copy-prompt-btn';
    copyBtn.textContent = 'Copy prompt';
    copyBtn.addEventListener('click', async () => {
      const prompt = buildPrompt(plant);
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

      text = unwrapJson(
        text.trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/, '')
          .trim()
      );

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

      // Accept sun_levels (array) or sun_level (string, from AI output)
      const sunFromData = Array.isArray(data.sun_levels)
        ? data.sun_levels
        : (data.sun_level ? [data.sun_level] : null);
      if (sunFromData) {
        plants[idx].sun_levels = sunFromData;
        Object.entries(sunChecks).forEach(([v, cb]) => { cb.checked = sunFromData.includes(v); });
      }

      if (data.moisture) { plants[idx].moisture = data.moisture; moistureSelect.value = data.moisture; }
      if (typeof data.is_pollinator     === 'boolean') { plants[idx].is_pollinator     = data.is_pollinator;     pollinatorCheck.checked = data.is_pollinator; }
      if (typeof data.is_deer_resistant === 'boolean') { plants[idx].is_deer_resistant = data.is_deer_resistant; deerCheck.checked       = data.is_deer_resistant; }

      plants[idx].source = 'ai_enriched';
      applyBadge(badge, 'ai_enriched');
      renderSummary();
    });
    tdSource.appendChild(fillBtn);

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

    // ── Icon fields: sun (multi), moisture, critter, deer ──────────────────────
    const tdIcons = document.createElement('td');
    tdIcons.style.minWidth = '140px';
    tdIcons.className = 'icon-fields';

    const makeCheckRow = (label, checked, onChange, dataAttrs) => {
      const row = document.createElement('label');
      row.className = 'icon-check-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = checked;
      if (dataAttrs) Object.entries(dataAttrs).forEach(([k, v]) => cb.dataset[k] = v);
      cb.addEventListener('change', () => { onChange(cb.checked); markManuallyEnriched(idx, tr); });
      row.appendChild(cb);
      row.append(' ' + label);
      return { row, cb };
    };

    // Sun — multi-select checkboxes
    const sunLabel = document.createElement('div');
    sunLabel.className   = 'icon-group-label';
    sunLabel.textContent = 'Sun:';
    tdIcons.appendChild(sunLabel);

    [['full_sun', 'Full sun'], ['part_shade', 'Part shade'], ['shade', 'Shade']].forEach(([v, l]) => {
      const { row, cb } = makeCheckRow(l, (plant.sun_levels || []).includes(v), checked => {
        if (checked) {
          if (!plants[idx].sun_levels) plants[idx].sun_levels = [];
          if (!plants[idx].sun_levels.includes(v)) plants[idx].sun_levels.push(v);
        } else {
          plants[idx].sun_levels = (plants[idx].sun_levels || []).filter(s => s !== v);
        }
      }, { sunValue: v });
      sunChecks[v] = cb;
      tdIcons.appendChild(row);
    });

    moistureSelect = document.createElement('select');
    [['', '— moisture —'], ['wet', 'Wet'], ['average', 'Average'], ['drought', 'Drought']].forEach(([v, l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l; moistureSelect.appendChild(o);
    });
    moistureSelect.value = plant.moisture || '';
    moistureSelect.addEventListener('change', () => { plants[idx].moisture = moistureSelect.value; markManuallyEnriched(idx, tr); });
    tdIcons.appendChild(moistureSelect);

    const { row: critterRow, cb: _critterCheck } = makeCheckRow('Critter friendly', plant.is_pollinator, v => { plants[idx].is_pollinator = v; }, { critterCheck: '1' });
    pollinatorCheck = _critterCheck;
    const { row: deerRow, cb: _deerCheck } = makeCheckRow('Deer resistant', plant.is_deer_resistant, v => { plants[idx].is_deer_resistant = v; }, { deerCheck: '1' });
    deerCheck = _deerCheck;

    tdIcons.appendChild(critterRow);
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

  const headers = [
    'latin', 'common', 'attributes_line', 'highlight_line',
    'sun_levels', 'moisture', 'is_pollinator', 'is_deer_resistant',
    'piedmont_native', 'flag_for_review', 'reason_for_review', 'source',
  ];
  const rows = [headers.join(',')];
  for (const p of plants) {
    rows.push([
      csvEscape(p.latin),
      csvEscape(p.common),
      csvEscape(p.attributes_line),
      csvEscape(p.highlight_line),
      csvEscape((p.sun_levels || []).join('|')),
      csvEscape(p.moisture),
      csvEscape(p.is_pollinator),
      csvEscape(p.is_deer_resistant),
      csvEscape(p.piedmont_native || false),
      csvEscape(p.flag_for_review || false),
      csvEscape(p.reason_for_review || ''),
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

// ─── Shared row-update helper (used by bulk and per-row enrichment) ───────────

function applyEnrichedDataToRow(tr, badge, updatedPlant) {
  if (badge) applyBadge(badge, 'ai_enriched');
  const inputs    = tr.querySelectorAll('input[type="text"]');
  const textareas = tr.querySelectorAll('textarea');
  const selects   = tr.querySelectorAll('.icon-fields select');
  if (inputs[0])    inputs[0].value    = updatedPlant.latin           || '';
  if (textareas[0]) textareas[0].value = updatedPlant.attributes_line || '';
  if (textareas[1]) textareas[1].value = updatedPlant.highlight_line  || '';
  if (selects[0])   selects[0].value   = updatedPlant.moisture        || '';

  // Sun levels via data-sun-value checkboxes
  const sunLevels = Array.isArray(updatedPlant.sun_levels) ? updatedPlant.sun_levels : [];
  tr.querySelectorAll('.icon-fields input[data-sun-value]').forEach(cb => {
    cb.checked = sunLevels.includes(cb.dataset.sunValue);
  });

  const critterCb = tr.querySelector('.icon-fields input[data-critter-check]');
  const deerCb    = tr.querySelector('.icon-fields input[data-deer-check]');
  if (critterCb) critterCb.checked = !!updatedPlant.is_pollinator;
  if (deerCb)    deerCb.checked    = !!updatedPlant.is_deer_resistant;
}

// ─── Enrichment UI ────────────────────────────────────────────────────────────

async function startEnrichment(limit) {
  const apiKey = document.getElementById('openai-key').value.trim();
  if (!apiKey) {
    const s = document.getElementById('enrich-status');
    s.style.color = '#c0392b';
    s.textContent = 'Please enter an OpenAI API key first.';
    return;
  }

  const enrichBtns   = document.querySelectorAll('.enrich-btn');
  const statusEl     = document.getElementById('enrich-status');
  const progressWrap = document.getElementById('enrich-progress-wrap');
  const progressBar  = document.getElementById('enrich-progress-bar');
  const progressLabel= document.getElementById('enrich-progress-label');

  enrichBtns.forEach(b => b.disabled = true);
  statusEl.textContent = '';
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';

  let errors = 0;

  await enrichAllPending(apiKey, limit ?? Infinity, (completed, total, updatedPlant) => {
    // Update progress bar
    const pct = Math.round((completed / total) * 100);
    progressBar.style.width = pct + '%';
    progressLabel.textContent = `Enriching… ${completed} / ${total}`;

    if (updatedPlant.enrichError) { errors++; return; }

    // Update the row in the review table in-place
    const tr = document.querySelector(`tr[data-idx="${plants.indexOf(updatedPlant)}"]`);
    if (tr) {
      const badge = tr.querySelector('.source-badge');
      applyEnrichedDataToRow(tr, badge, updatedPlant);
    }
    renderSummary();
  });

  progressWrap.style.display = 'none';
  statusEl.style.color = errors ? '#c0392b' : '#2d5a27';
  statusEl.textContent = errors
    ? `Done — ${errors} plant(s) failed to enrich. Check console for details.`
    : `✓ Done enriching plants.`;
  enrichBtns.forEach(b => b.disabled = false);

  // Refresh pending count on buttons
  const pendingCount = plants.filter(p => p.source === 'pending').length;
  document.getElementById('enrich-btn-all').textContent = `Enrich all (${pendingCount}) pending plants`;
}
