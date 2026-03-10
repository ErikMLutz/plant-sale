// ─── App state ────────────────────────────────────────────────────────────────
let plants = [];

// ─── File input handlers ──────────────────────────────────────────────────────

function handleSsFile(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById('ss-file-name').textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => { document.getElementById('ss-textarea').value = e.target.result; };
  reader.readAsText(file);
}

function handleLegacyFile(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById('legacy-file-name').textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => { document.getElementById('legacy-textarea').value = e.target.result; };
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
    const legacyText = document.getElementById('legacy-textarea').value.trim();
    const legacyMap  = legacyText ? parseLegacyCsv(legacyText) : new Map();
    const rows       = parseDelimited(ssText);

    if (rows.length === 0) {
      statusEl.style.color = '#c0392b';
      statusEl.textContent = 'No rows found — check that the file is tab-separated.';
      return;
    }

    plants = parseSquarespaceRows(rows, legacyMap);

    // Apply debug plant limit
    if (DEBUG && debugState.limitEnabled && plants.length > debugState.limitValue) {
      if (debugState.pickOverlap && legacyMap.size > 0) {
        // Fill limit with (N-1) legacy matches + 1 pending so both code paths are tested.
        const legacy  = plants.filter(p => p.source === 'legacy');
        const pending = plants.filter(p => p.source === 'pending');
        const nLegacy = Math.min(legacy.length, debugState.limitValue - (pending.length > 0 ? 1 : 0));
        plants = [...legacy.slice(0, nLegacy), ...pending.slice(0, debugState.limitValue - nLegacy)];
      } else {
        plants = plants.slice(0, debugState.limitValue);
      }
    }

    if (plants.length === 0) {
      statusEl.style.color = '#c0392b';
      statusEl.textContent = 'Parsed rows but found no valid plants (missing Title column?).';
      return;
    }

    const legacyCount = plants.filter(p => p.source === 'legacy').length;
    statusEl.style.color = '#2d5a27';
    statusEl.textContent =
      `Imported ${plants.length} plants. ` +
      (legacyMap.size > 0
        ? `${legacyCount} matched legacy data, ${plants.length - legacyCount} need enrichment.`
        : 'No legacy file provided — all plants need enrichment.');

    buildReviewTable();
    document.getElementById('review-section').style.display = 'block';
    document.getElementById('review-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    statusEl.style.color = '#c0392b';
    statusEl.textContent = 'Parse error: ' + err.message;
    console.error(err);
  }
}

// ─── Review table ─────────────────────────────────────────────────────────────

function buildReviewTable() {
  const tbody = document.getElementById('review-tbody');
  tbody.innerHTML = '';

  // Sort: pending first, legacy second
  const sorted = [...plants].sort((a, b) => {
    if (a.source === b.source) return 0;
    return a.source === 'pending' ? -1 : 1;
  });

  sorted.forEach((plant, idx) => {
    const tr = document.createElement('tr');

    // Source badge
    const tdSource = document.createElement('td');
    const badge    = document.createElement('span');
    badge.className   = plant.source === 'legacy' ? 'badge badge-legacy' : 'badge badge-pending';
    badge.textContent = plant.source === 'legacy' ? '🟢 Legacy' : '🟡 Needs enrichment';
    tdSource.appendChild(badge);
    tr.appendChild(tdSource);

    // Common name (read-only — comes from Squarespace)
    const tdCommon = document.createElement('td');
    tdCommon.style.minWidth = '120px';
    tdCommon.textContent    = plant.common;
    tr.appendChild(tdCommon);

    // Latin name — editable
    const tdLatin  = document.createElement('td');
    tdLatin.style.minWidth = '140px';
    const latinInput       = document.createElement('input');
    latinInput.type        = 'text';
    latinInput.value       = plant.latin;
    latinInput.placeholder = 'Latin name…';
    latinInput.addEventListener('input', () => { plants[idx].latin = latinInput.value; });
    tdLatin.appendChild(latinInput);
    tr.appendChild(tdLatin);

    // Photo thumbnail
    const tdPhoto = document.createElement('td');
    tdPhoto.style.minWidth = '60px';
    if (plant.photo_urls?.[0]) {
      const img    = document.createElement('img');
      img.src      = plant.photo_urls[0];
      img.className = 'thumb';
      img.alt      = plant.common;
      img.onerror  = () => img.replaceWith(noPhotoSpan());
      tdPhoto.appendChild(img);
    } else {
      tdPhoto.appendChild(noPhotoSpan());
    }
    tr.appendChild(tdPhoto);

    // Attributes — editable textarea
    const tdAttribs  = document.createElement('td');
    tdAttribs.style.minWidth = '200px';
    const attribArea = document.createElement('textarea');
    attribArea.value = plant.attributes_line;
    attribArea.placeholder = 'Size: …; Bloom: …; Soil: …';
    attribArea.addEventListener('input', () => { plants[idx].attributes_line = attribArea.value; });
    tdAttribs.appendChild(attribArea);
    tr.appendChild(tdAttribs);

    // Highlight — editable textarea
    const tdHighlight  = document.createElement('td');
    tdHighlight.style.minWidth = '200px';
    const highlightArea = document.createElement('textarea');
    highlightArea.value = plant.highlight_line;
    highlightArea.placeholder = 'Editorial highlight text…';
    highlightArea.addEventListener('input', () => { plants[idx].highlight_line = highlightArea.value; });
    tdHighlight.appendChild(highlightArea);
    tr.appendChild(tdHighlight);

    tbody.appendChild(tr);
  });

  document.getElementById('gen-btn').textContent = `Generate PPTX (${plants.length} plants)`;
}

function noPhotoSpan() {
  const span       = document.createElement('span');
  span.className   = 'no-photo';
  span.textContent = 'No photo';
  return span;
}
