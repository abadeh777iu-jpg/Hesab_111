# Scalable

A responsive, dark analytics landing page built with React 19, TypeScript, Vite,
Tailwind CSS v4, and TanStack Router's file-based routing.

## Development

```sh
npm ci
npm run dev
```

Vite binds to `0.0.0.0:5173` and accepts Arena's `.e2b.app` preview hosts.

```sh
npm run build
npm run typecheck
npm run preview
```

## Structure

- `src/routes/index.tsx`: home route, route SEO, landing page and interactive preview.
- `src/routes/__root.tsx`: root layout and route metadata rendering.
- `src/styles.css`: semantic OKLCH tokens, Tailwind v4 theme, responsive styling.
- `src/assets/ambient-fallback.mp4`: small, locally bundled, seamless atmospheric video.
- Fonts are served locally from the Fontsource packages.

## Background video

The requested SceneAI CDN URL was unavailable in the build environment (TLS connection
failures). The page tries that original URL, then switches to the included locally
generated purple/blue/teal ambient video on error or after a nine-second loading timeout.
If no video is playable, the semantic-token CSS gradient remains visible. Reduced-motion
preferences use only the static gradient. The local fallback is not the original CDN asset.

To bundle the exact requested video when its server is reachable:

```sh
npm run assets:video
```

This writes `src/assets/hero-gradient.mp4`; the home route's Vite glob import automatically
prefers that local original over its remote URL. No route changes are necessary.

**Background settings** in the footer (also in the **Pages** menu) exposes a direct video
URL input, original-source reset, and local fallback control. Any replacement retains
the oversized, centered, upward-offset position, blur, opacity, and screen blending.
Custom URLs are session-only. HTTP media can be blocked on HTTPS pages; HTTPS is recommended.

The optional `scripts/create-fallback.py` reproduces the fallback using `numpy` and
`imageio-ffmpeg`. Python is not required to run or build the site.

## Interactions and scope

- All navigation items open informational dialogs; Pages also links to the dashboard.
- Revenue tabs update the sample chart and support arrow-key navigation.
- Demo CTAs open a validated form and produce a downloadable demo brief. This is an
  explicitly labelled local preview: nothing is submitted or scheduled, and no backend
  or personal-data storage is configured.
- Withdraw explains that the dashboard uses illustrative data and cannot move money.
- Native dialogs include Escape dismissal, focus trapping and explicit focus restoration.

## Browser tests

```sh
npx playwright install chromium
npm test
```

Tests cover exact content and SEO, the local video, tabs, keyboard operation, demo-form
validation and download, navigation, custom-video replacement, missing media, six viewport
widths, and reduced motion. For a preinstalled Chromium, set `CHROMIUM_PATH` to its executable.
