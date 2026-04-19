/**
 * pdfGenerator.js — PDF Generation Logic
 * Uses jsPDF (loaded via CDN) for client-side PDF creation
 * Supports A4/Letter, landscape/portrait, fit modes, margins, page numbers, headers/footers
 */

const PDFGenerator = (() => {

  // Page dimensions in mm (width x height in portrait)
  const PAGE_SIZES = {
    a4:     { w: 210, h: 297 },
    letter: { w: 215.9, h: 279.4 },
  };

  /**
   * Main entry point: generate and download a PDF
   * @param {Array} images - sorted image records from DB (with .blob)
   * @param {Object} settings - PDF settings
   * @param {Function} onProgress - callback(percent, message)
   */
  async function generate(images, settings, onProgress = () => {}) {
    const validatedSettings = validateSettings(settings);
    const {
      filename = 'screenshots',
      pageSize = 'a4',
      orientation = 'landscape',
      fitMode = 'fit-page',
      margins = { top: 10, right: 10, bottom: 10, left: 10 },
      showPageNumbers = true,
      showHeaderFooter = false,
      headerText = '',
      footerText = '',
      compress = true,
      quality = 0.8,
      pageRange = '',
    } = validatedSettings;

    // Resolve page dimensions
    const base = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
    const pageW = orientation === 'landscape' ? base.h : base.w;
    const pageH = orientation === 'landscape' ? base.w : base.h;

    // Filter pages by range if provided
    const filteredImages = filterByRange(images, pageRange);

    if (filteredImages.length === 0) {
      throw new Error('No pages to export. Check your page range.');
    }

    onProgress(2, 'Initializing PDF…');

    // Create jsPDF instance
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({
      orientation,
      unit: 'mm',
      format: pageSize,
      compress,
    });

    // Usable area
    const usableW = pageW - margins.left - margins.right;
    const usableH = pageH - margins.top - margins.bottom
      - (showPageNumbers ? 6 : 0)
      - (showHeaderFooter && headerText ? 6 : 0)
      - (showHeaderFooter && footerText ? 6 : 0);

    for (let i = 0; i < filteredImages.length; i++) {
      const record = filteredImages[i];
      const pct = Math.round(5 + (i / filteredImages.length) * 88);
      onProgress(pct, `Processing page ${i + 1} of ${filteredImages.length}…`);

      if (i > 0) pdf.addPage(pageSize, orientation);

      // Get image data URL
      let imgDataURL;
      try {
        imgDataURL = await blobToDataURL(record.blob, compress ? quality : 1.0);
      } catch (err) {
        console.error(`Failed to load image for page ${i+1}`, err);
        continue;
      }

      // Apply any stored transforms (rotation, flip)
      if (record.rotation || record.flipH || record.flipV) {
        imgDataURL = await applyTransformToDataURL(imgDataURL, record);
      }

      const dims = await getImageDimensionsFromDataURL(imgDataURL);

      // Determine rendered dimensions
      const imgW = dims.width || record.w || 800;
      const imgH = dims.height || record.h || 600;
      const { x, y, w, h } = calcImagePlacement(imgW, imgH, usableW, usableH, fitMode, margins);

      // Add image to PDF
      const fmt = imgDataURL.startsWith('data:image/png') ? 'PNG' : 'JPEG';
      pdf.addImage(imgDataURL, fmt, x, y, w, h, undefined, 'FAST');

      // Header
      if (showHeaderFooter && headerText) {
        pdf.setFontSize(8);
        pdf.setTextColor(150);
        pdf.text(headerText, margins.left, margins.top - 2);
      }

      // Footer text
      if (showHeaderFooter && footerText) {
        pdf.setFontSize(8);
        pdf.setTextColor(150);
        pdf.text(footerText, margins.left, pageH - 3);
      }

      // Page numbers
      if (showPageNumbers) {
        pdf.setFontSize(8);
        pdf.setTextColor(180);
        const label = `${i + 1} / ${filteredImages.length}`;
        const tw = pdf.getTextWidth(label);
        pdf.text(label, pageW - margins.right - tw, pageH - 3);
      }

      await yieldToMainThread();
    }

    onProgress(96, 'Saving file…');

    // Trigger download
    const safeFilename = (filename || 'screenshots').replace(/[^a-zA-Z0-9_\-. ]/g, '_');
    pdf.save(`${safeFilename}.pdf`);

    onProgress(100, 'Done!');
  }

  /**
   * Calculate image position and size within usable area
   */
  function calcImagePlacement(imgW, imgH, areaW, areaH, fitMode, margins) {
    let w, h, x, y;

    if (fitMode === 'original') {
      // Convert px to mm (assuming 96 DPI)
      w = Math.min(imgW * 0.2646, areaW);
      h = Math.min(imgH * 0.2646, areaH);
      // Check aspect if clamped
      if (w === areaW) h = w * (imgH / imgW);
      if (h === areaH) w = h * (imgW / imgH);
    } else if (fitMode === 'fit-width') {
      w = areaW;
      h = w * (imgH / imgW);
      if (h > areaH) { h = areaH; w = h * (imgW / imgH); }
    } else {
      // fit-page: fit inside area maintaining aspect ratio
      const scaleW = areaW / imgW;
      const scaleH = areaH / imgH;
      const scale = Math.min(scaleW, scaleH);
      w = imgW * scale;
      h = imgH * scale;
    }

    // Center horizontally and vertically within usable area
    x = margins.left + (areaW - w) / 2;
    y = margins.top + (areaH - h) / 2;

    return { x, y, w, h };
  }

  /**
   * Parse page range string like "1-5, 8, 10-12"
   * Returns filtered + reordered array of image records
   */
  function filterByRange(images, rangeStr) {
    if (!rangeStr || !rangeStr.trim()) return images;

    const included = new Set();
    const parts = rangeStr.split(',');
    let hasValidToken = false;

    for (const part of parts) {
      const t = part.trim();
      if (!t) continue;
      if (t.includes('-')) {
        const [a, b] = t.split('-').map(s => parseInt(s.trim(), 10));
        if (!isNaN(a) && !isNaN(b)) {
          hasValidToken = true;
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) included.add(i);
        }
      } else {
        const n = parseInt(t, 10);
        if (!isNaN(n)) {
          hasValidToken = true;
          included.add(n);
        }
      }
    }

    if (!hasValidToken) {
      throw new Error('Invalid page range. Use values like "1-5, 8, 10-12".');
    }

    return images.filter((_, idx) => included.has(idx + 1));
  }

  /** Convert blob to data URL with optional JPEG quality re-encoding */
  function blobToDataURL(blob, quality) {
    return new Promise((resolve, reject) => {
      if (quality >= 1.0 || blob.type === 'image/png') {
        // Just read as-is
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
        return;
      }

      // Re-encode as JPEG at desired quality
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Load failed')); };
      img.src = url;
    });
  }

  /** Apply rotation/flip transforms to a data URL, returning new data URL */
  async function applyTransformToDataURL(dataURL, record) {
    const { rotation = 0, flipH = false, flipV = false } = record;
    if (!rotation && !flipH && !flipV) return dataURL;

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const ow = img.naturalWidth, oh = img.naturalHeight;
        const rotate90 = rotation % 180 !== 0;
        const cw = rotate90 ? oh : ow;
        const ch = rotate90 ? ow : oh;

        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        const ctx = c.getContext('2d');
        ctx.save();
        ctx.translate(cw / 2, ch / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        if (flipH) ctx.scale(-1, 1);
        if (flipV) ctx.scale(1, -1);
        ctx.drawImage(img, -ow / 2, -oh / 2, ow, oh);
        ctx.restore();
        resolve(c.toDataURL('image/jpeg', 0.92));
      };
      img.onerror = reject;
      img.src = dataURL;
    });
  }

  function getImageDimensionsFromDataURL(dataURL) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('Failed to read transformed image dimensions'));
      img.src = dataURL;
    });
  }

  function validateSettings(settings = {}) {
    const margins = settings.margins || {};
    const normalized = {
      ...settings,
      pageSize: PAGE_SIZES[settings.pageSize] ? settings.pageSize : 'a4',
      orientation: settings.orientation === 'portrait' ? 'portrait' : 'landscape',
      fitMode: ['fit-page', 'fit-width', 'original'].includes(settings.fitMode) ? settings.fitMode : 'fit-page',
      quality: Math.min(1, Math.max(0.3, Number(settings.quality ?? 0.8))),
      margins: {
        top: clampMargin(margins.top),
        right: clampMargin(margins.right),
        bottom: clampMargin(margins.bottom),
        left: clampMargin(margins.left),
      },
    };

    return normalized;
  }

  function clampMargin(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 10;
    return Math.min(50, Math.max(0, n));
  }

  function yieldToMainThread() {
    return new Promise(resolve => requestAnimationFrame(resolve));
  }

  return { generate, filterByRange };
})();
