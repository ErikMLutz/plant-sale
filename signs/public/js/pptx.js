// ─── PPTX slide rendering ─────────────────────────────────────────────────────

/** Parse "Size: X; Bloom: Y; …" into [{label, value}, …] */
function parseAttributes(line) {
  return (line || '').split(';').map(part => {
    const colonIdx = part.indexOf(':');
    if (colonIdx === -1) return { label: '', value: part.trim() };
    return {
      label: part.slice(0, colonIdx).trim(),
      value: part.slice(colonIdx + 1).trim(),
    };
  }).filter(a => a.label || a.value);
}

/** Build icon strip strings from ICON_CONFIG for a plant object. */
function buildIcons(plant) {
  const icons = [];
  const sunStr  = ICON_CONFIG.sun[plant.sun_level];
  if (sunStr) icons.push(sunStr);
  const moistStr = ICON_CONFIG.moisture[plant.moisture];
  if (moistStr) icons.push(moistStr);
  if (plant.is_pollinator)     icons.push(ICON_CONFIG.pollinator.show);
  if (plant.is_deer_resistant) icons.push(ICON_CONFIG.deer_resistant.show);
  return icons;
}

/** Draw a muted green placeholder box in the photo area. */
function addPhotoPlaceholder(slide, yOffset, photoW, signH, colors) {
  slide.addShape('rect', {
    x: 0.09, y: yOffset, w: photoW - 0.09, h: signH,
    fill: { color: colors.photoBg },
    line: { color: colors.photoBg },
  });
  slide.addText('[ Photo ]', {
    x: 0.09, y: yOffset, w: photoW - 0.09, h: signH,
    fontSize: 12, fontFace: 'Calibri', color: '6a8c65',
    align: 'center', valign: 'middle', italic: true,
  });
}

/**
 * Render one plant sign onto a slide at vertical offset `yOffset`.
 *
 * Layout:
 *   [  Photo  |  Latin name (italic, small)   ]
 *   [  Area   |  Common Name (bold, 19pt)     ]
 *   [         |  ─────────────────────────    ]
 *   [         |  • Attribute bullets          ]
 *   [         |  Highlight text (italic)      ]
 *   [         |  ☀ 💧 🦋 🦌  icon strip      ]
 */
function addSignToSlide(slide, plant, yOffset, photoData) {
  const C = SLIDE_CONFIG;
  const { colors, fonts } = C;
  const { signH, slideW } = C;
  const photoW   = C.photoColW;
  const contentX = photoW;
  const contentW = slideW - photoW;
  const mX       = C.contentMarginX;
  const mY       = C.contentMarginY;

  // Background + left accent bar
  slide.addShape('rect', { x: 0, y: yOffset, w: slideW, h: signH, fill: { color: colors.signBg }, line: { color: colors.signBg } });
  slide.addShape('rect', { x: 0, y: yOffset, w: 0.09,   h: signH, fill: { color: colors.headerGreen }, line: { color: colors.headerGreen } });

  // Photo
  if (photoData) {
    try {
      slide.addImage({ data: photoData, x: 0.09, y: yOffset, w: photoW - 0.09, h: signH });
    } catch (e) {
      console.warn('[slide] addImage failed:', e.message);
      addPhotoPlaceholder(slide, yOffset, photoW, signH, colors);
    }
  } else {
    addPhotoPlaceholder(slide, yOffset, photoW, signH, colors);
  }

  // Content area geometry
  const innerX = contentX + mX;
  const innerW = contentW - mX * 2;

  const latinY = yOffset + mY;
  const latinH = 0.30;
  const commonY = latinY + latinH + 0.01;

  // Canvas-based line count with 0.88 factor to compensate for PowerPoint's
  // internal text box padding and slightly wider font rendering.
  const commonLines = estimateWrappedLines(
    plant.common || '',
    (slideW - photoW - mX * 2) * 0.88,
    fonts.common
  );
  const commonH  = Math.max(commonLines, 1) * 0.40; // 0.40" per line at 19pt
  const dividerY = commonY + commonH + 0.04;
  const dividerH = 0.02;
  const attribY  = dividerY + dividerH + 0.07;

  const iconStripH = 0.50;
  const iconStripY = yOffset + signH - iconStripH;
  const highlightH = 0.45;
  const highlightY = iconStripY - highlightH - 0.08;
  const bulletH    = highlightY - attribY - 0.04;

  // Latin name
  slide.addText(plant.latin || '', {
    x: innerX, y: latinY, w: innerW, h: latinH,
    fontSize: fonts.latin.size, fontFace: fonts.latin.name,
    italic: true, color: colors.accentGreen, valign: 'bottom', wrap: true,
  });

  // Common name
  slide.addText(plant.common || '', {
    x: innerX, y: commonY, w: innerW, h: commonH,
    fontSize: fonts.common.size, fontFace: fonts.common.name,
    bold: true, color: colors.headerGreen, valign: 'top', wrap: true, autoFit: false,
  });

  // Divider
  slide.addShape('line', {
    x: innerX, y: dividerY, w: innerW, h: 0,
    line: { color: colors.headerGreen, width: 1.5 },
  });

  // Attribute bullets
  const attrs    = parseAttributes(plant.attributes_line);
  const attrRuns = [];
  attrs.forEach((attr, i) => {
    if (i > 0) attrRuns.push({ text: '\n', options: { fontSize: fonts.attribute.size } });
    attrRuns.push({ text: '• ', options: { fontSize: fonts.attribute.size, color: colors.accentGreen, bold: true } });
    if (attr.label) {
      attrRuns.push({ text: attr.label + ': ', options: { fontSize: fonts.attribute.size, bold: true, color: colors.bodyText, fontFace: fonts.attribute.name } });
    }
    attrRuns.push({ text: attr.value, options: { fontSize: fonts.attribute.size, bold: false, color: colors.bodyText, fontFace: fonts.attribute.name } });
  });
  if (attrRuns.length > 0) {
    slide.addText(attrRuns, { x: innerX, y: attribY, w: innerW, h: bulletH, valign: 'top', wrap: true, paraSpaceAfter: 1 });
  }

  // Highlight text
  if (plant.highlight_line) {
    slide.addText(plant.highlight_line, {
      x: innerX, y: highlightY, w: innerW, h: highlightH,
      fontSize: fonts.highlight.size, fontFace: fonts.highlight.name,
      italic: true, color: colors.highlightText, valign: 'top', wrap: true,
    });
  }

  // Icon strip
  slide.addShape('rect', { x: contentX, y: iconStripY, w: contentW, h: iconStripH, fill: { color: colors.iconBg }, line: { color: colors.iconBg } });
  slide.addText(buildIcons(plant).join('   '), {
    x: innerX, y: iconStripY, w: innerW, h: iconStripH,
    fontSize: fonts.icon.size, fontFace: fonts.icon.name,
    color: colors.bodyText, valign: 'middle', wrap: false,
  });
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

  // Fetch photos with limited concurrency so the progress bar fills gradually.
  // CONCURRENCY = 4: safe for most hardware (Canvas WebP→JPEG is CPU-bound).
  const CONCURRENCY = 4;
  let completed = 0;

  const photoDataArr = await (async () => {
    const results = new Array(plants.length);
    let nextIdx   = 0;
    async function worker() {
      while (nextIdx < plants.length) {
        const i    = nextIdx++;
        results[i] = await fetchForPptx(plants[i].photo_urls?.[0] ?? null);
        completed++;
        const pct = Math.round((completed / plants.length) * 100);
        progressBar.style.width    = pct + '%';
        progressLabel.textContent  = `Fetching photos… ${completed} / ${plants.length}`;
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plants.length) }, worker));
    return results;
  })();

  const estSecs = Math.ceil(plants.length / 2);
  const estStr  = estSecs >= 60
    ? `up to ${Math.ceil(estSecs / 60)} minute${Math.ceil(estSecs / 60) > 1 ? 's' : ''}`
    : `up to ${estSecs} second${estSecs !== 1 ? 's' : ''}`;
  progressLabel.textContent = `Generating download… this may take a while (e.g. ${estStr})`;

  try {
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'SIGN_LAYOUT', width: SLIDE_CONFIG.slideW, height: SLIDE_CONFIG.slideH });
    pptx.layout = 'SIGN_LAYOUT';

    for (let i = 0; i < plants.length; i++) {
      const slide = pptx.addSlide();
      slide.background = { color: SLIDE_CONFIG.colors.signBg };
      addSignToSlide(slide, plants[i], 0, photoDataArr[i]);
    }

    await pptx.writeFile({ fileName: 'plant-sale-signs.pptx' });

    progressWrap.style.display = 'none';
    status.className   = 'success';
    status.textContent = `✓ Downloaded plant-sale-signs.pptx (${plants.length} slides) successfully!`;
  } catch (err) {
    console.error('[pptx] Generation failed:', err);
    progressWrap.style.display = 'none';
    status.className   = 'error';
    status.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}
