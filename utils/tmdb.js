require('dotenv').config();
const axios = require('axios');
const { AsyncLocalStorage } = require('async_hooks');

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// Server-side key (env), or the original shared fallback.
const DEFAULT_TMDB_KEY = process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c';

// The v3 key shipped in the old code, kept as a module export for backwards
// compatibility with anything that still imports it.
const TMDB_API_KEY = DEFAULT_TMDB_KEY;

// ---------- Per-request key handling ----------
// Users can supply their own TMDB credential through the configure page. It
// arrives per-request (query param / Stremio config path), so it must never be
// stored in a module-level variable: concurrent requests would overwrite each
// other. AsyncLocalStorage propagates through awaits and promise chains, so
// providers can keep calling resolveTmdb(id, type) with no signature change.
const als = new AsyncLocalStorage();

// v3 API keys are 32 hex chars; v4 read access tokens are JWTs.
const HEX32 = /^[0-9a-f]{32}$/i;
const JWTISH = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function isV4Token(k) {
  return JWTISH.test(String(k || '').trim());
}

function isValidTmdbKey(k) {
  const v = String(k == null ? '' : k).trim();
  if (!v) return false;
  return HEX32.test(v) || JWTISH.test(v);
}

function normalizeKey(k) {
  const v = String(k == null ? '' : k).trim();
  return isValidTmdbKey(v) ? v : null;
}

// Explicit arg > request-scoped key > server/env key
function activeTmdbKey(explicit) {
  return normalizeKey(explicit)
    || (als.getStore() && als.getStore().tmdbKey)
    || DEFAULT_TMDB_KEY;
}

/** Run fn with `key` as the request-scoped TMDB credential. */
function withTmdbKey(key, fn) {
  const k = normalizeKey(key);
  return k ? als.run({ tmdbKey: k }, fn) : fn();
}

/**
 * Build an axios request spec for a TMDB path, honouring v3 keys (query param)
 * and v4 tokens (Authorization: Bearer).
 * @param {string} pathAndQuery e.g. "/movie/27205" or "/find/tt1?external_source=imdb_id"
 */
function tmdbRequest(pathAndQuery, explicitKey) {
  const key = activeTmdbKey(explicitKey);
  const base = `${TMDB_BASE_URL}${pathAndQuery}`;
  if (isV4Token(key)) {
    return { url: base, opts: { headers: { Authorization: `Bearer ${key}` } } };
  }
  const sep = base.includes('?') ? '&' : '?';
  return { url: `${base}${sep}api_key=${key}`, opts: {} };
}

/** True when a user-supplied key is active for this request. */
function usingUserKey(explicit) {
  return !!(normalizeKey(explicit) || (als.getStore() && als.getStore().tmdbKey));
}

/**
 * Resolve a TMDB ID to { id, type: 'movie'|'tv', title, year }.
 * Accepts an already-tmdb numeric id (with expected type) or an IMDb tt-id.
 * @param {string|number} rawId e.g. "27205", "tt1375666"
 * @param {string} expectedType 'movie'|'series'|'tv'
 * @param {string} [apiKey] optional per-call key override
 */
async function resolveTmdb(rawId, expectedType = null, apiKey = null) {
  const isSeries = expectedType === 'tv' || expectedType === 'series';
  const idStr = String(rawId);

  // IMDb id -> TMDB find API
  if (/^tt\d+$/i.test(idStr)) {
    const req = tmdbRequest(`/find/${idStr}?external_source=imdb_id`, apiKey);
    const res = await axios.get(req.url, { timeout: 10000, ...req.opts });
    const data = res.data || {};
    let pick = null;
    if (isSeries) {
      pick = (data.tv_results && data.tv_results[0]) || null;
      if (!pick) pick = (data.movie_results && data.movie_results[0]) || null;
    } else {
      pick = (data.movie_results && data.movie_results[0]) || null;
      if (!pick) pick = (data.tv_results && data.tv_results[0]) || null;
    }
    if (!pick) return null;
    const isTv = pick.name !== undefined && pick.title === undefined;
    return {
      id: pick.id,
      type: isTv ? 'tv' : 'movie',
      title: isTv ? pick.name : pick.title,
      year: isTv
        ? (pick.first_air_date || '').substring(0, 4)
        : (pick.release_date || '').substring(0, 4),
    };
  }

  // Numeric TMDB id with expected type
  if (/^\d+$/.test(idStr)) {
    const type = isSeries ? 'tv' : 'movie';
    const req = tmdbRequest(`/${type}/${idStr}`, apiKey);
    const res = await axios.get(req.url, { timeout: 10000, ...req.opts });
    const d = res.data || {};
    const isTv = d.name !== undefined && d.title === undefined;
    return {
      id: d.id,
      type: isTv ? 'tv' : 'movie',
      title: isTv ? d.name : d.title,
      year: isTv
        ? (d.first_air_date || '').substring(0, 4)
        : (d.release_date || '').substring(0, 4),
    };
  }

  return null;
}

module.exports = {
  resolveTmdb,
  TMDB_API_KEY,
  DEFAULT_TMDB_KEY,
  TMDB_BASE_URL,
  tmdbRequest,
  withTmdbKey,
  activeTmdbKey,
  usingUserKey,
  isValidTmdbKey,
};
