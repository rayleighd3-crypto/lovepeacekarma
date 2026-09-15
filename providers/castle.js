/**
 * Castle provider for LovePeaceKarma.
 * Ported from yoruix/nuvio-providers castle (src/castle), verified live 2026-09-15 (Inception):
 *   1. GET api.hlowb.com/v0.1/system/getSecurityKey/1?channel=&clientType=&lang= -> b64 key
 *   2. EVERY film-api response is b64 ciphertext: AES-128-CBC,
 *      key = base64(keyB64) + "T!BgJB" zero-padded to 16 bytes, IV = key
 *   3. /film-api/v1.1.0/movie/searchByKeyword -> rows[0].id (TMDB title match)
 *   4. /film-api/v1.9.9/movie?movieId=... -> episodes[].tracks[] language metadata
 *   5. POST /film-api/v2.0.1/movie/getVideo2 {apkSignKey,...} -> {videoUrl: m3u8}
 * Multi-language (English default + Tamil etc). Resolution: 1=480p, 2=720p, 4=FHD.
 */
require('dotenv').config();
const crypto = require('crypto');
const { resolveTmdb } = require('../utils/tmdb');
const { getCache, setCache } = require('../utils/cache');

const CASTLE_BASE = 'https://api.hlowb.com';
const PKG = 'com.external.castle';
const CHANNEL = 'IndiaA';
const CLIENT = '1';
const LANG = 'en';
const APK_SIGN_KEY = 'ED0955EB04E67A1D9F3305B95454FED485261475';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEBUG = process.env.DEBUG === 'true';
const log = DEBUG ? console.log : () => {};
const logWarn = DEBUG ? console.warn : () => {};

// AES-128-CBC with key==IV, PKCS7 (Node has no pad option -> strip manually)
function aesCbcDecrypt(key, data) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
  decipher.setAutoPadding(true);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
  } catch (e) {
    // fallback: no padding if PKCS7 strip fails
    const d2 = crypto.createDecipheriv('aes-128-cbc', key, key);
    d2.setAutoPadding(false);
    return Buffer.concat([d2.update(data), d2.final()]).toString('utf-8');
  }
}

function buildKey(securityKeyB64) {
  let km = Buffer.from(securityKeyB64, 'base64');
  // exactly like CryptoJS.enc.Base64.parse on the decoded string (yoruix uses double decode)
  // security key b64 decodes to ~10 ascii bytes; then concat "T!BgJB".
  km = Buffer.concat([km, Buffer.from('T!BgJB')]);
  if (km.length > 16) km = km.slice(0, 16);
  else if (km.length < 16) km = Buffer.concat([km, Buffer.alloc(16 - km.length)]);
  return km;
}

async function rawFetch(url, { method = 'GET', body = null, headers = {} } = {}) {
  const h = { 'User-Agent': UA, 'Accept': 'application/json', ...headers };
  const opts = { method, headers: h };
  if (body) {
    opts.body = JSON.stringify(body);
    h['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function getSecurityKey() {
  const d = JSON.parse(await rawFetch(`${CASTLE_BASE}/v0.1/system/getSecurityKey/1?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`));
  if (d.code !== 200 || !d.data) throw new Error(`security key error: ${JSON.stringify(d)}`);
  return d.data;
}

function decrypt(cipherB64, key) {
  return aesCbcDecrypt(key, Buffer.from(cipherB64, 'base64'));
}

async function searchCastle(key, keyword, page = 1, size = 30) {
  const params = new URLSearchParams({
    channel: CHANNEL, clientType: CLIENT, keyword, lang: LANG, mode: '1', packageName: PKG,
    page: String(page), size: String(size),
  });
  const cipher = await rawFetch(`${CASTLE_BASE}/film-api/v1.1.0/movie/searchByKeyword?${params}`);
  return JSON.parse(decrypt(cipher, key));
}

async function getDetails(key, movieId) {
  const cipher = await rawFetch(`${CASTLE_BASE}/film-api/v1.9.9/movie?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}&movieId=${movieId}&packageName=${PKG}`);
  return JSON.parse(decrypt(cipher, key));
}

async function getVideo2(key, movieId, episodeId, languageId, resolution) {
  const url = `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`;
  const body = {
    mode: '1', appMarket: 'GuanWang', clientType: CLIENT, woolUser: 'false',
    apkSignKey: APK_SIGN_KEY, androidVersion: '13',
    movieId: String(movieId),
    episodeId: String(episodeId),
    isNewUser: 'true',
    resolution: String(resolution),
    packageName: PKG,
  };
  if (languageId != null) body.languageId = String(languageId);
  const cipher = await rawFetch(url, { method: 'POST', body });
  return JSON.parse(decrypt(cipher, key));
}

function normalizeTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Map Castle languages array [.. names ..] -> tracks languageIds list
async function getCastleStreams(tmdbId, type = 'movie', season = null, episode = null) {
  const mediaType = type === 'series' || type === 'tv' ? 'tv' : 'movie';
  const cacheKey = `streams_${mediaType}_${tmdbId}${season ? `_s${season}e${episode}` : ''}`;
  const cached = await getCache('castle', cacheKey, 1800000);
  if (cached) return cached;

  try {
    const info = await resolveTmdb(tmdbId, mediaType);
    if (!info || !info.title) return [];
    const title = info.title;
    const year = info.year ? String(info.year).slice(0, 4) : '';

    const keyB64 = await getSecurityKey();
    const key = buildKey(keyB64);
    const searchTerm = year ? `${title} ${year}` : title;
    let search;
    try {
      search = await searchCastle(key, searchTerm);
    } catch (e) {
      logWarn(`[castle] search failed: ${e.message}`);
      return [];
    }
    const rows = (search.data && search.data.rows) || [];
    if (!rows.length) {
      log(`[castle] no search results for ${title}`);
      return [];
    }
    const titleNorm = normalizeTitle(title);
    let match = rows.find((r) => {
      const n = normalizeTitle(r.title || r.name);
      return n === titleNorm || n.includes(titleNorm) || titleNorm.includes(n);
    }) || rows[0];
    if (!match) return [];
    const movieId = match.id;

    let details;
    try {
      const detCipher = await rawFetch(`${CASTLE_BASE}/film-api/v1.9.9/movie?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}&movieId=${movieId}&packageName=${PKG}`);
      details = JSON.parse(decrypt(detCipher, key));
    } catch (e) {
      logWarn(`[castle] details failed: ${e.message}`);
      details = null;
    }

    const streams = [];
    // Build (episodeId, languageId) tuples
    const episodes = (details && details.data && details.data.episodes) || [];
    let targets = [];
    if (mediaType === 'tv' && season && episode) {
      const ep = episodes.find((e) => Number(e.number) === Number(episode));
      if (!ep) { log(`[castle] episode S${season}E${episode} not found`); return []; }
      for (const t of ep.tracks || []) {
        targets.push({ episodeId: ep.id, languageId: t.languageId, languageName: t.languageName, resolutions: t.videos || [] });
      }
      if (!targets.length && ep.videos) {
        targets.push({ episodeId: ep.id, languageId: null, languageName: match.languages ? match.languages[0] : '', resolutions: ep.videos });
      }
    } else {
      // Movie: use first episode (whole movie) - language list comes from data
      const ep = episodes[0];
      if (!ep) return [];
      const langs = (details && details.data && details.data.languages) || match.languages || [];
      for (const t of ep.tracks || []) {
        if (t.existIndividualVideo) {
          targets.push({ episodeId: ep.id, languageId: t.languageId, languageName: t.languageName, resolutions: t.videos || [] });
        } else {
          targets.push({ episodeId: ep.id, languageId: t.languageId, languageName: t.languageName, resolutions: ep.videos || [] });
        }
      }
      if (!targets.length) {
        targets.push({ episodeId: ep.id, languageId: null, languageName: langs[0] || '', resolutions: ep.videos || [] });
      }
    }

    // Probe each language/res combo with small resolutions; throttle
    const RESOLUTIONS = [1, 2, 4]; // 480p, 720p, FHD
    for (const t of targets) {
      for (const res of RESOLUTIONS) {
        if (t.resolutions.length && !t.resolutions.some((v) => String(v.resolution) === String(res))) continue;
        try {
          const body = {
            mode: '1', appMarket: 'GuanWang', clientType: CLIENT, woolUser: 'false',
            apkSignKey: APK_SIGN_KEY, androidVersion: '13',
            movieId: String(match.id || movieId), episodeId: String(t.episodeId),
            isNewUser: 'true', resolution: String(res), packageName: PKG,
          };
          if (t.languageId != null) body.languageId = String(t.languageId);
          const cipher = await rawFetch(`${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`, { method: 'POST', body });
          const d = JSON.parse(decrypt(cipher, key));
          if (d.code === 200 && d.data && d.data.videoUrl) {
            const quality = res === 4 ? '1080p' : res === 2 ? '720p' : '480p';
            streams.push({
              name: `Castle ${t.languageName || ''} - ${quality}`.trim(),
              title: `${title}${year ? ` (${year})` : ''}\n${t.languageName || ''}[${quality}]`.trim(),
              url: d.data.videoUrl,
              quality,
              behaviorHints: { bingeGroup: `castle-${t.languageId || 'default'}` },
            });
          } else if (d.code !== 200) {
            log(`[castle] getVideo2 code ${d.code}`);
          }
        } catch (e) {
          log(`[castle] getVideo2 failed: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    log(`[castle] tmdb ${tmdbId} -> ${streams.length} streams (${targets.length} langs)`);
    await setCache('castle', cacheKey, streams);
    return streams;
  } catch (e) {
    logWarn(`[castle] tmdb ${tmdbId} failed: ${e.message}`);
    return [];
  }
}

module.exports = { getCastleStreams };
