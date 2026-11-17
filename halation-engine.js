/**
 * Halation Optical Studio — WebGL2 / WebGL1 Multi-Pass Emulsion Scatter Engine
 * Simulates physical 35mm motion-picture film halation (e.g. CineStill 800T / Kodak Vision3)
 * with resolution-independent multi-octave Gaussian scattering, emissive point-light detection,
 * dual-layer spectral emulsion response (inner amber core + outer crimson halo), and lossless export.
 */

export const DEFAULT_PARAMS = {
  // Master toggle & view modes
  enabled: true,
  soloHalation: false,

  // Primary Halation Sliders
  strength: 135,          // 0 .. 200 (%)
  radius: 18,             // 2 .. 60 (relative optical units per 1000px)
  threshold: 80,          // 20 .. 98 (%)
  softness: 32,           // 5 .. 100 (%)
  warmth: 40,             // 0 (Deep Red) .. 100 (Amber Gold)
  redSensitivity: 55,     // 0 .. 100 (%)

  // Secondary Optical Sliders
  pointBoost: 115,        // 0 .. 200 (%) - boosts tiny point sources (tower lights, distant lamps)
  edgeGate: 72,           // 0 .. 100 (%) - concentrates halo into dark surrounding regions
  bloom: 18,              // 0 .. 100 (%) - soft highlight mist
  grain: 0,               // 0 .. 100 (%) - organic 35mm film grain

  // Slide Toggles (Boolean switches)
  pointBoostEnabled: true,
  dualLayerEnabled: true,
  edgeGateEnabled: true,
  bloomEnabled: true,
  grainEnabled: false,
  stripMetadata: false,
};

export const PRESETS = {
  reference800T: {
    name: '800T Reference Match',
    badge: 'Default',
    description: 'Calibrated to match the reference night scenes with authentic dual-layer red-orange emulsion scatter and point-light bloom.',
    params: {
      enabled: true,
      soloHalation: false,
      strength: 135,
      radius: 18,
      threshold: 80,
      softness: 32,
      warmth: 40,
      redSensitivity: 55,
      pointBoost: 115,
      edgeGate: 72,
      bloom: 18,
      grain: 0,
      pointBoostEnabled: true,
      dualLayerEnabled: true,
      edgeGateEnabled: true,
      bloomEnabled: true,
      grainEnabled: false,
    },
  },
  vision3Remjet: {
    name: 'Vision3 500T Cinema',
    badge: 'Cinema',
    description: 'Deep crimson-vermilion outer scatter with tight highlight rolloff, modeled after remjet-stripped 35mm motion picture stock.',
    params: {
      enabled: true,
      soloHalation: false,
      strength: 155,
      radius: 24,
      threshold: 76,
      softness: 28,
      warmth: 26,
      redSensitivity: 70,
      pointBoost: 130,
      edgeGate: 80,
      bloom: 24,
      grain: 18,
      pointBoostEnabled: true,
      dualLayerEnabled: true,
      edgeGateEnabled: true,
      bloomEnabled: true,
      grainEnabled: true,
    },
  },
  neonPointLights: {
    name: 'Night Beacons & Neon',
    badge: 'Night',
    description: 'High micro-contrast point source amplification for distant city windows, radio towers, and street lamps.',
    params: {
      enabled: true,
      soloHalation: false,
      strength: 165,
      radius: 21,
      threshold: 74,
      softness: 38,
      warmth: 35,
      redSensitivity: 68,
      pointBoost: 160,
      edgeGate: 76,
      bloom: 28,
      grain: 0,
      pointBoostEnabled: true,
      dualLayerEnabled: true,
      edgeGateEnabled: true,
      bloomEnabled: true,
      grainEnabled: false,
    },
  },
  subtleDaylight: {
    name: '400D Subtle Fringe',
    badge: 'Subtle',
    description: 'Gentle warm edge halation confined to specular highlights without overpowering midtones.',
    params: {
      enabled: true,
      soloHalation: false,
      strength: 82,
      radius: 11,
      threshold: 86,
      softness: 25,
      warmth: 48,
      redSensitivity: 40,
      pointBoost: 65,
      edgeGate: 82,
      bloom: 10,
      grain: 8,
      pointBoostEnabled: true,
      dualLayerEnabled: true,
      edgeGateEnabled: true,
      bloomEnabled: false,
      grainEnabled: false,
    },
  },
  proMistAmber: {
    name: 'Warm Pro-Mist 1/4',
    badge: 'Dreamy',
    description: 'Lush golden-amber halation paired with atmospheric highlight mist and soft contrast.',
    params: {
      enabled: true,
      soloHalation: false,
      strength: 125,
      radius: 28,
      threshold: 72,
      softness: 48,
      warmth: 64,
      redSensitivity: 45,
      pointBoost: 95,
      edgeGate: 55,
      bloom: 45,
      grain: 14,
      pointBoostEnabled: true,
      dualLayerEnabled: true,
      edgeGateEnabled: true,
      bloomEnabled: true,
      grainEnabled: true,
    },
  },
};

const VERTEX_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

// Separable 13-tap Gaussian blur shader with configurable radius & direction
const BLUR_FRAGMENT_SHADER = `
  precision highp float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform vec2 u_step;      // (1/width, 0) or (0, 1/height)
  uniform float u_sigma;    // blur sigma in pixels

  void main() {
    if (u_sigma <= 0.25) {
      gl_FragColor = texture2D(u_tex, v_uv);
      return;
    }
    // Sample 13 taps across [-3.0 * sigma, +3.0 * sigma]
    vec4 acc = vec4(0.0);
    float norm = 0.0;
    float stride = max(1.0, u_sigma * 0.26);
    for (int i = -12; i <= 12; i++) {
      float offset = float(i) * stride;
      float w = exp(-0.5 * (offset * offset) / max(0.0001, u_sigma * u_sigma));
      acc += texture2D(u_tex, clamp(v_uv + u_step * offset, 0.001, 0.999)) * w;
      norm += w;
    }
    gl_FragColor = acc / max(0.0001, norm);
  }
`;

// Highlight & Emissive Point-Source Extraction Shader
// Outputs:
//   R: primary halation source energy (normalized by 0.25 so range [0..4] fits in [0..1])
//   G: highlight core energy for subtle inner bloom
//   B: local red dominance factor
//   A: 1.0
const EXTRACT_FRAGMENT_SHADER = `
  precision highp float;
  varying vec2 v_uv;
  uniform sampler2D u_image;
  uniform sampler2D u_localBg;
  uniform vec2 u_texel;
  uniform float u_scale;
  uniform float u_threshold;
  uniform float u_softness;
  uniform float u_redSens;
  uniform float u_pointBoost;
  uniform float u_edgeGate;

  float getLum(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  void main() {
    vec3 rgb = texture2D(u_image, v_uv).rgb;
    vec3 bg = texture2D(u_localBg, v_uv).rgb;

    float maxC = max(rgb.r, max(rgb.g, rgb.b));
    float bgLum = getLum(bg);

    // 1. Pure Highlight Extraction (windows, streetlamp cores, bright light fixtures)
    float knee = max(0.02, u_softness * 0.35);
    float t0 = max(0.0, u_threshold - knee);
    float t1 = min(1.0, u_threshold + knee * 0.65);

    float trigger = mix(maxC, max(maxC, rgb.r * 1.08), u_redSens * 0.45);
    float hl = smoothstep(t0, t1, trigger);

    // Broad contrast gating so large flat mid-bright areas (e.g. lit ground/pavement) don't turn orange
    float broadContrast = max(0.0, maxC - bgLum);
    float nearClip = smoothstep(0.91, 0.985, maxC);
    float gateFactor = mix(
      1.0,
      clamp(broadContrast * 3.4 + nearClip * 0.95, 0.0, 1.0),
      u_edgeGate * 0.88
    );
    float pureHl = pow(hl, 1.75) * gateFactor;

    // 2. Emissive Point-Light Detection (5x5 neighborhood dilation in scaled space)
    // Detects small high-contrast point lights & red beacons against dark backgrounds
    float maxPoint = 0.0;
    if (u_pointBoost > 0.001) {
      float stepRadius = max(1.0, 1.35 * u_scale);
      for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
          vec2 sampleUv = clamp(v_uv + vec2(float(dx), float(dy)) * u_texel * stepRadius, 0.001, 0.999);
          vec3 sRgb = texture2D(u_image, sampleUv).rgb;
          vec3 sBg  = texture2D(u_localBg, sampleUv).rgb;
          float sMax = max(sRgb.r, max(sRgb.g, sRgb.b));
          float sBgLum = getLum(sBg);

          float localDiffR = max(0.0, sRgb.r - sBg.r);
          float localDiffL = max(0.0, sMax - sBgLum);
          float redExcess  = max(0.0, sRgb.r - 0.5 * (sRgb.g + sRgb.b));

          // Point light trigger: high local contrast over dark/mid surround, boosted by red excess
          float darkSurround = smoothstep(0.65, 0.12, sBgLum);
          float ptSignal = max(localDiffL * 0.9, localDiffR * (1.0 + u_redSens * redExcess * 3.6)) * darkSurround;
          float ptMask = smoothstep(0.16, 0.52, ptSignal);

          // Radial weight inside the 5x5 dilation kernel
          float dist2 = float(dx * dx + dy * dy);
          float radialW = exp(-dist2 * 0.14);
          maxPoint = max(maxPoint, ptMask * radialW);
        }
      }
    }

    float pointEnergy = maxPoint * u_pointBoost * 1.95;
    float totalEnergy = max(pureHl * 1.35, pointEnergy);

    // Pack with 0.25 scale factor so values up to 4.0 fit in normalized 8-bit / 16-bit FBO
    gl_FragColor = vec4(
      clamp(totalEnergy * 0.25, 0.0, 1.0),
      clamp(hl * 0.5, 0.0, 1.0),
      clamp(max(0.0, rgb.r - rgb.b), 0.0, 1.0),
      1.0
    );
  }
`;

// Final Composite Shader: Combines multi-scale scatter, dual-layer spectral color, bloom, & grain
const COMPOSITE_FRAGMENT_SHADER = `
  precision highp float;
  varying vec2 v_uv;
  uniform sampler2D u_image;
  uniform sampler2D u_blur1;
  uniform sampler2D u_blur2;
  uniform sampler2D u_blur3;

  uniform float u_enabled;
  uniform float u_solo;
  uniform float u_strength;
  uniform float u_warmth;
  uniform float u_edgeGate;
  uniform float u_dualLayer;
  uniform float u_bloom;
  uniform float u_grain;
  uniform vec2 u_resolution;

  float getLum(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  // High-frequency film grain hash
  float hash12(vec2 p) {
    vec3 p3  = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec4 orig = texture2D(u_image, v_uv);
    vec3 base = orig.rgb;

    if (u_enabled < 0.5) {
      gl_FragColor = orig;
      return;
    }

    // Unpack multi-octave scattered energy (rescaled by 4.0)
    vec3 s1 = texture2D(u_blur1, v_uv).rgb;
    vec3 s2 = texture2D(u_blur2, v_uv).rgb;
    vec3 s3 = texture2D(u_blur3, v_uv).rgb;

    float b1 = s1.r * 4.0;
    float b2 = s2.r * 4.0;
    float b3 = s3.r * 4.0;

    // Inner tight core + wide exponential outer tail
    float innerScatter = 0.62 * b1 + 0.38 * b2;
    float outerScatter = 0.44 * b2 + 0.56 * b3;

    // Shadow / Edge Gating: halation glows vividly when bleeding into darker surroundings
    float lum = getLum(base);
    float darkGate = pow(clamp(1.0 - lum * 0.78, 0.12, 1.0), u_edgeGate * 1.15);

    // Spectral Emulsion Color Model:
    // Warmth 0.0 -> deep crimson-red; Warmth 1.0 -> warm golden amber
    vec3 innerTint = vec3(
      1.0,
      mix(0.22, 0.68, u_warmth),
      mix(0.06, 0.34, u_warmth)
    );
    vec3 outerTint = vec3(
      1.0,
      mix(0.08, 0.36, u_warmth),
      mix(0.02, 0.15, u_warmth)
    );

    vec3 singleTint = mix(outerTint, innerTint, 0.55);
    vec3 coreColor  = mix(singleTint, innerTint, u_dualLayer);
    vec3 haloColor  = mix(singleTint, outerTint, u_dualLayer);

    vec3 halo = u_strength * (0.68 * innerScatter * coreColor + 0.88 * outerScatter * haloColor) * darkGate;

    // Optional Highlight Core Mist / Bloom
    if (u_bloom > 0.001) {
      float mist = (0.5 * s2.g + 0.5 * s3.g) * 2.0 * u_bloom;
      halo += mist * vec3(1.0, 0.86, 0.72) * 0.45;
    }

    // Solo view: inspect isolated halation glow on dark background
    if (u_solo > 0.5) {
      vec3 soloOut = 1.0 - exp(-halo * 1.45);
      gl_FragColor = vec4(clamp(soloOut, 0.0, 1.0), 1.0);
      return;
    }

    // Filmic Soft-Exposure Screen Blend
    vec3 outColor = 1.0 - (1.0 - base) * exp(-halo * 1.38);

    // Optional 35mm Film Grain (midtone-weighted organic luminance + subtle chroma grain)
    if (u_grain > 0.001) {
      vec2 grainCoord = floor(v_uv * u_resolution * 0.85);
      float n1 = hash12(grainCoord) - 0.5;
      float n2 = hash12(grainCoord + vec2(17.3, 41.7)) - 0.5;
      float grainMask = 4.0 * lum * (1.0 - lum * 0.75); // strongest in shadows/midtones
      outColor += vec3(n1, n1 * 0.92 + n2 * 0.08, n1 * 0.85 - n2 * 0.15) * (u_grain * 0.09 * grainMask);
    }

    gl_FragColor = vec4(clamp(outColor, 0.0, 1.0), orig.a);
  }
`;

export class HalationEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.ctx2d = null;
    this.useFallback = false;
    this.programs = {};
    this.textures = {};
    this.framebuffers = {};
    this.imageWidth = 0;
    this.imageHeight = 0;
    this.sourceImage = null;
    this.fboWidth = 0;
    this.fboHeight = 0;

    try {
      this._initWebGL();
    } catch (err) {
      console.warn('WebGL unavailable, using high-precision Canvas2D fallback:', err);
      this.useFallback = true;
      this.ctx2d = this.canvas.getContext('2d', { willReadFrequently: true });
      this.maxTexSize = 8192;
    }
  }

  _initWebGL() {
    const opts = {
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
      depth: false,
      stencil: false,
    };
    const gl = this.canvas.getContext('webgl2', opts) || this.canvas.getContext('webgl', opts);
    if (!gl) {
      throw new Error('WebGL is not supported in this browser.');
    }
    this.gl = gl;
    this.maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;

    // Compile shader programs
    this.programs.blur = this._createProgram(VERTEX_SHADER, BLUR_FRAGMENT_SHADER);
    this.programs.extract = this._createProgram(VERTEX_SHADER, EXTRACT_FRAGMENT_SHADER);
    this.programs.composite = this._createProgram(VERTEX_SHADER, COMPOSITE_FRAGMENT_SHADER);

    // Fullscreen quad buffer
    const quadVerts = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1,
    ]);
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    this.textures.source = this._createTexture();
  }

  _compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compile error: ' + info);
    }
    return shader;
  }

  _createProgram(vsSource, fsSource) {
    const gl = this.gl;
    const vs = this._compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this._compileShader(gl.FRAGMENT_SHADER, fsSource);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog);
      throw new Error('Program link error: ' + info);
    }
    return prog;
  }

  _createTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  _ensureFramebuffers(width, height) {
    if (this.fboWidth === width && this.fboHeight === height) {
      return;
    }
    const gl = this.gl;
    const names = ['localTemp', 'localBg', 'extracted', 'temp', 'blur1', 'blur2', 'blur3'];

    for (const name of names) {
      if (this.textures[name]) gl.deleteTexture(this.textures[name]);
      if (this.framebuffers[name]) gl.deleteFramebuffer(this.framebuffers[name]);

      const tex = this._createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

      this.textures[name] = tex;
      this.framebuffers[name] = fbo;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fboWidth = width;
    this.fboHeight = height;
  }

  /**
   * Load an HTMLImageElement, ImageBitmap, or HTMLCanvasElement into the GPU texture
   */
  setImage(imageSource, targetWidth = null, targetHeight = null) {
    const natW = imageSource.naturalWidth || imageSource.videoWidth || imageSource.width;
    const natH = imageSource.naturalHeight || imageSource.videoHeight || imageSource.height;

    let w = targetWidth || natW;
    let h = targetHeight || natH;

    // Respect GPU max texture dimension
    if (w > this.maxTexSize || h > this.maxTexSize) {
      const ratio = this.maxTexSize / Math.max(w, h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }

    this.sourceImage = imageSource;
    this.imageWidth = w;
    this.imageHeight = h;
    this.canvas.width = w;
    this.canvas.height = h;

    if (this.useFallback) {
      return;
    }

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.textures.source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    if (w === natW && h === natH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageSource);
    } else {
      const offscreen = document.createElement('canvas');
      offscreen.width = w;
      offscreen.height = h;
      const ctx = offscreen.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(imageSource, 0, 0, w, h);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offscreen);
    }

    this._ensureFramebuffers(w, h);
  }

  _bindQuad(program) {
    const gl = this.gl;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const posLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  }

  _runSeparableBlur(inputTex, tempFboName, destFboName, sigma) {
    const gl = this.gl;
    const w = this.imageWidth;
    const h = this.imageHeight;
    const prog = this.programs.blur;

    this._bindQuad(prog);
    const uTex = gl.getUniformLocation(prog, 'u_tex');
    const uStep = gl.getUniformLocation(prog, 'u_step');
    const uSigma = gl.getUniformLocation(prog, 'u_sigma');

    // Horizontal pass: inputTex -> tempFbo
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[tempFboName]);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(uTex, 0);
    gl.uniform2f(uStep, 1.0 / w, 0.0);
    gl.uniform1f(uSigma, sigma);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Vertical pass: tempTex -> destFbo
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[destFboName]);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[tempFboName]);
    gl.uniform1i(uTex, 0);
    gl.uniform2f(uStep, 0.0, 1.0 / h);
    gl.uniform1f(uSigma, sigma);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Render the halation pipeline with the given parameters
   */
  render(params = DEFAULT_PARAMS) {
    if (!this.sourceImage || !this.imageWidth || !this.imageHeight) return;

    if (this.useFallback) {
      this._renderFallback2D(params);
      return;
    }

    const gl = this.gl;
    const w = this.imageWidth;
    const h = this.imageHeight;
    const scale = Math.max(w, h) / 1000.0;

    const enabled = params.enabled ? 1.0 : 0.0;
    const solo = params.soloHalation ? 1.0 : 0.0;
    const strength = (params.strength / 100.0) * 1.45;
    const radius = Math.max(1.0, params.radius);
    const threshold = params.threshold / 100.0;
    const softness = params.softness / 100.0;
    const warmth = params.warmth / 100.0;
    const redSens = params.redSensitivity / 100.0;
    const pointBoost = params.pointBoostEnabled ? (params.pointBoost / 100.0) : 0.0;
    const edgeGate = params.edgeGateEnabled ? (params.edgeGate / 100.0) : 0.0;
    const dualLayer = params.dualLayerEnabled ? 1.0 : 0.0;
    const bloom = params.bloomEnabled ? (params.bloom / 100.0) : 0.0;
    const grain = params.grainEnabled ? (params.grain / 100.0) : 0.0;

    if (enabled > 0.5) {
      // 1. Local surround blur for local-contrast emissive light detection
      const localSigma = Math.max(2.0, 11.0 * scale);
      this._runSeparableBlur(this.textures.source, 'localTemp', 'localBg', localSigma);

      // 2. Extract highlights & point sources
      const extProg = this.programs.extract;
      this._bindQuad(extProg);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.extracted);
      gl.viewport(0, 0, w, h);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.source);
      gl.uniform1i(gl.getUniformLocation(extProg, 'u_image'), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.localBg);
      gl.uniform1i(gl.getUniformLocation(extProg, 'u_localBg'), 1);

      gl.uniform2f(gl.getUniformLocation(extProg, 'u_texel'), 1.0 / w, 1.0 / h);
      gl.uniform1f(gl.getUniformLocation(extProg, 'u_scale'), scale);
      gl.uniform1f(gl.getUniformLocation(extProg, 'u_threshold'), threshold);
      gl.uniform1f(gl.getUniformLocation(extProg, 'u_softness'), softness);
      gl.uniform1f(gl.getUniformLocation(extProg, 'u_redSens'), redSens);
      gl.uniform1f(gl.getUniformLocation(extProg, 'u_pointBoost'), pointBoost);
      gl.uniform1f(gl.getUniformLocation(extProg, 'u_edgeGate'), edgeGate);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // 3. Multi-Scale Exponential Scatter (3 Octaves)
      const s1 = Math.max(1.0, radius * 0.26 * scale);
      const s2 = Math.max(2.0, radius * 0.72 * scale);
      const s3 = Math.max(4.0, radius * 1.65 * scale);

      this._runSeparableBlur(this.textures.extracted, 'temp', 'blur1', s1);
      this._runSeparableBlur(this.textures.blur1, 'temp', 'blur2', Math.sqrt(Math.max(1.0, s2 * s2 - s1 * s1)));
      this._runSeparableBlur(this.textures.blur2, 'temp', 'blur3', Math.sqrt(Math.max(1.0, s3 * s3 - s2 * s2)));
    }

    // 4. Final Optical Composite to main canvas
    const compProg = this.programs.composite;
    this._bindQuad(compProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.source);
    gl.uniform1i(gl.getUniformLocation(compProg, 'u_image'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.blur1 || this.textures.source);
    gl.uniform1i(gl.getUniformLocation(compProg, 'u_blur1'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.blur2 || this.textures.source);
    gl.uniform1i(gl.getUniformLocation(compProg, 'u_blur2'), 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.blur3 || this.textures.source);
    gl.uniform1i(gl.getUniformLocation(compProg, 'u_blur3'), 3);

    gl.uniform1f(gl.getUniformLocation(compProg, 'u_enabled'), enabled);
    gl.uniform1f(gl.getUniformLocation(compProg, 'u_solo'), solo);
    gl.uniform1f(gl.getUniformLocation(compProg, 'u_strength'), strength);
    gl.uniform1f(gl.getUniformLocation(compProg, 'u_warmth'), warmth);
    gl.uniform1f(gl.getUniformLocation(compProg, 'u_edgeGate'), edgeGate);
    gl.uniform1f(gl.getUniformLocation(compProg, 'u_dualLayer'), dualLayer);
    gl.uniform1f(gl.getUniformLocation(compProg, 'u_bloom'), bloom);
    gl.uniform1f(gl.getUniformLocation(compProg, 'u_grain'), grain);
    gl.uniform2f(gl.getUniformLocation(compProg, 'u_resolution'), w, h);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  _renderFallback2D(params) {
    const ctx = this.ctx2d;
    const w = this.imageWidth;
    const h = this.imageHeight;
    ctx.clearRect(0, 0, w, h);
    if (!params.soloHalation) {
      ctx.drawImage(this.sourceImage, 0, 0, w, h);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
    }
    if (!params.enabled) return;

    const scale = Math.max(w, h) / 1000.0;
    const r = Math.max(2, params.radius * scale);
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    octx.drawImage(this.sourceImage, 0, 0, w, h);
    const imgData = octx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const thresh = (params.threshold / 100) * 255;
    const warmth = params.warmth / 100;

    for (let i = 0; i < d.length; i += 4) {
      const m = Math.max(d[i], d[i + 1], d[i + 2]);
      if (m > thresh) {
        const f = Math.min(1, (m - thresh) / Math.max(10, 255 - thresh));
        d[i] = Math.min(255, f * 255);
        d[i + 1] = Math.min(255, f * (75 + warmth * 110));
        d[i + 2] = Math.min(255, f * (20 + warmth * 55));
      } else {
        d[i] = d[i + 1] = d[i + 2] = 0;
      }
    }
    octx.putImageData(imgData, 0, 0);

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = Math.min(1, params.strength / 100);
    ctx.filter = `blur(${Math.round(r * 0.45)}px)`;
    ctx.drawImage(off, 0, 0, w, h);
    ctx.filter = `blur(${Math.round(r * 1.15)}px)`;
    ctx.drawImage(off, 0, 0, w, h);
    ctx.restore();
  }

  destroy() {
    if (this.gl) {
      const ext = this.gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      this.gl = null;
    }
  }

  /**
   * Export at exact full native resolution without quality loss
   * @param {HTMLImageElement} fullResImage
   * @param {Object} params
   * @param {string} mimeType - 'image/png' | 'image/jpeg' | 'image/webp'
   * @param {number} quality - 1.0 for maximum quality
   * @returns {Promise<Blob>}
   */
  async exportFullResolution(fullResImage, params, mimeType = 'image/png', quality = 1.0) {
    const natW = fullResImage.naturalWidth || fullResImage.width;
    const natH = fullResImage.naturalHeight || fullResImage.height;

    const exportCanvas = document.createElement('canvas');
    const exportEngine = new HalationEngine(exportCanvas);
    exportEngine.setImage(fullResImage, natW, natH);
    exportEngine.render({ ...params, soloHalation: false });

    return new Promise((resolve, reject) => {
      exportCanvas.toBlob(
        (blob) => {
          exportEngine.destroy();
          if (blob) resolve(blob);
          else reject(new Error('Failed to encode full-resolution image blob.'));
        },
        mimeType,
        quality
      );
    });
  }
}
