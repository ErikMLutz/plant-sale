// ─── App state ────────────────────────────────────────────────────────────────
let plants            = [];
let currentPlantIdx   = 0;
let sortedPlantsCache = [];
let quill             = null;
let searchQuery       = '';
let suppressTextChange = false;  // true while setQuillContent is running

// ─── NCSU Toolbox ─────────────────────────────────────────────────────────────

const ncsuCache = new Map(); // latin name → distribution string (or null if not found)

// Returns { distribution, origin } (either may be null). Returns null on fetch failure.
async function fetchNcsuDistribution(latin) {
  if (!latin) return null;
  // Strip parenthetical common name and cultivar: "Solidago rugosa 'Fireworks'" → "Solidago rugosa"
  const clean = latin.replace(/\s*\([^)]*\)/g, '').replace(/\s*'[^']*'/g, '').trim();
  if (!clean) return null;
  if (ncsuCache.has(clean)) return ncsuCache.get(clean);

  const slug = clean.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const url  = `https://plants.ces.ncsu.edu/plants/${slug}/`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) { ncsuCache.set(clean, null); return null; }
    const html = await resp.text();
    const doc  = new DOMParser().parseFromString(html, 'text/html');

    function dtValue(label) {
      for (const dt of doc.querySelectorAll('dt')) {
        if (dt.textContent.trim() === label) {
          const dd   = dt.nextElementSibling;
          const span = dd && dd.querySelector('.detail_display_attribute');
          return (span ? span.textContent.trim() : (dd ? dd.textContent.trim() : null)) || null;
        }
      }
      return null;
    }

    const result = {
      distribution: dtValue('Distribution:'),
      origin:       dtValue('Country Or Region Of Origin:'),
    };
    ncsuCache.set(clean, result);
    return result;
  } catch (_) {
    ncsuCache.set(clean, null);
    return null;
  }
}

// ─── API key helpers ──────────────────────────────────────────────────────────

function syncRowEnrichBtns() {
  const key = document.getElementById('openai-key')?.value.trim() || '';
  const plant = sortedPlantsCache[currentPlantIdx];
  const enrich = document.getElementById('btn-auto-enrich-row');
  const merge  = document.getElementById('btn-auto-merge-row');
  if (enrich) enrich.disabled = !key || !plant || plant.source !== 'pending';
  if (merge)  merge.disabled  = !key || !plant || plant.source === 'pending' || !!plant.description_merged;
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

// ─── Zip upload ───────────────────────────────────────────────────────────────

async function handleZipUpload() {
  const input   = document.getElementById('zip-file');
  const file    = input.files[0];
  if (!file) return;

  document.getElementById('zip-file-name').textContent = file.name;

  const statusEl = document.getElementById('import-status');
  statusEl.style.color = '#555';
  statusEl.textContent = 'Reading zip…';

  try {
    const { ssContent, latestCsvContent } = await readZipFile(file);
    if (!ssContent) {
      statusEl.style.color = '#c0392b';
      statusEl.textContent = 'No Squarespace inventory found in the zip.';
      return;
    }
    runImport(ssContent, latestCsvContent);
  } catch (err) {
    statusEl.style.color = '#c0392b';
    statusEl.textContent = 'Failed to read zip: ' + err.message;
    console.error(err);
  }
}

// ─── Unmatched CSV plants ─────────────────────────────────────────────────────

/**
 * Return CSV entries from csvMap that were not matched by any SS title.
 * Each result includes the entry and the closest SS title by word overlap (or null).
 */
function computeUnmatchedCsv(csvMap, ssTitles) {
  // Determine which CSV entries were actually matched
  const matchedCommons = new Set();
  for (const title of ssTitles) {
    const m = findCsvMatch(title, csvMap);
    if (m) matchedCommons.add(m.common);
  }

  // Collect unmatched entries, deduplicating by common name
  const seen = new Set();
  const unmatched = [];
  for (const [, entry] of csvMap) {
    if (!matchedCommons.has(entry.common) && !seen.has(entry.common)) {
      seen.add(entry.common);
      unmatched.push(entry);
    }
  }

  // For each unmatched entry, find the SS title with the best word overlap
  return unmatched.map(entry => {
    const csvWords = new Set(
      normalizeName(`${entry.common} ${entry.latin || ''}`).split(' ').filter(Boolean)
    );
    let bestTitle = null, bestScore = 0;
    for (const title of ssTitles) {
      const shared = normalizeName(title).split(' ').filter(w => csvWords.has(w)).length;
      const score  = shared / Math.max(csvWords.size, normalizeName(title).split(' ').length);
      if (score > bestScore) { bestScore = score; bestTitle = title; }
    }
    return { entry, closest: bestScore > 0 ? bestTitle : null };
  }).sort((a, b) => a.entry.common.localeCompare(b.entry.common));
}

function renderUnmatchedCsv(unmatched) {
  const section = document.getElementById('unmatched-csv-section');
  if (!unmatched.length) { section.style.display = 'none'; return; }

  document.getElementById('unmatched-csv-label').textContent =
    `${unmatched.length} plants in CSV not matched in Squarespace`;
  section.style.display = 'block';

  const body = document.getElementById('unmatched-csv-body');
  body.innerHTML = unmatched.map(({ entry, closest }) => {
    const name    = entry.latin
      ? `${entry.common} <span style="color:#999;font-style:italic;">(${entry.latin})</span>`
      : entry.common;
    const suggest = closest
      ? `<span style="color:#bbb; margin:0 6px;">→</span><span style="color:#888;">${closest}</span>`
      : `<span style="color:#bbb; margin:0 6px;">→</span><span style="color:#ccc;">not in SS</span>`;
    return `<div style="display:flex; align-items:baseline; gap:0; flex-wrap:wrap;">${name}${suggest}</div>`;
  }).join('');
}

// ─── Import ───────────────────────────────────────────────────────────────────

function runImport(ssContent, latestCsvContent) {
  const statusEl = document.getElementById('import-status');
  statusEl.style.color = '#555';
  statusEl.textContent = 'Parsing…';

  try {
    const csvMap = latestCsvContent ? parsePlantsCsv(latestCsvContent) : new Map();
    const rows   = parseDelimited(ssContent);

    if (rows.length === 0) {
      statusEl.style.color = '#c0392b';
      statusEl.textContent = 'No rows found in Squarespace inventory.';
      return;
    }

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

    const ssTitles = filteredRows.map(r => r['Title']).filter(Boolean);
    plants = parseSquarespaceRows(filteredRows, csvMap, rows);


    if (DEBUG && debugState.limitEnabled && plants.length > debugState.limitValue) {
      if (debugState.pickOverlap && csvMap.size > 0) {
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
      statusEl.textContent = 'No valid plants found after filtering.';
      return;
    }

    const csvCount    = plants.filter(p => p.source === 'csv').length;
    const reviewCount = plants.filter(p => p.flag_for_review).length;
    const mergedCount = plants.filter(p => p.description_merged).length;
    statusEl.style.color = '#2d5a27';
    statusEl.textContent =
      `Imported ${plants.length} plants.` +
      (csvMap.size > 0
        ? ` ${csvCount} from CSV, ${plants.length - csvCount} need enrichment.`
        : ' No CSV — all plants need enrichment.') +
      (mergedCount > 0 ? ` ${mergedCount} merged.` : '') +
      (reviewCount > 0 ? ` ${reviewCount} flagged for review.` : '');

    // Show enrich section (collapsed) if there's anything to do
    const pendingCount  = plants.filter(p => p.source === 'pending').length;
    const unmergedCount = plants.filter(p => !p.description_merged && p.source !== 'pending').length;
    const enrichSection = document.getElementById('enrich-section');
    if (pendingCount > 0 || csvCount > 0) {
      enrichSection.style.display = 'block';
      document.getElementById('enrich-btn-all').textContent = `Enrich all (${pendingCount}) pending plants`;
      document.getElementById('merge-btn-all').textContent  = `Merge all (${unmergedCount}) unmerged`;
      document.getElementById('enrich-status').textContent  = '';
      document.getElementById('merge-status').textContent   = '';
    }

    if (csvMap.size > 0) {
      renderUnmatchedCsv(computeUnmatchedCsv(csvMap, ssTitles));
    }

    buildReviewPanel();

    document.getElementById('review-section').style.display = 'block';
    document.getElementById('step4-section').style.display  = 'block';
    document.getElementById('review-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    statusEl.style.color = '#c0392b';
    statusEl.textContent = 'Parse error: ' + err.message;
    console.error(err);
  }
}

// ─── Sort ─────────────────────────────────────────────────────────────────────

const SOURCE_BADGE = {
  csv:                { cls: 'badge-csv',               text: '🟢 plants.csv' },
  pending:            { cls: 'badge-pending',           text: '🟡 Needs enrichment' },
  ai_enriched:        { cls: 'badge-ai-enriched',       text: '🔵 AI Enriched' },
  manually_enriched:  { cls: 'badge-manually-enriched', text: '🟣 Manually Enriched' },
};

function getSelectedCategories() {
  return Array.from(
    document.querySelectorAll('#category-checkboxes input[type="checkbox"]:checked')
  ).map(cb => cb.value);
}

function defaultSortKey(p) {
  if (p.source === 'pending') return 0;
  if (p.source === 'csv' && !p.description_merged) return 1;
  if (p.flag_for_review && !p.reviewed) return 2;
  if (!p.reviewed) return 3;
  return 4;
}

function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  return tmp.textContent || '';
}

function getSortedPlants() {
  const selected = getSelectedCategories();
  const query    = searchQuery.trim();

  // Fuzzy search: when a query is active, sort by match score but keep all plants
  if (query) {
    const fuse = new Fuse(plants, {
      keys: [
        { name: 'common',            weight: 3 },
        { name: 'category',          weight: 2 },
        { name: 'tags',              weight: 2 },
        { name: 'description',       weight: 1 },
        { name: 'reason_for_review', weight: 1 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
      getFn: (obj, path) => {
        const key = Array.isArray(path) ? path[0] : path;
        if (key === 'description') return stripHtml(obj.description);
        return obj[key] ?? '';
      },
    });
    const matched    = fuse.search(query).map(r => r.item);
    const matchedSet = new Set(matched);
    const unmatched  = plants.filter(p => !matchedSet.has(p));
    return [...matched, ...unmatched];
  }

  function matchCount(p) {
    if (selected.length === 0) return 0;
    const plantCats = (p.category || '').split(',').map(c => c.trim()).filter(Boolean);
    return selected.filter(c => plantCats.includes(c)).length;
  }

  return [...plants].sort((a, b) => {
    if (selected.length > 0) {
      const am = matchCount(a);
      const bm = matchCount(b);
      if (selected.length === 1) {
        const aTop = am > 0 ? 0 : 1;
        const bTop = bm > 0 ? 0 : 1;
        if (aTop !== bTop) return aTop - bTop;
      } else {
        if (bm !== am) return bm - am;
      }
    }
    return defaultSortKey(a) - defaultSortKey(b);
  });
}

function handleSearchInput(val) {
  searchQuery = val;
  const activeEl = document.activeElement;
  rebuildSort();
  if (activeEl) activeEl.focus();
}

// Returns clean vanilla HTML from Quill (ul/li/p/strong/em).
// Strips &nbsp; (Quill 2 artifact) so stored HTML uses plain spaces.
function readQuillHtml() {
  let html;
  if (typeof quill.getSemanticHTML === 'function') {
    html = quill.getSemanticHTML();
  } else {
    // Fallback: strip ql-ui spans, convert data-list ol→ul
    const tmp = document.createElement('div');
    tmp.innerHTML = quill.root.innerHTML;
    tmp.querySelectorAll('.ql-ui').forEach(el => el.remove());
    tmp.querySelectorAll('ol').forEach(ol => {
      if ([...ol.children].every(li => li.getAttribute('data-list') === 'bullet')) {
        const ul = document.createElement('ul');
        ul.innerHTML = ol.innerHTML;
        ul.querySelectorAll('[data-list]').forEach(li => li.removeAttribute('data-list'));
        ol.replaceWith(ul);
      }
    });
    html = tmp.innerHTML;
  }
  return html.replace(/&nbsp;/g, ' ');
}

// Sets Quill content programmatically using the proper Quill 2 API.
// convert({ html }) → Delta, then setContents with 'silent' source so no
// text-change events fire at all — no scroll jump, no handler side-effects.
function setQuillContent(html) {
  const savedScroll = window.scrollY;
  const delta = quill.clipboard.convert({ html: html || '' });
  quill.setContents(delta, 'silent');
  window.scrollTo(0, savedScroll);
}

// ─── Review panel ─────────────────────────────────────────────────────────────

function buildReviewPanel() {
  // Initialize Quill once
  if (!quill) {
    quill = new Quill('#quill-container', {
      theme: 'snow',
      modules: {
        toolbar: [
          ['bold', 'italic'],
          [{ list: 'bullet' }],
        ],
      },
    });
    quill.on('text-change', () => {
      if (suppressTextChange) return;
      const plant = sortedPlantsCache[currentPlantIdx];
      if (!plant) return;
      plant.description = readQuillHtml();
      if (plant.source !== 'pending') {
        plant.source = 'manually_enriched';
        updateNavBadge(plant);
      }
    });
  }

  // Render category sort checkboxes
  const catBox = document.getElementById('category-checkboxes');
  catBox.innerHTML = '';
  Array.from(allSsCategories).sort().forEach(cat => {
    const label = document.createElement('label');
    label.className = 'cat-sort-check';
    const cb = document.createElement('input');
    cb.type  = 'checkbox';
    cb.value = cat;
    cb.addEventListener('change', rebuildSort);
    label.appendChild(cb);
    label.append(' ' + cat);
    catBox.appendChild(label);
  });

  // Wire navigation buttons
  document.getElementById('btn-prev').onclick = () => {
    if (currentPlantIdx > 0) navigateTo(currentPlantIdx - 1);
  };
  document.getElementById('btn-next').onclick = () => {
    if (currentPlantIdx < sortedPlantsCache.length - 1) navigateTo(currentPlantIdx + 1);
  };

  // Wire AI action buttons
  document.getElementById('btn-auto-enrich-row').onclick  = runEnrichOnCurrentPlant;
  document.getElementById('btn-auto-merge-row').onclick   = runMergeOnCurrentPlant;
  document.getElementById('btn-mark-reviewed').onclick    = markReviewed;

  document.getElementById('btn-copy-prompt-row').onclick = async () => {
    const plant = sortedPlantsCache[currentPlantIdx];
    if (!plant) return;
    const btn = document.getElementById('btn-copy-prompt-row');
    try {
      await navigator.clipboard.writeText(buildPrompt(plant));
      btn.textContent = 'Copied!';
    } catch (e) {
      btn.textContent = 'Failed';
    }
    setTimeout(() => { btn.textContent = 'Copy prompt'; }, 2000);
  };

  document.getElementById('btn-fill-clipboard-row').onclick = async () => {
    const btn   = document.getElementById('btn-fill-clipboard-row');
    const plant = sortedPlantsCache[currentPlantIdx];
    if (!plant) return;
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      btn.textContent = 'No access';
      setTimeout(() => { btn.textContent = 'Fill from clipboard'; }, 2000);
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
      btn.textContent = 'Invalid JSON';
      setTimeout(() => { btn.textContent = 'Fill from clipboard'; }, 2000);
      return;
    }

    if (data.description) {
      plant.description = data.description;
      setQuillContent(data.description);
    }
    const sunFromData = Array.isArray(data.sun_levels)
      ? data.sun_levels
      : (data.sun_level ? [data.sun_level] : null);
    if (sunFromData) plant.sun_levels = sunFromData;
    if (data.moisture) plant.moisture = data.moisture;
    if (typeof data.is_pollinator     === 'boolean') plant.is_pollinator     = data.is_pollinator;
    if (typeof data.is_deer_resistant === 'boolean') plant.is_deer_resistant = data.is_deer_resistant;
    if (typeof data.piedmont_native   === 'boolean') plant.piedmont_native   = data.piedmont_native;

    plant.source = 'ai_enriched';
    updateNavBadge(plant);
    renderSummary();
    btn.textContent = 'Applied!';
    setTimeout(() => { btn.textContent = 'Fill from clipboard'; }, 2000);
  };

  // Build sorted cache and show first plant
  sortedPlantsCache = getSortedPlants();
  currentPlantIdx   = 0;
  navigateTo(0);
  renderSummary();
}

function navigateTo(idx) {
  if (sortedPlantsCache.length === 0) return;
  idx = Math.max(0, Math.min(idx, sortedPlantsCache.length - 1));
  const savedScroll = window.scrollY;

  // Flush current Quill content to plant before switching (skip when staying on same index)
  const prev = sortedPlantsCache[currentPlantIdx];
  if (prev && quill && idx !== currentPlantIdx) prev.description = readQuillHtml();

  currentPlantIdx = idx;
  const plant = sortedPlantsCache[idx];

  // Nav bar
  document.getElementById('nav-counter').textContent   = `Plant ${idx + 1} of ${sortedPlantsCache.length}`;
  document.getElementById('nav-plant-name').textContent = plant.common;
  updateNavBadge(plant);

  // Prev/next state
  document.getElementById('btn-prev').disabled = idx === 0;
  document.getElementById('btn-next').disabled = idx === sortedPlantsCache.length - 1;

  // Photo — skip reload if the same URL is already displayed
  const photoEl   = document.getElementById('review-photo');
  const noPhotoEl = document.getElementById('review-no-photo');
  const newPhotoUrl = plant.photo_urls?.[0] || '';
  const alreadyShown = newPhotoUrl && photoEl.src === newPhotoUrl && photoEl.style.display !== 'none';

  if (!alreadyShown) {
    photoEl.style.display = 'none';
    photoEl.src = '';
    if (noPhotoEl) noPhotoEl.style.display = '';

    if (newPhotoUrl) {
      photoEl.onload = () => {
        photoEl.style.display = '';
        if (noPhotoEl) noPhotoEl.style.display = 'none';
      };
      photoEl.onerror = () => { photoEl.style.display = 'none'; };
      photoEl.src = newPhotoUrl;
      photoEl.alt = plant.common;
    }
  }

  // Description → Quill (suppress text-change during programmatic set)
  if (quill) {
    quill.off('text-change');
    setQuillContent(plant.description || '');
    quill.on('text-change', () => {
      if (suppressTextChange) return;
      const p = sortedPlantsCache[currentPlantIdx];
      if (!p) return;
      p.description = readQuillHtml();
      if (p.source !== 'pending') {
        p.source = 'manually_enriched';
        updateNavBadge(p);
      }
    });
  }

  // SS description (read-only preview)
  const ssDescContent = document.getElementById('ss-desc-content');
  ssDescContent.innerHTML = plant.ss_description_html
    || '<em style="color:#aaa">No SS description yet</em>';

  // NCSU Toolbox Distribution (async, cached)
  const ncsuEl = document.getElementById('ncsu-dist-content');
  ncsuEl.textContent = 'Loading…';
  fetchNcsuDistribution(plant.latin || plant.common).then(data => {
    if (sortedPlantsCache[currentPlantIdx] !== plant) return;
    if (!data || (!data.distribution && !data.origin)) {
      ncsuEl.textContent = 'Not found on NCSU Toolbox';
      return;
    }
    const parts = [];
    if (data.distribution) parts.push(`Distribution: ${data.distribution}`);
    if (data.origin)       parts.push(`Origin: ${data.origin}`);
    ncsuEl.textContent = parts.join('\n');
    ncsuEl.style.whiteSpace = 'pre-line';
  });

  // Flag row
  const flagRow = document.getElementById('review-flag-row');
  if (plant.flag_for_review && plant.reason_for_review) {
    flagRow.style.display = '';
    document.getElementById('review-flag-reason').textContent = plant.reason_for_review;
  } else {
    flagRow.style.display = 'none';
  }

  // Tags checkboxes
  const tagsEl = document.getElementById('review-tags');
  tagsEl.innerHTML = '';
  const tagsLabel = document.createElement('div');
  tagsLabel.className   = 'review-field-label';
  tagsLabel.textContent = 'Tags:';
  tagsEl.appendChild(tagsLabel);
  const currentTags = new Set((plant.tags || '').split(',').map(t => t.trim()).filter(Boolean));
  let piedmontTagCb = null;
  let piedmontCatCb = null;
  Array.from(allSsTags).sort().forEach(tagVal => {
    const isPiedmont = tagVal === 'piedmont-native';
    const row = document.createElement('label');
    row.className = 'icon-check-row' + (isPiedmont ? ' icon-check-row--piedmont' : '');
    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = isPiedmont ? !!plant.piedmont_native : currentTags.has(tagVal);
    cb.addEventListener('change', () => {
      if (isPiedmont) {
        plant.piedmont_native = cb.checked;
        if (piedmontCatCb) piedmontCatCb.checked = cb.checked;
        const tagSet = new Set((plant.tags || '').split(',').map(t => t.trim()).filter(Boolean));
        if (cb.checked) tagSet.add('piedmont-native'); else tagSet.delete('piedmont-native');
        plant.tags = Array.from(tagSet).join(', ');
        const catSet = new Set((plant.category || '').split(',').map(c => c.trim()).filter(Boolean));
        if (cb.checked) catSet.add('/piedmont-native'); else catSet.delete('/piedmont-native');
        plant.category = Array.from(catSet).join(', ');
      } else {
        const tagSet = new Set((plant.tags || '').split(',').map(t => t.trim()).filter(Boolean));
        if (cb.checked) tagSet.add(tagVal); else tagSet.delete(tagVal);
        plant.tags = Array.from(tagSet).join(', ');
      }
      if (plant.source !== 'pending') plant.source = 'manually_enriched';
    });
    if (isPiedmont) piedmontTagCb = cb;
    row.appendChild(cb);
    row.append(' ' + tagVal);
    tagsEl.appendChild(row);
  });

  // Categories checkboxes
  const catsEl = document.getElementById('review-categories');
  catsEl.innerHTML = '';
  const catsLabel = document.createElement('div');
  catsLabel.className   = 'review-field-label';
  catsLabel.textContent = 'Categories:';
  catsEl.appendChild(catsLabel);
  const currentCats = new Set((plant.category || '').split(',').map(c => c.trim()).filter(Boolean));
  Array.from(allSsCategories).sort().forEach(catVal => {
    const isPiedmont = catVal === '/piedmont-native';
    const row = document.createElement('label');
    row.className = 'icon-check-row' + (isPiedmont ? ' icon-check-row--piedmont' : '');
    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = isPiedmont ? !!plant.piedmont_native : currentCats.has(catVal);
    cb.addEventListener('change', () => {
      if (isPiedmont) {
        plant.piedmont_native = cb.checked;
        if (piedmontTagCb) piedmontTagCb.checked = cb.checked;
        const catSet = new Set((plant.category || '').split(',').map(c => c.trim()).filter(Boolean));
        if (cb.checked) catSet.add('/piedmont-native'); else catSet.delete('/piedmont-native');
        plant.category = Array.from(catSet).join(', ');
        const tagSet = new Set((plant.tags || '').split(',').map(t => t.trim()).filter(Boolean));
        if (cb.checked) tagSet.add('piedmont-native'); else tagSet.delete('piedmont-native');
        plant.tags = Array.from(tagSet).join(', ');
      } else {
        const catSet = new Set((plant.category || '').split(',').map(c => c.trim()).filter(Boolean));
        if (cb.checked) catSet.add(catVal); else catSet.delete(catVal);
        plant.category = Array.from(catSet).join(', ');
      }
      if (plant.source !== 'pending') plant.source = 'manually_enriched';
    });
    if (isPiedmont) piedmontCatCb = cb;
    row.appendChild(cb);
    row.append(' ' + catVal);
    catsEl.appendChild(row);
  });

  // AI button states
  const apiKey = document.getElementById('openai-key')?.value.trim() || '';
  document.getElementById('btn-auto-enrich-row').disabled = !apiKey || plant.source !== 'pending';
  document.getElementById('btn-auto-merge-row').disabled  = !apiKey || plant.source === 'pending' || !!plant.description_merged;

  updateMarkReviewedBtn(plant);
  window.scrollTo(0, savedScroll);
}

function updateNavBadge(plant) {
  // Reviewed/unreviewed
  const badge = document.getElementById('nav-badge');
  badge.textContent = plant.reviewed ? '✅ Reviewed' : '⚪ Unreviewed';
  badge.className   = 'badge ' + (plant.reviewed ? 'badge-reviewed' : 'badge-unreviewed');

  // Source badge
  const srcBadge = document.getElementById('nav-source-badge');
  const { cls, text } = SOURCE_BADGE[plant.source] || SOURCE_BADGE.pending;
  srcBadge.className   = 'badge ' + cls;
  srcBadge.textContent = text;

  // Needs-merging badge
  const mergeBadge = document.getElementById('nav-merge-badge');
  mergeBadge.style.display = (plant.source !== 'pending' && !plant.description_merged) ? '' : 'none';

  // Flag badge
  const flagBadge = document.getElementById('nav-flag-badge');
  flagBadge.style.display = plant.flag_for_review ? '' : 'none';
}

function updateMarkReviewedBtn(plant) {
  const btn = document.getElementById('btn-mark-reviewed');
  btn.className   = plant.reviewed ? 'secondary' : 'btn-action';
  btn.textContent = plant.reviewed ? '↩ Unmark Reviewed' : 'Mark Reviewed';
}

function rebuildSort() {
  const prev = sortedPlantsCache[currentPlantIdx];
  if (prev && quill) prev.description = readQuillHtml();

  sortedPlantsCache = getSortedPlants();
  currentPlantIdx   = 0;
  navigateTo(0);
  renderSummary();

  const countEl = document.getElementById('search-count');
  if (countEl) {
    if (searchQuery.trim()) {
      const fuse = new Fuse(plants, {
        keys: ['common', 'category', 'tags', 'description', 'reason_for_review'],
        threshold: 0.4,
        ignoreLocation: true,
        getFn: (obj, path) => {
          const key = Array.isArray(path) ? path[0] : path;
          if (key === 'description') return stripHtml(obj.description);
          return obj[key] ?? '';
        },
      });
      const n = fuse.search(searchQuery.trim()).length;
      countEl.textContent = `${n} match${n === 1 ? '' : 'es'}`;
    } else {
      countEl.textContent = '';
    }
  }
}

function markReviewed() {
  const plant = sortedPlantsCache[currentPlantIdx];
  if (!plant) return;

  plant.reviewed = !plant.reviewed;
  if (plant.reviewed) {
    plant.flag_for_review   = false;
    plant.reason_for_review = '';
    document.getElementById('review-flag-row').style.display = 'none';
  }

  updateNavBadge(plant);
  updateMarkReviewedBtn(plant);
  renderSummary();
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function renderSummary() {
  const el = document.getElementById('review-summary');
  if (!el || !plants.length) { if (el) el.innerHTML = ''; return; }

  const reviewed   = plants.filter(p => p.reviewed).length;
  const unreviewed = plants.length - reviewed;
  const review     = plants.filter(p => p.flag_for_review).length;
  const pending    = plants.filter(p => p.source === 'pending').length;
  const csv        = plants.filter(p => p.source === 'csv').length;
  const ai         = plants.filter(p => p.source === 'ai_enriched').length;
  const manual     = plants.filter(p => p.source === 'manually_enriched').length;
  const merged     = plants.filter(p => p.description_merged).length;

  const chips = [
    { show: pending,    cls: 'badge-pending',            label: `🟡 ${pending} needs enrichment` },
    { show: review,     cls: 'badge-review-needed',      label: `⚠ ${review} potential issue` },
    { show: csv,        cls: 'badge-csv',                label: `🟢 ${csv} from CSV` },
    { show: ai,         cls: 'badge-ai-enriched',        label: `🔵 ${ai} AI enriched` },
    { show: manual,     cls: 'badge-manually-enriched',  label: `🟣 ${manual} manually enriched` },
    { show: merged,     cls: 'badge-merged',             label: `🟤 ${merged} desc merged` },
    { show: unreviewed, cls: 'badge-unreviewed',         label: `⚪ ${unreviewed} unreviewed` },
    { show: reviewed,   cls: 'badge-reviewed',           label: `✅ ${reviewed} reviewed` },
  ];

  el.innerHTML = chips
    .filter(c => c.show > 0)
    .map(c => `<span class="badge ${c.cls} summary-chip">${c.label}</span>`)
    .join('');
}

// ─── Per-plant AI actions ─────────────────────────────────────────────────────

async function runEnrichOnCurrentPlant() {
  const apiKey = document.getElementById('openai-key').value.trim();
  if (!apiKey) return;
  const plant = sortedPlantsCache[currentPlantIdx];
  if (!plant) return;
  const plantsIdx = plants.indexOf(plant);

  const btn = document.getElementById('btn-auto-enrich-row');
  btn.disabled    = true;
  btn.textContent = 'Enriching…';

  const updated = await enrichPlant(plant, apiKey);
  if (plantsIdx >= 0) plants[plantsIdx] = updated;
  sortedPlantsCache[currentPlantIdx] = updated;

  if (!updated.enrichError) {
    setQuillContent(updated.description || '');
    updateNavBadge(updated);
    renderSummary();
    syncRowEnrichBtns();
    const pendingCount = plants.filter(p => p.source === 'pending').length;
    document.getElementById('enrich-btn-all').textContent = `Enrich all (${pendingCount}) pending plants`;
  }

  btn.textContent = updated.enrichError ? 'Failed' : 'Done';
  setTimeout(() => {
    btn.textContent = 'Auto-enrich';
    syncRowEnrichBtns();
  }, 2000);
}

async function runMergeOnCurrentPlant() {
  const apiKey = document.getElementById('openai-key').value.trim();
  if (!apiKey) return;
  const plant = sortedPlantsCache[currentPlantIdx];
  if (!plant) return;
  const plantsIdx = plants.indexOf(plant);

  const btn = document.getElementById('btn-auto-merge-row');
  btn.disabled    = true;
  btn.textContent = 'Merging…';

  const updated = await mergeDescription(plant, apiKey);
  if (plantsIdx >= 0) plants[plantsIdx] = updated;
  sortedPlantsCache[currentPlantIdx] = updated;

  if (!updated.mergeError) {
    setQuillContent(updated.description || '');
    updateNavBadge(updated);
    renderSummary();
    syncRowEnrichBtns();
    const unmergedCount = plants.filter(p => !p.description_merged && p.source !== 'pending').length;
    document.getElementById('merge-btn-all').textContent = `Merge all (${unmergedCount}) unmerged`;
  }

  btn.textContent = updated.mergeError ? 'Failed' : 'Done';
  setTimeout(() => {
    btn.textContent = 'Auto-merge';
    syncRowEnrichBtns();
  }, 2000);
}

// ─── Bulk enrichment UI ───────────────────────────────────────────────────────

async function startEnrichment(limit) {
  const apiKey = document.getElementById('openai-key').value.trim();
  if (!apiKey) {
    const s = document.getElementById('enrich-status');
    s.style.color = '#c0392b';
    s.textContent = 'Please enter an OpenAI API key first.';
    return;
  }

  const enrichBtns    = document.querySelectorAll('.enrich-btn');
  const statusEl      = document.getElementById('enrich-status');
  const progressWrap  = document.getElementById('enrich-progress-wrap');
  const progressBar   = document.getElementById('enrich-progress-bar');
  const progressLabel = document.getElementById('enrich-progress-label');

  enrichBtns.forEach(b => b.disabled = true);
  statusEl.textContent = '';
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';

  const displayedName = sortedPlantsCache[currentPlantIdx]?.common;
  let errors = 0;

  await enrichAllPending(apiKey, limit ?? Infinity, (completed, total, updatedPlant) => {
    const pct = Math.round((completed / total) * 100);
    progressBar.style.width   = pct + '%';
    progressLabel.textContent = `Enriching… ${completed} / ${total}`;

    if (updatedPlant.enrichError) { errors++; return; }

    // Update sortedPlantsCache reference for this plant
    const si = sortedPlantsCache.findIndex(p => p.common === updatedPlant.common);
    if (si >= 0) {
      sortedPlantsCache[si] = updatedPlant;
      if (updatedPlant.common === displayedName) {
        setQuillContent(updatedPlant.description || '');
        updateNavBadge(updatedPlant);
      }
    }
    renderSummary();
  });

  progressWrap.style.display = 'none';
  statusEl.style.color = errors ? '#c0392b' : '#2d5a27';
  statusEl.textContent = errors
    ? `Done — ${errors} plant(s) failed to enrich.`
    : '✓ Done enriching plants.';
  enrichBtns.forEach(b => b.disabled = false);

  const pendingCount = plants.filter(p => p.source === 'pending').length;
  document.getElementById('enrich-btn-all').textContent = `Enrich all (${pendingCount}) pending plants`;
}

// ─── Bulk merge UI ────────────────────────────────────────────────────────────

async function startMerge(limit) {
  const apiKey = document.getElementById('openai-key').value.trim();
  if (!apiKey) {
    const s = document.getElementById('merge-status');
    s.style.color = '#c0392b';
    s.textContent = 'Please enter an OpenAI API key first.';
    return;
  }

  const mergeBtns     = document.querySelectorAll('.merge-btn');
  const statusEl      = document.getElementById('merge-status');
  const progressWrap  = document.getElementById('merge-progress-wrap');
  const progressBar   = document.getElementById('merge-progress-bar');
  const progressLabel = document.getElementById('merge-progress-label');

  mergeBtns.forEach(b => b.disabled = true);
  statusEl.textContent = '';
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';

  const displayedName = sortedPlantsCache[currentPlantIdx]?.common;
  let errors = 0;

  await mergeAllUnmerged(apiKey, limit ?? Infinity, (completed, total, updatedPlant) => {
    const pct = Math.round((completed / total) * 100);
    progressBar.style.width   = pct + '%';
    progressLabel.textContent = `Merging… ${completed} / ${total}`;

    if (updatedPlant.mergeError) { errors++; return; }

    const si = sortedPlantsCache.findIndex(p => p.common === updatedPlant.common);
    if (si >= 0) {
      sortedPlantsCache[si] = updatedPlant;
      if (updatedPlant.common === displayedName) {
        setQuillContent(updatedPlant.description || '');
      }
    }
    renderSummary();
  });

  progressWrap.style.display = 'none';
  statusEl.style.color = errors ? '#c0392b' : '#2d5a27';
  statusEl.textContent = errors
    ? `Done — ${errors} plant(s) failed to merge.`
    : '✓ Done merging descriptions.';
  mergeBtns.forEach(b => b.disabled = false);

  const unmergedCount = plants.filter(p => !p.description_merged && p.source !== 'pending').length;
  document.getElementById('merge-btn-all').textContent = `Merge all (${unmergedCount}) unmerged`;
}

// ─── Download helpers ─────────────────────────────────────────────────────────

function downloadEnrichedCsvText() {
  function csvEscape(val) {
    const s = String(val ?? '').replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ');
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }

  const headers = [
    'common', 'latin', 'piedmont_native', 'description',
    'flag_for_review', 'reason_for_review', 'description_merged', 'source', 'reviewed',
    'tags', 'category',
  ];
  const rows = [headers.join(',')];
  for (const p of plants) {
    if (p.source === 'pending') continue;  // no enriched data to persist; SS is source of truth
    rows.push([
      csvEscape(p.common),
      csvEscape(p.latin || ''),
      csvEscape(p.piedmont_native || false),
      csvEscape(p.description || ''),
      csvEscape(p.flag_for_review || false),
      csvEscape(p.reason_for_review || ''),
      csvEscape(p.description_merged || false),
      csvEscape(p.source),
      csvEscape(p.reviewed || false),
      csvEscape(p.tags !== p.ss_tags_original         ? (p.tags     || '') : ''),
      csvEscape(p.category !== p.ss_category_original ? (p.category || '') : ''),
    ].join(','));
  }
  return rows.join('\n');
}

async function downloadZipFile() {
  // Flush current editor state
  const plant = sortedPlantsCache[currentPlantIdx];
  if (plant && quill) plant.description = readQuillHtml();

  const csvText = downloadEnrichedCsvText();
  await downloadZip(csvText);
}

/**
 * Validate that the updated SS inventory only differs from the original in
 * Description, Tags, and Categories columns. Logs errors to console and
 * returns an array of error strings (empty = clean).
 */
function validateSsInventory(originalRows, updatedRows) {
  const ALLOWED = new Set(['Description', 'Tags', 'Categories']);
  const errors = [];

  if (originalRows.length !== updatedRows.length) {
    errors.push(`Row count mismatch: original ${originalRows.length}, updated ${updatedRows.length}`);
    return errors;
  }

  const allHeaders = originalRows.length > 0 ? Object.keys(originalRows[0]) : [];
  const checkHeaders = allHeaders.filter(h => !ALLOWED.has(h));

  for (let i = 0; i < originalRows.length; i++) {
    const orig = originalRows[i];
    const upd  = updatedRows[i];
    const label = orig['Title'] ? `"${orig['Title']}"` : `variant row ${i + 1}`;
    for (const h of checkHeaders) {
      const ov = orig[h] ?? '';
      const uv = upd[h]  ?? '';
      if (ov !== uv) {
        const msg = `Row ${i + 1} ${label}: field "${h}" changed from "${ov}" to "${uv}"`;
        errors.push(msg);
        console.error('[SS inventory validator]', msg);
      }
    }
  }
  return errors;
}

function downloadUpdatedSsInventory() {
  if (!rawSsRows || rawSsRows.length === 0) {
    alert('No Squarespace data loaded — import first.');
    return;
  }

  const plantByTitle = new Map();
  for (const p of plants) {
    plantByTitle.set(normalizeName(p.common), p);
  }

  const allHeaders = rawSsRows.length > 0 ? Object.keys(rawSsRows[0]) : [];

  function buildTags(plant, originalTags) {
    const tagParts = (plant.tags || originalTags || '').split(',').map(t => t.trim()).filter(Boolean);
    if (plant.piedmont_native && !tagParts.some(t => t.toLowerCase().includes('piedmont-native'))) {
      tagParts.push('piedmont-native');
    }
    return tagParts.join(', ');
  }

  function buildCategories(plant, originalCats) {
    const catParts = (plant.category || originalCats || '').split(',').map(c => c.trim()).filter(Boolean);
    if (plant.piedmont_native && !catParts.some(c => c.toLowerCase().includes('piedmont-native'))) {
      catParts.push('/piedmont-native');
    }
    return catParts.join(', ');
  }

  let lastPlant = null;
  const outputRows = rawSsRows.map(row => {
    const title   = row['Title'] || '';
    const updated = { ...row };
    if (title) {
      const match = plantByTitle.get(normalizeName(title));
      lastPlant = match || null;
      if (match) {
        updated['Description'] = match.description || '';
        updated['Tags']        = buildTags(match, row['Tags']);
        updated['Categories']  = buildCategories(match, row['Categories']);
      }
    } else {
      if (lastPlant) {
        updated['Tags']       = buildTags(lastPlant, row['Tags']);
        updated['Categories'] = buildCategories(lastPlant, row['Categories']);
      }
    }
    return updated;
  });

  // Validate: only Description/Tags/Categories should differ from the original
  const validationErrors = validateSsInventory(rawSsRows, outputRows);
  if (validationErrors.length > 0) {
    const summary = validationErrors.slice(0, 5).join('\n') +
      (validationErrors.length > 5 ? `\n…and ${validationErrors.length - 5} more (see console)` : '');
    alert(`SS inventory validation failed — unexpected fields changed:\n\n${summary}\n\nDownload blocked. Check the console for details.`);
    return;
  }

  function csvCell(val) {
    const s = String(val ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }

  const csvLines = [allHeaders.map(csvCell).join(',')];
  for (const row of outputRows) {
    csvLines.push(allHeaders.map(h => csvCell(row[h] ?? '')).join(','));
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const datetime = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `squarespace-inventory.${datetime}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
