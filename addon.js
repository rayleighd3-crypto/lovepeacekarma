require('dotenv').config();
const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const { resolveTmdb, TMDB_API_KEY } = require('./utils/tmdb');

const manifest = require('./manifest.json');

// Provider enable/disable flags (default all on)
const ENABLE = (name) => process.env[`ENABLE_${name}_PROVIDER`] !== 'false';

const PROVIDERS = [];
if (ENABLE('4KHDHUB')) PROVIDERS.push({ key: '4khdhub', label: '4KHDHub' });
if (ENABLE('HDHUB4U')) PROVIDERS.push({ key: 'hdhub4u', label: 'HDHub4u' });
if (ENABLE('111477')) PROVIDERS.push({ key: '111477', label: '111477' });

// Lazy-require providers (avoid loading heavyweight deps on /manifest)
function providerFns(key) {
  switch (key) {
    case '4khdhub': return require('./providers/4khdhub');
    case 'hdhub4u': return require('./providers/hdhub4u');
    case '111477': return require('./providers/111477');
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

async function runProvider(p, { tmdbId, mediaType, season, episode }) {
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
    const url = `https://api.themoviedb.org/3/search/${mediaType}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(search)}&page=1`;
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
  if (!search) return { metas: [] };
  const metas = await searchCatalog(type, search);
  return { metas };
});

builder.defineStreamHandler(async ({ type, id }) => {
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

  console.log(`[addon] stream request type=${type} id=${rawId}${season ? ` S${season}E${episode}` : ''} providers=${PROVIDERS.map(p => p.key).join(',')}`);

  const jobs = PROVIDERS.map(p => withTimeout(
    runProvider(p, { tmdbId: rawId, mediaType, season, episode }),
    parseInt(process.env.PROVIDER_TIMEOUT_MS || '25000', 10)
  ));

  const results = await Promise.all(jobs);
  const streams = results.flat();

  console.log(`[addon] total streams: ${streams.length}`);
  return { streams };
});

module.exports = builder;
