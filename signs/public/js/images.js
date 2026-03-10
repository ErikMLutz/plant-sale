// ─── Image utilities ──────────────────────────────────────────────────────────

/**
 * Convert a data URI to JPEG via Canvas with a centered cover crop.
 * Required because PowerPoint doesn't support WebP (served by Squarespace CDN).
 *
 * @param {string} dataUri      - any browser-renderable data URI
 * @param {number} targetAspect - desired width/height ratio
 * @returns {Promise<string>}   - JPEG data URI
 */
function convertToJpeg(dataUri, targetAspect) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const srcW = img.naturalWidth;
      const srcH = img.naturalHeight;
      const srcAspect = srcW / srcH;

      let cropX = 0, cropY = 0, cropW = srcW, cropH = srcH;
      if (srcAspect > targetAspect) {
        // Image wider than target — crop sides
        cropW = Math.round(srcH * targetAspect);
        cropX = Math.round((srcW - cropW) / 2);
      } else {
        // Image taller than target — crop top/bottom
        cropH = Math.round(srcW / targetAspect);
        cropY = Math.round((srcH - cropH) / 2);
      }

      const canvas = document.createElement('canvas');
      canvas.width  = cropW;
      canvas.height = cropH;
      canvas.getContext('2d').drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = reject;
    img.src = dataUri;
  });
}

/**
 * Fetch an image URL and return it in pptxgenjs `data` format:
 * "image/jpeg;base64,..." — NO leading "data:" prefix (pptxgenjs requirement).
 *
 * - Detects format via magic bytes (Squarespace CDN URLs have no file extension)
 * - Converts WebP/GIF/PNG → JPEG via Canvas (PowerPoint doesn't support WebP)
 * - Applies centered cover crop to match the photo column aspect ratio
 *
 * @param {string|null} url
 * @returns {Promise<string|null>}
 */
async function fetchForPptx(url) {
  if (!url) return null;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const arrayBuffer = await resp.arrayBuffer();

    // Detect format from magic bytes
    const h = new Uint8Array(arrayBuffer, 0, 4);
    let mimeType = 'image/jpeg';
    if (h[0] === 0x89 && h[1] === 0x50) mimeType = 'image/png';
    else if (h[0] === 0x47 && h[1] === 0x49) mimeType = 'image/gif';
    else if (h[0] === 0x52 && h[1] === 0x49) mimeType = 'image/webp';

    const blob    = new Blob([arrayBuffer], { type: mimeType });
    const dataUri = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    const targetAspect = (SLIDE_CONFIG.photoColW - 0.09) / SLIDE_CONFIG.signH;
    const finalDataUri = await convertToJpeg(dataUri, targetAspect);
    console.log(`[photo] ${url.split('/').pop()}: ${mimeType} → jpeg, ${Math.round(arrayBuffer.byteLength / 1024)}KB`);

    // Strip "data:" prefix — pptxgenjs expects "image/jpeg;base64,..."
    return finalDataUri.replace(/^data:/, '');
  } catch (err) {
    console.warn(`[photo] Could not fetch ${url}:`, err.message);
    return null;
  }
}

/**
 * Estimate how many lines a string will wrap to in a given width using Canvas
 * font metrics. Much more accurate than character-count estimates for
 * variable-width fonts like Georgia Bold.
 *
 * A 0.88 scale factor is applied by callers to compensate for PowerPoint's
 * internal text box padding and slightly wider font rendering than the browser.
 *
 * @param {string} text        - text to measure
 * @param {number} widthInches - available width in inches
 * @param {object} fontSpec    - { name, size (pt), bold, italic }
 * @returns {number}           - estimated line count (≥ 1)
 */
function estimateWrappedLines(text, widthInches, fontSpec) {
  const widthPx = widthInches * 96;  // 96 CSS px per inch
  const px      = fontSpec.size * (96 / 72);  // pt → px
  const fontStr = [
    fontSpec.bold   ? 'bold'   : '',
    fontSpec.italic ? 'italic' : '',
    `${px}px`,
    `"${fontSpec.name}"`,
  ].filter(Boolean).join(' ');

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  ctx.font     = fontStr;

  const words  = text.split(/\s+/).filter(Boolean);
  const spaceW = ctx.measureText(' ').width;
  let lines    = 1;
  let lineW    = 0;

  for (const word of words) {
    const wordW = ctx.measureText(word).width;
    if (lineW > 0 && lineW + spaceW + wordW > widthPx) {
      lines++;
      lineW = wordW;
    } else {
      lineW += (lineW > 0 ? spaceW : 0) + wordW;
    }
  }
  return lines;
}
