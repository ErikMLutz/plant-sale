// ─── Debug ────────────────────────────────────────────────────────────────────
// Set to false before shipping — hides the panel and removes all limits.
let DEBUG = false;

// Current debug settings (kept in sync with the panel UI)
const debugState = { limitEnabled: true, limitValue: 15, pickOverlap: true };

function syncDebugState() {
  debugState.limitEnabled = document.getElementById('dbg-limit-enabled').checked;
  debugState.limitValue   = parseInt(document.getElementById('dbg-limit-value').value, 10) || 10;
  debugState.pickOverlap  = document.getElementById('dbg-pick-overlap').checked;
}

function toggleDebug(on) {
  DEBUG = on;
  document.getElementById('debug-panel').style.display = on ? 'block' : 'none';
}

// Debug panel is always rendered in HTML; toggle controls visibility
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('debug-panel').style.display = 'none';
});

// ─── App settings (kept in sync with the settings panel UI) ──────────────────
const appSettings = {
  filterVisible: true,
  excludedPages: ['veggies', 'herbs', 'houseplants'],
};

function syncSettings() {
  const w = parseFloat(document.getElementById('cfg-slide-w').value);
  const h = parseFloat(document.getElementById('cfg-slide-h').value);
  if (w > 0) SLIDE_CONFIG.slideW = w;
  if (h > 0) SLIDE_CONFIG.slideH = h;

  const gap = parseFloat(document.getElementById('cfg-cut-gap').value);
  if (gap >= 0) SLIDE_CONFIG.cutGap = gap;

  const commonSize    = parseFloat(document.getElementById('cfg-font-common').value);
  const attribSize    = parseFloat(document.getElementById('cfg-font-attrib').value);
  const highlightSize = parseFloat(document.getElementById('cfg-font-highlight').value);
  const iconSize      = parseFloat(document.getElementById('cfg-font-icon').value);
  if (commonSize > 0)    SLIDE_CONFIG.fonts.common.size    = commonSize;
  if (attribSize > 0)    SLIDE_CONFIG.fonts.attribute.size = attribSize;
  if (highlightSize > 0) SLIDE_CONFIG.fonts.highlight.size = highlightSize;
  if (iconSize > 0)      SLIDE_CONFIG.fonts.icon.size      = iconSize;

  appSettings.filterVisible = document.getElementById('cfg-filter-visible').checked;
  appSettings.excludedPages = document.getElementById('cfg-excluded-pages').value
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

// ─── Icon configuration ───────────────────────────────────────────────────────
// Edit this object to change icon display. Keys must match sun_levels / moisture
// field values on plant objects. To swap emoji for image assets, replace the
// string values with pptxgenjs image objects in pptx.js → buildIcons().
const ICON_CONFIG = {
  sun: {
    full_sun:   '☀ Full Sun',
    part_shade: '⛅ Part Shade',
    shade:      '☁ Shade',
  },
  moisture: {
    drought: '🌵 Drought Tolerant',
  },
  critter_friendly: { show: '🦋 Pollinator' },
  deer_resistant:   { show: '🦌 Deer Resistant' },
  // If icon count exceeds this threshold, font size is reduced by 33%.
  // Set to null to disable. Update once overrun threshold is confirmed.
  overrunThreshold: 4,
};

// ─── Slide / layout configuration ────────────────────────────────────────────
// All dimensions in inches. Change values here; do not edit rendering code.
const SLIDE_CONFIG = {
  slideW: 8.5,
  slideH: 11.0,

  // Gap between the two signs stacked on a page (cut line whitespace).
  cutGap: 0.125,

  // Height of one sign = half the page minus half the gap.
  get signH() { return (this.slideH - this.cutGap) / 2; },

  photoColW:      3.0,
  contentMarginX: 0.18,
  contentMarginY: 0.18,

  colors: {
    headerGreen:       '2d5a27',
    accentGreen:       '4a8c3f',
    bodyText:          '1a1a1a',
    highlightText:     '3a5f35',
    photoBg:           'c8d8c4',
    dividerLine:       '2d5a27',
    iconBg:            'eaf3e8',
    signBg:            'FFFFFF',
    piedmontBadge:     'FFD700',  // bright gold
    piedmontBadgeText: '2d5a27',  // same dark green as title
  },

  fonts: {
    common:    { name: 'Georgia',        size: 24,  italic: false, bold: true  },
    attribute: { name: 'Calibri',        size: 18,  italic: false, bold: false },
    highlight: { name: 'Georgia',        size: 20,  italic: true,  bold: false },
    icon:      { name: 'Segoe UI Emoji', size: 18,  italic: false, bold: false },
    iconLabel: { name: 'Calibri',        size: 18,  italic: false, bold: false },
  },
};
