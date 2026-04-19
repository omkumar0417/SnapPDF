/**
 * imageProcessor.js — Client-side image manipulation
 * Handles: resize, compress, rotate, flip, auto-crop black borders
 * All operations are canvas-based and non-destructive to the original blob
 */

const ImageProcessor = (() => {

  /** Load a Blob/File into an HTMLImageElement */
  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
      img.src = url;
    });
  }

  /** Create an off-screen canvas */
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /**
   * Get image dimensions from blob
   * Returns { width, height }
   */
  async function getDimensions(blob) {
    const img = await loadImage(blob);
    return { width: img.naturalWidth, height: img.naturalHeight };
  }

  /**
   * Compress/resize an image blob
   * @param {Blob} blob
   * @param {Object} opts { maxWidth, maxHeight, quality (0-1), format }
   * @returns {Promise<Blob>}
   */
  async function compress(blob, opts = {}) {
    const {
      maxWidth = 3840,
      maxHeight = 2160,
      quality = 0.82,
      format = 'image/jpeg',
    } = opts;

    const img = await loadImage(blob);
    let { naturalWidth: w, naturalHeight: h } = img;

    // Scale down if needed
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);

    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    return canvasToBlob(c, format, quality);
  }

  /**
   * Apply rotation (degrees: 0, 90, 180, 270) and flip to a blob
   * Returns a new Blob with the transformation applied
   */
  async function applyTransform(blob, { rotation = 0, flipH = false, flipV = false, quality = 0.92 } = {}) {
    const img = await loadImage(blob);
    const { naturalWidth: ow, naturalHeight: oh } = img;

    const rotate90 = rotation % 180 !== 0;
    const cw = rotate90 ? oh : ow;
    const ch = rotate90 ? ow : oh;

    const c = makeCanvas(cw, ch);
    const ctx = c.getContext('2d');

    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    if (flipH) ctx.scale(-1, 1);
    if (flipV) ctx.scale(1, -1);
    ctx.drawImage(img, -ow / 2, -oh / 2, ow, oh);
    ctx.restore();

    return canvasToBlob(c, 'image/jpeg', quality);
  }

  /**
   * Auto-crop black (or near-black) borders from image
   * Threshold controls sensitivity (0-255)
   */
  async function cropBlackBorders(blob, threshold = 20, quality = 0.92) {
    const img = await loadImage(blob);
    const { naturalWidth: w, naturalHeight: h } = img;

    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const data = ctx.getImageData(0, 0, w, h).data;

    function isDark(x, y) {
      const i = (y * w + x) * 4;
      return data[i] < threshold && data[i+1] < threshold && data[i+2] < threshold;
    }

    function isRowDark(y) {
      for (let x = 0; x < w; x++) if (!isDark(x, y)) return false;
      return true;
    }
    function isColDark(x) {
      for (let y = 0; y < h; y++) if (!isDark(x, y)) return false;
      return true;
    }

    let top = 0;
    let bottom = h - 1;
    let left = 0;
    let right = w - 1;

    while (top < h && isRowDark(top)) {
      top++;
      if (top % 64 === 0) await yieldToBrowser();
    }
    while (bottom > top && isRowDark(bottom)) {
      bottom--;
      if (bottom % 64 === 0) await yieldToBrowser();
    }
    while (left < w && isColDark(left)) {
      left++;
      if (left % 64 === 0) await yieldToBrowser();
    }
    while (right > left && isColDark(right)) {
      right--;
      if (right % 64 === 0) await yieldToBrowser();
    }

    // Add 2px padding
    top = Math.max(0, top - 2);
    bottom = Math.min(h - 1, bottom + 2);
    left = Math.max(0, left - 2);
    right = Math.min(w - 1, right + 2);

    const nw = right - left + 1;
    const nh = bottom - top + 1;

    if (nw <= 0 || nh <= 0 || (nw === w && nh === h)) return blob; // nothing to crop

    const cropped = makeCanvas(nw, nh);
    const cCtx = cropped.getContext('2d');
    cCtx.drawImage(c, left, top, nw, nh, 0, 0, nw, nh);

    return canvasToBlob(cropped, 'image/jpeg', quality);
  }

  /**
   * Generate a small thumbnail blob from an image blob
   * @param {Blob} blob
   * @param {number} maxSize - max dimension in px
   * @returns {Promise<string>} - data URL
   */
  async function makeThumbnailDataURL(blob, maxSize = 120) {
    const img = await loadImage(blob);
    const { naturalWidth: w, naturalHeight: h } = img;

    const scale = Math.min(1, maxSize / w, maxSize / h);
    const tw = Math.round(w * scale);
    const th = Math.round(h * scale);

    const c = makeCanvas(tw, th);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, tw, th);

    return c.toDataURL('image/jpeg', 0.75);
  }

  /**
   * Detect duplicate images by computing an exact content hash
   * Returns a string hash
   */
  async function computeHash(blob) {
    const buffer = await blob.arrayBuffer();

    if (globalThis.crypto?.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      return `${blob.type}:${blob.size}:${bufferToHex(digest)}`;
    }

    // Fallback for browsers without SubtleCrypto support.
    const bytes = new Uint8Array(buffer);
    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 16777619);
    }
    return `${blob.type}:${blob.size}:${(hash >>> 0).toString(16)}`;
  }

  function bufferToHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  /** Convert canvas to Blob */
  function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.9) {
    return new Promise((res, rej) => {
      canvas.toBlob(b => {
        if (b) res(b);
        else rej(new Error('Canvas toBlob failed'));
      }, type, quality);
    });
  }

  /** Format bytes to human-readable */
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  function yieldToBrowser() {
    return new Promise(resolve => requestAnimationFrame(resolve));
  }

  return {
    loadImage,
    getDimensions,
    compress,
    applyTransform,
    cropBlackBorders,
    makeThumbnailDataURL,
    computeHash,
    canvasToBlob,
    formatBytes,
  };
})();
