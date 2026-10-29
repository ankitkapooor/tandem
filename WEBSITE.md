# Tandem information site

The public download and setup page lives at **https://tandem.ankitkapoor.me**.
It is a static information site, separate from the Electron application and
its local server. It never runs agents or receives visitors' conversations.

## Source

- `website/index.html`: product explanation, workflow examples, downloads, Mac
  and iPhone setup, privacy details, troubleshooting, and known limits.
- `website/style.css`: responsive layout and Tandem's existing amber/mint identity.
- `website/script.js`: illustrative mode selector, keyboard navigation, and
  installer-command copying. No external dependencies or API calls.
- `website/assets/`: the app's existing SVG icon and social preview.
- `wrangler.jsonc`: Cloudflare Worker static assets with the custom domain
  `tandem.ankitkapoor.me` on the `tandem-info` Worker.

Download links use GitHub's `releases/latest/download/` URLs for the published
Apple Silicon and Intel DMGs. The Terminal command uses the repository's
existing installer. New app releases update those destinations automatically.
The illustrative conversation is labeled and is not a live agent demo.

## Preview

From the repository root:

```sh
python3 -m http.server 4199 --bind 127.0.0.1 --directory website
```

Open http://127.0.0.1:4199. No npm install or build is needed for the page.

## Publish changes

With an authenticated Cloudflare account that manages `ankitkapoor.me`:

```sh
npx wrangler deploy --config wrangler.jsonc
```

This deploys only `website/` as static assets. The Mac release workflow, desktop
application source, CLI authentication, and local conversation data are
independent of this deployment. No account credentials belong in this repo.

## Validation

The initial page was checked in Chromium at 360, 390, 768, 1024, and 1440 px:
no horizontal overflow, all four modes, keyboard tabs, clipboard copying,
phone setup, and in-page links. Both latest-release DMG URLs were checked.
The homepage includes canonical and social metadata, robots.txt, a sitemap,
and restrictive static security headers.
