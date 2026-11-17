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

test('Halation Optical Studio — End-to-End Browser UI Test Suite', async (t) => {
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
        };
      `);

      assert.equal(state.title, 'Halation Optical Studio');
      assert.equal(state.sliderCount, 10, 'Expected all 10 optical range sliders');
      assert.equal(state.toggleCount, 8, 'Expected all 8 slide toggles including stripMetadata');
      assert.ok(state.presetCount >= 4, 'Expected film stock preset cards');
      assert.equal(state.hasStripToggle, true);
      assert.equal(state.stripChecked, false);
      assert.ok(state.metadataBadgeText.includes('Metadata Preserved'));
      assert.equal(state.exportFilenamePreview, 'example1-input.png');
      assert.ok(state.canvasWidth > 0 && state.canvasHeight > 0);
    });

    await t.test('2. Sliders, Slide Toggles, Presets, Split Curtain & Mobile Tabs Interaction', async () => {
      const res = await browser.evaluate(`
        const app = window.halationStudio;

        // Slider input & double-click reset
        const strengthSlider = document.getElementById('slider-strength');
        strengthSlider.value = '175';
        strengthSlider.dispatchEvent(new Event('input', { bubbles: true }));
        const valAfterInput = document.getElementById('val-strength').textContent;
        const activePresetAfterManual = app.activePresetKey;

        strengthSlider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const valAfterReset = document.getElementById('val-strength').textContent;

        // Master Enable Toggle disables dependent slider groups
        const enableToggle = document.getElementById('toggle-enabled');
        enableToggle.checked = false;
        enableToggle.dispatchEvent(new Event('change', { bubbles: true }));
        const strengthDisabledWhenBypassed = document.getElementById('group-strength').classList.contains('disabled');

        enableToggle.checked = true;
        enableToggle.dispatchEvent(new Event('change', { bubbles: true }));
        const strengthEnabledAfterRestore = !document.getElementById('group-strength').classList.contains('disabled');

        // Preset card selection
        document.querySelector('.preset-card[data-preset="vision3Remjet"]').click();
        const presetStrength = app.params.strength;

        // Comparison view modes & keyboard split divider navigation
        document.getElementById('view-mode-single').click();
        const singleModeHiddenOverlay = document.getElementById('comparison-overlay').classList.contains('hidden');
        document.getElementById('view-mode-split').click();

        const divider = document.getElementById('split-divider');
        divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        const splitAfterArrow = app.splitPercent;

        // Zoom controls
        document.getElementById('zoom-in-btn').click();
        const zoomedLabel = document.getElementById('zoom-reset-btn').textContent;
        document.getElementById('zoom-reset-btn').click();
        const resetZoomLabel = document.getElementById('zoom-reset-btn').textContent;

        // Mobile tabs switching
        const togglesTabBtn = document.querySelector('.mobile-tab-btn[data-tab-target="toggles"]');
        togglesTabBtn.click();
        const togglesSectionActive = document
          .querySelector('.control-section[data-mobile-tab="toggles"]')
          .classList.contains('mobile-active');

        return {
          valAfterInput,
          activePresetAfterManual,
          valAfterReset,
          strengthDisabledWhenBypassed,
          strengthEnabledAfterRestore,
          presetStrength,
          singleModeHiddenOverlay,
          splitAfterArrow,
          zoomedLabel,
          resetZoomLabel,
          togglesSectionActive,
        };
      `);

      assert.equal(res.valAfterInput, '175%');
      assert.equal(res.activePresetAfterManual, null);
      assert.equal(res.valAfterReset, '135%');
      assert.equal(res.strengthDisabledWhenBypassed, true);
      assert.equal(res.strengthEnabledAfterRestore, true);
      assert.equal(res.presetStrength, 155);
      assert.equal(res.singleModeHiddenOverlay, true);
      assert.equal(res.splitAfterArrow, 53);
      assert.equal(res.zoomedLabel, '125%');
      assert.equal(res.resetZoomLabel, '100%');
      assert.equal(res.togglesSectionActive, true);
    });

    await t.test('3. JPEG Upload Preserves Exact Metadata & Filename on Export, and Strip Toggle Removes It', async () => {
      const jpegRes = await browser.evaluate(`
        const {
          extractImageMetadata,
          injectImageMetadataBytes,
          buildExifTiffPayload,
          createJpegSegment,
          parseExifTitle,
        } = await import('./metadata-utils.js');

        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = 48;
        tmpCanvas.height = 48;
        const ctx = tmpCanvas.getContext('2d');
        ctx.fillStyle = '#101218';
        ctx.fillRect(0, 0, 48, 48);
        ctx.fillStyle = '#ffebcc';
        ctx.fillRect(16, 16, 16, 16);

        const baseJpegBlob = await new Promise(r => tmpCanvas.toBlob(r, 'image/jpeg', 0.95));
        const baseJpegBytes = new Uint8Array(await baseJpegBlob.arrayBuffer());

        const exifTiff = buildExifTiffPayload({
          title: 'Cinema Frame 800T',
          artist: 'Valentin Vasilev',
          make: 'ARRI',
          model: 'Arriflex 435',
        });
        const exifPayload = new Uint8Array(6 + exifTiff.length);
        exifPayload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
        exifPayload.set(exifTiff, 6);
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

        const app = window.halationStudio;
        await app.loadUserFile(jpegFile);

        const expPreserved = await app.exportPhoto();
        const expPreservedBytes = new Uint8Array(await expPreserved.blob.arrayBuffer());
        const expPreservedMeta = extractImageMetadata(expPreservedBytes, 'image/jpeg', expPreserved.filename);

        // Toggle Strip Metadata ON
        const stripToggle = document.getElementById('toggle-stripMetadata');
        stripToggle.checked = true;
        stripToggle.dispatchEvent(new Event('change', { bubbles: true }));

        const expStripped = await app.exportPhoto();
        const expStrippedBytes = new Uint8Array(await expStripped.blob.arrayBuffer());
        const expStrippedMeta = extractImageMetadata(expStrippedBytes, 'image/jpeg', expStripped.filename);

        // Restore Strip Metadata OFF
        stripToggle.checked = false;
        stripToggle.dispatchEvent(new Event('change', { bubbles: true }));

        return {
          autoSelectedMime: app.exportMime,
          preservedFilename: expPreserved.filename,
          preservedHasMeta: expPreservedMeta.hasMetadata,
          preservedExifTitle: parseExifTitle(expPreservedMeta.rawExifTiff),
          preservedSegCount: expPreservedMeta.jpegSegments.length,
          strippedFilename: expStripped.filename,
          strippedHasMeta: expStrippedMeta.hasMetadata,
          strippedSegCount: expStrippedMeta.jpegSegments.length,
        };
      `);

      assert.equal(jpegRes.autoSelectedMime, 'image/jpeg');
      assert.equal(jpegRes.preservedFilename, 'Cinema_Frame_800T.JPG');
      assert.equal(jpegRes.preservedHasMeta, true);
      assert.equal(jpegRes.preservedExifTitle, 'Cinema Frame 800T');
      assert.equal(jpegRes.preservedSegCount, 2);
      assert.equal(jpegRes.strippedFilename, 'Cinema_Frame_800T.JPG');
      assert.equal(jpegRes.strippedHasMeta, false);
      assert.equal(jpegRes.strippedSegCount, 0);
    });

    await t.test('4. PNG Upload Preserves Exact Metadata & Filename on Export, and Strip Toggle Removes It', async () => {
      const pngRes = await browser.evaluate(`
        const {
          extractImageMetadata,
          injectImageMetadataBytes,
          buildExifTiffPayload,
          createPngChunk,
          createPngTextChunk,
          createPngITXtChunk,
          parseExifTitle,
        } = await import('./metadata-utils.js');

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

        const app = window.halationStudio;
        await app.loadUserFile(uploadFile);

        const export1 = await app.exportPhoto();
        const export1Bytes = new Uint8Array(await export1.blob.arrayBuffer());
        const export1Meta = extractImageMetadata(export1Bytes, 'image/png', export1.filename);

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
          export1Filename: export1.filename,
          export1HasMetadata: export1Meta.hasMetadata,
          export1Title: export1Meta.title,
          export1ExifTitle: parseExifTitle(export1Meta.rawExifTiff),
          export1Tags: export1Meta.tagsSummary,
          export1ChunkCount: export1Meta.pngChunks.length,
          badgeWhenStripped,
          export2Filename: export2.filename,
          export2HasMetadata: export2Meta.hasMetadata,
          export2ChunkCount: export2Meta.pngChunks.length,
        };
      `);

      assert.equal(pngRes.export1Filename, 'Golden_Gate_Midnight_800T.png');
      assert.equal(pngRes.export1HasMetadata, true);
      assert.equal(pngRes.export1Title, 'Golden Gate Midnight 800T');
      assert.equal(pngRes.export1ExifTitle, 'Golden Gate Midnight 800T');
      assert.ok(pngRes.export1Tags.includes('EXIF'));
      assert.ok(pngRes.export1Tags.includes('XMP'));
      assert.ok(pngRes.export1Tags.includes('Title'));
      assert.equal(pngRes.export1ChunkCount, 4);

      assert.equal(pngRes.badgeWhenStripped, 'Metadata Stripped');
      assert.equal(pngRes.export2Filename, 'Golden_Gate_Midnight_800T.png');
      assert.equal(pngRes.export2HasMetadata, false);
      assert.equal(pngRes.export2ChunkCount, 0);
    });

    await t.test('5. Accidental Page Refresh Restores Last Uploaded Image, Metadata & Studio State', async () => {
      await browser.sendCommand('Page.reload', { ignoreCache: false });

      const afterRefresh = await browser.evaluate(`
        while (!window.halationStudio || !window.halationStudio.readyPromise) {
          await new Promise(r => setTimeout(r, 50));
        }
        await window.halationStudio.readyPromise;

        const { extractImageMetadata, parseExifTitle } = await import('./metadata-utils.js');
        const app = window.halationStudio;

        // Export immediately after reload to prove cached image & metadata survived refresh
        const postRefreshExport = await app.exportPhoto();
        const postRefreshBytes = new Uint8Array(await postRefreshExport.blob.arrayBuffer());
        const postRefreshMeta = extractImageMetadata(
          postRefreshBytes,
          'image/png',
          postRefreshExport.filename
        );

        // Also test switching to Example 1 and clicking custom-photo-chip to return to cached upload
        await app.loadBuiltinSample('example1');
        const sampleAfterSwitch = app.currentSampleKey;
        document.getElementById('custom-photo-chip').click();
        await new Promise(r => setTimeout(r, 150));
        const sampleAfterChipClick = app.currentSampleKey;

        return {
          currentSampleKey: 'custom',
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
    });
  } finally {
    await browser.close();
    server.close();
  }
});
