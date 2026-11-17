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

## Running Automated UI & Metadata Tests

The project includes automated unit tests ([`tests/metadata.test.js`](./tests/metadata.test.js)) and real headless Chromium/Chrome end-to-end UI tests ([`tests/ui.test.js`](./tests/ui.test.js)) that verify all sliders, slide toggles, presets, metadata preservation/stripping, exact upload filename/title export, and accidental page refresh caching:

```bash
npm test
```

## Hosting on GitHub Pages

This project is 100% static client-side HTML/CSS/ES-Modules with zero build dependencies and includes `.nojekyll` and `.github/workflows/deploy.yml` (which runs `npm test` automatically before deploying to GitHub Pages).
