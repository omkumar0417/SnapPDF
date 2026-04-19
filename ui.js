/**
 * ui.js — UI Layer
 * Manages all DOM interactions, thumbnail rendering, drag-and-drop reorder,
 * preview panel, toasts, modals, zoom, and keyboard shortcuts
 */

const UI = (() => {

  // ---- TOAST NOTIFICATIONS ----

  const toastContainer = document.getElementById('toast-container');

  function toast(message, type = 'info', duration = 3500) {
    const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${message}</span>`;
    toastContainer.appendChild(el);

    setTimeout(() => {
      el.classList.add('out');
      el.addEventListener('animationend', () => el.remove());
    }, duration);
  }

  // ---- MODAL ----

  function showModal(title, body, onConfirm, confirmLabel = 'Confirm', isDanger = true) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').textContent = body;
    document.getElementById('modal-confirm').textContent = confirmLabel;
    document.getElementById('modal-confirm').className = isDanger ? 'btn btn-danger' : 'btn btn-primary';
    document.getElementById('modal-overlay').classList.remove('hidden');

    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn = document.getElementById('modal-cancel');

    const cleanup = () => {
      document.getElementById('modal-overlay').classList.add('hidden');
      confirmBtn.replaceWith(confirmBtn.cloneNode(true));
      cancelBtn.replaceWith(cancelBtn.cloneNode(true));
      // Re-bind cancel
      document.getElementById('modal-cancel').addEventListener('click', () =>
        document.getElementById('modal-overlay').classList.add('hidden'));
    };

    document.getElementById('modal-confirm').addEventListener('click', () => {
      cleanup(); onConfirm();
    });
  }

  // Init cancel
  document.getElementById('modal-cancel').addEventListener('click', () =>
    document.getElementById('modal-overlay').classList.add('hidden'));

  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay'))
      document.getElementById('modal-overlay').classList.add('hidden');
  });

  // ---- THUMBNAIL LIST ----

  let _dragSrc = null;
  let _onReorder = null;
  let _onDelete = null;
  let _onSelect = null;
  let _onThumbnailVisible = null;
  let _thumbnailObserver = null;
  let _currentPreviewURL = null;

  function setThumbnailCallbacks({ onReorder, onDelete, onSelect, onThumbnailVisible }) {
    _onReorder = onReorder;
    _onDelete = onDelete;
    _onSelect = onSelect;
    _onThumbnailVisible = onThumbnailVisible;
  }

  function getThumbnailObserver() {
    if (_thumbnailObserver || typeof IntersectionObserver === 'undefined') return _thumbnailObserver;
    _thumbnailObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const id = entry.target.dataset.id;
        if (id && _onThumbnailVisible) _onThumbnailVisible(id);
      });
    }, {
      root: document.getElementById('thumbnail-list'),
      rootMargin: '200px 0px',
      threshold: 0.01,
    });
    return _thumbnailObserver;
  }

  /**
   * Render the full thumbnail list
   * @param {Array} images - sorted array of image records
   * @param {string|null} activeId - currently selected image id
   */
  function renderThumbnails(images, activeId) {
    const list = document.getElementById('thumbnail-list');

    // Diff-render: update existing, add new, remove old
    const existingIds = new Set([...list.children].map(el => el.dataset.id));
    const newIds = new Set(images.map(img => img.id));

    // Remove items no longer in list
    [...list.children].forEach(el => {
      if (!newIds.has(el.dataset.id)) {
        _thumbnailObserver?.unobserve(el);
        el.remove();
      }
    });

    images.forEach((img, idx) => {
      let item = list.querySelector(`[data-id="${img.id}"]`);

      if (!item) {
        item = createThumbnailElement(img);
        list.appendChild(item);
      }

      // Update order number
      item.querySelector('.thumb-num').textContent = idx + 1;
      item.classList.toggle('active', img.id === activeId);

      // Update thumbnail if it has a cached dataURL
      if (img._thumbDataURL) {
        const imgEl = item.querySelector('img');
        if (imgEl.dataset.src !== img._thumbDataURL) {
          imgEl.dataset.src = img._thumbDataURL;
          imgEl.src = img._thumbDataURL;
          imgEl.classList.remove('loading');
        }
      } else {
        const imgEl = item.querySelector('img');
        imgEl.dataset.src = '';
        imgEl.removeAttribute('src');
        imgEl.classList.add('loading');
      }

      // Ensure correct DOM position
      const currentIndex = [...list.children].indexOf(item);
      if (currentIndex !== idx) {
        list.insertBefore(item, list.children[idx] || null);
      }
    });
  }

  function createThumbnailElement(img) {
    const item = document.createElement('div');
    item.className = 'thumbnail-item';
    item.dataset.id = img.id;
    item.draggable = true;
    item.innerHTML = `
      <span class="thumb-drag-handle" title="Drag to reorder">
        <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
          <circle cx="3" cy="3" r="1.2" fill="currentColor"/>
          <circle cx="7" cy="3" r="1.2" fill="currentColor"/>
          <circle cx="3" cy="7" r="1.2" fill="currentColor"/>
          <circle cx="7" cy="7" r="1.2" fill="currentColor"/>
          <circle cx="3" cy="11" r="1.2" fill="currentColor"/>
          <circle cx="7" cy="11" r="1.2" fill="currentColor"/>
        </svg>
      </span>
      <span class="thumb-num">?</span>
      <div class="thumb-img-wrap">
        <img class="loading" src="" alt="Page" loading="lazy" />
      </div>
      <div class="thumb-info">
        <div class="thumb-name">${escapeHTML(img.name || 'image')}</div>
        <div class="thumb-size">${ImageProcessor.formatBytes(img.size || 0)}</div>
      </div>
      <button class="thumb-delete-btn" title="Delete page" aria-label="Delete">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;

    const observer = getThumbnailObserver();
    if (observer) observer.observe(item);
    else if (_onThumbnailVisible) _onThumbnailVisible(img.id);

    // Click to select
    item.addEventListener('click', (e) => {
      if (!e.target.closest('.thumb-delete-btn') && !e.target.closest('.thumb-drag-handle')) {
        _onSelect && _onSelect(img.id);
      }
    });

    // Delete
    item.querySelector('.thumb-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      _onDelete && _onDelete(img.id);
    });

    // --- DRAG & DROP REORDER ---
    item.addEventListener('dragstart', (e) => {
      _dragSrc = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', img.id);
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      _dragSrc = null;
      document.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!_dragSrc || _dragSrc === item) return;
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      item.classList.remove('drag-over-top', 'drag-over-bottom');
      item.classList.add(e.clientY < midY ? 'drag-over-top' : 'drag-over-bottom');
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!_dragSrc || _dragSrc === item) return;
      const list = document.getElementById('thumbnail-list');
      const rect = item.getBoundingClientRect();
      const insertBefore = e.clientY < rect.top + rect.height / 2;

      if (insertBefore) {
        list.insertBefore(_dragSrc, item);
      } else {
        list.insertBefore(_dragSrc, item.nextSibling);
      }

      item.classList.remove('drag-over-top', 'drag-over-bottom');
      _dragSrc = null;

      // Notify app of new order
      const newOrder = [...list.children].map(el => el.dataset.id);
      _onReorder && _onReorder(newOrder);
    });

    return item;
  }

  // ---- PREVIEW PANEL ----

  let _currentZoom = 1.0;
  const MIN_ZOOM = 0.2, MAX_ZOOM = 4.0;

  function showPreview(record) {
    if (!record?.blob) {
      return;
    }

    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('preview-panel').classList.remove('hidden');

    const img = document.getElementById('preview-img');
    if (_currentPreviewURL) {
      URL.revokeObjectURL(_currentPreviewURL);
      _currentPreviewURL = null;
    }
    const url = URL.createObjectURL(record.blob);
    _currentPreviewURL = url;
    img.onload = () => {
      if (_currentPreviewURL === url) {
        URL.revokeObjectURL(url);
        _currentPreviewURL = null;
      }
      updateImageTransform(record);
      updateInfoBar(record);
    };
    img.onerror = () => {
      if (_currentPreviewURL === url) {
        URL.revokeObjectURL(url);
        _currentPreviewURL = null;
      }
    };
    img.src = url;
  }

  function updateImageTransform(record) {
    const img = document.getElementById('preview-img');
    const { rotation = 0, flipH = false, flipV = false } = record;
    let transform = `rotate(${rotation}deg)`;
    if (flipH) transform += ' scaleX(-1)';
    if (flipV) transform += ' scaleY(-1)';
    img.style.transform = transform;
  }

  function updateInfoBar(record) {
    const info = document.getElementById('preview-img-info');
    const { w = 0, h = 0, size = 0, name = '' } = record;
    info.textContent = `${w}×${h}px · ${ImageProcessor.formatBytes(size)} · ${escapeHTML(name)}`;
  }

  function setZoom(z) {
    _currentZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const canvas = document.getElementById('preview-canvas');
    canvas.style.transform = `scale(${_currentZoom})`;
    canvas.style.transformOrigin = 'center center';
    document.getElementById('zoom-level').textContent = `${Math.round(_currentZoom * 100)}%`;
  }

  function getZoom() { return _currentZoom; }

  function fitZoom() {
    const wrap = document.getElementById('preview-canvas-wrap');
    const canvas = document.getElementById('preview-canvas');
    const img = document.getElementById('preview-img');
    if (!img.naturalWidth) return;

    const availW = wrap.clientWidth - 48;
    const availH = wrap.clientHeight - 48;
    const scaleW = availW / canvas.offsetWidth;
    const scaleH = availH / canvas.offsetHeight;
    setZoom(Math.min(scaleW, scaleH, 1));
  }

  function updatePageIndicator(current, total) {
    document.getElementById('preview-page-input').value = current;
    document.getElementById('preview-page-total').textContent = `/ ${total}`;
  }

  function updatePageCount(n) {
    document.getElementById('page-count').textContent = n;
  }

  // ---- RESTORE BANNER ----

  function showRestoreBanner(count) {
    document.getElementById('restore-count').textContent = `${count} image${count !== 1 ? 's' : ''} from your last session`;
    document.getElementById('restore-banner').classList.remove('hidden');
  }

  function hideRestoreBanner() {
    document.getElementById('restore-banner').classList.add('hidden');
  }

  // ---- SETTINGS PANEL HELPERS ----

  function getPDFSettings() {
    const pageSize = document.querySelector('.toggle-btn.active[data-val="a4"], .toggle-btn.active[data-val="letter"]')?.dataset.val || 'a4';
    const orientation = document.querySelector('#orient-landscape.active') ? 'landscape' : 'portrait';

    return {
      filename: document.getElementById('pdf-filename').value.trim() || 'screenshots',
      pageSize,
      orientation,
      fitMode: document.getElementById('fit-mode').value,
      margins: {
        top: parseFloat(document.getElementById('margin-top').value) || 10,
        right: parseFloat(document.getElementById('margin-right').value) || 10,
        bottom: parseFloat(document.getElementById('margin-bottom').value) || 10,
        left: parseFloat(document.getElementById('margin-left').value) || 10,
      },
      showPageNumbers: document.getElementById('toggle-page-numbers').checked,
      showHeaderFooter: document.getElementById('toggle-header-footer').checked,
      headerText: document.getElementById('header-text').value,
      footerText: document.getElementById('footer-text').value,
      compress: document.getElementById('toggle-compress').checked,
      quality: parseFloat(document.getElementById('compress-quality').value) / 100,
      pageRange: document.getElementById('page-range').value.trim(),
    };
  }

  function setGenerating(isGenerating) {
    const progressEl = document.getElementById('generate-progress');
    const btn1 = document.getElementById('btn-generate-pdf');
    const btn2 = document.getElementById('btn-generate-pdf-2');

    if (isGenerating) {
      progressEl.classList.remove('hidden');
      btn1.classList.add('loading'); btn1.disabled = true;
      btn2.classList.add('loading'); btn2.disabled = true;
    } else {
      progressEl.classList.add('hidden');
      btn1.classList.remove('loading'); btn1.disabled = false;
      btn2.classList.remove('loading'); btn2.disabled = false;
    }
  }

  function setProgress(pct, label) {
    document.getElementById('progress-bar-fill').style.width = `${pct}%`;
    document.getElementById('progress-label').textContent = label;
  }

  // ---- SIDEBAR COLLAPSE ----

  function setSidebarCollapsed(collapsed) {
    const sidebar = document.getElementById('sidebar');
    const expandBtn = document.getElementById('btn-expand-sidebar');
    if (collapsed) {
      sidebar.style.width = '0';
      sidebar.style.overflow = 'hidden';
      expandBtn.classList.remove('hidden');
    } else {
      sidebar.style.width = '';
      sidebar.style.overflow = '';
      expandBtn.classList.add('hidden');
    }
  }

  // ---- UPLOAD ZONE DRAG HIGHLIGHT ----

  function setUploadDragActive(active) {
    document.getElementById('upload-zone-inner').classList.toggle('drag-active', active);
  }

  function setGlobalDragOverlay(visible) {
    document.getElementById('drag-overlay').classList.toggle('hidden', !visible);
  }

  // ---- THEME ----

  function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    document.querySelector('.icon-moon').classList.toggle('hidden', !isDark);
    document.querySelector('.icon-sun').classList.toggle('hidden', isDark);
    localStorage.setItem('snappdf_theme', isDark ? 'light' : 'dark');
  }

  function applyStoredTheme() {
    const stored = localStorage.getItem('snappdf_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', stored);
    if (stored === 'light') {
      document.querySelector('.icon-moon').classList.add('hidden');
      document.querySelector('.icon-sun').classList.remove('hidden');
    }
  }

  // ---- UNDO/REDO BUTTONS ----

  function setUndoRedoState(canUndo, canRedo) {
    document.getElementById('btn-undo').disabled = !canUndo;
    document.getElementById('btn-redo').disabled = !canRedo;
  }

  // ---- HELPERS ----

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    toast,
    showModal,
    renderThumbnails,
    setThumbnailCallbacks,
    showPreview,
    updateImageTransform,
    updateInfoBar,
    setZoom,
    getZoom,
    fitZoom,
    updatePageIndicator,
    updatePageCount,
    showRestoreBanner,
    hideRestoreBanner,
    getPDFSettings,
    setGenerating,
    setProgress,
    setSidebarCollapsed,
    setUploadDragActive,
    setGlobalDragOverlay,
    toggleTheme,
    applyStoredTheme,
    setUndoRedoState,
    escapeHTML,
  };
})();
