require('dotenv').config();
const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const { resolveTmdb, TMDB_API_KEY } = require('./utils/tmdb');

const manifest = require('./manifest.json');

// Provider registry: all available sources a user can pick during installation
const ALL_PROVIDERS = [
  { key: '4khdhub', envKey: '4KHDHUB', label: '4KHDHub' },
  { key: 'hdhub4u', envKey: 'HDHUB4U', label: 'HDHub4u' },
  { key: '111477', envKey: '111477', label: '111477' },
  { key: 'videasy', envKey: 'VIDEASY', label: 'Videasy' },
  { key: 'castle', envKey: 'CASTLE', label: 'Castle' },
  { key: 'showbox', envKey: 'SHOWBOX', label: 'ShowBox' },
];

// Server-side fallback list (env). Per-user config takes priority.
function serverEnabledKeys() {
  const list = ALL_PROVIDERS.filter(p => process.env[`ENABLE_${p.envKey}_PROVIDER`] !== 'false');
  // ShowBox via server env requires a server cookie; only enable it if one is set
  const showbox = list.find(p => p.key === 'showbox');
  if (showbox && !process.env.SHOWBOX_UI_COOKIE) {
    const without = list.filter(p => p.key !== 'showbox');
    return without.map(p => p.key);
  }
  return list.map(p => p.key);
}
const SERVER_DEFAULT_KEYS = serverEnabledKeys();

// Resolve which providers a given request should use
function providersForRequest(config = {}) {
  let selected;
  if (Array.isArray(config.providers) && config.providers.length > 0) {
    selected = config.providers;
  } else if (typeof config.providers === 'string' && config.providers.length > 0) {
    selected = config.providers.split(',').map(k => k.trim()).filter(Boolean);
  } else {
    selected = SERVER_DEFAULT_KEYS;
  }
  const valid = new Set(ALL_PROVIDERS.map(p => p.key));
  return ALL_PROVIDERS
    .filter(p => selected.includes(p.key) && valid.has(p.key))
    .filter(p => p.key !== 'showbox' || !!config.cookie || !!process.env.SHOWBOX_UI_COOKIE);
}

// Lazy-require providers (avoid loading heavyweight deps on /manifest)
function providerFns(key) {
  switch (key) {
    case '4khdhub': return require('./providers/4khdhub');
    case 'hdhub4u': return require('./providers/hdhub4u');
    case '111477': return require('./providers/111477');
    case 'videasy': return require('./providers/videasy');
    case 'castle': return require('./providers/castle');
    case 'showbox': return require('./providers/showbox');
    default: return null;
  }
}

// Run a promise with a timeout, always resolve
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), ms);
    Promise.resolve(promise)
      .then(v => { clearTimeout(timer); resolve(v || []); })
      .catch(() => { clearTimeout(timer); resolve([]); });
  });
}

async function runProvider(p, { tmdbId, mediaType, season, episode, requestConfig = {} }) {
  try {
    const fns = providerFns(p.key);
    if (!fns) return [];
    switch (p.key) {
      case '4khdhub':
        return await fns.get4KHDHubStreams(tmdbId, mediaType, season, episode);
      case 'hdhub4u':
        return await fns.getHDHub4uStreams(tmdbId, mediaType, season, episode);
      case '111477':
        return await fns.getStreamsFromTmdbId(
          mediaType === 'tv' ? 'tv' : 'movie',
          tmdbId,
          season,
          episode
        );
      case 'videasy':
        return await fns.getVideasyStreams(tmdbId, mediaType, season, episode);
      case 'castle':
        return await fns.getCastleStreams(tmdbId, mediaType, season, episode);
      case 'showbox':
        return await fns.getShowBoxStreams(tmdbId, mediaType, season, episode, requestConfig);
      default:
        return [];
    }
  } catch (e) {
    console.error(`[${p.label}] failed: ${e.message}`);
    return [];
  }
}

// Catalog: TMDB search
async function searchCatalog(type, search) {
  try {
    const mediaType = type === 'series' ? 'tv' : 'movie';
    // If no search term, return popular/trending rows so the Discover catalog isn't empty.
    const url = search
      ? `https://api.themoviedb.org/3/search/${mediaType}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(search)}&page=1`
      : `https://api.themoviedb.org/3/${mediaType}/popular?api_key=${TMDB_API_KEY}&language=en-US&page=1`;
    const res = await axios.get(url, { timeout: 10000 });
    const results = (res.data && res.data.results) || [];
    return results.slice(0, 20).map(r => {
      const isTv = mediaType === 'tv';
      const name = isTv ? r.name : r.title;
      return {
        id: `tmdb:${r.id}`,
        type: type,
        name: name,
        poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
        background: r.backdrop_path ? `https://image.tmdb.org/t/p/w500${r.backdrop_path}` : null,
        description: r.overview || '',
        releaseInfo: isTv ? (r.first_air_date || '').substring(0, 4) : (r.release_date || '').substring(0, 4),
      };
    });
  } catch (e) {
    console.error(`[Catalog] search error: ${e.message}`);
    return [];
  }
}

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const search = extra && extra.search;
  const metas = await searchCatalog(type, search);
  return { metas };
});

builder.defineStreamHandler(async ({ type, id, extra = {}, config = {} }) => {
  // Normalize id ("tmdb:123", "ttXXXX", "123")
  let rawId = id;
  if (rawId.startsWith('tmdb:')) rawId = rawId.slice(5);

  // Determine expected type
  const mediaType = (type === 'series') ? 'tv' : 'movie';

  // Extract season/episode if present in id (Stremio passes "tmdb:SEASON:EPISODE" for series)
  let season = null, episode = null;
  const numbers = rawId.split(':');
  if (numbers.length === 3 && /^\d+$/.test(numbers[0])) {
    season = parseInt(numbers[1], 10);
    episode = parseInt(numbers[2], 10);
    rawId = numbers[0];
  }

  // Resolve request-scoped config: SDK `config` (from path/query), the cookie extra,
  // and legacy global set by server.js middleware.
  const reqConfig = { ...config, ...(extra && extra.cookie ? { cookie: extra.cookie } : {}), ...(global.currentRequestConfig || {}) };
  const activeProviders = providersForRequest(reqConfig);

  console.log(`[addon] stream request type=${type} id=${rawId}${season ? ` S${season}E${episode}` : ''} providers=${activeProviders.map(p => p.key).join(',')}`);

  const jobs = activeProviders.map(p => withTimeout(
    runProvider(p, { tmdbId: rawId, mediaType, season, episode, requestConfig: reqConfig }),
    parseInt(process.env.PROVIDER_TIMEOUT_MS || '25000', 10)
  ));

  const results = await Promise.all(jobs);
  const streams = results.flat();

  console.log(`[addon] total streams: ${streams.length}`);
  return { streams };
});

module.exports = builder;
