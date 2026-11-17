import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
};

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      let relPath = decodeURIComponent(reqUrl.pathname);
      if (relPath === '/') relPath = '/index.html';
      const filePath = path.join(ROOT_DIR, relPath);

      if (!filePath.startsWith(ROOT_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);

  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('No Chromium or Chrome binary found for headless UI tests');
}

async function launchHeadlessBrowser(initialUrl) {
  const chromeBin = findChromeBinary();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halation-ui-test-'));

  const proc = spawn(
    chromeBin,
    [
      '--headless',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const wsEndpoint = await new Promise((resolve, reject) => {
    let stderrBuf = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for DevTools listening URL. Output: ${stderrBuf}`));
    }, 15000);

    const onData = (chunk) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };

    proc.stderr.on('data', onData);
    proc.stdout.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Browser exited prematurely with code ${code}: ${stderrBuf}`));
    });
  });

  const u = new URL(wsEndpoint);
  const listUrl = `http://${u.host}/json/list`;
  let pageWsUrl = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(listUrl);
    const targets = await res.json();
    const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (pageTarget) {
      pageWsUrl = pageTarget.webSocketDebuggerUrl;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!pageWsUrl) {
    proc.kill('SIGKILL');
    throw new Error('Could not find page target in headless browser');
  }

  const ws = new WebSocket(pageWsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  const sendCommand = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await sendCommand('Page.enable');
  await sendCommand('Runtime.enable');
  await sendCommand('Profiler.enable');
  await sendCommand('Profiler.startPreciseCoverage', {
    callCount: true,
    detailed: true,
  });

  await sendCommand('Page.navigate', { url: initialUrl });

  const evaluate = async (expression) => {
    const res = await sendCommand('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        'Evaluation error';
      throw new Error(desc);
    }
    return res.result?.value;
  };

  const close = async () => {
    try {
      ws.close();
    } catch (_) {}
    proc.kill('SIGKILL');
    await new Promise((r) => proc.once('close', r));
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (_) {}
  };

  return { sendCommand, evaluate, close };
}

/**
 * Computes line coverage percentage for a given source file from V8 precise coverage ranges.
 */
function computeFileLineCoverage(filePath, scriptEntries) {
  const source = fs.readFileSync(filePath, 'utf-8');
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  const totalLines = lineStarts.length;

  // Build byte-level execution count array per script snapshot, then union across snapshots
  const coveredBytes = new Uint8Array(source.length);
  for (const entry of scriptEntries) {
    const entryBytes = new Uint8Array(source.length);
    for (const fn of entry.functions) {
      for (const range of fn.ranges) {
        const val = range.count > 0 ? 1 : 0;
        for (let b = range.startOffset; b < Math.min(source.length, range.endOffset); b++) {
          entryBytes[b] = val;
        }
      }
    }
    for (let b = 0; b < source.length; b++) {
      if (entryBytes[b] === 1) coveredBytes[b] = 1;
    }
  }

  let executableLines = 0;
  let coveredLines = 0;
  const lines = source.split('\n');

  for (let idx = 0; idx < totalLines; idx++) {
    const text = lines[idx].trim();
    if (!text || text.startsWith('//') || text.startsWith('/*') || text.startsWith('*')) {
      continue;
    }
    executableLines++;
    const startByte = lineStarts[idx];
    const endByte = idx + 1 < totalLines ? lineStarts[idx + 1] - 1 : source.length;
    let lineHit = false;
    for (let b = startByte; b < endByte; b++) {
      if (coveredBytes[b] === 1) {
        lineHit = true;
        break;
      }
    }
    if (lineHit) coveredLines++;
  }

  return {
    executableLines,
    coveredLines,
    pct: executableLines > 0 ? (coveredLines / executableLines) * 100 : 100,
  };
}

test('Halation Optical Studio — Full Project End-to-End Browser & Coverage Suite', async (t) => {
  const { server, baseUrl } = await startStaticServer();
  const browser = await launchHeadlessBrowser(baseUrl);

  try {
    await browser.evaluate(`
      while (!window.halationStudio || !window.halationStudio.readyPromise) {
        await new Promise(r => setTimeout(r, 50));
      }
      await window.halationStudio.readyPromise;
    `);

    await t.test('1. UI Layout & Controls Initialization', async () => {
      const state = await browser.evaluate(`
        const sliders = document.querySelectorAll('.range-slider[data-param]');
        const toggles = document.querySelectorAll('.switch-input[data-toggle]');
        const presets = document.querySelectorAll('.preset-card[data-preset]');
        return {
          title: document.querySelector('.brand-titles h1')?.textContent?.trim(),
          sliderCount: sliders.length,
          toggleCount: toggles.length,
          presetCount: presets.length,
          hasStripToggle: Boolean(document.getElementById('toggle-stripMetadata')),
          stripChecked: document.getElementById('toggle-stripMetadata')?.checked,
          metadataBadgeText: document.getElementById('metadata-status-badge')?.textContent?.trim(),
          exportFilenamePreview: document.getElementById('export-filename-preview')?.textContent?.trim(),
          canvasWidth: document.getElementById('render-canvas')?.width,
          canvasHeight: document.getElementById('render-canvas')?.height,
          hudText: document.getElementById('hud-dimensions')?.textContent?.trim(),
        };
      `);

      assert.equal(state.title, 'Halation Optical Studio');
      assert.equal(state.sliderCount, 10, 'Expected all 10 optical range sliders');
      assert.equal(state.toggleCount, 8, 'Expected all 8 slide toggles including stripMetadata');
      assert.equal(state.presetCount, 5, 'Expected all 5 film stock preset cards');
      assert.equal(state.hasStripToggle, true);
      assert.equal(state.stripChecked, false);
      assert.ok(state.metadataBadgeText.includes('Metadata Preserved'));
      assert.equal(state.exportFilenamePreview, 'example1-input.png');
      assert.equal(state.canvasWidth, 667);
      assert.equal(state.canvasHeight, 1000);
      assert.ok(state.hudText.includes('667 × 1000'));
    });

    await t.test('2. Optical Engine Accuracy, Built-in Reference Scenes & Canvas2D Fallback', async () => {
      const opticalRes = await browser.evaluate(`
        const { HalationEngine, DEFAULT_PARAMS } = await import('./halation-engine.js');
        const app = window.halationStudio;

        // Switch to Example 2: Streetlamp via button click
        document.getElementById('sample-btn-2').click();
        await new Promise(r => setTimeout(r, 250));
        const ex2SampleKey = app.currentSampleKey;
        const ex2Filename = app.originalFileName;

        // Test Split vs Expected reference mode on Example 2
        document.getElementById('view-mode-ref').click();
        const refBadgeText = document.getElementById('split-badge-left').textContent;

        // Switch back to Example 1: Night Kiosk
        document.getElementById('sample-btn-1').click();
        await new Promise(r => setTimeout(r, 250));

        // Verify optical halation scatter on a synthetic high-contrast point light canvas
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = 64;
        srcCanvas.height = 64;
        const sctx = srcCanvas.getContext('2d');
        sctx.fillStyle = '#050608';
        sctx.fillRect(0, 0, 64, 64);
        sctx.fillStyle = '#ffffff';
        sctx.fillRect(28, 28, 8, 8);

        const outCanvas = document.createElement('canvas');
        const testEngine = new HalationEngine(outCanvas);
        testEngine.setImage(srcCanvas);
        testEngine.render({ ...DEFAULT_PARAMS, enabled: true, strength: 160, radius: 24 });

        // Read rendered pixels via an offscreen 2D canvas drawImage
        const readCanvas = document.createElement('canvas');
        readCanvas.width = 64;
        readCanvas.height = 64;
        const rctx = readCanvas.getContext('2d');
        rctx.drawImage(outCanvas, 0, 0);
        // Sample 4 pixels outside the white square (x=24, y=32) where red-orange halation scatter lands
        const haloPx = rctx.getImageData(24, 32, 1, 1).data;
        // Sample far corner (x=2, y=2) which should remain dark
        const cornerPx = rctx.getImageData(2, 2, 1, 1).data;

        // Also test Canvas2D fallback path in real browser
        const fbCanvas = document.createElement('canvas');
        const origGetCtx = fbCanvas.getContext.bind(fbCanvas);
        fbCanvas.getContext = (type, opts) => (type === '2d' ? origGetCtx('2d', opts) : null);
        const fbEngine = new HalationEngine(fbCanvas);
        fbEngine.setImage(srcCanvas);
        fbEngine.render({ ...DEFAULT_PARAMS, enabled: true, soloHalation: false });
        fbEngine.render({ ...DEFAULT_PARAMS, enabled: true, soloHalation: true });
        fbEngine.render({ ...DEFAULT_PARAMS, enabled: false, soloHalation: false });
        testEngine.destroy();

        return {
          ex2SampleKey,
          ex2Filename,
          refBadgeText,
          haloR: haloPx[0],
          haloG: haloPx[1],
          haloB: haloPx[2],
          cornerR: cornerPx[0],
        };
      `);

      assert.equal(opticalRes.ex2SampleKey, 'example2');
      assert.equal(opticalRes.ex2Filename, 'example2-input.png');
      assert.equal(opticalRes.refBadgeText, 'Expected Target');
      assert.ok(opticalRes.haloR > opticalRes.cornerR + 15, 'Expected red halation scatter around bright light source');
      assert.ok(opticalRes.haloR > opticalRes.haloB, 'Expected halation scatter to be warm red-orange (R > B)');
    });

    await t.test('3. All 10 Sliders, All 8 Slide Toggles, All 5 Presets & Reset All Button', async () => {
      const controlsRes = await browser.evaluate(`
        const app = window.halationStudio;

        // Exercise every single range slider: input event + dblclick reset
        const sliders = Array.from(document.querySelectorAll('.range-slider[data-param]'));
        const sliderParamsTested = [];
        for (const slider of sliders) {
          const param = slider.dataset.param;
          const maxVal = slider.max;
          slider.value = maxVal;
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          slider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          sliderParamsTested.push(param);
        }

        // Exercise every single slide toggle
        const toggles = Array.from(document.querySelectorAll('.switch-input[data-toggle]'));
        const toggleKeysTested = [];
        for (const toggle of toggles) {
          const key = toggle.dataset.toggle;
          toggle.checked = !toggle.checked;
          toggle.dispatchEvent(new Event('change', { bubbles: true }));
          toggle.checked = !toggle.checked;
          toggle.dispatchEvent(new Event('change', { bubbles: true }));
          toggleKeysTested.push(key);
        }

        // Exercise Solo Halation Map View badge update
        const soloToggle = document.getElementById('toggle-soloHalation');
        soloToggle.checked = true;
        soloToggle.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => requestAnimationFrame(r));
        const soloBadgeText = document.getElementById('split-badge-right').textContent;
        soloToggle.checked = false;
        soloToggle.dispatchEvent(new Event('change', { bubbles: true }));

        // Exercise all 5 preset cards
        const presetCards = Array.from(document.querySelectorAll('.preset-card[data-preset]'));
        const presetsClicked = [];
        for (const card of presetCards) {
          card.click();
          presetsClicked.push(app.activePresetKey);
        }

        // Exercise Reset All button
        document.getElementById('reset-all-btn').click();
        const activeAfterResetAll = app.activePresetKey;

        return {
          sliderParamsTested,
          toggleKeysTested,
          soloBadgeText,
          presetsClicked,
          activeAfterResetAll,
        };
      `);

      assert.equal(controlsRes.sliderParamsTested.length, 10);
      assert.equal(controlsRes.toggleKeysTested.length, 8);
      assert.equal(controlsRes.soloBadgeText, 'Solo Halation Map');
      assert.deepEqual(controlsRes.presetsClicked, [
        'reference800T',
        'vision3Remjet',
        'neonPointLights',
        'subtleDaylight',
        'proMistAmber',
      ]);
      assert.equal(controlsRes.activeAfterResetAll, 'reference800T');
    });

    await t.test('4. Hold Original (Mouse, Touch & Spacebar), Split Curtain (Mouse, Touch & Keyboard), Zoom/Pan & Mobile Tabs', async () => {
      const interactRes = await browser.evaluate(`
        const app = window.halationStudio;
        document.getElementById('view-mode-split').click();

        // 1. Hold Original via Mouse, Touch, and Spacebar
        const holdBtn = document.getElementById('hold-compare-btn');
        holdBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        const badgeDuringMouseHold = document.getElementById('split-badge-right').textContent;
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        const badgeAfterMouseRelease = document.getElementById('split-badge-right').textContent;

        holdBtn.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
        const badgeDuringTouchHold = document.getElementById('split-badge-right').textContent;
        window.dispatchEvent(new Event('touchend', { bubbles: true }));

        document.body.focus();
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
        const badgeDuringSpaceHold = document.getElementById('split-badge-right').textContent;
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));

        // 2. Split Curtain Dragging (Mouse, Touch & Keyboard ArrowLeft / ArrowRight)
        const divider = document.getElementById('split-divider');
        const wrapRect = document.getElementById('stage-transform-wrap').getBoundingClientRect();

        divider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: wrapRect.left + wrapRect.width * 0.5 }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: wrapRect.left + wrapRect.width * 0.3 }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        const splitAfterMouseDrag = Math.round(app.splitPercent);

        divider.dispatchEvent(new Event('touchstart', { bubbles: true }));
        const touchMoveEvt = new Event('touchmove', { bubbles: true });
        touchMoveEvt.touches = [{ clientX: wrapRect.left + wrapRect.width * 0.7 }];
        window.dispatchEvent(touchMoveEvt);
        window.dispatchEvent(new Event('touchend', { bubbles: true }));
        const splitAfterTouchDrag = Math.round(app.splitPercent);

        divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        const splitAfterArrowLeft = Math.round(app.splitPercent);
        divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        const splitAfterArrowRight = Math.round(app.splitPercent);

        // 3. Zoom & Pan (Buttons, Wheel, and Mouse Drag Panning when zoomed > 1)
        document.getElementById('zoom-in-btn').click();
        document.getElementById('zoom-in-btn').click();
        const zoomAfterIn = app.zoom;
        document.getElementById('zoom-out-btn').click();
        const zoomAfterOut = app.zoom;

        const stage = document.getElementById('canvas-stage');
        stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
        const zoomAfterWheelIn = app.zoom;

        // Drag pan while zoomed > 1
        stage.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, clientY: 200, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 245, clientY: 230, bubbles: true }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        const panAfterDrag = { panX: app.panX, panY: app.panY };

        stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
        document.getElementById('zoom-reset-btn').click();
        const zoomAfterReset = app.zoom;

        // 4. Mobile Tabs (halation, toggles, presets)
        const mobileTabs = ['halation', 'toggles', 'presets'];
        const mobileTabResults = [];
        for (const tab of mobileTabs) {
          document.querySelector(\`.mobile-tab-btn[data-tab-target="\${tab}"]\`).click();
          const isSecActive = document
            .querySelector(\`.control-section[data-mobile-tab="\${tab}"]\`)
            .classList.contains('mobile-active');
          mobileTabResults.push(isSecActive);
        }

        return {
          badgeDuringMouseHold,
          badgeAfterMouseRelease,
          badgeDuringTouchHold,
          badgeDuringSpaceHold,
          splitAfterMouseDrag,
          splitAfterTouchDrag,
          splitAfterArrowLeft,
          splitAfterArrowRight,
          zoomAfterIn,
          zoomAfterOut,
          zoomAfterWheelIn,
          panAfterDrag,
          zoomAfterReset,
          mobileTabResults,
        };
      `);

      assert.equal(interactRes.badgeDuringMouseHold, 'Original (Bypassed)');
      assert.equal(interactRes.badgeAfterMouseRelease, 'Halation Studio');
      assert.equal(interactRes.badgeDuringTouchHold, 'Original (Bypassed)');
      assert.equal(interactRes.badgeDuringSpaceHold, 'Original (Bypassed)');
      assert.equal(interactRes.splitAfterMouseDrag, 30);
      assert.equal(interactRes.splitAfterTouchDrag, 70);
      assert.equal(interactRes.splitAfterArrowLeft, 67);
      assert.equal(interactRes.splitAfterArrowRight, 70);
      assert.equal(interactRes.zoomAfterIn, 1.5);
      assert.equal(interactRes.zoomAfterOut, 1.25);
      assert.equal(interactRes.zoomAfterWheelIn, 1.4);
      assert.equal(interactRes.panAfterDrag.panX, 45);
      assert.equal(interactRes.panAfterDrag.panY, 30);
      assert.equal(interactRes.zoomAfterReset, 1);
      assert.deepEqual(interactRes.mobileTabResults, [true, true, true]);
    });

    await t.test('5. Upload Flows (Drag-and-Drop, Clipboard Paste, File Input & >2048px High-Res Native Export)', async () => {
      const uploadFlowsRes = await browser.evaluate(`
        const app = window.halationStudio;
        const dropOverlay = document.getElementById('dropzone-overlay');

        // 1. Dragover / Dragleave / Drop
        window.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
        const overlayVisibleOnDrag = dropOverlay.classList.contains('visible');

        const leaveEvt = new Event('dragleave', { bubbles: true });
        Object.defineProperty(leaveEvt, 'relatedTarget', { value: null });
        window.dispatchEvent(leaveEvt);
        const overlayHiddenOnLeave = !dropOverlay.classList.contains('visible');

        // Create a test WebP image for drop
        const c1 = document.createElement('canvas');
        c1.width = 40;
        c1.height = 40;
        const ctx1 = c1.getContext('2d');
        ctx1.fillStyle = '#ff5522';
        ctx1.fillRect(0, 0, 40, 40);
        const webpBlob = await new Promise(r => c1.toBlob(r, 'image/webp', 0.95));
        const webpFile = new File([webpBlob], 'dropped_street_scene.webp', { type: 'image/webp' });

        const dropEvt = new Event('drop', { bubbles: true, cancelable: true });
        dropEvt.dataTransfer = { files: [webpFile] };
        window.dispatchEvent(dropEvt);
        await new Promise(r => setTimeout(r, 150));
        const nameAfterDrop = app.originalFileName;
        const mimeAfterDrop = app.exportMime;

        // 2. Clipboard Paste flow + WebP metadata injection & export in browser
        const {
          injectImageMetadataBytes,
          extractImageMetadata,
          buildExifTiffPayload,
        } = await import('./metadata-utils.js');
        const webpBytes = new Uint8Array(await webpBlob.arrayBuffer());
        const richWebpBytes = injectImageMetadataBytes(
          webpBytes,
          {
            title: 'WebP Night Frame',
            rawExifTiff: buildExifTiffPayload({ title: 'WebP Night Frame' }),
            rawXmp: new TextEncoder().encode('<x:xmpmeta><dc:title><rdf:Alt><rdf:li>WebP Night Frame</rdf:li></rdf:Alt></dc:title></x:xmpmeta>'),
            rawIcc: new Uint8Array([1, 2, 3, 4]),
          },
          'image/webp'
        );
        const pasteFile = new File([richWebpBytes], 'pasted_clipboard_frame.webp', { type: 'image/webp' });
        const pasteEvt = new Event('paste', { bubbles: true });
        pasteEvt.clipboardData = {
          items: [{ type: 'image/webp', getAsFile: () => pasteFile }],
        };
        window.dispatchEvent(pasteEvt);
        await new Promise(r => setTimeout(r, 150));
        const nameAfterPaste = app.originalFileName;

        // Export WebP with metadata preserved and with metadata stripped
        const webpExportPreserved = await app.exportPhoto();
        const webpExportMeta = extractImageMetadata(
          new Uint8Array(await webpExportPreserved.blob.arrayBuffer()),
          'image/webp',
          webpExportPreserved.filename
        );
        app.params.stripMetadata = true;
        await app.exportPhoto();
        app.params.stripMetadata = false;

        // Exercise #upload-photo-btn click & #file-input change event
        const fileInput = document.getElementById('file-input');
        let fileInputClicked = false;
        const origClick = fileInput.click.bind(fileInput);
        fileInput.click = () => { fileInputClicked = true; };
        document.getElementById('upload-photo-btn').click();
        fileInput.click = origClick;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

        // 3. Attempting Split vs Expected on custom upload shows toast and stays in split-input
        app.setViewMode('split-expected');
        const toastOnInvalidRefMode = document.getElementById('toast-banner').textContent;

        // 4. High-Resolution (>2048px) Upload: Preview FBO caps at 2048px while Export stays 1:1 Native
        const hiCanvas = document.createElement('canvas');
        hiCanvas.width = 2200;
        hiCanvas.height = 1100;
        const hctx = hiCanvas.getContext('2d');
        hctx.fillStyle = '#08090c';
        hctx.fillRect(0, 0, 2200, 1100);
        hctx.fillStyle = '#fff5e0';
        hctx.fillRect(1050, 500, 100, 100);
        const hiBlob = await new Promise(r => hiCanvas.toBlob(r, 'image/jpeg', 0.92));
        const hiFile = new File([hiBlob], 'Very_Long_Filename_HighRes_2200x1100.jpg', {
          type: 'image/jpeg',
        });

        await app.loadUserFile(hiFile);
        const previewFboWidth = app.engine.imageWidth;
        const nativeWidth = app.fullResImage.naturalWidth;
        const truncatedChipText = document.getElementById('custom-photo-name').textContent;

        return {
          overlayVisibleOnDrag,
          overlayHiddenOnLeave,
          nameAfterDrop,
          mimeAfterDrop,
          nameAfterPaste,
          toastOnInvalidRefMode,
          previewFboWidth,
          nativeWidth,
          truncatedChipText,
        };
      `);

      assert.equal(uploadFlowsRes.overlayVisibleOnDrag, true);
      assert.equal(uploadFlowsRes.overlayHiddenOnLeave, true);
      assert.equal(uploadFlowsRes.nameAfterDrop, 'dropped_street_scene.webp');
      assert.equal(uploadFlowsRes.mimeAfterDrop, 'image/webp');
      assert.equal(uploadFlowsRes.nameAfterPaste, 'pasted_clipboard_frame.webp');
      assert.ok(uploadFlowsRes.toastOnInvalidRefMode.includes('built-in test examples'));
      assert.equal(uploadFlowsRes.previewFboWidth, 2048);
      assert.equal(uploadFlowsRes.nativeWidth, 2200);
      assert.ok(uploadFlowsRes.truncatedChipText.endsWith('…'));
    });

    await t.test('6. JPEG & PNG Metadata + Exact Upload Title/Filename Preservation & Strip Toggle', async () => {
      const metaRes = await browser.evaluate(`
        const {
          extractImageMetadata,
          injectImageMetadataBytes,
          buildExifTiffPayload,
          createPngChunk,
          createPngTextChunk,
          createPngITXtChunk,
          createJpegSegment,
          parseExifTitle,
        } = await import('./metadata-utils.js');

        const app = window.halationStudio;

        // Part A: JPEG with EXIF + Comment
        const cJpeg = document.createElement('canvas');
        cJpeg.width = 48;
        cJpeg.height = 48;
        const jctx = cJpeg.getContext('2d');
        jctx.fillStyle = '#101218';
        jctx.fillRect(0, 0, 48, 48);
        jctx.fillStyle = '#ffebcc';
        jctx.fillRect(16, 16, 16, 16);

        const baseJpegBlob = await new Promise(r => cJpeg.toBlob(r, 'image/jpeg', 0.95));
        const baseJpegBytes = new Uint8Array(await baseJpegBlob.arrayBuffer());

        const exifTiffJpeg = buildExifTiffPayload({
          title: 'Cinema Frame 800T',
          artist: 'Valentin Vasilev',
          make: 'ARRI',
          model: 'Arriflex 435',
        });
        const exifPayload = new Uint8Array(6 + exifTiffJpeg.length);
        exifPayload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
        exifPayload.set(exifTiffJpeg, 6);
        const app1Exif = createJpegSegment(0xe1, exifPayload);
        const comSeg = createJpegSegment(0xfe, new TextEncoder().encode('35mm Remjet Stripped'));

        const richJpegBytes = injectImageMetadataBytes(
          baseJpegBytes,
          { jpegSegments: [app1Exif, comSeg] },
          'image/jpeg'
        );

        const jpegFile = new File([richJpegBytes], 'Cinema_Frame_800T.JPG', {
          type: 'image/jpeg',
        });
        await app.loadUserFile(jpegFile);

        const expJpegPreserved = await app.exportPhoto();
        const expJpegMeta = extractImageMetadata(
          new Uint8Array(await expJpegPreserved.blob.arrayBuffer()),
          'image/jpeg',
          expJpegPreserved.filename
        );

        // Also test manually clicking format option buttons (.format-option)
        document.querySelector('.format-option[data-format="image/webp"]').click();
        const manualWebpFilename = document.getElementById('export-filename-preview').textContent;
        document.querySelector('.format-option[data-format="image/png"]').click();

        // Part B: PNG with eXIf + tEXt + iTXt XMP
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = 64;
        tmpCanvas.height = 64;
        const ctx = tmpCanvas.getContext('2d');
        ctx.fillStyle = '#090b10';
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = '#fff6e5';
        ctx.beginPath();
        ctx.arc(32, 32, 10, 0, Math.PI * 2);
        ctx.fill();

        const baseBlob = await new Promise(r => tmpCanvas.toBlob(r, 'image/png'));
        const baseBytes = new Uint8Array(await baseBlob.arrayBuffer());

        const exifTiff = buildExifTiffPayload({
          title: 'Golden Gate Midnight 800T',
          artist: 'Valentin Vasilev',
          make: 'Leica Camera AG',
          model: 'Leica M6 TTL 35mm',
        });
        const exifChunk = createPngChunk('eXIf', exifTiff);
        const titleChunk = createPngTextChunk('Title', 'Golden Gate Midnight 800T');
        const authorChunk = createPngTextChunk('Author', 'Valentin Vasilev');
        const xmpXml = '<x:xmpmeta><rdf:RDF><rdf:Description><dc:title><rdf:Alt><rdf:li>Golden Gate Midnight 800T</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>';
        const xmpChunk = createPngITXtChunk('XML:com.adobe.xmp', xmpXml);

        const richPngBytes = injectImageMetadataBytes(
          baseBytes,
          {
            pngChunks: [
              { type: 'eXIf', data: exifTiff, rawChunk: exifChunk },
              { type: 'tEXt', data: new Uint8Array(0), rawChunk: titleChunk },
              { type: 'tEXt', data: new Uint8Array(0), rawChunk: authorChunk },
              { type: 'iTXt', data: new Uint8Array(0), rawChunk: xmpChunk },
            ],
          },
          'image/png'
        );

        const uploadFilename = 'Golden_Gate_Midnight_800T.png';
        const uploadFile = new File([richPngBytes], uploadFilename, {
          type: 'image/png',
          lastModified: 1700000000000,
        });

        await app.loadUserFile(uploadFile);

        const export1 = await app.exportPhoto();
        const export1Bytes = new Uint8Array(await export1.blob.arrayBuffer());
        const export1Meta = extractImageMetadata(export1Bytes, 'image/png', export1.filename);

        // Toggle Strip Metadata ON
        const stripToggle = document.getElementById('toggle-stripMetadata');
        stripToggle.checked = true;
        stripToggle.dispatchEvent(new Event('change', { bubbles: true }));
        const badgeWhenStripped = document.getElementById('metadata-status-badge').textContent.trim();

        const export2 = await app.exportPhoto();
        const export2Bytes = new Uint8Array(await export2.blob.arrayBuffer());
        const export2Meta = extractImageMetadata(export2Bytes, 'image/png', export2.filename);

        // Set custom sliders and restore stripMetadata = false before testing refresh persistence
        stripToggle.checked = false;
        stripToggle.dispatchEvent(new Event('change', { bubbles: true }));

        const strengthSlider = document.getElementById('slider-strength');
        strengthSlider.value = '168';
        strengthSlider.dispatchEvent(new Event('input', { bubbles: true }));

        const warmthSlider = document.getElementById('slider-warmth');
        warmthSlider.value = '64';
        warmthSlider.dispatchEvent(new Event('input', { bubbles: true }));

        await app._persistState();

        return {
          jpegFilename: expJpegPreserved.filename,
          jpegExifTitle: parseExifTitle(expJpegMeta.rawExifTiff),
          jpegSegCount: expJpegMeta.jpegSegments.length,
          manualWebpFilename,
          export1Filename: export1.filename,
          export1HasMetadata: export1Meta.hasMetadata,
          export1Title: export1Meta.title,
          export1ExifTitle: parseExifTitle(export1Meta.rawExifTiff),
          export1ChunkCount: export1Meta.pngChunks.length,
          badgeWhenStripped,
          export2Filename: export2.filename,
          export2HasMetadata: export2Meta.hasMetadata,
          export2ChunkCount: export2Meta.pngChunks.length,
        };
      `);

      assert.equal(metaRes.jpegFilename, 'Cinema_Frame_800T.JPG');
      assert.equal(metaRes.jpegExifTitle, 'Cinema Frame 800T');
      assert.equal(metaRes.jpegSegCount, 2);
      assert.equal(metaRes.manualWebpFilename, 'Cinema_Frame_800T.webp');

      assert.equal(metaRes.export1Filename, 'Golden_Gate_Midnight_800T.png');
      assert.equal(metaRes.export1HasMetadata, true);
      assert.equal(metaRes.export1Title, 'Golden Gate Midnight 800T');
      assert.equal(metaRes.export1ExifTitle, 'Golden Gate Midnight 800T');
      assert.equal(metaRes.export1ChunkCount, 4);

      assert.equal(metaRes.badgeWhenStripped, 'Metadata Stripped');
      assert.equal(metaRes.export2Filename, 'Golden_Gate_Midnight_800T.png');
      assert.equal(metaRes.export2HasMetadata, false);
      assert.equal(metaRes.export2ChunkCount, 0);
    });

    let preReloadCoverage = [];

    await t.test('7. Accidental Page Refresh Restores Last Uploaded Image, Metadata & Studio State', async () => {
      const snap = await browser.sendCommand('Profiler.takePreciseCoverage');
      preReloadCoverage = snap.result || [];

      await browser.sendCommand('Page.reload', { ignoreCache: false });

      const afterRefresh = await browser.evaluate(`
        while (!window.halationStudio || !window.halationStudio.readyPromise) {
          await new Promise(r => setTimeout(r, 50));
        }
        await window.halationStudio.readyPromise;

        const { extractImageMetadata, parseExifTitle } = await import('./metadata-utils.js');
        const app = window.halationStudio;

        const postRefreshExport = await app.exportPhoto();
        const postRefreshBytes = new Uint8Array(await postRefreshExport.blob.arrayBuffer());
        const postRefreshMeta = extractImageMetadata(
          postRefreshBytes,
          'image/png',
          postRefreshExport.filename
        );

        // Switch to Example 1 and click custom-photo-chip to return to cached upload
        await app.loadBuiltinSample('example1');
        const sampleAfterSwitch = app.currentSampleKey;
        document.getElementById('custom-photo-chip').click();
        await new Promise(r => setTimeout(r, 150));
        const sampleAfterChipClick = app.currentSampleKey;

        // Also exercise clearStudioCache and localStorage/IndexedDB fallbacks in session-cache.js
        const {
          clearStudioCache,
          saveUploadedImageToCache,
          loadUploadedImageFromCache,
          saveStudioStateToCache,
          loadStudioStateFromCache,
        } = await import('./session-cache.js');
        localStorage.removeItem('halation_studio_state_v1');
        const idbStateFallback = await loadStudioStateFromCache();
        await clearStudioCache();

        // Exercise fallback when indexedDB is temporarily unavailable in browser
        const origIDB = window.indexedDB;
        Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
        await saveUploadedImageToCache(
          new File([new Uint8Array([1, 2, 3])], 'ls_only.png', { type: 'image/png' })
        );
        await saveStudioStateToCache({ currentSampleKey: 'custom' });
        const lsFallbackLoaded = await loadUploadedImageFromCache();
        localStorage.removeItem('halation_studio_state_v1');
        await loadStudioStateFromCache();
        await clearStudioCache();
        Object.defineProperty(window, 'indexedDB', { value: origIDB, configurable: true });

        await clearStudioCache();
        const emptyAfterClear = await loadUploadedImageFromCache();

        return {
          originalFileName: app.originalFileName,
          strengthParam: app.params.strength,
          warmthParam: app.params.warmth,
          strengthSliderVal: document.getElementById('slider-strength').value,
          warmthSliderVal: document.getElementById('slider-warmth').value,
          customChipActive: document.getElementById('custom-photo-chip').classList.contains('active'),
          exportedFilename: postRefreshExport.filename,
          exportedHasMetadata: postRefreshMeta.hasMetadata,
          exportedExifTitle: parseExifTitle(postRefreshMeta.rawExifTiff),
          naturalWidth: app.fullResImage?.naturalWidth,
          naturalHeight: app.fullResImage?.naturalHeight,
          sampleAfterSwitch,
          sampleAfterChipClick,
          emptyAfterClear,
          lsFallbackName: lsFallbackLoaded?.name,
          idbStateSample: idbStateFallback?.currentSampleKey,
        };
      `);

      assert.equal(afterRefresh.originalFileName, 'Golden_Gate_Midnight_800T.png');
      assert.equal(afterRefresh.strengthParam, 168);
      assert.equal(afterRefresh.warmthParam, 64);
      assert.equal(afterRefresh.strengthSliderVal, '168');
      assert.equal(afterRefresh.warmthSliderVal, '64');
      assert.equal(afterRefresh.customChipActive, true);
      assert.equal(afterRefresh.exportedFilename, 'Golden_Gate_Midnight_800T.png');
      assert.equal(afterRefresh.exportedHasMetadata, true);
      assert.equal(afterRefresh.exportedExifTitle, 'Golden Gate Midnight 800T');
      assert.equal(afterRefresh.naturalWidth, 64);
      assert.equal(afterRefresh.naturalHeight, 64);
      assert.equal(afterRefresh.sampleAfterSwitch, 'example1');
      assert.equal(afterRefresh.sampleAfterChipClick, 'custom');
      assert.equal(afterRefresh.emptyAfterClear, null);
      assert.equal(afterRefresh.lsFallbackName, 'ls_only.png');
      assert.equal(afterRefresh.idbStateSample, 'custom');
    });

    await t.test('8. Whole-Project Browser V8 Code Coverage Verification', async () => {
      const { result: postReloadCoverage } = await browser.sendCommand('Profiler.takePreciseCoverage');
      const scriptCoverages = [...preReloadCoverage, ...(postReloadCoverage || [])];
      const targetFiles = ['app.js', 'halation-engine.js', 'metadata-utils.js', 'session-cache.js'];

      let totalExec = 0;
      let totalCov = 0;
      const reportRows = [];
      const fileStats = {};

      for (const fname of targetFiles) {
        const matchingEntries = scriptCoverages.filter((s) => s.url.endsWith('/' + fname));
        assert.ok(matchingEntries.length > 0, `Expected V8 coverage entry for ${fname}`);
        const stats = computeFileLineCoverage(path.join(ROOT_DIR, fname), matchingEntries);
        fileStats[fname] = stats;
        totalExec += stats.executableLines;
        totalCov += stats.coveredLines;
        reportRows.push(`${fname}: ${stats.pct.toFixed(1)}% (${stats.coveredLines}/${stats.executableLines} lines)`);
      }

      const overallPct = (totalCov / totalExec) * 100;
      console.log(
        `[Browser V8 Coverage] Overall: ${overallPct.toFixed(1)}% (${totalCov}/${totalExec} lines) -> ` +
          reportRows.join(' | ')
      );

      for (const fname of targetFiles) {
        assert.ok(
          fileStats[fname].pct >= 80,
          `Expected >= 80% browser coverage on ${fname}, got ${fileStats[fname].pct.toFixed(1)}%`
        );
      }
      assert.ok(overallPct >= 88, `Expected overall browser code coverage >= 88%, got ${overallPct.toFixed(1)}%`);
    });
  } finally {
    await browser.close();
    server.close();
  }
});
