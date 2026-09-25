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

## GitHub Pages deployment

The Pages workflow builds and deploys pushes to `main` and the Arena working branch
`arena/01a0d7b6-hesab-111`. It publishes the Vite output via GitHub Actions rather than
committing generated files to a deployment branch.

The expected public URL, **after Pages is enabled and deployment succeeds**, is:
`https://abadeh777iu-jpg.github.io/Hesab_111/`.

One-time repository setup (requires repository administration access):

1. Open **Settings → Pages → Build and deployment → Source**.
2. Select **GitHub Actions**.
3. Open **Actions → Deploy Scalable to GitHub Pages** and re-run the latest run if it
   failed before Pages was enabled.
4. If GitHub reports an environment branch restriction, open **Settings → Environments
   → github-pages** and permit `arena/01a0d7b6-hesab-111` in deployment branches.

The connected GitHub integration returned HTTP 403 when attempting to enable Pages,
so this setting must be enabled by a repository administrator. The site is not live
until a deployment succeeds.

The workflow sets `VITE_BASE_PATH=/Hesab_111/`; Vite asset URLs, the favicon, and the
TanStack Router base path follow it. Local development and Arena previews still default
to `/`. The original video download is attempted during CI; its failure is non-blocking
because the local video and static gradient fallbacks are bundled.

To validate the project-path build locally:

```sh
VITE_BASE_PATH=/Hesab_111/ npm run build -- --outDir dist/pages-test
npm run preview -- --outDir dist/pages-test --base /Hesab_111/ --port 3001
# In a second terminal, after installing the Playwright browser:
PAGES_TEST_URL=http://127.0.0.1:3001/Hesab_111/ npm test -- tests/pages.spec.ts
```
