// ─── Debug ────────────────────────────────────────────────────────────────────
// Set to false before shipping — hides the panel and removes all limits.
const DEBUG = true;

// Current debug settings (kept in sync with the panel UI)
const debugState = { limitEnabled: true, limitValue: 10, pickOverlap: true };

function syncDebugState() {
  debugState.limitEnabled = document.getElementById('dbg-limit-enabled').checked;
  debugState.limitValue   = parseInt(document.getElementById('dbg-limit-value').value, 10) || 10;
  debugState.pickOverlap  = document.getElementById('dbg-pick-overlap').checked;
}

// Show debug panel if DEBUG is on
document.addEventListener('DOMContentLoaded', () => {
  if (DEBUG) document.getElementById('debug-panel').style.display = 'block';
});

// ─── Icon configuration ───────────────────────────────────────────────────────
// Edit this object to change icon display. Keys must match sun_level / moisture
// field values on plant objects. To swap emoji for image assets, replace the
// string values with pptxgenjs image objects in pptx.js → buildIcons().
const ICON_CONFIG = {
  sun: {
    full_sun:   '☀ Full Sun',
    part_shade: '⛅ Part Shade',
    shade:      '☁ Shade',
  },
  moisture: {
    wet:     '💧💧💧 Wet',
    average: '💧💧  Average',
    drought: '💧     Drought Tolerant',
  },
  pollinator:     { show: '🦋 Pollinator Friendly' },
  deer_resistant: { show: '🦌 Deer Resistant' },
};

// ─── Slide / layout configuration ────────────────────────────────────────────
// All dimensions in inches. Change values here; do not edit rendering code.
const SLIDE_CONFIG = {
  slideW: 7.75,
  slideH: 4.75,

  get signH() { return this.slideH; },

  photoColW:      3.0,
  contentMarginX: 0.18,
  contentMarginY: 0.18,

  colors: {
    headerGreen:  '2d5a27',
    accentGreen:  '4a8c3f',
    bodyText:     '1a1a1a',
    highlightText:'3a5f35',
    photoBg:      'c8d8c4',
    dividerLine:  '2d5a27',
    iconBg:       'eaf3e8',
    signBg:       'FFFFFF',
  },

  fonts: {
    latin:     { name: 'Georgia',         size: 11,  italic: true,  bold: false },
    common:    { name: 'Georgia',         size: 19,  italic: false, bold: true  },
    attribute: { name: 'Calibri',         size: 9,   italic: false, bold: false },
    highlight: { name: 'Georgia',         size: 9.5, italic: true,  bold: false },
    icon:      { name: 'Segoe UI Emoji',  size: 9,   italic: false, bold: false },
    iconLabel: { name: 'Calibri',         size: 8.5, italic: false, bold: false },
  },
};
