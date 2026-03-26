// ─── PPTX slide rendering ─────────────────────────────────────────────────────

/**
 * Convert an HTML description string to an array of pptxgenjs run objects.
 *
 * Handles:
 *   <ul>/<li> — bullet runs: "• " (accent green bold) + optional <strong>Label:</strong>
 *               (bold body text) + value text (plain body text) + breakLine
 *   <p>       — italic highlight paragraph + breakLine
 *   6pt spacer run inserted between <ul> block and first <p>
 *
 * Uses a temporary DOM element to parse HTML — no external parser needed.
 */
function parseHtmlToRuns(html, opts = {}) {
  const { fonts, colors } = SLIDE_CONFIG;
  const attrSize = opts.attrFontSize != null ? opts.attrFontSize : fonts.attribute.size;
  const el = document.createElement('div');
  el.innerHTML = html || '';

  const runs = [];
  let hadUl = false;

  for (const node of Array.from(el.childNodes)) {
    if (node.nodeName === 'UL') {
      hadUl = true;
      for (const li of Array.from(node.childNodes)) {
        if (li.nodeName !== 'LI') continue;

        // Bullet marker
        runs.push({ text: '• ', options: { fontSize: attrSize, color: colors.accentGreen, bold: true, fontFace: fonts.attribute.name } });

        // Walk li child nodes — split <strong>/<b> (bold) from text nodes (plain)
        const liChildren = Array.from(li.childNodes);
        const liRuns = [];
        for (const child of liChildren) {
          const isBold = child.nodeName === 'STRONG' || child.nodeName === 'B';
          const t = child.textContent || '';
          if (!t) continue;
          liRuns.push({ text: t, options: { fontSize: attrSize, bold: isBold, color: colors.bodyText, fontFace: fonts.attribute.name } });
        }

        if (liRuns.length === 0) {
          // Fallback: use full text content as plain run
          const t = li.textContent.trim();
          if (t) liRuns.push({ text: t, options: { fontSize: attrSize, bold: false, color: colors.bodyText, fontFace: fonts.attribute.name } });
        }

        if (liRuns.length > 0) {
          // breakLine on the last run of this li
          const last = liRuns[liRuns.length - 1];
          liRuns[liRuns.length - 1] = { ...last, options: { ...last.options, breakLine: true } };
          runs.push(...liRuns);
        } else {
          // Empty li — put breakLine on the bullet
          const bullet = runs[runs.length - 1];
          runs[runs.length - 1] = { ...bullet, options: { ...bullet.options, breakLine: true } };
        }
      }
    } else if (node.nodeName === 'P') {
      const t = node.textContent || '';
      if (!t.trim()) continue;
      if (hadUl) {
        runs.push({ text: ' ', options: { fontSize: 6, breakLine: true } });
        hadUl = false;
      }
      runs.push({
        text: t,
        options: { fontSize: fonts.highlight.size, fontFace: fonts.highlight.name, italic: true, color: colors.highlightText, breakLine: true },
      });
    }
  }

  return runs;
}

/**
 * Build icon strings for both lines of the icon strip.
 * Returns { line1: '...sun icons...', line2: '...moisture/critter/deer...' }
 */
function buildIcons(plant) {
  const parts = [];
  const sunLevels = Array.isArray(plant.sun_levels) ? plant.sun_levels : [];
  sunLevels.forEach(l => { const s = ICON_CONFIG.sun[l]; if (s) parts.push(s); });
  const moistStr = ICON_CONFIG.moisture[plant.moisture];
  if (moistStr) parts.push(moistStr);
  if (plant.is_pollinator)     parts.push(ICON_CONFIG.critter_friendly.show);
  if (plant.is_deer_resistant) parts.push(ICON_CONFIG.deer_resistant.show);
  return parts;
}

/** Draw a muted green placeholder box in the photo area. */
function addPhotoPlaceholder(slide, yOffset, photoW, photoH, colors) {
  slide.addShape('rect', {
    x: 0.09, y: yOffset, w: photoW - 0.09, h: photoH,
    fill: { color: colors.photoBg },
    line: { color: colors.photoBg },
  });
  slide.addText('[ Photo ]', {
    x: 0.09, y: yOffset, w: photoW - 0.09, h: photoH,
    fontSize: 12, fontFace: 'Calibri', color: '6a8c65',
    align: 'center', valign: 'middle', italic: true,
  });
}

/**
 * Render one plant sign onto a slide at vertical offset `yOffset`.
 *
 * Layout:
 *   [  Photo  |  Common Name (bold)            ]
 *   [  Area   |  ──────────────────────────    ]
 *   [         |  • Attribute bullets           ]
 *   [         |  Highlight text (italic)       ]
 *   [         |  ☀ ⛅  (sun icons, line 1)     ]
 *   [         |  💧 🦋 🦌  (line 2)           ]
 *
 * photoDataArr: array of base64 photo data strings. All are placed at the
 * same position so PowerPoint users can drag/resize/delete extras. First
 * photo ends up on top.
 */
function addSignToSlide(slide, plant, yOffset, photoDataArr) {
  const C = SLIDE_CONFIG;
  const { colors, fonts } = C;
  const { signH, slideW } = C;
  const photoW   = C.photoColW;
  const contentX = photoW;
  const contentW = slideW - photoW;
  const mX       = C.contentMarginX;
  const mY       = C.contentMarginY;
  const iconStripH = 0.45;  // single line at 12pt

  // Background + left accent bar
  slide.addShape('rect', { x: 0, y: yOffset, w: slideW, h: signH, fill: { color: colors.signBg }, line: { color: colors.signBg } });
  slide.addShape('rect', { x: 0, y: yOffset, w: 0.09,   h: signH, fill: { color: colors.headerGreen }, line: { color: colors.headerGreen } });

  // Photos — add in reverse so index 0 (first photo) ends up on top.
  // All images occupy the same position/size; extras are hidden under the first
  // but accessible to humans editing in PowerPoint.
  const photos = Array.isArray(photoDataArr) ? photoDataArr.filter(Boolean) : (photoDataArr ? [photoDataArr] : []);
  if (photos.length > 0) {
    for (let pi = photos.length - 1; pi >= 0; pi--) {
      try {
        slide.addImage({ data: photos[pi], x: 0.09, y: yOffset, w: photoW - 0.09, h: signH - iconStripH });
      } catch (e) {
        console.warn('[slide] addImage failed:', e.message);
      }
    }
  } else {
    addPhotoPlaceholder(slide, yOffset, photoW, signH - iconStripH, colors);
  }

  // Content area geometry
  const innerX = contentX + mX;
  const innerW = contentW - mX * 2;

  // Piedmont native badge — orange circle in the top-left corner of the sign
  if (plant.piedmont_native) {
    const badgeD = 1.0;
    const badgeX = 0.05;
    const badgeY = yOffset + 0.05;
    slide.addShape('star32', {
      x: badgeX, y: badgeY, w: badgeD, h: badgeD,
      fill: { color: colors.piedmontBadge },
      line: { color: colors.piedmontBadgeBorder, width: 2.25 },
    });
    slide.addText('NC\nPiedmont\nNative!', {
      x: badgeX, y: badgeY, w: badgeD, h: badgeD,
      fontSize: 12, fontFace: 'Calibri',
      bold: true, color: colors.piedmontBadgeText,
      align: 'center', valign: 'middle',
    });
  }

  const iconStripY = yOffset + signH - iconStripH;
  const textBoxY   = yOffset + mY;
  const textBoxH   = iconStripY - textBoxY - 0.05;

  // Parse description into bullet runs and highlight text separately
  const descEl = document.createElement('div');
  descEl.innerHTML = plant.description || '';
  const ulEl = descEl.querySelector('ul');
  const pEl  = descEl.querySelector('p');
  const highlightText = pEl ? pEl.textContent.trim() : '';

  // Split SS title "Latin name (Common Name)" into two display lines.
  // Falls back gracefully if no parenthetical or no latin field.
  const parenMatch = (plant.common || '').match(/^(.+?)\s*\((.+)\)\s*$/);
  let latinLine, commonLine;
  if (plant.latin) {
    latinLine  = plant.latin;
    commonLine = parenMatch ? parenMatch[2] : plant.common;
  } else if (parenMatch) {
    latinLine  = parenMatch[1];
    commonLine = parenMatch[2];
  } else {
    latinLine  = '';
    commonLine = plant.common || '';
  }

  // Auto-size bullets: reduce by 2pt if estimated top content would overflow into the highlight area.
  // Estimate line counts using Canvas-based wrapping (same approach as common name wrapping).
  const LINE_H     = sz => (sz / 24) * 0.40;  // line height in inches for a given pt size
  const effectiveW = innerW * 0.88;            // matches PowerPoint's effective text box width
  const latinLineCount  = latinLine
    ? estimateWrappedLines(latinLine,  effectiveW, { name: fonts.latin.name,  size: fonts.latin.size,  italic: true })
    : 0;
  const commonLineCount = estimateWrappedLines(commonLine, effectiveW, { name: fonts.common.name, size: fonts.common.size, bold: true });
  const liEls = ulEl ? Array.from(ulEl.querySelectorAll('li')) : [];
  // Estimate with bold=true (conservative: bold label chars are wider than plain)
  const bulletTexts = liEls.map(li => '• ' + li.textContent.trim());

  const highlightBoxH = 1.3;
  const highlightBoxY = iconStripY - highlightBoxH;

  let attrFontSize = fonts.attribute.size;
  const bulletLineCount = bulletTexts.reduce(
    (n, t) => n + estimateWrappedLines(t, effectiveW, { name: fonts.attribute.name, size: attrFontSize, bold: true }),
    0
  );
  const estHeight = (latinLineCount + commonLineCount) * LINE_H(fonts.latin.size) + LINE_H(10) * 2 + bulletLineCount * LINE_H(attrFontSize);
  // Add one line of cushion: Canvas slightly underestimates vs PowerPoint's actual render,
  // so reduce if content comes within one bullet-line-height of the highlight box.
  if (textBoxY + estHeight + LINE_H(attrFontSize) > highlightBoxY) {
    attrFontSize -= 2;
  }

  const bulletRuns = parseHtmlToRuns(ulEl ? `<ul>${ulEl.innerHTML}</ul>` : '', { attrFontSize });

  // Top text box: latin + common name + attribute bullets (top-anchored)
  const topRuns = [];
  if (latinLine) {
    topRuns.push({ text: latinLine, options: { fontSize: fonts.latin.size, fontFace: fonts.latin.name, italic: true, bold: false, color: colors.headerGreen, breakLine: true } });
  }
  topRuns.push({ text: commonLine, options: { fontSize: fonts.common.size, fontFace: fonts.common.name, bold: true, italic: false, color: colors.headerGreen, breakLine: true } });
  topRuns.push({ text: ' ', options: { fontSize: 10, breakLine: true } });
  topRuns.push({ text: ' ', options: { fontSize: 10, breakLine: true } });
  topRuns.push(...bulletRuns);
  slide.addText(topRuns, { x: innerX, y: textBoxY, w: innerW, h: textBoxH, valign: 'top', wrap: true, autoFit: false });

  // Bottom text box: highlight/flavor text — pinned just above the icon strip
  if (highlightText) {
    slide.addText(highlightText, {
      x: innerX, y: highlightBoxY, w: innerW, h: highlightBoxH,
      fontSize: fonts.highlight.size, fontFace: fonts.highlight.name,
      italic: true, color: colors.highlightText,
      valign: 'middle', wrap: true, autoFit: false,
    });
  }

  // Icon strip — single line, full width starting from left margin
  slide.addShape('rect', { x: 0, y: iconStripY, w: slideW, h: iconStripH, fill: { color: colors.iconBg }, line: { color: colors.iconBg } });
  const iconParts = buildIcons(plant);
  if (iconParts.length > 0) {
    const threshold = ICON_CONFIG.overrunThreshold;
    const iconSize  = (threshold !== null && iconParts.length > threshold)
      ? Math.round(fonts.icon.size * 0.80)
      : fonts.icon.size;
    slide.addText(iconParts.join('   '), {
      x: mX, y: iconStripY, w: slideW - mX * 2, h: iconStripH,
      fontSize: iconSize, fontFace: fonts.icon.name,
      color: colors.bodyText, valign: 'middle', wrap: false,
    });
  }
}

// ─── Main generation function ─────────────────────────────────────────────────

async function generatePPTX() {
  const btn    = document.getElementById('gen-btn');
  const status = document.getElementById('status');

  if (!plants || plants.length === 0) {
    status.className   = 'error';
    status.textContent = 'No plants to generate. Import data first.';
    return;
  }

  btn.disabled       = true;
  status.className   = '';
  status.textContent = '';

  const progressWrap  = document.getElementById('progress-wrap');
  const progressBar   = document.getElementById('progress-bar');
  const progressLabel = document.getElementById('progress-label');
  progressWrap.style.display = 'block';
  progressBar.style.width    = '0%';

  // Fetch all photos for each plant with limited concurrency.
  // Multiple photos per plant are stacked on the slide; humans can drag/delete.
  // CONCURRENCY = 4: safe for most hardware (Canvas WebP→JPEG is CPU-bound).
  const CONCURRENCY = 4;
  let completed = 0;

  // Sort plants: SS page A-Z, then latin name A-Z within each page
  const sortedPlants = [...plants].sort((a, b) => {
    const pageA = (a.page || '').toLowerCase();
    const pageB = (b.page || '').toLowerCase();
    if (pageA !== pageB) return pageA.localeCompare(pageB);
    return (a.latin || a.common || '').toLowerCase().localeCompare((b.latin || b.common || '').toLowerCase());
  });

  const photoDataArrs = await (async () => {
    const results = new Array(sortedPlants.length);
    let nextIdx   = 0;
    async function worker() {
      while (nextIdx < sortedPlants.length) {
        const i    = nextIdx++;
        const urls = sortedPlants[i].photo_urls || [];
        results[i] = await Promise.all(urls.map(u => fetchForPptx(u)));
        completed++;
        const pct = Math.round((completed / sortedPlants.length) * 100);
        progressBar.style.width    = pct + '%';
        progressLabel.textContent  = `Fetching photos… ${completed} / ${sortedPlants.length}`;
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sortedPlants.length) }, worker));
    return results;
  })();

  const slideCount = Math.ceil(sortedPlants.length / 2);
  const estSecs = Math.ceil(sortedPlants.length / 2);
  const estStr  = estSecs >= 60
    ? `up to ${Math.ceil(estSecs / 60)} minute${Math.ceil(estSecs / 60) > 1 ? 's' : ''}`
    : `up to ${estSecs} second${estSecs !== 1 ? 's' : ''}`;
  progressLabel.textContent = `Generating download… this may take a while (e.g. ${estStr})`;

  try {
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'SIGN_LAYOUT', width: SLIDE_CONFIG.slideW, height: SLIDE_CONFIG.slideH });
    pptx.layout = 'SIGN_LAYOUT';

    const signH  = SLIDE_CONFIG.signH;
    const cutGap = SLIDE_CONFIG.cutGap;

    // Two plants per slide, stacked vertically with a cut gap between them.
    // A category divider slide is inserted before each new category group.
    let currentCategory = null;

    const flushPair = (plantA, photoA, plantB, photoB) => {
      const slide = pptx.addSlide();
      slide.background = { color: SLIDE_CONFIG.colors.signBg };
      addSignToSlide(slide, plantA, 0, photoA);
      if (plantB) addSignToSlide(slide, plantB, signH + cutGap, photoB);
    };

    // Group plants by category, emit a divider slide before each group
    let i = 0;
    while (i < sortedPlants.length) {
      const plant = sortedPlants[i];
      const cat   = (plant.page || '').toLowerCase();

      if (cat !== currentCategory) {
        currentCategory = cat;

        // Category divider slide
        const divider = pptx.addSlide();
        divider.background = { color: 'FFFFFF' };
        const label = cat.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        divider.addText(label, {
          x: 0, y: 0, w: SLIDE_CONFIG.slideW, h: SLIDE_CONFIG.slideH,
          fontSize: 40, fontFace: 'Georgia', bold: true,
          color: SLIDE_CONFIG.colors.headerGreen,
          align: 'center', valign: 'middle',
        });
      }

      // Pair plants within the same category; don't pair across categories
      const next = sortedPlants[i + 1];
      const nextCat = next ? (next.page || '').toLowerCase() : null;
      if (nextCat === cat) {
        flushPair(plant, photoDataArrs[i], next, photoDataArrs[i + 1]);
        i += 2;
      } else {
        flushPair(plant, photoDataArrs[i], null, null);
        i += 1;
      }
    }

    await pptx.writeFile({ fileName: 'plant-sale-signs.pptx' });

    progressWrap.style.display = 'none';
    status.className   = 'success';
    status.textContent = `✓ Downloaded plant-sale-signs.pptx (${sortedPlants.length} plants) successfully!`;
  } catch (err) {
    console.error('[pptx] Generation failed:', err);
    progressWrap.style.display = 'none';
    status.className   = 'error';
    status.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}
