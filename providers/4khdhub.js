/**
 * 4KHDHub provider for LovePeaceKarma.
 * Base URL and approach: https://4khdhub.fans (WordPress download site).
 * Decodes obfuscated redirect links (atob + ROT13 chain) to HubCloud/HubDrive hosts.
 */
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const bytes = require('bytes');
const levenshtein = require('fast-levenshtein');
const rot13Cipher = require('rot13-cipher');
const { resolveTmdb } = require('../utils/tmdb');
const { getCache, setCache } = require('../utils/cache');

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const DEFAULT_BASE_URL = 'https://4khdhub.fans';
const FALLBACK_BASE_URLS = ['https://4khdhub.one', 'https://4khdhub.com', 'https://4khdhub.dad'];
let BASE_URL = DEFAULT_BASE_URL;
let domainCacheTimestamp = 0;
const DOMAIN_CACHE_TTL = 4 * 60 * 60 * 1000;

// Current 4KHDHub domain rotates - fetch from the shared domains.json
async function resolveBaseUrl() {
  if (Date.now() - domainCacheTimestamp < DOMAIN_CACHE_TTL) return BASE_URL;
  try {
    const resp = await axios.get(DOMAINS_URL, { timeout: 10000 });
    if (resp.data && resp.data['4khdhub']) {
      BASE_URL = resp.data['4khdhub'];
      domainCacheTimestamp = Date.now();
      log(`[4KHDHub] domain -> ${BASE_URL}`);
      return BASE_URL;
    }
  } catch (e) {
    logWarn(`[4KHDHub] domain fetch failed, using fallback list`);
  }
  return BASE_URL;
}

// Try each candidate base URL until one responds
async function getWorkingBaseUrl() {
  const candidates = [await resolveBaseUrl(), ...FALLBACK_BASE_URLS];
  const seen = new Set();
  for (const base of candidates) {
    if (!base || seen.has(base)) continue;
    seen.add(base);
    try {
      const res = await axios.head(base + '/', { timeout: 8000, validateStatus: () => true });
      if (res.status >= 200 && res.status < 500) {
        BASE_URL = base;
        return base;
      }
    } catch (e) { /* try next */ }
  }
  return BASE_URL;
}
const DEBUG = process.env.DEBUG === 'true';
const log = DEBUG ? console.log : () => {};
const logWarn = DEBUG ? console.warn : () => {};

const atob = (str) => Buffer.from(str, 'base64').toString('binary');

async function fetchText(url, options = {}) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        ...options.headers,
      },
      timeout: 15000,
    });
    return response.data;
  } catch (e) {
    log(`[4KHDHub] req failed ${url}: ${e.message}`);
    return null;
  }
}

async function fetchPageUrl(name, year, isSeries) {
  const key = `search_${name.replace(/[^a-z0-9]/gi, '_')}_${year}`;
  const cached = await getCache('4khdhub', key, 86400000);
  if (cached) return cached;

  const html = await fetchText(`${BASE_URL}/?s=${encodeURIComponent(`${name} ${year}`)}`);
  if (!html) return null;
  const $ = cheerio.load(html);
  const targetType = isSeries ? 'Series' : 'Movies';

  const matchingCards = $('.movie-card')
    .filter((_i, el) => $(el).find(`.movie-card-format:contains("${targetType}")`).length > 0)
    .filter((_i, el) => {
      const metaText = $(el).find('.movie-card-meta').text();
      const y = parseInt(metaText, 10);
      return !isNaN(y) && Math.abs(y - year) <= 1;
    })
    .filter((_i, el) => {
      const t = $(el).find('.movie-card-title').text().replace(/\[.*?]/g, '').trim();
      return levenshtein.get(t.toLowerCase(), name.toLowerCase()) < 5;
    })
    .map((_i, el) => {
      let href = $(el).attr('href');
      if (href && !href.startsWith('http')) {
        href = BASE_URL + (href.startsWith('/') ? '' : '/') + href;
      }
      return href;
    })
    .get();

  const result = matchingCards.length > 0 ? matchingCards[0] : null;
  log(`[4KHDHub] fetchPageUrl("${name}") -> ${result}`);
  if (result) await setCache('4khdhub', key, result);
  return result;
}

// Resolve a HubCloud link (https://hubcloud.ist|.cx/drive/<id>) to a direct playable file.
// Current chain: hubcloud.ist -> (302) hubcloud.cx -> page contains `url='https://gamerxyt.com/hubcloud.php?host=hubcloud&id=...&token=...'`
//                -> gamerxyt.php page contains `<a href="https://*.workers.dev/<sig>/<file>.mkv">` (direct file).
async function resolveHubCloudToDirect(hubCloudUrl) {
  try {
    const pageHtml = await fetchText(hubCloudUrl, { headers: { Referer: BASE_URL + '/' } });
    if (!pageHtml) return null;
    const phpMatch = pageHtml.match(/url\s*=\s*'([^']+)'/);
    if (!phpMatch) return null;
    const phpUrl = phpMatch[1];
    const linksHtml = await fetchText(phpUrl, { headers: { Referer: hubCloudUrl } });
    if (!linksHtml) return null;
    const directMatch = linksHtml.match(/href="([^"]+)"[^>]*>\s*Download File/i) ||
      linksHtml.match(/href="([^"]*(?:workers\.dev|\.mkv|\.mp4)[^"]*)"/i);
    if (!directMatch) return null;
    // Clean: collapse any whitespace/newlines and URL-encode raw spaces
    return directMatch[1].replace(/\s+/g, '%20');
  } catch (e) {
    log(`[4KHDHub] resolve error: ${e.message}`);
    return null;
  }
}

// Deprecated legacy decode path (older hubcloud scheme) kept as fallback.
async function resolveRedirectUrl(redirectUrl) {
  const redirHtml = await fetchText(redirectUrl);
  if (!redirHtml) return null;
  try {
    const match = redirHtml.match(/'o','(.*?)'/);
    if (!match) return null;
    const step1 = atob(match[1]);
    const step2 = atob(step1);
    const step3 = rot13Cipher(step2);
    const step4 = atob(step3);
    const redirectData = JSON.parse(step4);
    if (redirectData && redirectData.o) return atob(redirectData.o);
  } catch (e) {
    log(`[4KHDHub] redirect decode error: ${e.message}`);
  }
  return null;
}

async function extractSourceResults($, el) {
  const localHtml = $(el).html();
  const sizeMatch = localHtml.match(/([\d.]+ ?[GM]B)/);
  let heightMatch = localHtml.match(/\d{3,}p/);
  const title = $(el).find('.file-title, .episode-file-title').text().trim();
  if (!heightMatch) heightMatch = title.match(/(\d{3,4})p/i);
  let height = heightMatch ? parseInt(heightMatch[0]) : 0;
  if (height === 0 && /4K/i.test(title + localHtml)) height = 2160;
  const meta = { bytes: sizeMatch ? bytes.parse(sizeMatch[1]) : 0, height, title };

  const hubCloud = $(el).find('a').filter((_i, a) => $(a).text().includes('HubCloud')).attr('href');
  if (hubCloud) {
    const resolved = await resolveHubCloudToDirect(hubCloud);
    if (resolved) return { url: resolved, meta, direct: true };
    // legacy fallback
    const legacy = await resolveRedirectUrl(hubCloud);
    if (legacy) return { url: legacy, meta };
  }

  const hubDrive = $(el).find('a').filter((_i, a) => $(a).text().includes('HubDrive')).attr('href');
  if (hubDrive) {
    const resolvedDrive = await resolveHubCloudToDirect(hubDrive);
    if (resolvedDrive) return { url: resolvedDrive, meta, direct: true };
    const hubDriveHtml = await fetchText(hubDrive);
    if (hubDriveHtml) {
      const $2 = cheerio.load(hubDriveHtml);
      const inner = $2('a:contains("HubCloud")').attr('href');
      if (inner) {
        const d = await resolveHubCloudToDirect(inner);
        if (d) return { url: d, meta, direct: true };
      }
    }
  }
  return null;
}

async function extractHubCloud(hubCloudUrl, baseMeta) {
  if (!hubCloudUrl) return [];
  const redirectHtml = await fetchText(hubCloudUrl, { headers: { Referer: hubCloudUrl } });
  if (!redirectHtml) return [];
  const m = redirectHtml.match(/var url ?= ?'(.*?)'/);
  if (!m) return [];
  const linksHtml = await fetchText(m[1], { headers: { Referer: hubCloudUrl } });
  if (!linksHtml) return [];
  const $ = cheerio.load(linksHtml);
  const results = [];
  const sizeText = $('#size').text();
  const titleText = $('title').text().trim();
  const currentMeta = {
    ...baseMeta,
    bytes: bytes.parse(sizeText) || baseMeta.bytes,
    title: titleText || baseMeta.title,
  };
  $('a').each((_i, el) => {
    const text = $(el).text();
    const href = $(el).attr('href');
    if (!href) return;
    if (text.includes('FSL') || text.includes('Download File')) {
      results.push({ source: 'FSL', url: href, meta: currentMeta });
    } else if (text.includes('PixelServer')) {
      results.push({ source: 'PixelServer', url: href.replace('/u/', '/api/file/'), meta: currentMeta });
    }
  });
  return results;
}

async function get4KHDHubStreams(tmdbId, type = 'movie', season = null, episode = null) {
  const mediaType = type === 'series' ? 'tv' : type;
  const info = await resolveTmdb(tmdbId, mediaType);
  if (!info || !info.title) return [];
  const { title, year } = info;
  const isSeries = mediaType === 'tv';

  const cacheKey = `streams_${mediaType}_${tmdbId}${season ? `_s${season}e${episode}` : ''}`;
  const cached = await getCache('4khdhub', cacheKey, 1800000);
  if (cached) return cached;

  await getWorkingBaseUrl();
  log(`[4KHDHub] using base ${BASE_URL}`);
  const pageUrl = await fetchPageUrl(title, parseInt(year, 10) || 0, isSeries);
  if (!pageUrl) { log(`[4KHDHub] page not found`); return []; }
  const html = await fetchText(pageUrl);
  if (!html) return [];
  const $ = cheerio.load(html);

  const items = [];
  if (isSeries && season && episode) {
    const seasonStr = `S${String(season).padStart(2, '0')}`;
    const epStr = `Episode-${String(episode).padStart(2, '0')}`;
    $('.episode-item').each((_i, el) => {
      if ($('.episode-title', el).text().includes(seasonStr)) {
        $('.episode-download-item', el).filter((_j, item) => $(item).text().includes(epStr)).each((_k, item) => items.push(item));
      }
    });
  } else {
    $('.download-item').each((_i, el) => items.push(el));
  }

  const streams = [];
  for (const item of items) {
    try {
      const src = await extractSourceResults($, item);
      if (src && src.url) {
        let links;
        if (src.direct) {
          // src.url is already a direct playable file
          links = [{ source: 'Direct', url: src.url, meta: src.meta }];
        } else {
          links = await extractHubCloud(src.url, src.meta);
        }
        for (const link of links) {
          const h = src.meta.height ? `${src.meta.height}p` : undefined;
          streams.push({
            name: `4KHDHub - ${link.source}${h ? ' ' + h : ''}`,
            title: `${link.meta.title}\n${bytes.format(link.meta.bytes || 0)}`,
            url: link.url,
            quality: h,
            behaviorHints: { bingeGroup: `4khdhub-${link.source}` },
          });
        }
      }
    } catch (err) {
      log(`[4KHDHub] item error: ${err.message}`);
    }
  }

  await setCache('4khdhub', cacheKey, streams);
  return streams;
}

module.exports = { get4KHDHubStreams };
