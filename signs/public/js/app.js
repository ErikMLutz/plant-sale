// ─── App state ────────────────────────────────────────────────────────────────
let plants = [];

// ─── API key helpers ──────────────────────────────────────────────────────────

function syncRowEnrichBtns() {
  const key = document.getElementById('openai-key')?.value.trim() || '';
  document.querySelectorAll('.row-enrich-btn, .row-merge-btn').forEach(b => { b.disabled = !key; });
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
    const mergedCount = plants.filter(p => p.description_merged).length;
    const reviewCount = plants.filter(p => p.flag_for_review).length;
    statusEl.style.color = '#2d5a27';
    statusEl.textContent =
      `Imported ${plants.length} plants. ` +
      (csvMap.size > 0
        ? `${csvCount} matched from plants.csv, ${plants.length - csvCount} need enrichment.`
        : 'No plants.csv provided — all plants need enrichment.') +
      (mergedCount > 0 ? ` ${mergedCount} descriptions merged.` : '') +
      (reviewCount > 0 ? ` ${reviewCount} flagged for review.` : '');

    buildReviewTable();

    const pendingCount = plants.filter(p => p.source === 'pending').length;
    const enrichSection = document.getElementById('enrich-section');
    if (pendingCount > 0 || csvCount > 0) {
      enrichSection.style.display = 'block';
      document.getElementById('enrich-btn-all').textContent = `Enrich all (${pendingCount}) pending plants`;
      document.getElementById('enrich-status').textContent = '';
      document.getElementById('enrich-progress-wrap').style.display = 'none';
      document.getElementById('enrich-progress-bar').style.width = '0%';

      // Update merge button counts
      const unmergedCount = plants.filter(p => !p.description_merged && p.source !== 'pending').length;
      document.getElementById('merge-btn-all').textContent = `Merge all (${unmergedCount}) unmerged`;
      document.getElementById('merge-status').textContent = '';
      document.getElementById('merge-progress-wrap').style.display = 'none';
      document.getElementById('merge-progress-bar').style.width = '0%';
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
  const merged   = plants.filter(p => p.description_merged).length;

  const chips = [
    { show: review,  cls: 'badge-review-needed',     label: `🔴 ${review} review needed` },
    { show: pending, cls: 'badge-pending',            label: `🟡 ${pending} needs enrichment` },
    { show: csv,     cls: 'badge-csv',                label: `🟢 ${csv} from plants.csv` },
    { show: ai,      cls: 'badge-ai-enriched',        label: `🔵 ${ai} AI enriched` },
    { show: manual,  cls: 'badge-manually-enriched',  label: `🟣 ${manual} manually enriched` },
    { show: merged,  cls: 'badge-merged',             label: `🟤 ${merged} desc merged` },
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

    // description_merged badge
    const mergedBadge = document.createElement('span');
    mergedBadge.className   = 'badge badge-merged desc-merged-badge';
    mergedBadge.textContent = '🟤 Desc merged';
    mergedBadge.style.display = plant.description_merged ? '' : 'none';
    tdSource.appendChild(mergedBadge);

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

    // Auto-merge button
    const rowMergeBtn = document.createElement('button');
    rowMergeBtn.className   = 'secondary row-merge-btn';
    rowMergeBtn.textContent = 'Auto-merge';
    rowMergeBtn.disabled    = !(document.getElementById('openai-key')?.value.trim());
    rowMergeBtn.addEventListener('click', async () => {
      const apiKey = document.getElementById('openai-key').value.trim();
      if (!apiKey) return;
      rowMergeBtn.disabled = true;
      rowMergeBtn.textContent = 'Merging…';
      const updated = await mergeDescription(plants[idx], apiKey);
      plants[idx] = updated;
      if (!updated.mergeError) {
        // Update the description div
        const descDiv = tr.querySelector('.desc-edit');
        if (descDiv) descDiv.innerHTML = updated.description || '';
        mergedBadge.style.display = '';
        renderSummary();
      }
      rowMergeBtn.textContent = updated.mergeError ? 'Failed' : 'Done';
      setTimeout(() => {
        rowMergeBtn.textContent = 'Auto-merge';
        rowMergeBtn.disabled = !(document.getElementById('openai-key')?.value.trim());
      }, 2000);
    });
    tdSource.appendChild(rowMergeBtn);

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

      text = text.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();

      let data;
      try {
        data = JSON.parse(unwrapJson(text));
      } catch (e) {
        fillBtn.textContent = 'Invalid JSON';
        setTimeout(() => { fillBtn.textContent = 'Fill from clipboard'; }, 2000);
        return;
      }

      if (data.description) {
        plants[idx].description = data.description;
        const descDiv = tr.querySelector('.desc-edit');
        if (descDiv) descDiv.innerHTML = data.description;
      }

      // Accept sun_levels (array) or sun_level (string, from legacy AI output)
      const sunFromData = Array.isArray(data.sun_levels)
        ? data.sun_levels
        : (data.sun_level ? [data.sun_level] : null);
      if (sunFromData) {
        plants[idx].sun_levels = sunFromData;
      }

      if (data.moisture) plants[idx].moisture = data.moisture;
      if (typeof data.is_pollinator     === 'boolean') plants[idx].is_pollinator     = data.is_pollinator;
      if (typeof data.is_deer_resistant === 'boolean') plants[idx].is_deer_resistant = data.is_deer_resistant;
      if (typeof data.piedmont_native   === 'boolean') plants[idx].piedmont_native   = data.piedmont_native;

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

    // ── Description (HTML, contenteditable) ────────────────────────────────────
    const tdDesc = document.createElement('td');
    tdDesc.style.minWidth = '260px';
    const descDiv = document.createElement('div');
    descDiv.className     = 'desc-edit';
    descDiv.contentEditable = 'true';
    descDiv.innerHTML     = plant.description || '';
    descDiv.addEventListener('input', () => {
      plants[idx].description = descDiv.innerHTML;
      markManuallyEnriched(idx, tr);
    });
    tdDesc.appendChild(descDiv);
    const descHint = document.createElement('div');
    descHint.className   = 'area-hint';
    descHint.textContent = '(HTML)';
    tdDesc.appendChild(descHint);
    tr.appendChild(tdDesc);

    // ── Tags checkboxes ─────────────────────────────────────────────────────────
    const tdTags = document.createElement('td');
    tdTags.style.minWidth = '140px';
    tdTags.className = 'tag-fields';

    const tagsLabel = document.createElement('div');
    tagsLabel.className   = 'icon-group-label';
    tagsLabel.textContent = 'Tags:';
    tdTags.appendChild(tagsLabel);

    const currentTags = new Set(
      (plant.tags || '').split(',').map(t => t.trim()).filter(Boolean)
    );

    Array.from(allSsTags).sort().forEach(tagVal => {
      const row = document.createElement('label');
      row.className = 'icon-check-row';
      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.checked = currentTags.has(tagVal);
      cb.addEventListener('change', () => {
        const tagSet = new Set(
          (plants[idx].tags || '').split(',').map(t => t.trim()).filter(Boolean)
        );
        if (cb.checked) tagSet.add(tagVal);
        else            tagSet.delete(tagVal);
        plants[idx].tags = Array.from(tagSet).join(', ');
        markManuallyEnriched(idx, tr);
      });
      row.appendChild(cb);
      row.append(' ' + tagVal);
      tdTags.appendChild(row);
    });

    tr.appendChild(tdTags);

    // ── Categories checkboxes ───────────────────────────────────────────────────
    const tdCats = document.createElement('td');
    tdCats.style.minWidth = '140px';
    tdCats.className = 'tag-fields';

    const catsLabel = document.createElement('div');
    catsLabel.className   = 'icon-group-label';
    catsLabel.textContent = 'Categories:';
    tdCats.appendChild(catsLabel);

    const currentCats = new Set(
      (plant.category || '').split(',').map(c => c.trim()).filter(Boolean)
    );

    Array.from(allSsCategories).sort().forEach(catVal => {
      const row = document.createElement('label');
      row.className = 'icon-check-row';
      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.checked = currentCats.has(catVal);
      cb.addEventListener('change', () => {
        const catSet = new Set(
          (plants[idx].category || '').split(',').map(c => c.trim()).filter(Boolean)
        );
        if (cb.checked) catSet.add(catVal);
        else            catSet.delete(catVal);
        plants[idx].category = Array.from(catSet).join(', ');
        markManuallyEnriched(idx, tr);
      });
      row.appendChild(cb);
      row.append(' ' + catVal);
      tdCats.appendChild(row);
    });

    tr.appendChild(tdCats);

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
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }

  const headers = [
    'common', 'piedmont_native', 'description',
    'flag_for_review', 'reason_for_review', 'description_merged', 'source',
  ];
  const rows = [headers.join(',')];
  for (const p of plants) {
    rows.push([
      csvEscape(p.common),
      csvEscape(p.piedmont_native || false),
      csvEscape(p.description || ''),
      csvEscape(p.flag_for_review || false),
      csvEscape(p.reason_for_review || ''),
      csvEscape(p.description_merged || false),
      csvEscape(p.source),
    ].join(','));
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const datetime = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `plants.improved.${datetime}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── Download updated Squarespace inventory ───────────────────────────────────

function downloadUpdatedSsInventory() {
  if (!rawSsRows || rawSsRows.length === 0) {
    alert('No Squarespace data loaded — import first.');
    return;
  }

  // Build a lookup from normalized title → plant
  const plantByTitle = new Map();
  for (const p of plants) {
    plantByTitle.set(normalizeName(p.common), p);
  }

  // Collect all headers from the raw rows
  const allHeaders = rawSsRows.length > 0 ? Object.keys(rawSsRows[0]) : [];

  // Helper: rebuild tags string with /piedmont-native appended if needed
  function buildTags(plant, originalTags) {
    const tagParts = (plant.tags || originalTags || '').split(',').map(t => t.trim()).filter(Boolean);
    if (plant.piedmont_native && !tagParts.some(t => t.toLowerCase().includes('piedmont-native'))) {
      tagParts.push('/piedmont-native');
    }
    return tagParts.join(', ');
  }

  // Helper: rebuild categories string with Piedmont Native appended if needed
  function buildCategories(plant, originalCats) {
    const catParts = (plant.category || originalCats || '').split(',').map(c => c.trim()).filter(Boolean);
    if (plant.piedmont_native && !catParts.some(c => c.toLowerCase().includes('piedmont native'))) {
      catParts.push('Piedmont Native');
    }
    return catParts.join(', ');
  }

  // Track last seen primary plant for variant row tag/category inheritance
  let lastPlant = null;

  const outputRows = rawSsRows.map(row => {
    const title = row['Title'] || '';
    const updated = { ...row };

    if (title) {
      // Primary product row — find matching plant
      const match = plantByTitle.get(normalizeName(title));
      lastPlant = match || null;

      if (match) {
        updated['Description'] = match.description || '';
        updated['Tags']        = buildTags(match, row['Tags']);
        updated['Categories']  = buildCategories(match, row['Categories']);
      }
    } else {
      // Variant row — copy tags/categories from last primary, leave Description empty
      if (lastPlant) {
        updated['Tags']       = buildTags(lastPlant, row['Tags']);
        updated['Categories'] = buildCategories(lastPlant, row['Categories']);
      }
      // Description stays empty for variant rows
    }

    return updated;
  });

  // Serialize as TSV (matching input format)
  const tsvLines = [allHeaders.join('\t')];
  for (const row of outputRows) {
    tsvLines.push(allHeaders.map(h => (row[h] ?? '').replace(/\t/g, ' ')).join('\t'));
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const datetime = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const blob = new Blob([tsvLines.join('\n')], { type: 'text/tab-separated-values' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `squarespace-inventory.${datetime}.tsv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── Shared row-update helper (used by bulk and per-row enrichment) ───────────

function applyEnrichedDataToRow(tr, badge, updatedPlant) {
  if (badge) applyBadge(badge, 'ai_enriched');

  // Update description div
  const descDiv = tr.querySelector('.desc-edit');
  if (descDiv) descDiv.innerHTML = updatedPlant.description || '';
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

// ─── Merge UI ─────────────────────────────────────────────────────────────────

async function startMerge(limit) {
  const apiKey = document.getElementById('openai-key').value.trim();
  if (!apiKey) {
    const s = document.getElementById('merge-status');
    s.style.color = '#c0392b';
    s.textContent = 'Please enter an OpenAI API key first.';
    return;
  }

  const mergeBtns    = document.querySelectorAll('.merge-btn');
  const statusEl     = document.getElementById('merge-status');
  const progressWrap = document.getElementById('merge-progress-wrap');
  const progressBar  = document.getElementById('merge-progress-bar');
  const progressLabel= document.getElementById('merge-progress-label');

  mergeBtns.forEach(b => b.disabled = true);
  statusEl.textContent = '';
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';

  let errors = 0;

  await mergeAllUnmerged(apiKey, limit ?? Infinity, (completed, total, updatedPlant) => {
    const pct = Math.round((completed / total) * 100);
    progressBar.style.width = pct + '%';
    progressLabel.textContent = `Merging… ${completed} / ${total}`;

    if (updatedPlant.mergeError) { errors++; return; }

    // Update description div and merged badge in table
    const tr = document.querySelector(`tr[data-idx="${plants.indexOf(updatedPlant)}"]`);
    if (tr) {
      const descDiv = tr.querySelector('.desc-edit');
      if (descDiv) descDiv.innerHTML = updatedPlant.description || '';
      const mb = tr.querySelector('.desc-merged-badge');
      if (mb) mb.style.display = '';
    }
    renderSummary();
  });

  progressWrap.style.display = 'none';
  statusEl.style.color = errors ? '#c0392b' : '#2d5a27';
  statusEl.textContent = errors
    ? `Done — ${errors} plant(s) failed to merge. Check console for details.`
    : `✓ Done merging descriptions.`;
  mergeBtns.forEach(b => b.disabled = false);

  // Refresh unmerged count on buttons
  const unmergedCount = plants.filter(p => !p.description_merged && p.source !== 'pending').length;
  document.getElementById('merge-btn-all').textContent = `Merge all (${unmergedCount}) unmerged`;
}
