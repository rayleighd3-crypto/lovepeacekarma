# LovePeaceKarma

A **Stremio addon** that streams movies and TV series directly via HTTP from multiple sources,
with metadata powered by **TMDB**. No P2P / torrents — every stream is a direct playable link.

> Programmers: `rayleighd3` · Source: this repository · Hosted: Vercel-ready

---

## What it does

Install the addon into Stremio, search for any movie or series, and pick from direct-stream links
aggregated across all enabled providers. Results are de-duplicated and sorted by quality (2160p → 360p).

### Providers

| Provider   | Type     | Source                                                  | Status |
|------------|----------|---------------------------------------------------------|--------|
| **111477** | File host| `https://a.111477.xyz/` (direct directory listings)     | ✅ Active |
| **4KHDHub**| WordPress| `https://4khdhub.one/` (auto-rotating domain)            | ✅ Active |
| **HDHub4u**| WordPress| auto-rotating domain (TVVVV `domains.json`)              | ✅ Active |

All three providers are verified to return playable streams. MovieBox, ShowBox and UHDMovies were
removed because their upstream APIs / keys / proxies could not be resolved at runtime.

---

## Install into Stremio

### 1. Host the addon (pick one)

**Option A — Vercel (recommended, free):**
1. Push this repository to your GitHub account.
2. In [Vercel](https://vercel.com) → **New Project** → import the repo.
3. Framework preset: **Other** (it's a Node.js server). Build command: none.
   Install command: `npm install`. Start command: none needed (`vercel.json` already routes to `server.js`).
4. Set the environment variable below (see **Environment variables**).
5. Deploy → you get a URL like `https://lovepeacekarma-<hash>.vercel.app`.

**Option B — locally (for testing):**
```bash
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
5. Pick any `111477` / `4KHDHub` / `HDHub4u` link (quality shown in the name, e.g. `2160p`).

---

## Configuration

The addon is configurable via environment variables (set them on Vercel under
**Project → Settings → Environment Variables**).

| Variable | Purpose |
|----------|---------|
| `TMDB_API_KEY` | TMDB API key (a public demo key is bundled; provide your own for higher limits) |
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
│   └── hdhub4u.js    # Scrapes HDHub4u (HubCloud/Pixeldrain/etc.)
├── utils/
│   ├── cache.js      # In-memory + file cache
│   ├── linkResolver.js
│   └── tmdb.js       # TMDB id resolution
└── test/run.js       # `npm test` smoke test for all providers
```

---

## Development / testing

```bash
npm install
npm test          # runs the provider smoke test (Inception, TMDB 27205)
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