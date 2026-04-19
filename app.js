/**
 * app.js — Main Application Controller
 * Orchestrates DB, UI, ImageProcessor, and PDFGenerator
 * Manages state: images array, selection, undo/redo stack
 */

(async () => {
  'use strict';

  let images = [];
  let selectedId = null;
  let isGenerating = false;
  let storageAvailable = true;
  let knownHashes = new Set();
  const thumbnailJobs = new Map();
  const thumbnailTouch = new Map();

  const MAX_STORAGE_DIMENSION = 2560;
  const MAX_IN_MEMORY_THUMBNAILS = 80;
  const THUMBNAIL_GENERATION_BATCH = 6;

  const HISTORY_LIMIT = 50;
  let undoStack = [];
  let redoStack = [];

  async function init() {
    UI.applyStoredTheme();
    bindEvents();

    try {
      await DB.open();

      const savedName = await DB.getMeta('projectName');
      if (savedName) document.getElementById('project-name').value = savedName;

      const savedSettings = await DB.getMeta('pdfSettings');
      if (savedSettings) applyPDFSettings(savedSettings);

      const hist = await DB.loadHistory();
      undoStack = hist.undo || [];
      redoStack = hist.redo || [];
      ensureHistoryArrays();
      updateUndoRedoUI();

      const count = await DB.countImages();
      if (count > 0) {
        await restoreSession(false);
      }
    } catch (err) {
      storageAvailable = false;
      console.error('Storage unavailable:', err);
      undoStack = [];
      redoStack = [];
      updateUndoRedoUI();
      UI.toast('Storage unavailable', 'error', 6000);
    }
  }

  function sortImagesInPlace() {
    images.sort((a, b) => a.order - b.order);
  }

  function snapshotRecord(record) {
    return record ? DB.sanitizeImageRecord({ ...record }) : record;
  }

  function snapshotRecords(records) {
    return records.map(record => snapshotRecord(record));
  }

  function updateKnownHashes() {
    knownHashes = new Set(images.map(img => img.hash).filter(Boolean));
  }

  function getUserFacingErrorMessage(err, fallback = 'Operation failed') {
    if (DB.isQuotaError?.(err)) {
      return 'Storage full. Try reducing image size or clearing project';
    }
    return err?.message || fallback;
  }

  function validateImageRecord(record) {
    return DB.isValidImageRecord ? DB.isValidImageRecord(record) : !!(record?.id && record?.blob);
  }

  function markThumbnailUsed(id) {
    thumbnailTouch.set(id, Date.now());
  }

  function trimThumbnailCache() {
    const cached = images.filter(img => img._thumbDataURL);
    if (cached.length <= MAX_IN_MEMORY_THUMBNAILS) return;

    cached
      .filter(img => img.id !== selectedId)
      .sort((a, b) => (thumbnailTouch.get(a.id) || 0) - (thumbnailTouch.get(b.id) || 0))
      .slice(0, cached.length - MAX_IN_MEMORY_THUMBNAILS)
      .forEach(img => {
        delete img._thumbDataURL;
        thumbnailTouch.delete(img.id);
      });
  }

  function yieldToMainThread() {
    return new Promise(resolve => requestAnimationFrame(resolve));
  }

  function ensureHistoryArrays() {
    if (!Array.isArray(undoStack)) undoStack = [];
    if (!Array.isArray(redoStack)) redoStack = [];
  }

  async function persistHistory() {
    if (!storageAvailable) return;
    ensureHistoryArrays();
    await DB.saveHistory(undoStack, redoStack);
  }

  function updateUndoRedoUI() {
    UI.setUndoRedoState(storageAvailable && undoStack.length > 0, storageAvailable && redoStack.length > 0);
  }

  async function recordHistory(entry) {
    if (!storageAvailable) return;
    ensureHistoryArrays();
    undoStack.push(entry);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    await persistHistory();
    updateUndoRedoUI();
  }

  async function ensureThumbnail(img, { force = false } = {}) {
    if (!img?.blob) return;
    if (!force && img._thumbDataURL) {
      markThumbnailUsed(img.id);
      return;
    }
    if (thumbnailJobs.has(img.id)) {
      return thumbnailJobs.get(img.id);
    }

    const job = (async () => {
      try {
        const transformed = await ImageProcessor.applyTransform(img.blob, img);
        img._thumbDataURL = await ImageProcessor.makeThumbnailDataURL(transformed);
        markThumbnailUsed(img.id);
        trimThumbnailCache();
      } catch (err) {
        console.error('Thumbnail generation failed:', err);
      } finally {
        thumbnailJobs.delete(img.id);
      }
    })();

    thumbnailJobs.set(img.id, job);
    return job;
  }

  async function hydrateVisibleThumbnails(records) {
    for (let i = 0; i < records.length; i += THUMBNAIL_GENERATION_BATCH) {
      const batch = records.slice(i, i + THUMBNAIL_GENERATION_BATCH);
      await Promise.all(batch.map(img => ensureThumbnail(img)));
      renderThumbnailsOnly();
      await yieldToMainThread();
    }
  }

  function scheduleBackgroundThumbnailHydration() {
    const run = async () => {
      const remaining = images.filter(img => !img._thumbDataURL).slice(0, THUMBNAIL_GENERATION_BATCH);
      if (remaining.length === 0) return;
      await hydrateVisibleThumbnails(remaining);
      scheduleBackgroundThumbnailHydration();
    };

    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => run(), { timeout: 300 });
    } else {
      window.setTimeout(() => { run(); }, 80);
    }
  }

  async function ensureThumbnailById(id) {
    const img = images.find(record => record.id === id);
    if (!img) return;
    await ensureThumbnail(img);
    renderThumbnailsOnly();
  }

  function sanitizeLoadedImages(records) {
    const valid = [];
    let skipped = 0;

    for (const record of records) {
      if (validateImageRecord(record)) valid.push(record);
      else skipped++;
    }

    if (skipped > 0) {
      UI.toast(`Skipped ${skipped} corrupted record${skipped !== 1 ? 's' : ''}`, 'warning', 5000);
    }

    return valid;
  }

  async function restoreSession(showToast = true) {
    if (!storageAvailable) return;
    try {
      const dbImages = await DB.getAllImages();
      images = sanitizeLoadedImages(dbImages);
      sortImagesInPlace();
      updateKnownHashes();
      renderAll();

      if (images.length > 0) {
        await hydrateVisibleThumbnails(images.slice(0, Math.min(images.length, THUMBNAIL_GENERATION_BATCH)));
        selectImage(selectedId && images.some(img => img.id === selectedId) ? selectedId : images[0].id);
        scheduleBackgroundThumbnailHydration();
      } else {
        selectImage(null);
      }

      if (showToast && images.length > 0) {
        UI.toast(`Restored ${images.length} page${images.length !== 1 ? 's' : ''}`, 'success');
      }
    } catch (err) {
      console.error('Restore failed:', err);
      UI.toast(getUserFacingErrorMessage(err, 'Restore failed'), 'error');
    }
  }

  async function discardSession() {
    if (!storageAvailable) return;
    try {
      await DB.replaceProjectData({
        images: [],
        meta: {},
        undoStack: [],
        redoStack: [],
      });

      images = [];
      selectedId = null;
      knownHashes.clear();
      undoStack = [];
      redoStack = [];
      updateUndoRedoUI();
      renderAll();
    } catch (err) {
      UI.toast(getUserFacingErrorMessage(err, 'Discard failed'), 'error');
    }
  }

  async function addImages(files) {
    const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];
    const selectedFiles = Array.from(files || []);
    const toAdd = selectedFiles.filter(f => validTypes.includes(f.type) || f.name.match(/\.(png|jpg|jpeg|webp|gif|bmp)$/i));

    if (toAdd.length === 0) {
      UI.toast('No valid images found (PNG, JPG, WEBP, GIF supported)', 'warning');
      return;
    }

    if (!storageAvailable) {
      UI.toast('Storage unavailable', 'error');
      return;
    }

    const addedRecords = [];
    let skippedCount = 0;
    let failedCount = 0;
    const settings = UI.getPDFSettings();
    const baseOrder = images.length;

    for (let index = 0; index < toAdd.length; index++) {
      const file = toAdd[index];
      try {
        const preparedBlob = settings.compress
          ? await ImageProcessor.compress(file, {
            maxWidth: MAX_STORAGE_DIMENSION,
            maxHeight: MAX_STORAGE_DIMENSION,
            quality: settings.quality,
            format: file.type === 'image/png' ? 'image/png' : 'image/jpeg',
          })
          : file;

        const hash = await ImageProcessor.computeHash(preparedBlob);
        if (knownHashes.has(hash)) {
          skippedCount++;
          continue;
        }

        const dims = await ImageProcessor.getDimensions(preparedBlob);
        const record = {
          id: DB.generateId(),
          blob: preparedBlob,
          name: file.name,
          size: preparedBlob.size,
          w: dims.width,
          h: dims.height,
          rotation: 0,
          flipH: false,
          flipV: false,
          hash,
          addedAt: Date.now(),
          order: baseOrder + addedRecords.length + 1,
        };

        await DB.saveImage(record);
        images.push(record);
        knownHashes.add(hash);
        addedRecords.push(snapshotRecord(record));
      } catch (err) {
        console.error('Failed to add image:', file.name, err);
        failedCount++;
        UI.toast(`Failed to add ${file.name}: ${getUserFacingErrorMessage(err)}`, 'error');
        if (DB.isQuotaError?.(err)) break;
      }

      if ((index + 1) % THUMBNAIL_GENERATION_BATCH === 0) {
        renderAll();
        await yieldToMainThread();
      }
    }

    if (addedRecords.length > 0) {
      sortImagesInPlace();
      renderAll();
      await ensureThumbnail(images[images.length - 1]);
      selectImage(images[images.length - 1].id);
      scheduleBackgroundThumbnailHydration();
      const list = document.getElementById('thumbnail-list');
      list.scrollTop = list.scrollHeight;

      try {
        await recordHistory({ type: 'add', records: addedRecords });
      } catch (err) {
        console.error('Failed to save add history:', err);
        UI.toast('Images were added, but undo history for this batch could not be saved', 'warning', 5000);
      }

      UI.toast(`Added ${addedRecords.length} page${addedRecords.length !== 1 ? 's' : ''}`, 'success');
    }

    if (skippedCount > 0) {
      UI.toast(`${skippedCount} duplicate${skippedCount !== 1 ? 's' : ''} skipped`, 'warning');
    }

    if (failedCount > 0) {
      UI.toast(`${failedCount} file${failedCount !== 1 ? 's' : ''} failed to upload`, 'warning');
    }

    await saveSettings();
  }

  async function deleteImage(id) {
    if (!storageAvailable) return;

    const idx = images.findIndex(img => img.id === id);
    if (idx === -1) return;
    try {
      const [removed] = images.splice(idx, 1);
      await DB.deleteImage(id);
      updateKnownHashes();
      images.forEach((img, index) => { img.order = index + 1; });
      await DB.batchUpdateOrder(images.map(img => ({ id: img.id, order: img.order })));
      await recordHistory({ type: 'delete', records: [snapshotRecord(removed)] });

      if (selectedId === id) {
        const next = images[idx] || images[idx - 1] || null;
        selectImage(next ? next.id : null);
      }

      renderAll();
      UI.toast('Page deleted', 'info');
    } catch (err) {
      UI.toast(getUserFacingErrorMessage(err, 'Delete failed'), 'error');
    }
  }

  async function clearAll() {
    if (!storageAvailable) return;
    try {
      const removedRecords = snapshotRecords(images);
      images = [];
      selectedId = null;
      knownHashes.clear();
      await DB.clearImages();
      await recordHistory({ type: 'clear', records: removedRecords });
      renderAll();
      UI.toast('All pages cleared', 'info');
    } catch (err) {
      UI.toast(getUserFacingErrorMessage(err, 'Clear failed'), 'error');
    }
  }

  async function reorderImages(newIdOrder, saveHistory = true) {
    if (!storageAvailable) return;

    const dedupedOrder = [...new Set(newIdOrder)].filter(id => images.some(img => img.id === id));
    if (dedupedOrder.length !== images.length) {
      UI.toast('Reorder cancelled due to inconsistent drag state', 'warning');
      renderAll();
      return;
    }

    const beforeOrder = images.map(img => img.id);
    const map = new Map(images.map(img => [img.id, img]));
    images = dedupedOrder.map((id, idx) => {
      const img = map.get(id);
      if (!img) return null;
      img.order = idx + 1;
      return img;
    }).filter(Boolean);

    await DB.batchUpdateOrder(images.map(img => ({ id: img.id, order: img.order })));

    if (saveHistory) {
      await recordHistory({ type: 'reorder', beforeOrder, afterOrder: [...dedupedOrder] });
    }

    renderAll();
  }

  async function rotateImage(id, delta) {
    if (!storageAvailable) return;

    const img = images.find(i => i.id === id);
    if (!img) return;

    const before = { id: img.id, rotation: img.rotation, flipH: img.flipH, flipV: img.flipV };
    img.rotation = ((img.rotation || 0) + delta + 360) % 360;
    await DB.saveImage(img);
    await ensureThumbnail(img, { force: true });
    await recordHistory({
      type: 'transform',
      before: [before],
      after: [{ id: img.id, rotation: img.rotation, flipH: img.flipH, flipV: img.flipV }],
    });
    UI.updateImageTransform(img);
    renderAll();
  }

  async function flipImage(id, axis) {
    if (!storageAvailable) return;

    const img = images.find(i => i.id === id);
    if (!img) return;

    const before = { id: img.id, rotation: img.rotation, flipH: img.flipH, flipV: img.flipV };
    if (axis === 'h') img.flipH = !img.flipH;
    else img.flipV = !img.flipV;

    await DB.saveImage(img);
    await ensureThumbnail(img, { force: true });
    await recordHistory({
      type: 'transform',
      before: [before],
      after: [{ id: img.id, rotation: img.rotation, flipH: img.flipH, flipV: img.flipV }],
    });
    UI.updateImageTransform(img);
    renderAll();
  }

  async function autoCropBlack(id) {
    if (!storageAvailable) return;

    const img = images.find(i => i.id === id);
    if (!img) return;

    UI.toast('Cropping black borders…', 'info', 1500);

    try {
      const before = snapshotRecord(img);
      const newBlob = await ImageProcessor.cropBlackBorders(img.blob, 20);
      const dims = await ImageProcessor.getDimensions(newBlob);

      img.blob = newBlob;
      img.size = newBlob.size;
      img.w = dims.width;
      img.h = dims.height;
      delete img._thumbDataURL;
      await ensureThumbnail(img, { force: true });

      await DB.saveImage(img);
      await recordHistory({
        type: 'replace-record',
        before: [before],
        after: [snapshotRecord(img)],
      });

      UI.showPreview(img);
      renderAll();
      UI.toast('Black borders removed', 'success');
    } catch (err) {
      console.error('Crop failed:', err);
      UI.toast('Crop failed: ' + err.message, 'error');
    }
  }

  function selectImage(id) {
    selectedId = id;
    const img = images.find(i => i.id === id);

    if (img) {
      ensureThumbnail(img);
      UI.showPreview(img);
      const idx = images.indexOf(img);
      UI.updatePageIndicator(idx + 1, images.length);
      const thumbEl = document.querySelector(`[data-id="${id}"]`);
      if (thumbEl) thumbEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      document.getElementById('empty-state').classList.toggle('hidden', images.length > 0);
      if (images.length === 0) {
        document.getElementById('preview-panel').classList.add('hidden');
      }
    }

    renderThumbnailsOnly();
  }

  async function moveImage(id, direction) {
    const idx = images.findIndex(i => i.id === id);
    if (idx === -1) return;

    let newIdx;
    if (direction === 'up' && idx > 0) newIdx = idx - 1;
    else if (direction === 'down' && idx < images.length - 1) newIdx = idx + 1;
    else if (direction === 'top') newIdx = 0;
    else if (direction === 'bottom') newIdx = images.length - 1;
    else return;

    const newOrder = images.map(img => img.id);
    const [moved] = newOrder.splice(idx, 1);
    newOrder.splice(newIdx, 0, moved);
    await reorderImages(newOrder, true);
    selectImage(id);
  }

  async function applyOrder(idOrder) {
    const safeOrder = [...new Set(idOrder)].filter(id => images.some(img => img.id === id));
    if (safeOrder.length !== images.length) return;
    const map = new Map(images.map(img => [img.id, img]));
    images = safeOrder.map((id, idx) => {
      const img = map.get(id);
      if (!img) return null;
      img.order = idx + 1;
      return img;
    }).filter(Boolean);

    await DB.batchUpdateOrder(images.map(img => ({ id: img.id, order: img.order })));
    renderAll();
  }

  async function replaceRecordVersion(record) {
    const index = images.findIndex(img => img.id === record.id);
    const restored = { ...record };

    if (index === -1) {
      images.push(restored);
    } else {
      images[index] = restored;
    }

    sortImagesInPlace();
    await DB.saveImage(restored);
    await ensureThumbnail(restored, { force: true });
    updateKnownHashes();
    renderAll();
  }

  async function applyTransformState(states) {
    for (const state of states) {
      const img = images.find(item => item.id === state.id);
      if (!img) continue;
      img.rotation = state.rotation;
      img.flipH = state.flipH;
      img.flipV = state.flipV;
      await DB.saveImage(img);
      await ensureThumbnail(img, { force: true });
      if (selectedId === img.id) UI.updateImageTransform(img);
    }
    renderAll();
  }

  async function applyHistoryEntry(entry, direction) {
    switch (entry.type) {
      case 'add': {
        if (direction === 'undo') {
          for (const record of entry.records) {
            images = images.filter(img => img.id !== record.id);
            await DB.deleteImage(record.id);
          }
        } else {
          await DB.saveImages(entry.records);
          for (const record of entry.records) {
            const restored = { ...record };
            images.push(restored);
          }
        }
        sortImagesInPlace();
        break;
      }
      case 'delete': {
        if (direction === 'undo') {
          await DB.saveImages(entry.records);
          for (const record of entry.records) {
            const restored = { ...record };
            images.push(restored);
          }
          sortImagesInPlace();
          await DB.batchUpdateOrder(images.map((img, index) => ({ id: img.id, order: index + 1 })));
          images.forEach((img, index) => { img.order = index + 1; });
        } else {
          for (const record of entry.records) {
            images = images.filter(img => img.id !== record.id);
            await DB.deleteImage(record.id);
          }
          images.forEach((img, index) => { img.order = index + 1; });
          await DB.batchUpdateOrder(images.map(img => ({ id: img.id, order: img.order })));
        }
        break;
      }
      case 'clear': {
        if (direction === 'undo') {
          await DB.saveImages(entry.records);
          images = [];
          for (const record of entry.records) {
            const restored = { ...record };
            images.push(restored);
          }
          sortImagesInPlace();
        } else {
          images = [];
          await DB.clearImages();
        }
        break;
      }
      case 'reorder': {
        await applyOrder(direction === 'undo' ? entry.beforeOrder : entry.afterOrder);
        break;
      }
      case 'transform': {
        await applyTransformState(direction === 'undo' ? entry.before : entry.after);
        break;
      }
      case 'replace-record': {
        const records = direction === 'undo' ? entry.before : entry.after;
        for (const record of records) {
          await replaceRecordVersion(record);
        }
        break;
      }
      default:
        break;
    }

    updateKnownHashes();

    if (selectedId && !images.some(img => img.id === selectedId)) {
      selectedId = images[0]?.id || null;
    }

    renderAll();
    if (selectedId) selectImage(selectedId);
    else selectImage(images[0]?.id || null);
  }

  async function undo() {
    if (!storageAvailable || undoStack.length === 0) return;

    const entry = undoStack.pop();
    redoStack.push(entry);
    await applyHistoryEntry(entry, 'undo');
    await persistHistory();
    updateUndoRedoUI();
    UI.toast('Undone', 'info', 1500);
  }

  async function redo() {
    if (!storageAvailable || redoStack.length === 0) return;

    const entry = redoStack.pop();
    undoStack.push(entry);
    await applyHistoryEntry(entry, 'redo');
    await persistHistory();
    updateUndoRedoUI();
    UI.toast('Redone', 'info', 1500);
  }

  function renderAll() {
    UI.renderThumbnails(images, selectedId);
    UI.updatePageCount(images.length);
    const idx = images.findIndex(i => i.id === selectedId);
    if (idx !== -1) UI.updatePageIndicator(idx + 1, images.length);

    if (images.length === 0) {
      document.getElementById('empty-state').classList.remove('hidden');
      document.getElementById('preview-panel').classList.add('hidden');
    } else {
      document.getElementById('empty-state').classList.add('hidden');
      document.getElementById('preview-panel').classList.remove('hidden');
    }
  }

  function renderThumbnailsOnly() {
    UI.renderThumbnails(images, selectedId);
    UI.updatePageCount(images.length);
    const idx = images.findIndex(i => i.id === selectedId);
    if (idx !== -1) UI.updatePageIndicator(idx + 1, images.length);
  }

  async function generatePDF() {
    if (isGenerating) return;
    if (images.length === 0) {
      UI.toast('Add at least one image first', 'warning');
      return;
    }

    isGenerating = true;
    UI.setGenerating(true);

    try {
      const settings = UI.getPDFSettings();
      const withBlobs = await Promise.all(images.map(async img => {
        if (img.blob) return img;
        const dbRecord = await DB.getImage(img.id);
        return { ...img, ...(dbRecord || {}) };
      }));

      await PDFGenerator.generate(
        withBlobs,
        settings,
        (pct, msg) => UI.setProgress(pct, msg)
      );

      UI.toast('PDF exported successfully!', 'success');
    } catch (err) {
      console.error('PDF generation error:', err);
      UI.toast('PDF generation failed: ' + getUserFacingErrorMessage(err), 'error');
    } finally {
      isGenerating = false;
      UI.setGenerating(false);
    }
  }

  async function saveSettings() {
    if (!storageAvailable) return;
    const name = document.getElementById('project-name').value;
    await DB.setMeta('projectName', name);
    await DB.setMeta('pdfSettings', UI.getPDFSettings());
  }

  function applyPDFSettings(s) {
    if (!s) return;
    if (s.filename) document.getElementById('pdf-filename').value = s.filename;
    if (s.fitMode) document.getElementById('fit-mode').value = s.fitMode;
    if (s.margins) {
      document.getElementById('margin-top').value = s.margins.top ?? 10;
      document.getElementById('margin-right').value = s.margins.right ?? 10;
      document.getElementById('margin-bottom').value = s.margins.bottom ?? 10;
      document.getElementById('margin-left').value = s.margins.left ?? 10;
    }
    if (typeof s.showPageNumbers === 'boolean') {
      document.getElementById('toggle-page-numbers').checked = s.showPageNumbers;
    }
    if (typeof s.showHeaderFooter === 'boolean') {
      document.getElementById('toggle-header-footer').checked = s.showHeaderFooter;
      document.getElementById('hf-fields').classList.toggle('hidden', !s.showHeaderFooter);
    }
    if (typeof s.compress === 'boolean') {
      document.getElementById('toggle-compress').checked = s.compress;
    }
    document.getElementById('header-text').value = s.headerText ?? '';
    document.getElementById('footer-text').value = s.footerText ?? '';
    document.getElementById('page-range').value = s.pageRange ?? '';
    if (s.quality) {
      const q = Math.round(s.quality * 100);
      document.getElementById('compress-quality').value = q;
      document.getElementById('quality-val').textContent = q;
    }
    if (s.pageSize) {
      document.querySelectorAll('.toggle-btn[data-val="a4"], .toggle-btn[data-val="letter"]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.val === s.pageSize);
      });
    }
    if (s.orientation) {
      const isLandscape = s.orientation === 'landscape';
      document.getElementById('orient-landscape').classList.toggle('active', isLandscape);
      document.getElementById('orient-portrait').classList.toggle('active', !isLandscape);
    }
  }

  async function exportProjectJSON() {
    if (images.length === 0) {
      UI.toast('No images to export', 'warning');
      return;
    }
    UI.toast('Preparing export…', 'info', 2000);
    try {
      const name = document.getElementById('project-name').value;
      const settings = UI.getPDFSettings();
      const json = await DB.exportProjectJSON(name, settings);
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name || 'project'}.snappdf.json`;
      a.click();
      URL.revokeObjectURL(url);
      UI.toast('Project exported', 'success');
    } catch (err) {
      UI.toast('Export failed: ' + getUserFacingErrorMessage(err), 'error');
    }
  }

  async function importProjectJSON(file) {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (!json.images || !Array.isArray(json.images)) throw new Error('Invalid project file');

      UI.showModal(
        'Import Project',
        `This will replace your current session with "${json.projectName || 'imported project'}" (${json.images.length} pages). Continue?`,
        async () => {
          try {
            UI.toast('Importing…', 'info', 2000);
            await DB.importProjectJSON(json);
            undoStack = [];
            redoStack = [];
            updateUndoRedoUI();
            await restoreSession(false);
            if (json.projectName) document.getElementById('project-name').value = json.projectName;
            if (json.pdfSettings) applyPDFSettings(json.pdfSettings);
            UI.toast('Project imported', 'success');
          } catch (err) {
            console.error('Import failed:', err);
            UI.toast('Import failed: ' + getUserFacingErrorMessage(err), 'error');
          }
        },
        'Import',
        false
      );
    } catch (err) {
      UI.toast('Import failed: ' + getUserFacingErrorMessage(err), 'error');
    }
  }

  function bindEvents() {
    UI.setThumbnailCallbacks({
      onReorder: reorderImages,
      onDelete: id => UI.showModal(
        'Delete Page',
        'Remove this page from the project?',
        () => deleteImage(id)
      ),
      onSelect: selectImage,
      onThumbnailVisible: ensureThumbnailById,
    });

    const fileInput = document.getElementById('file-input');
    document.getElementById('btn-pick-files').addEventListener('click', () => fileInput.click());
    document.getElementById('btn-empty-pick').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      if (e.target.files.length) addImages(e.target.files);
      e.target.value = '';
    });

    document.getElementById('upload-zone-inner').addEventListener('click', () => fileInput.click());
    document.getElementById('upload-zone-inner').addEventListener('dragover', e => {
      e.preventDefault();
      UI.setUploadDragActive(true);
    });
    document.getElementById('upload-zone-inner').addEventListener('dragleave', () => UI.setUploadDragActive(false));
    document.getElementById('upload-zone-inner').addEventListener('drop', e => {
      e.preventDefault();
      UI.setUploadDragActive(false);
      if (e.dataTransfer.files.length) addImages(e.dataTransfer.files);
    });

    let dragCounter = 0;
    window.addEventListener('dragenter', e => {
      if ([...e.dataTransfer.types].includes('Files')) {
        dragCounter++;
        UI.setGlobalDragOverlay(true);
      }
    });
    window.addEventListener('dragleave', () => {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        UI.setGlobalDragOverlay(false);
      }
    });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      dragCounter = 0;
      UI.setGlobalDragOverlay(false);
      if (e.dataTransfer.files.length) addImages(e.dataTransfer.files);
    });

    const onGeneratePDF = () => generatePDF();
    document.getElementById('btn-generate-pdf').addEventListener('click', onGeneratePDF);
    document.getElementById('btn-generate-pdf-2').addEventListener('click', onGeneratePDF);

    document.getElementById('btn-clear-all').addEventListener('click', () => {
      if (images.length === 0) return;
      UI.showModal('Clear All', `Remove all ${images.length} pages? This can be undone.`, clearAll);
    });

    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);
    document.getElementById('btn-theme').addEventListener('click', UI.toggleTheme);

    document.getElementById('btn-collapse-sidebar').addEventListener('click', () => UI.setSidebarCollapsed(true));
    document.getElementById('btn-expand-sidebar').addEventListener('click', () => UI.setSidebarCollapsed(false));

    document.getElementById('btn-prev-page').addEventListener('click', () => {
      const idx = images.findIndex(i => i.id === selectedId);
      if (idx > 0) selectImage(images[idx - 1].id);
    });
    document.getElementById('btn-next-page').addEventListener('click', () => {
      const idx = images.findIndex(i => i.id === selectedId);
      if (idx < images.length - 1) selectImage(images[idx + 1].id);
    });

    document.getElementById('preview-page-input').addEventListener('change', e => {
      const n = parseInt(e.target.value, 10);
      if (!isNaN(n) && n >= 1 && n <= images.length) selectImage(images[n - 1].id);
    });

    document.getElementById('btn-rotate-ccw').addEventListener('click', () => {
      if (selectedId) rotateImage(selectedId, -90);
    });
    document.getElementById('btn-rotate-cw').addEventListener('click', () => {
      if (selectedId) rotateImage(selectedId, 90);
    });
    document.getElementById('btn-flip-h').addEventListener('click', () => {
      if (selectedId) flipImage(selectedId, 'h');
    });
    document.getElementById('btn-flip-v').addEventListener('click', () => {
      if (selectedId) flipImage(selectedId, 'v');
    });
    document.getElementById('btn-crop-black').addEventListener('click', () => {
      if (selectedId) autoCropBlack(selectedId);
    });

    document.getElementById('btn-zoom-in').addEventListener('click', () => UI.setZoom(UI.getZoom() * 1.25));
    document.getElementById('btn-zoom-out').addEventListener('click', () => UI.setZoom(UI.getZoom() / 1.25));
    document.getElementById('btn-zoom-fit').addEventListener('click', () => UI.fitZoom());

    document.getElementById('btn-move-top').addEventListener('click', () => {
      if (selectedId) moveImage(selectedId, 'top');
    });
    document.getElementById('btn-move-up').addEventListener('click', () => {
      if (selectedId) moveImage(selectedId, 'up');
    });
    document.getElementById('btn-move-down').addEventListener('click', () => {
      if (selectedId) moveImage(selectedId, 'down');
    });
    document.getElementById('btn-move-bottom').addEventListener('click', () => {
      if (selectedId) moveImage(selectedId, 'bottom');
    });
    document.getElementById('btn-delete-current').addEventListener('click', () => {
      if (!selectedId) return;
      UI.showModal('Delete Page', 'Remove this page from the project?', () => deleteImage(selectedId));
    });

    document.querySelectorAll('.toggle-btn[data-val="a4"], .toggle-btn[data-val="letter"]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.toggle-btn[data-val="a4"], .toggle-btn[data-val="letter"]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        saveSettings();
      });
    });

    document.getElementById('orient-landscape').addEventListener('click', () => {
      document.getElementById('orient-landscape').classList.add('active');
      document.getElementById('orient-portrait').classList.remove('active');
      saveSettings();
    });
    document.getElementById('orient-portrait').addEventListener('click', () => {
      document.getElementById('orient-portrait').classList.add('active');
      document.getElementById('orient-landscape').classList.remove('active');
      saveSettings();
    });

    document.getElementById('toggle-header-footer').addEventListener('change', e => {
      document.getElementById('hf-fields').classList.toggle('hidden', !e.target.checked);
      saveSettings();
    });

    document.getElementById('compress-quality').addEventListener('input', e => {
      document.getElementById('quality-val').textContent = e.target.value;
    });
    document.getElementById('compress-quality').addEventListener('change', () => saveSettings());

    ['pdf-filename', 'fit-mode', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'toggle-page-numbers', 'toggle-compress', 'header-text', 'footer-text', 'page-range',
      'project-name'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => saveSettings());
    });

    document.getElementById('project-name').addEventListener('input', () => {
      clearTimeout(window._nameTimer);
      window._nameTimer = setTimeout(saveSettings, 800);
    });

    document.getElementById('btn-export-json').addEventListener('click', exportProjectJSON);
    document.getElementById('import-json-input').addEventListener('change', e => {
      if (e.target.files[0]) {
        importProjectJSON(e.target.files[0]);
        e.target.value = '';
      }
    });

    document.addEventListener('keydown', e => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key === 'z') { e.preventDefault(); undo(); }
      else if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); }
      else if (ctrl && e.key === 'o') { e.preventDefault(); fileInput.click(); }
      else if (ctrl && e.key === 'p') { e.preventDefault(); generatePDF(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        const idx = images.findIndex(i => i.id === selectedId);
        if (idx > 0) selectImage(images[idx - 1].id);
      }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        const idx = images.findIndex(i => i.id === selectedId);
        if (idx < images.length - 1) selectImage(images[idx + 1].id);
      }
      else if (e.key === 'Delete' && selectedId) {
        UI.showModal('Delete Page', 'Remove this page?', () => deleteImage(selectedId));
      }
      else if (e.key === 'r' && selectedId) {
        e.shiftKey ? rotateImage(selectedId, 90) : rotateImage(selectedId, -90);
      }
      else if (e.key === '+' || e.key === '=') UI.setZoom(UI.getZoom() * 1.25);
      else if (e.key === '-') UI.setZoom(UI.getZoom() / 1.25);
      else if (e.key === '0') UI.setZoom(1);
      else if (e.key === 'f') UI.fitZoom();
    });

    document.getElementById('preview-canvas-wrap').addEventListener('wheel', e => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      UI.setZoom(UI.getZoom() * delta);
    }, { passive: false });

    document.getElementById('orient-landscape').classList.add('active');

    document.getElementById('btn-restore')?.addEventListener('click', () => restoreSession());
    document.getElementById('btn-discard')?.addEventListener('click', discardSession);
  }

  await init();
})();
