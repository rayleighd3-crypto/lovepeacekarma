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

### 1. Open the configure page

Open the addon's **`/configure`** page in a browser (on a hosted deployment,
`https://lovepeacekarma-<hash>.vercel.app/configure`; locally
`http://localhost:3000/configure` — opening the bare addon URL also redirects there).

### 2. Pick your sources

All six providers are **unticked by default**: choose exactly the sources you want.
If you tick **ShowBox (FebBox)**, a cookie field appears and the install button stays
disabled until you paste a valid FebBox `ui` cookie (JWT shape — three dot-separated
base64 parts, not expired; validated locally, no upstream request).

### 3. Install the generated URL

Click **Install** — the page builds a personalised manifest URL:

```
https://<host>/manifest.json?providers=4khdhub,videasy&cookie=<JWT>
```

Copy that URL into Stremio (**Add-ons → Add URL**). The selection lives in the URL,
so re-generating/re-installing with different picks is all it takes to change the
source set.

> **Privacy note:** the FebBox cookie is embedded in the URL in plain text. Anyone the
> URL is shared with can replay the cookie against FebBox. Treat the URL like a credential.

### 4. Search & play

1. Open the **Discover** tab.
2. Select the **LovePeaceKarma** catalog (it uses TMDB search).
3. Type a title (e.g. *Inception*) → results load.
4. Open the movie or episode → **"Choose stream"**.
5. Pick any provider link (quality/language shown in the name, e.g. `2160p` / `Tamil` / `720p`).

### Hosting

**Option A — Vercel (recommended, free):**
1. Push this repository to your GitHub account.
2. In [Vercel](https://vercel.com) → **New Project** → import the repo.
3. Framework preset: **Other** (it's a Node.js server). Build command: none.
   Install command: `npm install`. Start command: none needed (`vercel.json` already routes to `server.js`).
4. Optional server-side env vars (see **Configuration**) — source picking itself is per-user.
5. Deploy → you get a URL like `https://lovepeacekarma-<hash>.vercel.app`, then continue
   from step 1 above.

**Option B — locally (for testing):**
```bash
npm install
node server.js
# configure page is now at http://localhost:3000/configure
```

---

## Configuration

### Per-user (configure page)

Source selection and the ShowBox FebBox cookie are **per-user**, chosen on the
`/configure` page and encoded in that user's manifest URL — nothing is stored on the
server. See [Install into Stremio](#install-into-stremio).

### Server-side (environment variables)

Server variables only set **defaults** for requests that carry no config (which should
not happen in the normal install flow). Set them on Vercel under
**Project → Settings → Environment Variables**, or in `.env` locally.

| Variable | Purpose |
|----------|---------|
| `TMDB_API_KEY` | TMDB API key (a public demo key is bundled; provide your own for higher limits) |
| `SHOWBOX_UI_COOKIE` | Server-level FebBox `ui` cookie fallback (per-user cookies take priority) |
| `HDHUB4U_PROXY_URL` | Optional proxy to route HDHub4u requests through (e.g. ScraperAPI) |
| `PROVIDER_111477_BASE_URL` | Override the 111477 file-host base URL |
| `PROVIDER_TIMEOUT_MS` | Per-provider timeout in ms (default 25000) |
| `DEBUG` | `true` for verbose per-provider logging |
| `DISABLE_CACHE` | `true` to disable the disk/memory cache |

Server-side provider enable/disable toggles (set to `false` to turn a provider off
for un-configured requests):

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
   The configure page accepts both `ui=<JWT>` and bare-JWT forms.
4. Paste it into the ShowBox cookie field on the configure page (or set
   `SHOWBOX_UI_COOKIE` as the server-level fallback). Cookie effectively lasts ~1 year
   (`exp` field) but FebBox rotates it on account activity; if ShowBox returns no
   streams while other providers work, generate a new URL with a fresh cookie.

---

## Project structure

```
├── addon.js          # Stremio addon builder (catalog + stream handlers, per-request provider routing)
├── server.js         # Express server + /configure page (source picker, cookie-gated URLs)
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
curl localhost:3000/configure                                      # source picker page
curl localhost:3000/manifest.json                                  # redirects to /configure
curl "localhost:3000/manifest.json?providers=4khdhub,videasy"      # personalised manifest
curl "localhost:3000/stream/movie/tmdb:27205.json?providers=showbox&cookie=<JWT>"
curl localhost:3000/catalog/movie/tmdb-movies/search=inception.json
curl localhost:3000/stream/series/tmdb:66788:1:1.json
```

---

## License

This project is for personal/research use. Respect the terms of service of the upstream sources it
aggregates. This addon is not affiliated with or endorsed by any of the content providers.
