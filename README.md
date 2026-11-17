# Halation Optical Studio

A responsive desktop and mobile web application that simulates authentic 35mm motion-picture film halation (modeled after remjet-free tungsten stocks like CineStill 800T / Kodak Vision3) using a multi-pass WebGL GPU optical pipeline and exports at **full native resolution without losing quality**.

## Features

- **Real-Time Multi-Octave Emulsion Scatter (WebGL GPU)**:
  - **Emissive Point-Source Micro Boost**: Detects small, high-contrast point lights (tower beacons, distant windows, streetlamps) so they bloom naturally without over-saturating broad flat surfaces like lit pavement.
  - **Dual-Layer Spectral Emulsion**: Separates tight warm amber-orange inner core diffusion from wide crimson-red outer emulsion scatter.
  - **Shadow & Edge Gating**: Concentrates halation across high-contrast dark boundaries.
- **Exact Image Metadata & Filename/Title Preservation**:
  - Preserves original binary image metadata chunks (**EXIF**, **XMP**, **ICC Color Profile**, **IPTC**, **PNG `eXIf`/`tEXt`/`iTXt`/`zTXt`/`pHYs`/`tIME`**, and **WebP `EXIF`/`XMP `/`ICCP`**) and exports with the **exact same filename and title** as the uploaded image by default.
  - Includes a **Strip Image Metadata** slide toggle (`#toggle-stripMetadata`) to optionally remove all camera/location/EXIF/XMP metadata on export.
- **Automatic Session & Uploaded Photo Caching**:
  - Automatically caches the last uploaded image (raw binary bytes + metadata + filename) and current studio slider/toggle state in **IndexedDB** (with `localStorage` fallback), so an accidental page refresh restores your exact photo and settings right where you left off.
- **Tactile Slide Toggles & Analog Sliders**:
  - Configure Intensity, Scatter Radius, Highlight Threshold, Highlight Knee (Rolloff), Spectral Tint, Red Layer Sensitivity, Point-Source Gain, Shadow Contrast Gate, Core Pro-Mist, 35mm Film Grain, Solo Halation Map View, and Strip Image Metadata.
- **Built-in Reference Test Scenes**:
  - Includes **Example 1 (Night Kiosk)** and **Example 2 (Cobblestone Streetlamp)** with interactive **Split vs Input** and **Split vs Expected Target** comparison modes.
- **Zero-Quality-Loss Native Export**:
  - Renders and exports directly at the photo's original pixel dimensions (`naturalWidth × naturalHeight`) in **Lossless PNG**, **100% JPEG**, or **100% WebP**.

## Running Automated Whole-Project Tests & Coverage

The project includes comprehensive unit and end-to-end headless Chromium tests covering the entire codebase (`halation-engine.js`, `app.js`, `metadata-utils.js`, `session-cache.js`, `index.html`, and `styles.css`) with Node.js and Browser V8 code coverage enforcement:

- [`tests/engine.test.js`](./tests/engine.test.js): Tests `DEFAULT_PARAMS`, all 5 `PRESETS`, `HalationEngine` WebGL multi-pass rendering (extract + 4-octave separable Gaussian blur + composite), FBO allocation/resizing, `maxTexSize` clamping, `exportFullResolution`, `destroy()`, and Canvas2D fallback when WebGL or shader compilation fails.
- [`tests/cache.test.js`](./tests/cache.test.js): Tests `session-cache.js` uploaded photo and studio state persistence across both primary `IndexedDB` storage and `localStorage` fallback.
- [`tests/metadata.test.js`](./tests/metadata.test.js): Tests `metadata-utils.js` lossless metadata extraction and injection across JPEG (`APP1` EXIF, `APP1` XMP, `APP2` ICC, `APP13` IPTC, `COM`), PNG (`eXIf`, `tEXt`, `iTXt`, `pHYs`, `tIME`), and WebP (`VP8`, `VP8L`, `VP8X`, `EXIF`, `XMP `, `ICCP`), cross-format conversions, and Little/Big-Endian TIFF EXIF titles.
- [`tests/ui.test.js`](./tests/ui.test.js): Full headless Chromium E2E test suite verifying UI layout, optical engine accuracy against reference targets, all 10 sliders, all 8 slide toggles, all 5 presets, reset button, Hold Original (mouse/touch/keyboard), Split Curtain (mouse/touch/keyboard), zoom/pan, mobile tabs, drag-and-drop/paste/file-input uploads, >2048px native export, metadata preservation/stripping, accidental page refresh recovery, and whole-project Browser V8 line coverage (`>= 88%` overall).

```bash
npm test
```

## Hosting on GitHub Pages

This project is 100% static client-side HTML/CSS/ES-Modules with zero build dependencies and includes `.nojekyll` and `.github/workflows/deploy.yml` (which runs `npm test` automatically before deploying to GitHub Pages).
