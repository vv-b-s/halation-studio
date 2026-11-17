import test from 'node:test';
import assert from 'node:assert/strict';
import { HalationEngine, DEFAULT_PARAMS, PRESETS } from '../halation-engine.js';

/**
 * Creates a mock HTMLCanvasElement & WebGLRenderingContext / CanvasRenderingContext2D
 * so HalationEngine can be unit-tested directly in Node.js as well as in headless Chromium.
 */
function createMockWebGLCanvas({
  failWebGL = false,
  failShaderCompile = false,
  failProgramLink = false,
  maxTexSize = 4096,
} = {}) {
  const calls = [];
  const createdTextures = [];
  const createdFramebuffers = [];
  const deletedTextures = [];
  const deletedFramebuffers = [];
  let loseContextCalled = false;

  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    MAX_TEXTURE_SIZE: 0x0d33,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    TEXTURE_2D: 0x0de1,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    CLAMP_TO_EDGE: 0x812f,
    LINEAR: 0x2601,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    FLOAT: 0x1406,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE2: 0x84c2,
    TEXTURE3: 0x84c3,
    TRIANGLES: 0x0004,

    getParameter(p) {
      if (p === this.MAX_TEXTURE_SIZE) return maxTexSize;
      return 0;
    },
    createShader(type) {
      return { type };
    },
    shaderSource() {},
    compileShader() {},
    getShaderParameter() {
      return !failShaderCompile;
    },
    getShaderInfoLog() {
      return 'Mock shader compile error';
    },
    deleteShader() {},
    createProgram() {
      return {};
    },
    attachShader() {},
    linkProgram() {},
    getProgramParameter() {
      return !failProgramLink;
    },
    getProgramInfoLog() {
      return 'Mock program link error';
    },
    createBuffer() {
      return {};
    },
    bindBuffer() {},
    bufferData() {},
    createTexture() {
      const t = { id: createdTextures.length + 1 };
      createdTextures.push(t);
      return t;
    },
    deleteTexture(t) {
      deletedTextures.push(t);
    },
    bindTexture() {},
    texParameteri() {},
    texImage2D(...args) {
      calls.push(['texImage2D', ...args]);
    },
    createFramebuffer() {
      const f = { id: createdFramebuffers.length + 1 };
      createdFramebuffers.push(f);
      return f;
    },
    deleteFramebuffer(f) {
      deletedFramebuffers.push(f);
    },
    bindFramebuffer() {},
    framebufferTexture2D() {},
    pixelStorei() {},
    useProgram() {},
    getAttribLocation() {
      return 0;
    },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    getUniformLocation(_prog, name) {
      return name;
    },
    viewport() {},
    activeTexture() {},
    uniform1i(loc, v) {
      calls.push(['uniform1i', loc, v]);
    },
    uniform1f(loc, v) {
      calls.push(['uniform1f', loc, v]);
    },
    uniform2f(loc, v1, v2) {
      calls.push(['uniform2f', loc, v1, v2]);
    },
    drawArrays(mode, first, count) {
      calls.push(['drawArrays', mode, first, count]);
    },
    getExtension(name) {
      if (name === 'WEBGL_lose_context') {
        return {
          loseContext() {
            loseContextCalled = true;
          },
        };
      }
      return null;
    },
  };

  const pixelBuffer = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < pixelBuffer.length; i += 4) {
    // Make half the pixels bright highlights (250) and half dark (20)
    const v = i < pixelBuffer.length / 2 ? 250 : 20;
    pixelBuffer[i] = v;
    pixelBuffer[i + 1] = v;
    pixelBuffer[i + 2] = v;
    pixelBuffer[i + 3] = 255;
  }

  const ctx2d = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    fillStyle: '#000',
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    filter: 'none',
    clearRect(...args) {
      calls.push(['clearRect', ...args]);
    },
    fillRect(...args) {
      calls.push(['fillRect', ...args]);
    },
    drawImage(...args) {
      calls.push(['drawImage', ...args]);
    },
    getImageData(_x, _y, w, h) {
      return { data: new Uint8ClampedArray(pixelBuffer.subarray(0, w * h * 4)) };
    },
    putImageData(imgData) {
      calls.push(['putImageData', imgData.data[0]]);
    },
    save() {},
    restore() {},
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext(type) {
      if (type === 'webgl2' || type === 'webgl') {
        return failWebGL ? null : gl;
      }
      if (type === '2d') {
        return ctx2d;
      }
      return null;
    },
    toBlob(cb, mimeType = 'image/png') {
      cb(new Blob([new Uint8Array([1, 2, 3, 4])], { type: mimeType }));
    },
  };

  return {
    canvas,
    gl,
    ctx2d,
    calls,
    createdTextures,
    createdFramebuffers,
    deletedTextures,
    deletedFramebuffers,
    wasLoseContextCalled: () => loseContextCalled,
  };
}

// Provide minimal document.createElement('canvas') shim in Node for offscreen scaling/export tests
function withDocumentCanvasMock(fn, canvasFactory = () => createMockWebGLCanvas().canvas) {
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return canvasFactory();
      return {};
    },
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.document = prevDoc;
    });
}

test('DEFAULT_PARAMS and all 5 PRESETS contain valid optical parameter ranges', () => {
  const requiredKeys = [
    'enabled',
    'soloHalation',
    'strength',
    'radius',
    'threshold',
    'softness',
    'warmth',
    'redSensitivity',
    'pointBoost',
    'edgeGate',
    'bloom',
    'grain',
    'pointBoostEnabled',
    'dualLayerEnabled',
    'edgeGateEnabled',
    'bloomEnabled',
    'grainEnabled',
  ];

  for (const key of requiredKeys) {
    assert.ok(key in DEFAULT_PARAMS, `DEFAULT_PARAMS missing ${key}`);
  }
  assert.equal(DEFAULT_PARAMS.stripMetadata, false);

  const presetKeys = Object.keys(PRESETS);
  assert.deepEqual(presetKeys, [
    'reference800T',
    'vision3Remjet',
    'neonPointLights',
    'subtleDaylight',
    'proMistAmber',
  ]);

  for (const [name, preset] of Object.entries(PRESETS)) {
    assert.ok(preset.name && preset.badge && preset.description, `Preset ${name} metadata incomplete`);
    for (const key of requiredKeys) {
      assert.ok(key in preset.params, `Preset ${name} missing param ${key}`);
    }
    assert.ok(preset.params.strength >= 0 && preset.params.strength <= 200);
    assert.ok(preset.params.radius >= 2 && preset.params.radius <= 60);
    assert.ok(preset.params.threshold >= 20 && preset.params.threshold <= 98);
  }
});

test('HalationEngine WebGL pipeline initializes shaders, manages FBOs, scales textures, and renders all passes', async () => {
  await withDocumentCanvasMock(async () => {
    const mock = createMockWebGLCanvas({ maxTexSize: 1024 });
    const engine = new HalationEngine(mock.canvas);
    assert.equal(engine.useFallback, false);
    assert.equal(engine.maxTexSize, 1024);

    // Calling render() before setImage() should safely no-op
    engine.render();
    assert.equal(mock.calls.filter((c) => c[0] === 'drawArrays').length, 0);

    // 1. setImage at native size (500x400)
    const img = { naturalWidth: 500, naturalHeight: 400 };
    engine.setImage(img);
    assert.equal(engine.imageWidth, 500);
    assert.equal(engine.imageHeight, 400);
    assert.equal(engine.fboWidth, 500);
    assert.equal(engine.fboHeight, 400);

    // Calling setImage with identical dimensions reuses existing FBOs without deleting
    engine.setImage(img, 500, 400);
    assert.equal(mock.deletedTextures.length, 0);

    // 2. setImage with oversized dimensions (> maxTexSize 1024) clamps to maxTexSize preserving aspect ratio
    engine.setImage({ naturalWidth: 2048, naturalHeight: 1024 });
    assert.equal(engine.imageWidth, 1024);
    assert.equal(engine.imageHeight, 512);
    assert.ok(mock.deletedTextures.length > 0, 'Expected old FBO textures to be cleaned up on resize');

    // 3. Full render with all optical features enabled
    mock.calls.length = 0;
    engine.render({
      ...DEFAULT_PARAMS,
      enabled: true,
      soloHalation: false,
      grainEnabled: true,
      grain: 35,
    });
    const drawCountEnabled = mock.calls.filter((c) => c[0] === 'drawArrays').length;
    // 2 (localBg blur) + 1 (extract) + 6 (3-octave separable blurs) + 1 (composite) = 10 draw calls
    assert.equal(drawCountEnabled, 10);

    // 4. Render with enabled: false bypasses blur/extract passes and runs only composite pass (1 draw call)
    mock.calls.length = 0;
    engine.render({
      ...DEFAULT_PARAMS,
      enabled: false,
      pointBoostEnabled: false,
      edgeGateEnabled: false,
      dualLayerEnabled: false,
      bloomEnabled: false,
      grainEnabled: false,
      soloHalation: true,
    });
    const drawCountBypassed = mock.calls.filter((c) => c[0] === 'drawArrays').length;
    assert.equal(drawCountBypassed, 1);

    // 5. exportFullResolution renders at native image resolution and destroys temporary context
    const blob = await engine.exportFullResolution(
      { naturalWidth: 640, naturalHeight: 480 },
      DEFAULT_PARAMS,
      'image/png',
      1.0
    );
    assert.equal(blob.type, 'image/png');
    assert.ok(blob.size > 0);

    // 6. destroy() releases WebGL context
    engine.destroy();
    assert.equal(mock.wasLoseContextCalled(), true);
    assert.equal(engine.gl, null);
  });
});

test('HalationEngine automatically falls back to Canvas2D when WebGL or shader compilation fails', async () => {
  await withDocumentCanvasMock(async () => {
    // Case A: WebGL context unavailable
    const noGlMock = createMockWebGLCanvas({ failWebGL: true });
    const engine2D = new HalationEngine(noGlMock.canvas);
    assert.equal(engine2D.useFallback, true);

    engine2D.setImage({ width: 32, height: 32 });
    assert.equal(engine2D.imageWidth, 32);
    assert.equal(engine2D.imageHeight, 32);

    // Render normal 2D fallback (draws original + 2 blurred screen passes = 3 drawImage calls)
    noGlMock.calls.length = 0;
    engine2D.render({ ...DEFAULT_PARAMS, enabled: true, soloHalation: false });
    assert.equal(noGlMock.calls.filter((c) => c[0] === 'drawImage').length, 3);

    // Render soloHalation in 2D fallback (fills black + 2 blurred screen passes = 2 drawImage calls)
    noGlMock.calls.length = 0;
    engine2D.render({ ...DEFAULT_PARAMS, enabled: true, soloHalation: true });
    assert.ok(noGlMock.calls.some((c) => c[0] === 'fillRect'));
    assert.equal(noGlMock.calls.filter((c) => c[0] === 'drawImage').length, 2);

    // Render disabled bypass in 2D fallback (only draws original image = 1 drawImage call)
    noGlMock.calls.length = 0;
    engine2D.render({ ...DEFAULT_PARAMS, enabled: false, soloHalation: false });
    assert.equal(noGlMock.calls.filter((c) => c[0] === 'drawImage').length, 1);

    // Case B: Shader compilation error triggers fallback
    const badShaderMock = createMockWebGLCanvas({ failShaderCompile: true });
    const engineShaderFallback = new HalationEngine(badShaderMock.canvas);
    assert.equal(engineShaderFallback.useFallback, true);

    // Case C: Program link error triggers fallback
    const badLinkMock = createMockWebGLCanvas({ failProgramLink: true });
    const engineLinkFallback = new HalationEngine(badLinkMock.canvas);
    assert.equal(engineLinkFallback.useFallback, true);
  });
});
