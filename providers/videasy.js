/**
 * Videasy provider for LovePeaceKarma.
 * Ported from Vynx-Velvet/Flyx-main packages/extractors/src/services/videasy.ts (RE'd chain):
 *   1. GET db.speedracelight.com/3/movie|tv/{id}          -> TMDB metadata (title/year/imdb)
 *   2. GET api.speedracelight.com/seed?mediaId={tmdbId}   -> short-lived seed (rate-limited)
 *   3. GET api.speedracelight.com/{provider}/sources-with-title?...&enc=2&seed=
 *      -> base64 payload XOR-encrypted with a custom PRNG (magic header "mvm1")
 *   4. Decrypt -> JSON { sources: [{url,quality}], subtitles: [{url,lang}] }
 *
 * Verified live 2026-09-15: Inception (4 HLS variants) + 13 Reasons Why S01E01 (3 HLS).
 */
require('dotenv').config();
const { getCache, setCache } = require('../utils/cache');

const TMDB_PROXY = 'https://db.speedracelight.com/3';
const API_BASE = 'https://api.speedracelight.com';
const REFERER = 'https://player.videasy.to/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Ordered by reliability. Keep short - seed API rate-limits.
const PROVIDERS = [
  { path: '/cdn/sources-with-title', label: 'Yoru' },
  { path: '/neon2/sources-with-title', label: 'Neon' },
  { path: '/m4uhd/sources-with-title', label: 'Breach' },
  { path: '/meine/sources-with-title', label: 'Killjoy' },
  { path: '/lamovie/sources-with-title', label: 'Omen' },
];
const MAX_SOURCES = 8;

const DEBUG = process.env.DEBUG === 'true';
const log = DEBUG ? console.log : () => {};
const logWarn = DEBUG ? console.warn : () => {};

// ── Decrypt tables (Flyx player chunk 8351) ──
const F = [
  1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993,
  2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987,
  1925078388, 2162078206, 2614888103, 3248222580,
];
const MAGIC = [109, 118, 109, 49]; // "mvm1"

const isEvenTri = (e) => ((e * (e + 1)) & 1) === 0;
const isOddTri = (e) => ((e * (e + 1)) & 1) === 1;

function mix(e) {
  e >>>= 0;
  e ^= e >>> 16;
  e = Math.imul(e, 2246822507) >>> 0;
  e ^= e >>> 13;
  e = Math.imul(e, 3266489909) >>> 0;
  return (e ^= e >>> 16) >>> 0;
}
function rotl(e, t) {
  e >>>= 0;
  t &= 31;
  if (t === 0) return e >>> 0;
  return ((e << t) | (e >>> (32 - t))) >>> 0;
}
function fnv1a(e) {
  let t = 2166136261;
  for (let s = 0; s < e.length; s++) {
    t = Math.imul(t ^ e.charCodeAt(s), 16777619) >>> 0;
  }
  return mix(t);
}
function accSeed(e) {
  let t = 1732584193;
  for (let s = 0; s < e.length; s++) {
    t = rotl((t ^ Math.imul(e.charCodeAt(s), F[15 & s] != null ? F[15 & s] : 0)) >>> 0, 5);
  }
  return mix(t);
}
function rc4Sbox(e) {
  const t = Array.from({ length: 256 }, (_, i) => i);
  let s = 0;
  for (let a = 0; a < 256; a++) {
    s = (s + t[a] + e.charCodeAt(a % e.length)) & 255;
    const r = t[a];
    t[a] = t[s];
    t[s] = r;
  }
  return t;
}
function buildState(seed, mediaId) {
  if (isOddTri(seed.length)) {
    return { S: rc4Sbox(seed), acc: accSeed(seed) };
  }
  const s = new Array(61);
  let a = mix(fnv1a(seed) ^ mix((mediaId >>> 0) ^ 2654435769)) >>> 0;
  for (let e = 0; e < 8; e++) {
    if (isEvenTri(e)) {
      const t = a % 61;
      a = rotl((a + 2654435769) >>> 0, 7 + (7 & e));
      s[t] = (a ^ mix(a)) >>> 0;
      a = mix((a + t) >>> 0);
    } else {
      s[e] = F[15 & e];
    }
  }
  return { S: s, acc: mix(2779096485 ^ a) >>> 0 };
}
function nextWord(state, counter) {
  const r = state.S;
  let acc = state.acc;
  const n = acc % 61;
  const i = 0 - Number(Object.prototype.hasOwnProperty.call(r, n));
  const l = (r[n] != null ? r[n] : 0) >>> 0;
  const a = (l ^ (Math.imul(2654435769, counter + 1) >>> 0)) >>> 0;
  let d = ((acc ^ a) >>> 0 | ((acc & a & i) >>> 0)) >>> 0;
  d = (rotl((d + acc) >>> 0, 31 & n) ^ rotl(acc, 31 & Math.imul(n, 7))) >>> 0;
  acc = mix((d + 2654435769) >>> 0);
  r[n] = acc >>> 0;
  state.acc = acc;
  return acc >>> 0;
}
function keystream(seed, mediaId, len) {
  const state = buildState(seed, mediaId);
  const out = new Uint8Array(len);
  let counter = 0;
  for (let e = 0; e < len; ) {
    const t = nextWord(state, counter++);
    out[e++] = 255 & t;
    if (e < len) out[e++] = (t >>> 8) & 255;
    if (e < len) out[e++] = (t >>> 16) & 255;
    if (e < len) out[e++] = (t >>> 24) & 255;
  }
  return out;
}
function b64ToBytes(e) {
  return new Uint8Array(Buffer.from(e.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}
function decryptPayload(payload, seed, mediaId) {
  const r = b64ToBytes(payload);
  const o = keystream(seed, mediaId, r.length);
  for (let e = 0; e < r.length; e++) r[e] ^= o[e];
  for (let e = 0; e < MAGIC.length; e++) {
    if (r[e] !== MAGIC[e]) {
      throw new Error('videasy decrypt failed: bad seed or tampered payload');
    }
  }
  return Buffer.from(r.slice(MAGIC.length)).toString('utf-8');
}

// ── HTTP ──
async function fetchJSON(url, headers, timeoutMs = 15000) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}
async function fetchText(url, headers, timeoutMs = 20000) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function defaultHeaders() {
  return { 'User-Agent': UA, Referer: REFERER, Origin: 'https://player.videasy.to', Accept: 'application/json, text/plain, */*' };
}

// ── Seed with cache + let a 30s TTL, shared across providers ──
const seedCache = new Map(); // mediaId -> { seed, expiresAt }
const seedInflight = new Map();

async function getSeed(mediaId, force = false) {
  const now = Date.now();
  if (!force) {
    const c = seedCache.get(mediaId);
    if (c && c.expiresAt - 5000 > now) return c.seed;
    if (seedInflight.has(mediaId)) return seedInflight.get(mediaId);
  }
  const promise = (async () => {
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`${API_BASE}/seed?mediaId=${mediaId}`, { headers: defaultHeaders() });
        const data = await res.json();
        if (res.status === 429 || data.error === 'rate_limited') {
          lastErr = new Error('seed rate_limited');
          await sleep(800 * (attempt + 1) + Math.random() * 400);
          continue;
        }
        if (!res.ok || !data.seed) throw new Error(`seed HTTP ${res.status}`);
        const ttl = data.ttlMs || 30000;
        seedCache.set(mediaId, { seed: data.seed, expiresAt: Date.now() + ttl });
        return data.seed;
      } catch (e) {
        lastErr = e;
        await sleep(400 * (attempt + 1));
      }
    }
    throw lastErr || new Error('seed failed');
  })();
  seedInflight.set(mediaId, promise);
  try {
    return await promise;
  } finally {
    seedInflight.delete(mediaId);
  }
}

// ── Encrypted source fetch (one attempt, plus fresh-seed retry) ──
async function fetchProvider(path, mediaId, params, seed) {
  const buildQs = (s) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === '') continue;
      qs.set(k, String(v));
    }
    qs.set('enc', '2');
    qs.set('seed', s);
    return qs;
  };
  const attempt = async (s) => {
    let payload = (await fetchText(`${API_BASE}${path}?${buildQs(s)}`, defaultHeaders())).trim();
    if (payload.startsWith('"') && payload.endsWith('"')) payload = JSON.parse(payload);
    if (payload.startsWith('{')) {
      try {
        const err = JSON.parse(payload);
        if (err.error) {
          if (String(err.error).toLowerCase().includes('seed')) throw new Error('SEED_INVALID');
          return null;
        }
      } catch (e) {
        if (e.message === 'SEED_INVALID') throw e;
      }
    }
    return JSON.parse(decryptPayload(payload, s, mediaId));
  };
  try {
    return await attempt(seed);
  } catch (e) {
    if (e.message === 'SEED_INVALID') {
      try {
        seedCache.delete(mediaId);
        const fresh = await getSeed(mediaId, true);
        return await attempt(fresh);
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

function mapSources(raw, label) {
  const out = [];
  for (const s of raw || []) {
    const url = s && (s.url || s.file);
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    const isHls = s.type === 'hls' || url.includes('.m3u8');
    const isDash = s.type === 'dash' || s.type === 'mpd' || url.includes('.mpd');
    const quality = String(s.quality || 'Auto').toUpperCase();
    out.push({
      name: `Videasy ${label} - ${quality}`,
      title: `Videasy ${label}\n${quality}${isHls ? '\nHLS' : ''}`,
      url: url,
      quality: /^(\d{3,4})P?$/i.test(quality) ? `${parseInt(quality, 10)}p` : undefined,
      behaviorHints: { bingeGroup: `videasy-${label}` },
    });
  }
  return out;
}

async function getVideasyStreams(tmdbId, type = 'movie', season = null, episode = null) {
  const mediaType = type === 'series' || type === 'tv' ? 'tv' : 'movie';
  const cacheKey = `streams_${mediaType}_${tmdbId}${season ? `_s${season}e${episode}` : ''}`;
  const cached = await getCache('videasy', cacheKey, 1800000);
  if (cached) return cached;

  try {
    // Step 1: metadata via their TMDB proxy
    const isTv = mediaType === 'tv' && season != null && episode != null;
    const metaPath = isTv
      ? `/tv/${tmdbId}?append_to_response=external_ids`
      : `/movie/${tmdbId}?append_to_response=external_ids`;
    const tmdb = await fetchJSON(`${TMDB_PROXY}${metaPath}`, defaultHeaders());
    const title = tmdb.title || tmdb.name || tmdb.original_title || tmdb.original_name || String(tmdbId);
    const yearStr = (tmdb.release_date || tmdb.first_air_date || '').slice(0, 4);
    const year = yearStr ? parseInt(yearStr, 10) : undefined;
    const imdbId = tmdb.imdb_id || (tmdb.external_ids && tmdb.external_ids.imdb_id) || '';
    const totalSeasons = tmdb.number_of_seasons;

    // Player double-encodes the title once via encodeURIComponent, then URLSearchParams encodes again.
    const params = {
      title: encodeURIComponent(title),
      mediaType: isTv ? 'tv' : 'movie',
      year: year || undefined,
      tmdbId,
      imdbId,
      totalSeasons: isTv ? totalSeasons : undefined,
      seasonId: isTv ? season : undefined,
      episodeId: isTv ? episode : undefined,
    };

    // Step 2: one seed, sequential providers
    let seed;
    try {
      seed = await getSeed(tmdbId);
    } catch (e) {
      logWarn(`[videasy] seed failed: ${e.message}`);
      return [];
    }

    const sources = [];
    const seen = new Set();
    for (const p of PROVIDERS) {
      if (sources.length >= MAX_SOURCES) break;
      let data;
      try {
        data = await fetchProvider(p.path, tmdbId, params, seed);
      } catch (e) {
        log(`[videasy] ${p.label} error: ${e.message}`);
        data = null;
      }
      const cachedSeed = seedCache.get(tmdbId);
      if (cachedSeed) seed = cachedSeed.seed;
      if (data && data.sources && data.sources.length) {
        for (const s of mapSources(data.sources, p.label)) {
          if (!seen.has(s.url)) {
            seen.add(s.url);
            sources.push(s);
          }
        }
      }
      await sleep(150);
    }
    log(`[videasy] tmdb ${tmdbId} -> ${sources.length} streams`);
    await setCache('videasy', cacheKey, sources);
    return sources;
  } catch (e) {
    logWarn(`[videasy] tmdb ${tmdbId} failed: ${e.message}`);
    return [];
  }
}

module.exports = {
  getVideasyStreams,
  // exposed for testing
  _decryptPayload: decryptPayload,
};
