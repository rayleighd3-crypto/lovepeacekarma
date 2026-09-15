# LovePeaceKarma

A **Stremio addon** that streams movies and TV series directly via HTTP from multiple sources,
with metadata powered by **TMDB**. No P2P / torrents — every stream is a direct playable link.

> Programmers: `rayleighd3` · Source: this repository · Hosted: Vercel-ready

---

## What it does

Install the addon into Stremio, search for any movie or series, and pick from direct-stream links
aggregated across all enabled providers. Results are de-duplicated and sorted by quality (2160p → 360p).

### Providers

| Provider    | Type         | Source                                                                 | Status |
|-------------|--------------|------------------------------------------------------------------------|--------|
| **111477**  | File host    | `https://a.111477.xyz/` (direct directory listings)                    | ✅ Active |
| **4KHDHub** | WordPress    | `https://4khdhub.one/` (auto-rotating domain)                          | ✅ Active |
| **HDHub4u** | WordPress    | auto-rotating domain (TVVVV `domains.json`)                            | ✅ Active |
| **Videasy** | Multi-server | `api.speedracelight.com` (seed + `mvm1` PRNG decrypt)                  | ✅ Active |
| **Castle**  | App API      | `api.hlowb.com` (AES-128-CBC film-api, multi-language)                 | ✅ Active |
| **ShowBox** | FebBox share | `id-mapping-api-showbox-proxy.hf.space` + `febbox.com`                 | ✅ Active (needs own `ui` cookie) |
| UHDMovies   | WordPress    | TLS-blocked/dead upstream domains                                      | ❌ removed |
| MovieBox    | Private APK  | all mirror hosts return `441 miss token` at runtime                    | ❌ removed |

All six active providers are verified to return playable streams (Inception / 13 Reasons Why, tested locally
with curl + Node from the developer's network).

### What distinguishes each

- **111477 / 4KHDHub / HDHub4u** — direct MP4/MKV download hosts, quality labelled by file name.
- **Videasy** — HLS (`.m3u8`) with 2160p/1080p/720p/480p variants and built-in subtitle tracks.
  Encrypted payload with a custom PRNG (`mvm1` magic header) ported from the player's JS.
- **Castle** — HLS with `auth_key` (expiring), released with multi-language audio per title
  (English / Tamil / Hindi / OST etc.) and clean episode metadata for TV.
- **ShowBox** — HLS + ORG-dir MP4s via a FebBox share listing. Requires **your own FebBox `ui` cookie**
  (see [Configuration](#configuration)).

---

## Install into Stremio

### 1. Host the addon (pick one)

**Option A — Vercel (recommended, free):**
1. Push this repository to your GitHub account.
2. In [Vercel](https://vercel.com) → **New Project** → import the repo.
3. Framework preset: **Other** (it's a Node.js server). Build command: none.
   Install command: `npm install`. Start command: none needed (`vercel.json` already routes to `server.js`).
4. Set the environment variables below (see **Environment variables**).
5. Deploy → you get a URL like `https://lovepeacekarma-<hash>.vercel.app`.

**Option B — locally (for testing):**
```bash
cp .env.example .env    # edit if you want ShowBox enabled
npm install
node server.js
# addon is now at http://localhost:3000/manifest.json
```

### 2. Add to Stremio

Open the addon URL in a browser, or paste it directly into Stremio:

```
# Hosted example:
https://lovepeacekarma-<hash>.vercel.app/manifest.json

# Local example:
http://localhost:3000/manifest.json
```

Steps in the Stremio app:
1. Open the **Stremio** app (desktop, mobile, or TV).
2. Go to the addon page → **Add-ons** section.
3. Click **"Install addon"** / paste the manifest URL above.
4. **Install** → the "LovePeaceKarma" addon now appears in your addon list.
5. On desktop you can also paste the URL directly into the address/search bar.

### 3. Search & play

1. Open the **Discover** tab.
2. Select the **LovePeaceKarma** catalog (it uses TMDB search).
3. Type a title (e.g. *Inception*) → results load.
4. Open the movie or episode → **"Choose stream"**.
5. Pick any provider link (quality/language shown in the name, e.g. `2160p` / `Tamil` / `720p`).

---

## Configuration

The addon is configurable via environment variables (set them on Vercel under
**Project → Settings → Environment Variables**, or in `.env` locally).

| Variable | Purpose |
|----------|---------|
| `TMDB_API_KEY` | TMDB API key (a public demo key is bundled; provide your own for higher limits) |
| `SHOWBOX_UI_COOKIE` | **Required for ShowBox.** Your personal FebBox `ui` cookie value (JWT). Skip to disable ShowBox silently. |
| `HDHUB4U_PROXY_URL` | Optional proxy to route HDHub4u requests through (e.g. ScraperAPI) |
| `PROVIDER_111477_BASE_URL` | Override the 111477 file-host base URL |
| `DEBUG` | `true` for verbose per-provider logging |
| `DISABLE_CACHE` | `true` to disable the disk/memory cache |

Provider enable/disable toggles (set to `false` to turn a provider off):

| Variable | Default | Disables |
|----------|---------|----------|
| `ENABLE_111477_PROVIDER` | on | 111477 file host |
| `ENABLE_4KHDHUB_PROVIDER` | on | 4KHDHub |
| `ENABLE_HDHUB4U_PROVIDER` | on | HDHub4u |
| `ENABLE_VIDEASY_PROVIDER` | on | Videasy |
| `ENABLE_CASTLE_PROVIDER` | on | Castle |
| `ENABLE_SHOWBOX_PROVIDER` | on | ShowBox (still skipped when no cookie set) |

### Getting a FebBox `ui` cookie for ShowBox

1. Open https://www.febbox.com and log in (any login method works).
2. DevTools → Application (Chrome) / Storage (Firefox) → Cookies → `https://www.febbox.com`.
3. Copy the **`ui`** cookie's value (starts with `eyJ…`, a JWT that decodes to `{uid, token}`).
   Current shape: `ui=<JWT>` — the provider normalises both forms.
4. Set it as `SHOWBOX_UI_COOKIE` in the addon environment. Cookie effectively lasts ~1 year
   (`exp` field) but FebBox rotates it on account activity; if you notice ShowBox returning
   no streams while other providers do, refresh the cookie.

---

## Project structure

```
├── addon.js          # Stremio addon builder (catalog + stream handlers)
├── server.js         # Express server + /configure page
├── manifest.json     # Addon manifest (identity, resources, catalogs)
├── vercel.json       # Vercel deployment config
├── providers/
│   ├── 111477.js     # Scrapes https://a.111477.xyz file listings
│   ├── 4khdhub.js    # Scrapes 4KHDHub + resolves HubCloud direct links
│   ├── hdhub4u.js    # Scrapes HDHub4u (HubCloud/Pixeldrain/etc.)
│   ├── videasy.js    # videasy / api.speedracelight.com encrypted m3u8 extractor
│   ├── castle.js     # api.hlowb.com AES-128-CBC film-api, multi-language HLS
│   └── showbox.js    # FebBox-share direct files (requires user `ui` cookie)
├── utils/
│   ├── cache.js      # In-memory + file cache
│   ├── linkResolver.js
│   └── tmdb.js       # TMDB id resolution
└── test/run.js       # `npm test` smoke test for all providers
```

---

## Development / testing

```bash
cp .env.example .env
# put your FebBox ui cookie in SHOWBOX_UI_COOKIE to enable ShowBox
npm install
npm test          # runs the provider smoke test (Inception + 13 Reasons Why)
node server.js    # start local server on :3000
```

Sample endpoints after boot:

```bash
curl localhost:3000/manifest.json
curl localhost:3000/catalog/movie/tmdb-movies/search=inception.json
curl localhost:3000/stream/movie/tmdb:27205.json
curl localhost:3000/stream/series/tmdb:66788:1:1.json
```

---

## License

This project is for personal/research use. Respect the terms of service of the upstream sources it
aggregates. This addon is not affiliated with or endorsed by any of the content providers.
