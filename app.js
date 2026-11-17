import { HalationEngine, DEFAULT_PARAMS, PRESETS } from './halation-engine.js';
import {
  extractImageMetadata,
  processExportBlobMetadata,
  getExactExportFilename,
} from './metadata-utils.js';
import {
  saveUploadedImageToCache,
  loadUploadedImageFromCache,
  saveStudioStateToCache,
  loadStudioStateFromCache,
} from './session-cache.js';

const BUILTIN_SAMPLES = {
  example1: {
    id: 'example1',
    title: 'Example 1: Night Kiosk',
    filename: 'example1-input.png',
    inputUrl: './assets/examples/example1-input.png',
    expectedUrl: './assets/examples/example1-expected.png',
  },
  example2: {
    id: 'example2',
    title: 'Example 2: Streetlamp',
    filename: 'example2-input.png',
    inputUrl: './assets/examples/example2-input.png',
    expectedUrl: './assets/examples/example2-expected.png',
  },
};

export class HalationStudioApp {
  constructor() {
    this.params = { ...DEFAULT_PARAMS };
    this.activePresetKey = 'reference800T';
    this.currentSampleKey = 'example1';
    this.currentFilename = 'example1-input';
    this.originalFileName = 'example1-input.png';
    this.originalMime = 'image/png';
    this.currentMetadata = null;

    // Last exported artifact references (used by UI & automated tests)
    this.lastExportedBlob = null;
    this.lastExportedFilename = null;

    // Full-resolution source image (never downscaled for export)
    this.fullResImage = null;
    this.expectedRefUrl = BUILTIN_SAMPLES.example1.expectedUrl;
    this.inputDataUrl = BUILTIN_SAMPLES.example1.inputUrl;

    // View & comparison state
    this.viewMode = 'split-input'; // 'single' | 'split-input' | 'split-expected'
    this.splitPercent = 50;
    this.isHoldingOriginal = false;

    // Zoom & pan state
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;

    // Export format state
    this.exportMime = 'image/png';
    this.exportExt = 'png';

    // DOM elements
    this.canvas = document.getElementById('render-canvas');
    this.engine = new HalationEngine(this.canvas);

    this.stage = document.getElementById('canvas-stage');
    this.transformWrap = document.getElementById('stage-transform-wrap');
    this.compareOverlay = document.getElementById('comparison-overlay');
    this.compareImg = document.getElementById('compare-img');
    this.splitDivider = document.getElementById('split-divider');
    this.badgeLeft = document.getElementById('split-badge-left');
    this.badgeRight = document.getElementById('split-badge-right');

    this._initPresetsUI();
    this._bindControls();
    this._bindSplitCurtain();
    this._bindZoomAndPan();
    this._bindFileUploadAndDrop();
    this._bindMobileTabs();

    // Restore cached session / uploaded image or fall back to Example 1
    this.readyPromise = this._restoreSessionOrDefault();
  }

  async _restoreSessionOrDefault() {
    try {
      const [savedState, cachedImage] = await Promise.all([
        loadStudioStateFromCache(),
        loadUploadedImageFromCache(),
      ]);

      // If a cached uploaded image exists, populate the custom photo chip so user can switch to it anytime
      if (cachedImage && cachedImage.name) {
        this._cachedCustomImage = cachedImage;
        const customChip = document.getElementById('custom-photo-chip');
        if (customChip) {
          customChip.style.display = 'inline-flex';
          document.getElementById('custom-photo-name').textContent =
            cachedImage.name.length > 20
              ? cachedImage.name.slice(0, 18) + '…'
              : cachedImage.name;
        }
      }

      if (savedState) {
        if (savedState.params && typeof savedState.params === 'object') {
          this.params = { ...DEFAULT_PARAMS, ...savedState.params };
        }
        this.activePresetKey =
          savedState.activePresetKey !== undefined
            ? savedState.activePresetKey
            : 'reference800T';
        if (savedState.exportMime && savedState.exportExt) {
          this.exportMime = savedState.exportMime;
          this.exportExt = savedState.exportExt;
        }
        if (typeof savedState.splitPercent === 'number') {
          this.splitPercent = savedState.splitPercent;
        }
        if (savedState.viewMode) {
          this.viewMode = savedState.viewMode;
        }

        this._syncControlsFromParams();
        this._syncPresetHighlight();
        this._syncExportFormatUI();

        if (savedState.currentSampleKey === 'custom' && cachedImage?.file) {
          await this.loadUserFile(cachedImage.file, {
            fromCache: true,
            preserveExportFormat: true,
            preserveViewMode: true,
          });
          return;
        }

        const sampleKey = BUILTIN_SAMPLES[savedState.currentSampleKey]
          ? savedState.currentSampleKey
          : 'example1';
        await this.loadBuiltinSample(sampleKey, {
          skipPersist: true,
          preserveViewMode: true,
        });
        return;
      }
    } catch (err) {
      console.warn('Session cache restore skipped:', err);
    }

    await this.loadBuiltinSample('example1', { skipPersist: true });
  }

  async _persistState() {
    await saveStudioStateToCache({
      params: { ...this.params },
      activePresetKey: this.activePresetKey,
      currentSampleKey: this.currentSampleKey,
      viewMode: this.viewMode,
      splitPercent: this.splitPercent,
      exportMime: this.exportMime,
      exportExt: this.exportExt,
      originalFileName: this.originalFileName,
      originalMime: this.originalMime,
    });
  }

  _initPresetsUI() {
    const grid = document.getElementById('preset-grid');
    grid.innerHTML = '';

    for (const [key, preset] of Object.entries(PRESETS)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `preset-card ${key === this.activePresetKey ? 'active' : ''}`;
      btn.dataset.preset = key;
      btn.title = preset.description;
      btn.innerHTML = `
        <div class="preset-card-top">
          <span class="preset-name">${preset.name}</span>
          <span class="preset-badge">${preset.badge}</span>
        </div>
      `;
      btn.addEventListener('click', () => this.applyPreset(key));
      grid.appendChild(btn);
    }
  }

  _syncPresetHighlight() {
    document.querySelectorAll('.preset-card').forEach((card) => {
      card.classList.toggle('active', card.dataset.preset === this.activePresetKey);
    });
  }

  applyPreset(presetKey, { resetMetadataToggle = false } = {}) {
    const preset = PRESETS[presetKey];
    if (!preset) return;

    this.activePresetKey = presetKey;
    const keepStrip = resetMetadataToggle ? false : Boolean(this.params.stripMetadata);
    this.params = { ...DEFAULT_PARAMS, ...preset.params, stripMetadata: keepStrip };

    this._syncPresetHighlight();
    this._syncControlsFromParams();
    this._updateMetadataStatusUI();
    this.requestRender();
    this._persistState();
    this.showToast(`Applied "${preset.name}" profile`);
  }

  _syncControlsFromParams() {
    // Sync range sliders
    document.querySelectorAll('.range-slider[data-param]').forEach((slider) => {
      const param = slider.dataset.param;
      const unit = slider.dataset.unit || '';
      const val = this.params[param];
      if (val !== undefined) {
        slider.value = val;
        this._updateSliderVisual(slider, val, unit);
      }
    });

    // Sync slide toggles
    document.querySelectorAll('.switch-input[data-toggle]').forEach((toggle) => {
      const key = toggle.dataset.toggle;
      if (this.params[key] !== undefined) {
        toggle.checked = Boolean(this.params[key]);
      }
    });

    // Update dependent slider enabled/disabled states
    this._updateDependentGroups();
    this._updateMetadataStatusUI();
  }

  _updateSliderVisual(slider, val, unit) {
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 100;
    const pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
    slider.style.setProperty('--fill-pct', `${pct.toFixed(1)}%`);

    const valSpan = document.getElementById(`val-${slider.dataset.param}`);
    if (valSpan) {
      valSpan.textContent = `${val}${unit}`;
    }
  }

  _updateDependentGroups() {
    const masterOn = Boolean(this.params.enabled);
    const depMap = {
      pointBoost: masterOn && Boolean(this.params.pointBoostEnabled),
      edgeGate: masterOn && Boolean(this.params.edgeGateEnabled),
      bloom: masterOn && Boolean(this.params.bloomEnabled),
      grain: masterOn && Boolean(this.params.grainEnabled),
    };

    for (const [param, active] of Object.entries(depMap)) {
      const group = document.getElementById(`group-${param}`);
      if (group) group.classList.toggle('disabled', !active);
    }

    const primaryParams = ['strength', 'radius', 'threshold', 'softness', 'warmth', 'redSensitivity'];
    for (const param of primaryParams) {
      const group = document.getElementById(`group-${param}`);
      if (group) group.classList.toggle('disabled', !masterOn);
    }
  }

  _syncExportFormatUI() {
    document.querySelectorAll('.format-option').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.format === this.exportMime);
    });
    const fmtName = this.exportExt.toUpperCase();
    const qualityNote = this.exportExt === 'png' ? 'Lossless PNG' : `Max-Quality ${fmtName}`;
    const labelEl = document.getElementById('export-btn-label');
    if (labelEl) {
      labelEl.textContent = `Download Full-Resolution ${qualityNote}`;
    }
    this._updateMetadataStatusUI();
  }

  _setExportFormat(mime, ext) {
    this.exportMime = mime;
    this.exportExt = ext;
    this._syncExportFormatUI();
  }

  _updateMetadataStatusUI() {
    const badge = document.getElementById('metadata-status-badge');
    const filePreview = document.getElementById('export-filename-preview');
    const outName = getExactExportFilename(
      this.originalFileName,
      this.originalMime,
      this.exportMime,
      this.exportExt
    );

    if (filePreview) {
      filePreview.textContent = outName;
      filePreview.title = `Export filename: ${outName}`;
    }

    if (!badge) return;

    if (this.params.stripMetadata) {
      badge.textContent = 'Metadata Stripped';
      badge.className = 'metadata-badge stripped';
    } else {
      const tags = this.currentMetadata?.tagsSummary?.length
        ? ` (${this.currentMetadata.tagsSummary.join('•')})`
        : '';
      badge.textContent = `Metadata Preserved${tags}`;
      badge.className = 'metadata-badge preserved';
    }
  }

  _bindControls() {
    // Range sliders
    document.querySelectorAll('.range-slider[data-param]').forEach((slider) => {
      const param = slider.dataset.param;
      const unit = slider.dataset.unit || '';

      this._updateSliderVisual(slider, this.params[param], unit);

      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        this.params[param] = val;
        this._updateSliderVisual(slider, val, unit);
        this._clearActivePresetHighlight();
        this.requestRender();
        this._persistState();
      });

      // Double-click any slider to reset it to its default value
      slider.addEventListener('dblclick', () => {
        const defVal = DEFAULT_PARAMS[param];
        this.params[param] = defVal;
        slider.value = defVal;
        this._updateSliderVisual(slider, defVal, unit);
        this.requestRender();
        this._persistState();
      });
    });

    // Slide Toggles (checkboxes)
    document.querySelectorAll('.switch-input[data-toggle]').forEach((toggle) => {
      const key = toggle.dataset.toggle;
      toggle.addEventListener('change', () => {
        this.params[key] = toggle.checked;
        this._updateDependentGroups();
        this._updateMetadataStatusUI();
        if (key !== 'stripMetadata') {
          this.requestRender();
        } else {
          this.showToast(
            toggle.checked
              ? 'Metadata will be stripped on export'
              : 'Original image metadata & title will be preserved on export'
          );
        }
        this._persistState();
      });
    });

    // Sample Switcher Buttons
    document.getElementById('sample-btn-1').addEventListener('click', () => {
      this.loadBuiltinSample('example1');
    });
    document.getElementById('sample-btn-2').addEventListener('click', () => {
      this.loadBuiltinSample('example2');
    });

    const customChip = document.getElementById('custom-photo-chip');
    if (customChip) {
      customChip.addEventListener('click', async () => {
        if (this.currentSampleKey === 'custom') return;
        const cached = this._cachedCustomImage || (await loadUploadedImageFromCache());
        if (cached && cached.file) {
          await this.loadUserFile(cached.file, { fromCache: true });
        }
      });
    }

    // Comparison View Mode Buttons
    document.querySelectorAll('.compare-mode-group .mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setViewMode(btn.dataset.mode);
      });
    });

    // Hold Original Button + Spacebar shortcut
    const holdBtn = document.getElementById('hold-compare-btn');
    const startHold = () => {
      if (this.isHoldingOriginal) return;
      this.isHoldingOriginal = true;
      this.engine.render({ ...this.params, enabled: false, soloHalation: false });
      this.badgeRight.textContent = 'Original (Bypassed)';
    };
    const endHold = () => {
      if (!this.isHoldingOriginal) return;
      this.isHoldingOriginal = false;
      this.requestRender();
      this.badgeRight.textContent = this.params.soloHalation ? 'Solo Halation Map' : 'Halation Studio';
    };

    holdBtn.addEventListener('mousedown', startHold);
    holdBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      startHold();
    });
    window.addEventListener('mouseup', endHold);
    window.addEventListener('touchend', endHold);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'BUTTON') {
        e.preventDefault();
        startHold();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        endHold();
      }
    });

    // Reset All Button
    document.getElementById('reset-all-btn').addEventListener('click', () => {
      this.applyPreset('reference800T', { resetMetadataToggle: true });
      this.resetZoom();
    });

    // Export Format Selector
    document.querySelectorAll('.format-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._setExportFormat(btn.dataset.format, btn.dataset.ext);
        this._persistState();
      });
    });

    // Export Trigger Buttons
    document.getElementById('export-btn').addEventListener('click', () => this.exportPhoto());
    document.getElementById('header-export-btn').addEventListener('click', () => this.exportPhoto());
  }

  _clearActivePresetHighlight() {
    this.activePresetKey = null;
    this._syncPresetHighlight();
  }

  setViewMode(mode) {
    if (mode === 'split-expected' && !this.expectedRefUrl) {
      this.showToast('Reference target is only available on the built-in test examples');
      return;
    }

    this.viewMode = mode;
    document.querySelectorAll('.compare-mode-group .mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    this._updateComparisonOverlay();
    this._persistState();
  }

  _updateComparisonOverlay() {
    if (this.viewMode === 'single') {
      this.compareOverlay.classList.add('hidden');
      this.splitDivider.classList.add('hidden');
      this.badgeLeft.style.display = 'none';
      this.badgeRight.textContent = this.params.soloHalation ? 'Solo Halation Map' : 'Halation Studio';
      return;
    }

    this.compareOverlay.classList.remove('hidden');
    this.splitDivider.classList.remove('hidden');
    this.badgeLeft.style.display = '';

    if (this.viewMode === 'split-expected' && this.expectedRefUrl) {
      this.compareImg.src = this.expectedRefUrl;
      this.badgeLeft.textContent = 'Expected Target';
    } else {
      this.compareImg.src = this.inputDataUrl;
      this.badgeLeft.textContent = 'Original Input';
    }

    this._applySplitPosition(this.splitPercent);
  }

  _applySplitPosition(percent) {
    this.splitPercent = Math.max(2, Math.min(98, percent));
    this.splitDivider.style.left = `${this.splitPercent}%`;
    this.splitDivider.setAttribute('aria-valuenow', Math.round(this.splitPercent));
    // Clip the comparison overlay to the left side of the split divider
    this.compareOverlay.style.clipPath = `inset(0 ${100 - this.splitPercent}% 0 0)`;
  }

  _bindSplitCurtain() {
    let draggingSplit = false;

    const updateFromClientX = (clientX) => {
      const rect = this.transformWrap.getBoundingClientRect();
      if (!rect.width) return;
      const relX = ((clientX - rect.left) / rect.width) * 100;
      this._applySplitPosition(relX);
    };

    this.splitDivider.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      draggingSplit = true;
    });

    this.splitDivider.addEventListener(
      'touchstart',
      (e) => {
        e.stopPropagation();
        draggingSplit = true;
      },
      { passive: true }
    );

    window.addEventListener('mousemove', (e) => {
      if (!draggingSplit) return;
      updateFromClientX(e.clientX);
    });

    window.addEventListener(
      'touchmove',
      (e) => {
        if (!draggingSplit || !e.touches[0]) return;
        updateFromClientX(e.touches[0].clientX);
      },
      { passive: true }
    );

    window.addEventListener('mouseup', () => {
      if (draggingSplit) {
        draggingSplit = false;
        this._persistState();
      }
    });
    window.addEventListener('touchend', () => {
      if (draggingSplit) {
        draggingSplit = false;
        this._persistState();
      }
    });

    // Keyboard accessibility on split handle
    this.splitDivider.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this._applySplitPosition(this.splitPercent - 3);
        this._persistState();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this._applySplitPosition(this.splitPercent + 3);
        this._persistState();
      }
    });
  }

  _bindZoomAndPan() {
    let panning = false;
    let startX = 0;
    let startY = 0;

    const applyTransform = () => {
      this.transformWrap.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
      document.getElementById('zoom-reset-btn').textContent = `${Math.round(this.zoom * 100)}%`;
    };

    this.resetZoom = () => {
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      applyTransform();
    };

    const setZoom = (newZoom) => {
      this.zoom = Math.max(0.5, Math.min(4.0, newZoom));
      if (this.zoom === 1) {
        this.panX = 0;
        this.panY = 0;
      }
      applyTransform();
    };

    document.getElementById('zoom-in-btn').addEventListener('click', () => setZoom(this.zoom + 0.25));
    document.getElementById('zoom-out-btn').addEventListener('click', () => setZoom(this.zoom - 0.25));
    document.getElementById('zoom-reset-btn').addEventListener('click', () => this.resetZoom());

    this.stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.15 : -0.15;
        setZoom(this.zoom + delta);
      },
      { passive: false }
    );

    this.stage.addEventListener('mousedown', (e) => {
      if (e.target.closest('#split-divider')) return;
      if (this.zoom <= 1) return;
      panning = true;
      startX = e.clientX - this.panX;
      startY = e.clientY - this.panY;
      this.stage.classList.add('dragging-pan');
    });

    window.addEventListener('mousemove', (e) => {
      if (!panning) return;
      this.panX = e.clientX - startX;
      this.panY = e.clientY - startY;
      applyTransform();
    });

    window.addEventListener('mouseup', () => {
      panning = false;
      this.stage.classList.remove('dragging-pan');
    });
  }

  _bindFileUploadAndDrop() {
    const fileInput = document.getElementById('file-input');
    const uploadBtn = document.getElementById('upload-photo-btn');
    const dropOverlay = document.getElementById('dropzone-overlay');

    uploadBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) this.loadUserFile(file);
      fileInput.value = '';
    });

    // Drag & Drop support
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropOverlay.classList.add('visible');
    });

    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) {
        dropOverlay.classList.remove('visible');
      }
    });

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dropOverlay.classList.remove('visible');
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) {
        this.loadUserFile(file);
      }
    });

    // Clipboard Paste support
    window.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) this.loadUserFile(file);
          break;
        }
      }
    });
  }

  _bindMobileTabs() {
    const tabBtns = document.querySelectorAll('.mobile-tab-btn');
    const sections = document.querySelectorAll('.control-section[data-mobile-tab]');

    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tabTarget;
        tabBtns.forEach((b) => b.classList.toggle('active', b === btn));
        sections.forEach((sec) => {
          sec.classList.toggle('mobile-active', sec.dataset.mobileTab === target);
        });
      });
    });
  }

  async loadBuiltinSample(sampleKey, { skipPersist = false, preserveViewMode = false } = {}) {
    const sample = BUILTIN_SAMPLES[sampleKey];
    if (!sample) return;

    this.currentSampleKey = sampleKey;
    this.currentFilename = sample.filename.replace(/\.[^/.]+$/, '');
    this.originalFileName = sample.filename;
    this.originalMime = 'image/png';
    this.expectedRefUrl = sample.expectedUrl;
    this.inputDataUrl = sample.inputUrl;

    document.getElementById('sample-btn-1').classList.toggle('active', sampleKey === 'example1');
    document.getElementById('sample-btn-2').classList.toggle('active', sampleKey === 'example2');

    const customChip = document.getElementById('custom-photo-chip');
    if (customChip) {
      customChip.classList.remove('active');
      if (!this._cachedCustomImage) {
        customChip.style.display = 'none';
      }
    }

    document.getElementById('view-mode-ref').style.display = '';

    // Extract metadata from the built-in sample file if available
    try {
      const resp = await fetch(sample.inputUrl);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        this.currentMetadata = extractImageMetadata(
          new Uint8Array(buf),
          'image/png',
          sample.filename
        );
      }
    } catch (_) {
      this.currentMetadata = extractImageMetadata(new Uint8Array(0), 'image/png', sample.filename);
    }

    if (preserveViewMode) {
      document.querySelectorAll('.compare-mode-group .mode-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === this.viewMode);
      });
    }

    this._updateMetadataStatusUI();
    await this._setImageFromUrl(sample.inputUrl);

    if (!skipPersist) {
      await this._persistState();
    }
  }

  async loadUserFile(
    file,
    { fromCache = false, preserveExportFormat = false, preserveViewMode = false } = {}
  ) {
    const rawBytes = new Uint8Array(await file.arrayBuffer());
    const metadata = extractImageMetadata(rawBytes, file.type, file.name);
    const detectedMime =
      metadata.format !== 'unknown' ? metadata.format : file.type || 'image/png';

    this.currentMetadata = metadata;
    this.originalFileName = file.name || 'photo.png';
    this.originalMime = detectedMime;

    const cleanName = this.originalFileName.replace(/\.[^/.]+$/, '') || 'photo';
    this.currentSampleKey = 'custom';
    this.currentFilename = cleanName;
    this.expectedRefUrl = null;

    // Auto-select matching export format so export preserves exact upload format & filename by default
    if (!preserveExportFormat) {
      if (detectedMime === 'image/jpeg') {
        this._setExportFormat('image/jpeg', 'jpg');
      } else if (detectedMime === 'image/webp') {
        this._setExportFormat('image/webp', 'webp');
      } else {
        this._setExportFormat('image/png', 'png');
      }
    }

    const blob = new Blob([rawBytes], { type: detectedMime });
    if (this._customObjectUrl) {
      URL.revokeObjectURL(this._customObjectUrl);
    }
    const objectUrl = URL.createObjectURL(blob);
    this._customObjectUrl = objectUrl;
    this.inputDataUrl = objectUrl;

    document.getElementById('sample-btn-1').classList.remove('active');
    document.getElementById('sample-btn-2').classList.remove('active');

    const customChip = document.getElementById('custom-photo-chip');
    customChip.style.display = 'inline-flex';
    customChip.classList.add('active');
    document.getElementById('custom-photo-name').textContent =
      this.originalFileName.length > 20
        ? this.originalFileName.slice(0, 18) + '…'
        : this.originalFileName;

    // Hide "Split vs Expected" when user loads their own photo
    document.getElementById('view-mode-ref').style.display = 'none';
    if (this.viewMode === 'split-expected' || !preserveViewMode) {
      if (this.viewMode === 'split-expected') {
        this.viewMode = 'split-input';
      }
      document.querySelectorAll('.compare-mode-group .mode-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === this.viewMode);
      });
    }

    this._cachedCustomImage = {
      name: this.originalFileName,
      type: detectedMime,
      lastModified: file.lastModified || Date.now(),
      bytes: rawBytes,
      file: new File([rawBytes], this.originalFileName, {
        type: detectedMime,
        lastModified: file.lastModified || Date.now(),
      }),
    };

    if (!fromCache) {
      await saveUploadedImageToCache(file, rawBytes);
    }

    this._updateMetadataStatusUI();
    await this._setImageFromUrl(objectUrl);
    await this._persistState();

    const metaNote = metadata.tagsSummary.length
      ? ` • ${metadata.tagsSummary.join('+')} metadata detected`
      : '';
    this.showToast(
      `${fromCache ? 'Restored' : 'Loaded'} "${this.originalFileName}" (${this.fullResImage.naturalWidth} × ${this.fullResImage.naturalHeight} px${metaNote})`
    );
  }

  async _setImageFromUrl(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });

    this.fullResImage = img;
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;

    // For ultra-fast 60fps interactive preview on huge >2400px images, cap interactive preview FBO at 2048px
    // while keeping fullResImage intact for 1:1 native lossless export!
    const maxPreviewDim = 2048;
    let prevW = natW;
    let prevH = natH;
    if (Math.max(natW, natH) > maxPreviewDim) {
      const s = maxPreviewDim / Math.max(natW, natH);
      prevW = Math.round(natW * s);
      prevH = Math.round(natH * s);
    }

    this.engine.setImage(img, prevW, prevH);
    this.resetZoom();
    this._updateResolutionHUD(natW, natH);
    this._updateComparisonOverlay();
    this.requestRender();
  }

  _updateResolutionHUD(w, h) {
    const mp = ((w * h) / 1e6).toFixed(1);
    document.getElementById('hud-dimensions').innerHTML = `<strong>${w} × ${h}</strong> px (${mp} MP)`;
    document.getElementById('export-res-label').textContent = `${w} × ${h} px`;
  }

  requestRender() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => {
      this.engine.render(this.params);
      this.badgeRight.textContent = this.params.soloHalation ? 'Solo Halation Map' : 'Halation Studio';
    });
  }

  async exportPhoto() {
    if (!this.fullResImage) return null;

    const exportBtn = document.getElementById('export-btn');
    const labelSpan = document.getElementById('export-btn-label');
    const prevText = labelSpan.textContent;

    try {
      exportBtn.disabled = true;
      labelSpan.textContent = `Rendering Native ${this.fullResImage.naturalWidth}×${this.fullResImage.naturalHeight}…`;

      const rawBlob = await this.engine.exportFullResolution(
        this.fullResImage,
        this.params,
        this.exportMime,
        1.0
      );

      const stripMeta = Boolean(this.params.stripMetadata);
      const finalBlob = await processExportBlobMetadata(
        rawBlob,
        this.currentMetadata,
        stripMeta
      );

      const outFilename = getExactExportFilename(
        this.originalFileName,
        this.originalMime,
        this.exportMime,
        this.exportExt
      );

      this.lastExportedBlob = finalBlob;
      this.lastExportedFilename = outFilename;

      const url = URL.createObjectURL(finalBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      const sizeMB = (finalBlob.size / (1024 * 1024)).toFixed(2);
      const metaStatus = stripMeta ? 'metadata stripped' : 'metadata preserved';
      this.showToast(
        `Exported ${outFilename} (${this.fullResImage.naturalWidth}×${this.fullResImage.naturalHeight} px, ${sizeMB} MB, ${metaStatus})`
      );
      return { blob: finalBlob, filename: outFilename };
    } catch (err) {
      console.error('Export failed:', err);
      this.showToast('Export error: ' + err.message);
      return null;
    } finally {
      exportBtn.disabled = false;
      labelSpan.textContent = prevText;
    }
  }

  showToast(message) {
    const toast = document.getElementById('toast-banner');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2800);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.halationStudio = new HalationStudioApp();
});
