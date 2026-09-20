/**
 * Netmirror provider for LovePeaceKarma.
 *
 * Ported from yoruix/nuvio-providers (providers/netmirror.js) and rewired to
 * LPF conventions (utils/tmdb for the title lookup so a user-supplied TMDB key
 * applies, utils/cache for result caching, clean async/await).
 *
 * Flow (verified live 2026-09-20):
 *   1. TMDB id -> title via resolveTmdb
 *   2. Rotating API base: try each mobiledetect* mirror's /checknewtv.php, take
 *      the base64 `token_hash` as the working API host (tv.imgcdn.kim)
 *   3. GET {api}/newtv/search.php?s=<title>  (header Ott: nf|pv|hs)
 *   4. GET {api}/newtv/post.php?id=<id>, and for TV GET /newtv/episodes.php to
 *      map season/episode -> episode id
 *   5. GET {api}/newtv/player.php?id=<id> -> { status, video_link, referer }
 *
 * IMPORTANT (the bug this port fixes): player.php answers with status "otp"
 * (and sometimes "ok") while still returning a perfectly valid HLS master
 * playlist. The upstream provider only accepted status === "ok" and therefore
 * discarded every stream. We accept any response that carries a video_link.
 * The returned m3u8 + its segments play with no Referer/cookie (verified:
 * 200 application/vnd.apple.mpegurl, 1080p/720p/480p variants, MPEG-TS segments,
 * some served disguised as .jpg/image/jpeg).
 *
 * Three OTT variants are queried in parallel (Netflix / Prime Video / Hotstar);
 * whichever answer are returned as separate streams.
 */
require('dotenv').config();
const { resolveTmdb } = require('../utils/tmdb');
const { getCache, setCache } = require('../utils/cache');

const DEBUG = process.env.DEBUG === 'true';
const log = DEBUG ? console.log : () => {};
const logWarn = DEBUG ? console.warn : () => {};

// Mirrors are base64-encoded in the upstream source; keep them as-is so the
// rotation list survives future mirror swaps without editing URLs by hand.
const DOMAIN_POOL = [
  'aHR0cHM6Ly9tb2JpbGVkZXRlY3RzLmNvbQ==',
  'aHR0cHM6Ly9tb2JpbGVkZXRlY3QuYXBw',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmFydA==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNj',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNsaWNr',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0Lmluaw==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmxpdmU=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnBybw==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNob3A=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNpdGU=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNwYWNl',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnN0b3Jl',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnZpcA==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0Lndpa2k=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0Lnh5eg==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5hcnQ=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5jYw==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbmZv',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbms=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5saXZl',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5wcm8=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5zdG9yZQ==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy50b3A=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy54eXo=',
];

const PLATFORMS = [
  { key: 'netflix', ott: 'nf', label: 'Netflix' },
  { key: 'primevideo', ott: 'pv', label: 'Prime Video' },
  { key: 'hotstar', ott: 'hs', label: 'Hotstar' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Headers the API insists on (X-Requested-With + the Ott selector header).
const BASE_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Requested-With': 'NetmirrorNewTV v1.0',
  'User-Agent': `${UA} /OS.GatuNewTV v1.0`,
  Accept: 'application/json, text/plain, */*',
};

const API_BASE_TTL_MS = 30 * 60 * 1000;
const STREAM_TTL_MS = 30 * 60 * 1000;

let cachedApiBase = null;
let cachedApiBaseAt = 0;

function b64decode(s) {
  try {
    return Buffer.from(s, 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

function headersFor(ott) {
  return { ...BASE_HEADERS, Ott: ott };
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers: { ...headers, 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

/** Resolve the current API host from the mirror pool (cached). */
async function resolveApiUrl() {
  if (cachedApiBase && Date.now() - cachedApiBaseAt < API_BASE_TTL_MS) return cachedApiBase;
  for (const encoded of DOMAIN_POOL) {
    const base = b64decode(encoded).replace(/\/+$/, '');
    if (!base) continue;
    try {
      const data = await fetchJson(`${base}/checknewtv.php`, headersFor('nf'));
      const tokenHash = data && data.token_hash;
      if (tokenHash) {
        const resolved = b64decode(tokenHash).replace(/\/+$/, '');
        if (resolved) {
          cachedApiBase = resolved;
          cachedApiBaseAt = Date.now();
          log(`[netmirror] api base -> ${resolved} (via ${base})`);
          return resolved;
        }
      }
    } catch (e) {
      log(`[netmirror] mirror ${base} failed: ${e.message}`);
    }
  }
  throw new Error('could not resolve NewTV API base');
}

function episodeNumber(ep) {
  if (!ep) return null;
  if (ep.ep) return parseInt(ep.ep, 10);
  if (ep.epNum) return parseInt(String(ep.epNum).replace(/[^\d]/g, ''), 10);
  return null;
}

function seasonNumber(ep, fallback) {
  if (fallback) return fallback;
  if (ep && ep.sNum) return parseInt(String(ep.sNum).replace(/[^\d]/g, ''), 10);
  return null;
}

function collectEpisodes(list, seasonFallback) {
  const out = [];
  for (const ep of (list || [])) {
    if (!ep) continue;
    const num = episodeNumber(ep);
    if (!ep.id) continue;
    out.push({ id: ep.id, s: seasonNumber(ep, seasonFallback), ep: num });
  }
  return out;
}

/** Walk episodes.php pages for one season id. */
async function fetchEpisodesPage(apiBase, seasonId, page, seasonFallback, ott) {
  const episodes = [];
  let pg = page;
  let guard = 0;
  while (guard++ < 10) {
    const data = await fetchJson(`${apiBase}/newtv/episodes.php?id=${seasonId}&page=${pg}`, headersFor(ott));
    episodes.push(...collectEpisodes(data.episodes, seasonFallback));
    if (data.nextPageShow !== 1) break;
    pg++;
  }
  return episodes;
}

async function getAllEpisodes(apiBase, contentId, postData, ott) {
  let episodes = collectEpisodes(postData.episodes, null);
  const seasonIdx = postData.season ? postData.season.findIndex((s) => s && s.selected === true) : -1;
  const selectedSeasonId = seasonIdx >= 0 ? postData.season[seasonIdx].id : postData.nextPageSeason;
  const selectedSeasonNum = seasonIdx >= 0 ? seasonIdx + 1 : null;

  if (postData.nextPageShow === 1 && selectedSeasonId) {
    episodes.push(...await fetchEpisodesPage(apiBase, selectedSeasonId, 2, selectedSeasonNum, ott));
  }
  if (Array.isArray(postData.season)) {
    for (let i = 0; i < postData.season.length; i++) {
      const s = postData.season[i];
      if (!s || !s.id || s.id === selectedSeasonId) continue;
      episodes.push(...await fetchEpisodesPage(apiBase, s.id, 1, i + 1, ott));
    }
  }
  return episodes;
}

/** One OTT variant: search -> post -> (episodes) -> player. Returns streams[] . */
async function fetchFromPlatform(platform, title, mediaType, seasonNum, episodeNum, apiBase, year) {
  const search = await fetchJson(
    `${apiBase}/newtv/search.php?s=${encodeURIComponent(title)}`,
    headersFor(platform.ott)
  );
  const results = (search && search.searchResult) || [];
  if (!results.length) return [];
  // Prefer an exact-ish title match over the first row.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = norm(title);
  const hit = results.find((r) => norm(r.t) === wanted) || results[0];
  const contentId = hit.id;

  const post = await fetchJson(
    `${apiBase}/newtv/post.php?id=${contentId}`,
    headersFor(platform.ott)
  );

  let targetId = contentId;
  if (mediaType === 'tv') {
    if (!seasonNum || !episodeNum) return [];
    const episodes = await getAllEpisodes(apiBase, contentId, post, platform.ott);
    const match = episodes.find((e) => e && e.s === seasonNum && e.ep === episodeNum);
    if (!match) {
      log(`[netmirror] ${platform.key}: no S${seasonNum}E${episodeNum} (${episodes.length} episodes seen)`);
      return [];
    }
    targetId = match.id;
  } else {
    const isSeries = post.type === 't'
      || (Array.isArray(post.episodes) && post.episodes.filter(Boolean).length > 0);
    if (isSeries) return [];
    targetId = post.main_id || contentId;
  }

  const player = await fetchJson(
    `${apiBase}/newtv/player.php?id=${targetId}`,
    headersFor(platform.ott)
  );

  // Accept ANY status that carries a playable link: the API commonly answers
  // "otp" (not "ok") with a valid HLS master playlist attached.
  if (!player || !player.video_link) {
    log(`[netmirror] ${platform.key}: no video_link (status=${player && player.status})`);
    return [];
  }

  const label = hit.t || title;
  // The media variant playlists on the CDN (s21.freecdn4.top/.../*.m3u8) answer 404
  // unless the request carries EXACTLY `Referer: https://net52.cc/` (any other
  // referer, or none, is rejected - verified). Stremio sends no Referer on its own,
  // so declare it via the addon protocol's proxyHeaders hint. Segments themselves
  // (.jpg-disguised MPEG-TS) play without any header, so only the playlist layer
  // needs this.
  const apiReferer = String(player.referer || 'https://net52.cc').replace(/\/+$/, '') + '/';
  return [{
    name: `NetMirror - ${platform.label}`,
    title: `${label}${year ? ` (${year})` : ''}\n${mediaType === 'tv' ? `S${seasonNum}E${episodeNum} | ` : ''}HLS`.trim(),
    url: player.video_link,
    quality: 'Auto',
    behaviorHints: {
      bingeGroup: `netmirror-${platform.key}`,
      proxyHeaders: { request: { Referer: apiReferer } },
    },
  }];
}

/**
 * @param {string|number} tmdbId
 * @param {string} mediaType 'movie' | 'tv' | 'series'
 */
async function getStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
  const type = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
  try {
    const info = await resolveTmdb(tmdbId, type);
    if (!info || !info.title) return [];
    const title = info.title;
    const year = info.year || null;

    // v2: bump when the stream object shape changes (proxyHeaders added) so a
    // stale entry from the on-disk cache cannot mask the change.
    const cacheKey = `streams_v2_${type}_${tmdbId}${type === 'tv' && seasonNum ? `_s${seasonNum}e${episodeNum}` : ''}`;
    const cached = await getCache('netmirror', cacheKey, STREAM_TTL_MS);
    if (Array.isArray(cached) && cached.length) return cached;

    const apiBase = await resolveApiUrl();

    const results = await Promise.all(PLATFORMS.map((p) =>
      fetchFromPlatform(p, title, type, seasonNum, episodeNum, apiBase, year)
        .catch((e) => {
          log(`[netmirror] ${p.key} failed: ${e.message}`);
          return [];
        })
    ));
    const streams = results.flat();

    log(`[netmirror] tmdb ${tmdbId} (${title}) -> ${streams.length} streams`);
    if (streams.length) await setCache('netmirror', cacheKey, streams);
    return streams;
  } catch (e) {
    logWarn(`[netmirror] error: ${e.message}`);
    return [];
  }
}

module.exports = { getStreams, resolveApiUrl };
