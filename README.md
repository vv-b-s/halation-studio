# Halation Optical Studio

A responsive desktop and mobile web application that simulates authentic 35mm motion-picture film halation (modeled after remjet-free tungsten stocks like CineStill 800T / Kodak Vision3) using a multi-pass WebGL GPU optical pipeline and exports at **full native resolution without losing quality**.

## Features

- **Real-Time Multi-Octave Emulsion Scatter (WebGL GPU)**:
  - **Emissive Point-Source Micro Boost**: Detects small, high-contrast point lights (tower beacons, distant windows, streetlamps) so they bloom naturally without over-saturating broad flat surfaces like lit pavement.
  - **Dual-Layer Spectral Emulsion**: Separates tight warm amber-orange inner core diffusion from wide crimson-red outer emulsion scatter.
  - **Shadow & Edge Gating**: Concentrates halation across high-contrast dark boundaries.
- **Tactile Slide Toggles & Analog Sliders**:
  - Configure Intensity, Scatter Radius, Highlight Threshold, Highlight Knee (Rolloff), Spectral Tint, Red Layer Sensitivity, Point-Source Gain, Shadow Contrast Gate, Core Pro-Mist, 35mm Film Grain, and Solo Halation Map View.
- **Built-in Reference Test Scenes**:
  - Includes **Example 1 (Night Kiosk)** and **Example 2 (Cobblestone Streetlamp)** with interactive **Split vs Input** and **Split vs Expected Target** comparison modes.
- **Zero-Quality-Loss Native Export**:
  - Renders and exports directly at the photo's original pixel dimensions (`naturalWidth × naturalHeight`) in **Lossless PNG**, **100% JPEG**, or **100% WebP**.
- **Desktop & Mobile Friendly**:
  - Precision 2-column studio layout on desktop and touch-first sticky viewport + tabbed control drawer on mobile devices.

## Hosting on GitHub Pages

This project is 100% static client-side HTML/CSS/ES-Modules with zero build dependencies and includes `.nojekyll` and `.github/workflows/deploy.yml`:

1. Push this repository to GitHub.
2. Go to **Settings → Pages** in your GitHub repository.
3. Under **Build and deployment**, select **GitHub Actions** (or **Deploy from a branch** → `main` / `/ (root)`).
