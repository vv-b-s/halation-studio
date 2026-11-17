import { HalationEngine, DEFAULT_PARAMS, PRESETS } from './halation-engine.js';

const BUILTIN_SAMPLES = {
  example1: {
    id: 'example1',
    title: 'Example 1: Night Kiosk',
    filename: 'night-kiosk',
    inputUrl: './assets/examples/example1-input.png',
    expectedUrl: './assets/examples/example1-expected.png',
  },
  example2: {
    id: 'example2',
    title: 'Example 2: Streetlamp',
    filename: 'cobblestone-streetlamp',
    inputUrl: './assets/examples/example2-input.png',
    expectedUrl: './assets/examples/example2-expected.png',
  },
};

class HalationStudioApp {
  constructor() {
    this.params = { ...DEFAULT_PARAMS };
    this.activePresetKey = 'reference800T';
    this.currentSampleKey = 'example1';
    this.currentFilename = 'night-kiosk';

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

    // Load Example 1 on startup
    this.loadBuiltinSample('example1');
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

  applyPreset(presetKey) {
    const preset = PRESETS[presetKey];
    if (!preset) return;

    this.activePresetKey = presetKey;
    this.params = { ...preset.params };

    document.querySelectorAll('.preset-card').forEach((card) => {
      card.classList.toggle('active', card.dataset.preset === presetKey);
    });

    this._syncControlsFromParams();
    this.requestRender();
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
      });

      // Double-click any slider to reset it to its default value
      slider.addEventListener('dblclick', () => {
        const defVal = DEFAULT_PARAMS[param];
        this.params[param] = defVal;
        slider.value = defVal;
        this._updateSliderVisual(slider, defVal, unit);
        this.requestRender();
      });
    });

    // Slide Toggles (checkboxes)
    document.querySelectorAll('.switch-input[data-toggle]').forEach((toggle) => {
      const key = toggle.dataset.toggle;
      toggle.addEventListener('change', () => {
        this.params[key] = toggle.checked;
        this._updateDependentGroups();
        this.requestRender();
      });
    });

    // Sample Switcher Buttons
    document.getElementById('sample-btn-1').addEventListener('click', () => {
      this.loadBuiltinSample('example1');
    });
    document.getElementById('sample-btn-2').addEventListener('click', () => {
      this.loadBuiltinSample('example2');
    });

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
      this.applyPreset('reference800T');
      this.resetZoom();
    });

    // Export Format Selector
    document.querySelectorAll('.format-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.format-option').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.exportMime = btn.dataset.format;
        this.exportExt = btn.dataset.ext;

        const fmtName = this.exportExt.toUpperCase();
        const qualityNote = this.exportExt === 'png' ? 'Lossless PNG' : `Max-Quality ${fmtName}`;
        document.getElementById('export-btn-label').textContent = `Download Full-Resolution ${qualityNote}`;
      });
    });

    // Export Trigger Buttons
    document.getElementById('export-btn').addEventListener('click', () => this.exportPhoto());
    document.getElementById('header-export-btn').addEventListener('click', () => this.exportPhoto());
  }

  _clearActivePresetHighlight() {
    this.activePresetKey = null;
    document.querySelectorAll('.preset-card').forEach((card) => card.classList.remove('active'));
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
      draggingSplit = false;
    });
    window.addEventListener('touchend', () => {
      draggingSplit = false;
    });

    // Keyboard accessibility on split handle
    this.splitDivider.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this._applySplitPosition(this.splitPercent - 3);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this._applySplitPosition(this.splitPercent + 3);
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

  async loadBuiltinSample(sampleKey) {
    const sample = BUILTIN_SAMPLES[sampleKey];
    if (!sample) return;

    this.currentSampleKey = sampleKey;
    this.currentFilename = sample.filename;
    this.expectedRefUrl = sample.expectedUrl;
    this.inputDataUrl = sample.inputUrl;

    document.getElementById('sample-btn-1').classList.toggle('active', sampleKey === 'example1');
    document.getElementById('sample-btn-2').classList.toggle('active', sampleKey === 'example2');
    document.getElementById('custom-photo-chip').style.display = 'none';
    document.getElementById('view-mode-ref').style.display = '';

    await this._setImageFromUrl(sample.inputUrl);
  }

  async loadUserFile(file) {
    const objectUrl = URL.createObjectURL(file);
    const cleanName = file.name.replace(/\.[^/.]+$/, '') || 'photo';

    this.currentSampleKey = 'custom';
    this.currentFilename = cleanName;
    this.expectedRefUrl = null;
    this.inputDataUrl = objectUrl;

    document.getElementById('sample-btn-1').classList.remove('active');
    document.getElementById('sample-btn-2').classList.remove('active');

    const customChip = document.getElementById('custom-photo-chip');
    customChip.style.display = 'inline-flex';
    customChip.classList.add('active');
    document.getElementById('custom-photo-name').textContent =
      file.name.length > 20 ? file.name.slice(0, 18) + '…' : file.name;

    // Hide "Split vs Expected" when user loads their own photo
    document.getElementById('view-mode-ref').style.display = 'none';
    if (this.viewMode === 'split-expected') {
      this.viewMode = 'split-input';
      document.querySelectorAll('.compare-mode-group .mode-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === 'split-input');
      });
    }

    await this._setImageFromUrl(objectUrl);
    this.showToast(`Loaded "${file.name}" (${this.fullResImage.naturalWidth} × ${this.fullResImage.naturalHeight} px)`);
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
    if (!this.fullResImage) return;

    const exportBtn = document.getElementById('export-btn');
    const labelSpan = document.getElementById('export-btn-label');
    const prevText = labelSpan.textContent;

    try {
      exportBtn.disabled = true;
      labelSpan.textContent = `Rendering Native ${this.fullResImage.naturalWidth}×${this.fullResImage.naturalHeight}…`;

      const blob = await this.engine.exportFullResolution(
        this.fullResImage,
        this.params,
        this.exportMime,
        1.0
      );

      const outFilename = `${this.currentFilename}-halation.${this.exportExt}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
      this.showToast(`Exported ${outFilename} (${this.fullResImage.naturalWidth}×${this.fullResImage.naturalHeight} px, ${sizeMB} MB)`);
    } catch (err) {
      console.error('Export failed:', err);
      this.showToast('Export error: ' + err.message);
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
