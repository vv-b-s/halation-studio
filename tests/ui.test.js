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
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
      initialUrl,
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
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  const sendCommand = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 25000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await sendCommand('Page.enable');
  await sendCommand('Runtime.enable');
  await sendCommand('Profiler.enable');
  await sendCommand('Profiler.startPreciseCoverage', {
    callCount: true,
    detailed: true,
  });

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
        app.engine.render(app.params);
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

        // Part A.2: Vertical Portrait Photo (80x120 display) from a 120x80 landscape camera sensor with EXIF Orientation = 6 (90° CW tag)
        // Verifies that exported vertical portrait photos keep their exact vertical orientation (80x120, height > width)
        // and are not double-rotated sideways into 120x80, and keep the exact input filename!
        const sensorCanvas = document.createElement('canvas');
        sensorCanvas.width = 120;
        sensorCanvas.height = 80;
        const sctx2 = sensorCanvas.getContext('2d');
        sctx2.fillStyle = '#080a0f';
        sctx2.fillRect(0, 0, 120, 80);
        sctx2.fillStyle = '#ffddaa';
        sctx2.fillRect(40, 20, 40, 40);
        const sensorRawBlob = await new Promise(r => sensorCanvas.toBlob(r, 'image/jpeg', 0.95));
        const sensorRawBytes = new Uint8Array(await sensorRawBlob.arrayBuffer());

        const exifOrient6 = buildExifTiffPayload({
          title: 'Vertical Portrait Study',
          artist: 'Valentin Vasilev',
          make: 'Sony',
          model: 'A7RV',
          orientation: 6,
          width: 120,
          height: 80,
        });
        const exifOrientPayload = new Uint8Array(6 + exifOrient6.length);
        exifOrientPayload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
        exifOrientPayload.set(exifOrient6, 6);
        const app1Orient6 = createJpegSegment(0xe1, exifOrientPayload);

        // Construct raw JPEG with Orientation = 6 directly (simulating a vertical portrait camera photo whose raw coded sensor is 120x80 with Orientation=6 -> 80x120 vertical display)
        const orientedJpegBytes = new Uint8Array(
          2 + app1Orient6.length + (sensorRawBytes.length - 2)
        );
        orientedJpegBytes.set([0xff, 0xd8], 0);
        orientedJpegBytes.set(app1Orient6, 2);
        orientedJpegBytes.set(sensorRawBytes.subarray(2), 2 + app1Orient6.length);

        const orientedVertFile = new File([orientedJpegBytes], 'Vertical_Portrait_0042.jpeg', {
          type: 'image/jpeg',
        });
        await app.loadUserFile(orientedVertFile);
        const expVert = await app.exportPhoto();
        const expVertBytes = new Uint8Array(await expVert.blob.arrayBuffer());
        const expVertMeta = extractImageMetadata(expVertBytes, 'image/jpeg', expVert.filename);

        // Decode the exported JPEG in the browser and verify its rendered dimensions are vertical (80 x 120)
        const decodedExportImg = await new Promise((resolve, reject) => {
          const img = new Image();
          const u = URL.createObjectURL(expVert.blob);
          img.onload = () => {
            URL.revokeObjectURL(u);
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
          };
          img.onerror = reject;
          img.src = u;
        });

        // Also test pure 160x90 horizontal PNG without EXIF orientation
        const pureHorizCanvas = document.createElement('canvas');
        pureHorizCanvas.width = 160;
        pureHorizCanvas.height = 90;
        const pctx = pureHorizCanvas.getContext('2d');
        pctx.fillStyle = '#090b10';
        pctx.fillRect(0, 0, 160, 90);
        pctx.fillStyle = '#fffae6';
        pctx.fillRect(60, 30, 40, 30);
        const pureHorizBlob = await new Promise(r => pureHorizCanvas.toBlob(r, 'image/png'));
        const pureHorizFile = new File([pureHorizBlob], 'Wide_Panorama_160x90.png', {
          type: 'image/png',
        });
        await app.loadUserFile(pureHorizFile);
        const expPureHoriz = await app.exportPhoto();
        const decodedPureHoriz = await new Promise((resolve, reject) => {
          const img = new Image();
          const u = URL.createObjectURL(expPureHoriz.blob);
          img.onload = () => {
            URL.revokeObjectURL(u);
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
          };
          img.onerror = reject;
          img.src = u;
        });

        // Part A.3: Photo with EXIF GPS location coordinates AND a synthetic mobile photo picker numeric filename ("1000038492.jpg")
        // Verifies that:
        // 1) #file-input accept attribute includes application/octet-stream to bypass Android Photo Picker GPS stripping & filename randomization
        // 2) If a mobile OS picker still passes a random number filename ("1000038492.jpg"), the app recovers the real camera filename ("PXL_20260514_192210.jpg")
        // 3) The exported JPEG preserves the exact EXIF GPS latitude, longitude, and altitude coordinates
        const fileInputAccept = document.getElementById('file-input').getAttribute('accept') || '';
        const exifGpsPayload = buildExifTiffPayload({
          title: 'Marin Headlands Halation',
          artist: 'Valentin Vasilev',
          make: 'Google',
          model: 'Pixel 9 Pro',
          orientation: 6,
          width: 120,
          height: 80,
          dateTime: '2026:05:14 19:22:10',
          gps: {
            latitude: 37.8199,
            longitude: -122.4783,
            altitude: 67.5,
          },
        });
        const app1GpsBuf = new Uint8Array(6 + exifGpsPayload.length);
        app1GpsBuf.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
        app1GpsBuf.set(exifGpsPayload, 6);
        const app1GpsSeg = createJpegSegment(0xe1, app1GpsBuf);
        const gpsJpegBytes = new Uint8Array(2 + app1GpsSeg.length + (sensorRawBytes.length - 2));
        gpsJpegBytes.set([0xff, 0xd8], 0);
        gpsJpegBytes.set(app1GpsSeg, 2);
        gpsJpegBytes.set(sensorRawBytes.subarray(2), 2 + app1GpsSeg.length);

        const syntheticPickerFile = new File([gpsJpegBytes], '1000038492.jpg', {
          type: 'image/jpeg',
        });
        await app.loadUserFile(syntheticPickerFile);
        const gpsBadgeText = document.getElementById('metadata-status-badge').textContent.trim();
        const gpsPreviewFilename = document.getElementById('export-filename-preview').textContent.trim();
        const expGps = await app.exportPhoto();
        const expGpsBytes = new Uint8Array(await expGps.blob.arrayBuffer());
        const expGpsMeta = extractImageMetadata(expGpsBytes, 'image/jpeg', expGps.filename);

        // Part A.4: Fujifilm DSCF0141.JPG with 0/0 uninitialized camera GPSInfo template in APP1 EXIF,
        // real geolocation in XMP (42.6977° N, 23.3219° E, 550m), APP2 MPF segment, and APP2 ICC placed before APP1
        const { parseExifGps } = await import('./metadata-utils.js');
        const fujiTiff = buildExifTiffPayload({
          title: 'DSCF0141 Streetlamps',
          make: 'FUJIFILM',
          model: 'X100V',
          orientation: 6,
          width: 120,
          height: 80,
          gps: { latitude: 42.6977, longitude: 23.3219, altitude: 550 },
        });
        const zeroedFujiTiff = fujiTiff.slice();
        zeroedFujiTiff.fill(0, zeroedFujiTiff.length - 56);
        const app1ZeroedFuji = createJpegSegment(
          0xe1,
          new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...zeroedFujiTiff])
        );
        const app1FujiXmp = createJpegSegment(
          0xe1,
          new TextEncoder().encode(
            'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:RDF><rdf:Description exif:GPSLatitude="42,41.862N" exif:GPSLongitude="23,19.314E" exif:GPSAltitude="550/1" exif:GPSAltitudeRef="0"/></rdf:RDF></x:xmpmeta>'
          )
        );
        const app2FujiMpf = createJpegSegment(
          0xe2,
          new Uint8Array([0x4d, 0x50, 0x46, 0x00, 0x49, 0x49, 0x2a, 0x00])
        );
        const dscfBytes = new Uint8Array([
          0xff, 0xd8,
          ...app2FujiMpf,
          ...app1ZeroedFuji,
          ...app1FujiXmp,
          ...sensorRawBytes.subarray(2),
        ]);
        const dscfFile = new File([dscfBytes], 'DSCF0141.JPG', { type: 'image/jpeg' });
        await app.loadUserFile(dscfFile);
        const expDscf = await app.exportPhoto();
        const expDscfBytes = new Uint8Array(await expDscf.blob.arrayBuffer());
        const expDscfMeta = extractImageMetadata(expDscfBytes, 'image/jpeg', expDscf.filename);
        const expDscfDirectIfd0Gps = parseExifGps(expDscfMeta.rawExifTiff, { ifd0Only: true });

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
          vertExportFilename: expVert.filename,
          vertExportOrientation: expVertMeta.orientation,
          vertDecodedWidth: decodedExportImg.width,
          vertDecodedHeight: decodedExportImg.height,
          pureHorizFilename: expPureHoriz.filename,
          pureHorizWidth: decodedPureHoriz.width,
          pureHorizHeight: decodedPureHoriz.height,
          fileInputAccept,
          gpsBadgeText,
          gpsPreviewFilename,
          gpsExportFilename: expGps.filename,
          gpsExportHasGps: expGpsMeta.hasGps,
          gpsExportCoords: expGpsMeta.gps,
          dscfExportFilename: expDscf.filename,
          dscfFirstMarker: (expDscfBytes[2] << 8) | expDscfBytes[3],
          dscfDirectIfd0Gps: expDscfDirectIfd0Gps,
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

      assert.equal(metaRes.vertExportFilename, 'Vertical_Portrait_0042.jpeg');
      assert.equal(metaRes.vertExportOrientation, 1);
      assert.equal(metaRes.vertDecodedWidth, 80, 'Expected EXIF-oriented vertical image to remain 80px wide on export');
      assert.equal(metaRes.vertDecodedHeight, 120, 'Expected EXIF-oriented vertical image to remain 120px tall on export');

      assert.equal(metaRes.pureHorizFilename, 'Wide_Panorama_160x90.png');
      assert.equal(metaRes.pureHorizWidth, 160);
      assert.equal(metaRes.pureHorizHeight, 90);

      assert.equal(
        metaRes.fileInputAccept,
        '',
        'Expected #file-input to omit the accept attribute so mobile browsers do not attach EXTRA_MIME_TYPES image/* filters that trigger OS gallery GPS redaction'
      );
      assert.ok(metaRes.gpsBadgeText.includes('GPS'), 'Expected metadata badge to indicate GPS tag detected');
      assert.equal(metaRes.gpsPreviewFilename, 'PXL_20260514_192210.jpg');
      assert.equal(metaRes.gpsExportFilename, 'PXL_20260514_192210.jpg');
      assert.equal(metaRes.gpsExportHasGps, true);
      assert.ok(Math.abs(metaRes.gpsExportCoords.latitude - 37.8199) < 0.0001);
      assert.ok(Math.abs(metaRes.gpsExportCoords.longitude - -122.4783) < 0.0001);
      assert.equal(metaRes.gpsExportCoords.altitude, 67.5);

      assert.equal(metaRes.dscfExportFilename, 'DSCF0141.JPG');
      assert.equal(metaRes.dscfFirstMarker, 0xffe1, 'Expected APP1 EXIF immediately after SOI at offset 2');
      assert.ok(metaRes.dscfDirectIfd0Gps, 'Expected exported DSCF0141.JPG IFD0 to contain valid GPSInfo (0x8825)');
      assert.ok(Math.abs(metaRes.dscfDirectIfd0Gps.latitude - 42.6977) < 0.0001);
      assert.ok(Math.abs(metaRes.dscfDirectIfd0Gps.longitude - 23.3219) < 0.0001);
      assert.equal(metaRes.dscfDirectIfd0Gps.altitude, 550);

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

    await t.test('8. Progressive Web App (PWA) Manifest, Icons, Offline Service Worker & Homescreen Install Flow', async () => {
      const pwaRes = await browser.evaluate(`
        const app = window.halationStudio;

        // 1. Verify Web App Manifest link & standalone homescreen meta tags
        const manifestHref = document.querySelector('link[rel="manifest"]')?.getAttribute('href');
        const appleCapable = document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content');
        const mobileCapable = document.querySelector('meta[name="mobile-web-app-capable"]')?.getAttribute('content');
        const appleTouchIcon = document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href');
        const viewportContent = document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '';

        const manifestResp = await fetch(manifestHref);
        const manifestJson = await manifestResp.json();

        // Verify all manifest icons and apple-touch-icon resolve with HTTP 200
        const iconUrls = [...manifestJson.icons.map(i => i.src), appleTouchIcon];
        const iconStatuses = await Promise.all(
          iconUrls.map(async (u) => {
            const r = await fetch(u);
            return r.status;
          })
        );

        // 2. Verify Service Worker registration & offline cache population
        const swReg = await app.swRegistrationPromise;
        await navigator.serviceWorker.ready;
        const cacheKeys = await caches.keys();

        // 3. Verify beforeinstallprompt -> #install-app-btn click -> appinstalled flow
        const installBtn = document.getElementById('install-app-btn');
        let promptCalled = false;
        const fakeInstallEvt = new Event('beforeinstallprompt', { cancelable: true });
        fakeInstallEvt.prompt = async () => {
          promptCalled = true;
        };
        fakeInstallEvt.userChoice = Promise.resolve({ outcome: 'accepted' });
        window.dispatchEvent(fakeInstallEvt);
        const displayOnPrompt = installBtn.style.display;

        installBtn.click();
        await new Promise(r => setTimeout(r, 40));
        const displayAfterAccept = installBtn.style.display;

        // Also fire appinstalled event
        window.dispatchEvent(new Event('appinstalled'));
        const toastOnInstalled = document.getElementById('toast-banner').textContent;

        // 4. Verify OS File Handling launchQueue consumer
        const cLaunch = document.createElement('canvas');
        cLaunch.width = 40;
        cLaunch.height = 30;
        const lctx = cLaunch.getContext('2d');
        lctx.fillStyle = '#101218';
        lctx.fillRect(0, 0, 40, 30);
        const launchBlob = await new Promise(r => cLaunch.toBlob(r, 'image/png'));
        const launchFile = new File([launchBlob], 'launched_from_homescreen.png', {
          type: 'image/png',
        });

        const hasNativeLaunchQueue = Boolean(window.launchQueue && typeof window.launchQueue.setConsumer === 'function');
        await app._handleLaunchQueueParams({
          files: [{ getFile: async () => launchFile }],
        });
        const launchedFileName = app.originalFileName;

        return {
          manifestHref,
          appleCapable,
          mobileCapable,
          viewportHasFitCover: viewportContent.includes('viewport-fit=cover'),
          manifestName: manifestJson.name,
          manifestShortName: manifestJson.short_name,
          manifestDisplay: manifestJson.display,
          manifestIconCount: manifestJson.icons.length,
          iconStatuses,
          swRegistered: Boolean(swReg),
          hasPwaCache: cacheKeys.some(k => k.startsWith('halation-studio-pwa-')),
          displayOnPrompt,
          promptCalled,
          displayAfterAccept,
          toastOnInstalled,
          launchedFileName,
        };
      `);

      assert.equal(pwaRes.manifestHref, './manifest.webmanifest');
      assert.equal(pwaRes.appleCapable, 'yes');
      assert.equal(pwaRes.mobileCapable, 'yes');
      assert.equal(pwaRes.viewportHasFitCover, true);
      assert.equal(pwaRes.manifestName, 'Halation Optical Studio');
      assert.equal(pwaRes.manifestShortName, 'Halation');
      assert.equal(pwaRes.manifestDisplay, 'standalone');
      assert.equal(pwaRes.manifestIconCount, 4);
      assert.deepEqual(pwaRes.iconStatuses, [200, 200, 200, 200, 200]);
      assert.equal(pwaRes.swRegistered, true);
      assert.equal(pwaRes.hasPwaCache, true);
      assert.equal(pwaRes.displayOnPrompt, 'inline-flex');
      assert.equal(pwaRes.promptCalled, true);
      assert.equal(pwaRes.displayAfterAccept, 'none');
      assert.ok(pwaRes.toastOnInstalled.includes('installed to your device'));
      assert.equal(pwaRes.launchedFileName, 'launched_from_homescreen.png');
    });

    await t.test('9. Whole-Project Browser V8 Code Coverage Verification', async () => {
      const { result: postReloadCoverage } = await browser.sendCommand('Profiler.takePreciseCoverage');
      const scriptCoverages = [...preReloadCoverage, ...(postReloadCoverage || [])];
      const targetFiles = ['app.js', 'halation-engine.js', 'metadata-utils.js', 'session-cache.js'];

      let totalExec = 0;
      let totalCov = 0;
      const reportRows = [];
      const fileStats = {};

      for (const fname of targetFiles) {
        const matchingEntries = scriptCoverages.filter((s) =>
          s.url.split('?')[0].endsWith('/' + fname)
        );
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
