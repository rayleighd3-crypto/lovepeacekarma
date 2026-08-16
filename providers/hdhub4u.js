/**
 * HDHub4u provider for LovePeaceKarma.
 * Base URL: dynamic (rotates) - fetched from the shared TVVVV domains.json, default https://hdhub4u.frl.
 * Decodes obfuscated redirect links and extracts from HubCloud/HubDrive/HubCdn/HbLinks/StreamTape/Pixeldrain.
 */
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { findBestMatch } = require('string-similarity');
const { resolveTmdb } = require('../utils/tmdb');
const { getCache, setCache } = require('../utils/cache');

const DEBUG = process.env.DEBUG === 'true';
const log = DEBUG ? console.log : () => {};
const logWarn = DEBUG ? console.warn : () => {};

const agent = new https.Agent({ rejectUnauthorized: false });

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
let MAIN_URL = 'https://hdhub4u.frl';

const PROXY_URL = process.env.HDHUB4U_PROXY_URL;

async function fetchAndUpdateDomain() {
  try {
    const response = await axios.get(DOMAINS_URL, { httpsAgent: agent, timeout: 10000 });
    if (response.data && response.data.HDHUB4u && response.data.HDHUB4u !== MAIN_URL) {
      MAIN_URL = response.data.HDHUB4u;
      log(`[HDHub4u] domain -> ${MAIN_URL}`);
    }
  } catch (e) {
    log(`[HDHub4u] domain fetch failed, using ${MAIN_URL}`);
  }
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Cookie': 'xla=s4t',
  'Referer': '/',
};

const makeRequest = async (url, options = {}) => {
  const opts = { ...options, httpsAgent: agent };
  if (PROXY_URL) {
    return axios.get(`${PROXY_URL}?url=${encodeURIComponent(url)}`, opts);
  }
  return axios.get(url, opts);
};

const rot13 = (value) => value.replace(/[a-zA-Z]/g, (c) =>
  String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26));
const btoa = (value) => Buffer.from(value).toString('base64');
const atob = (value) => Buffer.from(value, 'base64').toString('utf-8');

function cleanTitle(title) {
  if (!title) return '';
  const parts = title.split(/[.\-_]/);
  const qTags = ['WEBRip', 'WEB-DL', 'WEB', 'BluRay', 'HDRip', 'DVDRip', 'HDTV', 'CAM', 'TS', 'R5', 'DVDScr', 'BRRip', 'BDRip', 'DVD', 'PDTV', 'HD'];
  const tags = ['AAC', 'AC3', 'DTS', 'MP3', 'FLAC', 'DD5', 'EAC3', 'Atmos', 'ESub', 'ESubs', 'Subs', 'MultiSub', 'NoSub', 'EnglishSub', 'HindiSub', 'x264', 'x265', 'H264', 'HEVC', 'AVC'];
  const start = parts.findIndex(p => qTags.some(t => p.toLowerCase().includes(t.toLowerCase())));
  const end = parts.findLastIndex(p => tags.some(t => p.toLowerCase().includes(t.toLowerCase())));
  if (start !== -1 && end !== -1 && end >= start) return parts.slice(start, end + 1).join('.');
  if (start !== -1) return parts.slice(start).join('.');
  return parts.slice(-3).join('.');
}

async function getRedirectLinks(url) {
  try {
    HEADERS.Referer = `${MAIN_URL}/`;
    const response = await makeRequest(url, { headers: HEADERS });
    const doc = response.data;

    if (typeof doc === 'string' && doc.trim() === 'Invalid Link !!') {
      log('[HDHub4u] invalid link returned');
      return null;
    }

    const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
    let combined = '';
    let m;
    while ((m = regex.exec(doc)) !== null) combined += m[1] || m[2];

    if (!combined) {
      log('[HDHub4u] no encoded strings in redirect page');
      return null;
    }

    const decoded = atob(rot13(atob(atob(combined))));
    const json = JSON.parse(decoded);
    const encodedUrl = atob(json.o || '').trim();
    if (encodedUrl) return encodedUrl;

    const data = btoa(json.data || '').trim();
    const wpHttp = (json.blog_url || '').trim();
    if (wpHttp && data) {
      const dl = await makeRequest(`${wpHttp}?re=${data}`, { headers: HEADERS });
      const $ = cheerio.load(dl.data);
      return $('body').text().trim();
    }
    return url;
  } catch (e) {
    log(`[HDHub4u] redirect error: ${e.message}`);
    return url;
  }
}

async function pixelDrainExtractor(link) {
  try {
    const m = link.match(/(?:file|u)\/([A-Za-z0-9]+)/);
    const fileId = m ? m[1] : link.split('/').pop();
    if (!fileId) return [{ source: 'Pixeldrain', quality: 'Unknown', url: link }];
    let fileInfo = { name: '', quality: 'Unknown', size: 0 };
    try {
      const { data: info } = await makeRequest(`https://pixeldrain.com/api/file/${fileId}/info`, { httpsAgent: agent });
      if (info && info.name) {
        fileInfo.name = info.name;
        fileInfo.size = info.size || 0;
        const q = info.name.match(/(\d{3,4})p/);
        if (q) fileInfo.quality = q[0];
      }
    } catch (e) { /* ignore */ }
    return [{ source: 'Pixeldrain', quality: fileInfo.quality, url: `https://pixeldrain.com/api/file/${fileId}?download`, name: fileInfo.name, size: fileInfo.size }];
  } catch (e) {
    return [{ source: 'Pixeldrain', quality: 'Unknown', url: link }];
  }
}

async function streamTapeExtractor(link) {
  const url = new URL(link);
  url.hostname = 'streamtape.com';
  const normalizedLink = url.toString();
  try {
    const res = await makeRequest(normalizedLink, { headers: HEADERS });
    const m = res.data.match(/document\.getElementById\('videolink'\)\.innerHTML = (.*?);/);
    const body = m && m[1] ? m[1] : res.data;
    const part = body.match(/('\/\/streamtape\.com\/get_video[^']+')/);
    if (part) return [{ source: 'StreamTape', quality: 'Stream', url: 'https:' + part[1].slice(1, -1) }];
    return [];
  } catch (e) {
    if (!e.response || e.response.status !== 404) log(`[HDHub4u] StreamTape error: ${e.message}`);
    return [];
  }
}

async function hubCdnExtractor(url, referer) {
  const response = await makeRequest(url, { headers: { ...HEADERS, Referer: referer } });
  const m = response.data.match(/r=([A-Za-z0-9+/=]+)/);
  if (m && m[1]) {
    const data = atob(m[1]);
    const link = data.substring(data.lastIndexOf('link=') + 5);
    return [{ source: 'HubCdn', quality: 'M3U8', url: link }];
  }
  return [];
}

async function hubDriveExtractor(url, referer) {
  const response = await makeRequest(url, { headers: { ...HEADERS, Referer: referer } });
  const $ = cheerio.load(response.data);
  const href = $('.btn.btn-primary.btn-user.btn-success1.m-1').attr('href');
  if (href) return loadExtractor(href, url);
  return [];
}

async function hubCloudExtractor(url, referer) {
  let currentUrl = url.includes('hubcloud.ink') ? url.replace('hubcloud.ink', 'hubcloud.dad') : url;
  let pageResponse = await makeRequest(currentUrl, { headers: { ...HEADERS, Referer: referer } });
  let finalUrl = currentUrl;
  if (!currentUrl.includes('hubcloud.php')) {
    const sm = pageResponse.data.match(/var url = '([^']*)'/);
    if (sm && sm[1]) {
      finalUrl = sm[1];
      pageResponse = await makeRequest(finalUrl, { headers: { ...HEADERS, Referer: currentUrl } });
    }
  }
  const $ = cheerio.load(pageResponse.data);
  const size = $('i#size').text().trim();
  const header = $('div.card-header').text().trim();
  const quality = (() => { const m = (header || '').match(/(\d{3,4})[pP]/); return m ? parseInt(m[1]) : 2160; })();
  const headerDetails = cleanTitle(header);
  const labelExtras = `${headerDetails ? `[${headerDetails}]` : ''}${size ? `[${size}]` : ''}`;
  const links = [];

  for (const element of $('div.card-body h2 a.btn').get()) {
    const link = $(element).attr('href');
    const text = $(element).text();
    if (!link) continue;
    if (text.includes('Download File')) links.push({ source: `HubCloud ${labelExtras}`, quality, url: link });
    else if (text.includes('FSL Server')) links.push({ source: `HubCloud - FSL Server ${labelExtras}`, quality, url: link });
    else if (text.includes('S3 Server')) links.push({ source: `HubCloud - S3 Server ${labelExtras}`, quality, url: link });
    else if (text.includes('BuzzServer')) {
      try {
        const bz = await makeRequest(`${link}/download`, { headers: { ...HEADERS, Referer: link }, maxRedirects: 0, validateStatus: s => s >= 200 && s < 400 });
        const dlink = bz.headers['hx-redirect'];
        if (dlink) links.push({ source: `HubCloud - BuzzServer ${labelExtras}`, quality, url: new URL(link).origin + dlink });
      } catch (e) {
        if (e.response && e.response.headers['hx-redirect']) {
          links.push({ source: `HubCloud - BuzzServer ${labelExtras}`, quality, url: new URL(link).origin + e.response.headers['hx-redirect'] });
        }
      }
    } else if (link.includes('pixeldra')) links.push({ source: `Pixeldrain ${labelExtras}`, quality, url: link });
    else if (text.includes('10Gbps')) {
      let cur = link;
      for (let i = 0; i < 5; i++) {
        try {
          const r = await makeRequest(cur, { maxRedirects: 0, validateStatus: () => true });
          const loc = r.headers.location;
          if (loc) {
            if (loc.includes('link=')) { links.push({ source: `HubCloud - 10Gbps ${labelExtras}`, quality, url: loc.substring(loc.indexOf('link=') + 5) }); break; }
            cur = new URL(loc, cur).toString();
          } else break;
        } catch (e2) {
          if (e2.response && e2.response.headers.location) {
            const loc = e2.response.headers.location;
            if (loc.includes('link=')) { links.push({ source: `HubCloud - 10Gbps ${labelExtras}`, quality, url: loc.substring(loc.indexOf('link=') + 5) }); break; }
            cur = new URL(loc, cur).toString();
          } else break;
        }
      }
    } else {
      const extracted = await loadExtractor(link, finalUrl);
      links.push(...extracted);
    }
  }
  return links;
}

async function hubStreamExtractor(url, referer) {
  try {
    await makeRequest(url, { headers: { ...HEADERS, Referer: referer } });
    return [{ source: 'Hubstream', quality: 'Unknown', url }];
  } catch (e) {
    return [];
  }
}

async function hbLinksExtractor(url, referer) {
  const response = await makeRequest(url, { headers: { ...HEADERS, Referer: referer } });
  const $ = cheerio.load(response.data);
  const links = $('h3 a, div.entry-content p a').map((i, el) => $(el).attr('href')).get();
  const out = [];
  for (const link of links) out.push(...(await loadExtractor(link, url)));
  return out;
}

async function loadExtractor(url, referer = MAIN_URL) {
  const hostname = new URL(url).hostname;
  if (url.includes('?id=') || hostname.includes('techyboy4u')) {
    const finalLink = await getRedirectLinks(url);
    if (!finalLink) return [];
    return loadExtractor(finalLink, url);
  }
  if (hostname.includes('hubcloud')) return hubCloudExtractor(url, referer);
  if (hostname.includes('hubdrive')) return hubDriveExtractor(url, referer);
  if (hostname.includes('hubcdn')) return hubCdnExtractor(url, referer);
  if (hostname.includes('hblinks')) return hbLinksExtractor(url, referer);
  if (hostname.includes('hubstream')) return hubStreamExtractor(url, referer);
  if (hostname.includes('pixeldrain')) return pixelDrainExtractor(url);
  if (hostname.includes('streamtape')) return streamTapeExtractor(url);
  if (hostname.includes('hdstream4u')) return [{ source: 'HdStream4u', quality: 'Unknown', url }];
  if (hostname.includes('linkrit')) return [];
  return [{ source: hostname.replace(/^www\./, ''), quality: 'Unknown', url }];
}

async function search(query) {
  await fetchAndUpdateDomain();
  HEADERS.Referer = `${MAIN_URL}/`;
  const response = await makeRequest(`${MAIN_URL}/?s=${encodeURIComponent(query)}`, { headers: HEADERS });
  const $ = cheerio.load(response.data);
  let results = [];

  $('figcaption').each((_i, el) => {
    const linkEl = $(el).find('a').first();
    const url = linkEl.attr('href');
    const title = linkEl.find('p').text().trim() || linkEl.text().trim();
    if (title && url && url.length > 10) results.push({ title, url });
  });

  if (results.length === 0) {
    $('.thumbnail-wrapper, .thumb-wrapper, li.thumb').each((_i, el) => {
      const linkEl = $(el).find('figcaption a, a').first();
      const url = linkEl.attr('href');
      const title = linkEl.find('p').text().trim() || linkEl.text().trim();
      if (title && url && url.length > 10) results.push({ title, url: url.startsWith('http') ? url : `${MAIN_URL}${url.startsWith('/') ? '' : '/'}${url}` });
    });
  }

  if (results.length === 0) {
    $('article, .post, .result-item, .search-result').each((_i, el) => {
      const titleEl = $(el).find('h3 a, h2 a, .entry-title a, a.title').first();
      const title = titleEl.text().trim();
      const url = titleEl.attr('href') || $(el).find('a').first().attr('href');
      if (title && url) results.push({ title, url: url.startsWith('http') ? url : `${MAIN_URL}${url.startsWith('/') ? '' : '/'}${url}` });
    });
  }

  const seen = new Set();
  results = results.filter(r => { if (!r.url || seen.has(r.url)) return false; seen.add(r.url); return true; });
  return results;
}

async function getDownloadLinks(mediaUrl) {
  await fetchAndUpdateDomain();
  HEADERS.Referer = `${MAIN_URL}/`;
  const response = await makeRequest(mediaUrl, { headers: HEADERS });
  const $ = cheerio.load(response.data);
  const typeRaw = $('h1.page-title span').text();
  const isMovie = typeRaw.toLowerCase().includes('movie');

  const title = $('.page-body h2').text();
  const seasonMatch = title.match(/\bSeason\s*(\d+)\b/i);

  let initialLinks = [];
  if (isMovie) {
    const qLinks = $('h3 a, h4 a').filter((_i, el) => {
      const t = $(el).text();
      return /480|720|1080|2160|4K/i.test(t);
    });
    const seen = new Set();
    initialLinks = qLinks.map((_i, el) => ({ url: $(el).attr('href') })).get().filter(l => {
      if (!l.url || seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });
  } else {
    const episodeLinksMap = new Map();
    $('h3 a, h4 a').each((_i, el) => {
      const $el = $(el);
      const text = $el.text();
      const href = $el.attr('href');
      if (/1080|720|4K|2160/i.test(text) && href) {
        initialLinks.push({ url: href, isQualityRedirect: href.includes('techyboy4u.com'), priority: 1 });
      }
    });
    $('h4').each((_i, el) => {
      const $el = $(el);
      const text = $el.text();
      const em = text.match(/(?:EPiSODE\s*(\d+)|E(\d+))/i);
      if (em) {
        const ep = parseInt(em[1] || em[2]);
        if (!episodeLinksMap.has(ep)) episodeLinksMap.set(ep, []);
        $el.find('a').each((_j, a) => episodeLinksMap.get(ep).push($(a).attr('href')));
      }
    });
    episodeLinksMap.forEach((links, ep) => {
      [...new Set(links)].forEach(link => initialLinks.push({ url: link, episode: ep }));
    });
  }

  const finalLinks = [];
  for (const linkInfo of initialLinks) {
    try {
      if (linkInfo.isQualityRedirect) {
        const resolved = await getRedirectLinks(linkInfo.url);
        const doc = await makeRequest(resolved, { headers: HEADERS });
        const $$ = cheerio.load(doc.data);
        $$('h5 a').each((_i, a) => {
          const lt = $$(a).text();
          const ee = lt.match(/Episode\s*(\d+)/i);
          const href = $$(a).attr('href');
          if (ee && href) finalLinks.push({ url: href, episode: parseInt(ee[1]) });
        });
      } else {
        const extracted = await loadExtractor(linkInfo.url, mediaUrl);
        extracted.forEach(f => finalLinks.push({ ...f, episode: linkInfo.episode }));
      }
    } catch (e) {
      log(`[HDHub4u] extract error ${linkInfo.url}: ${e.message}`);
    }
  }

  const seen = new Set();
  const uniq = finalLinks.filter(l => {
    if (l.url && (l.url.includes('.zip') || (l.name && l.name.toLowerCase().includes('.zip')))) return false;
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });
  return { finalLinks: uniq, isMovie };
}

const parseQualityForSort = (q) => {
  if (!q) return 0;
  if (typeof q === 'number') return q;
  const m = String(q).match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : 0;
};

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return 'Unknown';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

async function getHDHub4uStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
  try {
    const info = await resolveTmdb(tmdbId, mediaType);
    if (!info || !info.title) return [];
    const title = info.title;
    const year = info.year || null;

    const cacheKey = `streams_${mediaType}_${tmdbId}${seasonNum ? `_s${seasonNum}e${episodeNum}` : ''}`;
    const cached = await getCache('hdhub4u', cacheKey, 1800000);
    if (cached) return cached;

    await fetchAndUpdateDomain();
    let searchQuery = title;
    let results = await search(searchQuery);
    if (results.length === 0 && year) {
      searchQuery = `${title} ${year}`;
      results = await search(searchQuery);
    }
    if (results.length === 0) return [];

    let bestMatch = null;
    if (mediaType === 'tv' && seasonNum) {
      const pat = new RegExp(`season\\s*${seasonNum}|s${seasonNum}\\b|\\(season\\s*${seasonNum}\\)`, 'i');
      const seasonMatches = results.filter(r => pat.test(r.title));
      bestMatch = seasonMatches.length > 0 ? seasonMatches[0] : results[0];
    } else if (results.length === 1) {
      bestMatch = results[0];
    } else {
      const m = findBestMatch(searchQuery.toLowerCase(), results.map(r => r.title.toLowerCase()));
      bestMatch = m.bestMatch.rating > 0.3 ? results[m.bestMatchIndex] : results[0];
    }

    const { finalLinks, isMovie } = await getDownloadLinks(bestMatch.url);
    if (!finalLinks.length) return [];

    let filtered = finalLinks;
    if (!isMovie && episodeNum) filtered = finalLinks.filter(l => l.episode === episodeNum);

    const streams = filtered
      .map(link => {
        const q = parseQualityForSort(link.quality);
        return q > 0 ? { quality: q, link } : null;
      })
      .filter(Boolean)
      .map(({ quality, link }) => {
        const sourceAbbrev = link.source.includes('Pixeldrain') ? 'PD'
          : link.source.includes('HubCloud') ? 'HC'
          : link.source.substring(0, 2).toUpperCase();
        let t = `${quality}p`;
        if (link.episode) t += ` - Episode ${link.episode}`;
        return {
          name: `HDHub4u-${quality}p | ${sourceAbbrev}`,
          title: t,
          url: link.url,
          quality: String(quality),
          provider: 'HDHub4u',
          source: link.source,
          size: link.size ? formatBytes(link.size) : '',
        };
      });

    await setCache('hdhub4u', cacheKey, streams);
    return streams;
  } catch (e) {
    console.error(`[HDHub4u] error: ${e.message}`);
    return [];
  }
}

module.exports = { getHDHub4uStreams };
