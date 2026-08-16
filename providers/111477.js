/**
 * 111477 provider for LovePeaceKarma.
 * Data source: https://a.111477.xyz/ — a direct file host with browsable directory listings.
 *   - Movies: /movies/<Title> (<Year>)/  -> direct .mkv/.mp4 files
 *   - TV:     /tvs/<Series>/Season <N>/  -> SxxEyy episode files
 * Streams are emitted as the direct file URL (the site's own "copy URL"), which 307-redirects
 * to the Cloudflare-protected download proxy (p.111477.xyz/bulk) at playback time.
 */
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { resolveTmdb } = require('../utils/tmdb');

const BASE_URL = process.env.PROVIDER_111477_BASE_URL || 'https://a.111477.xyz';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

async function fetchListing(path) {
  const url = `${BASE_URL}${path}`;
  const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': UA } });
  if (res.status < 200 || res.status >= 300) return null;
  const $ = cheerio.load(res.data);
  const items = [];
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (href.startsWith('/cdn-cgi/') || href.startsWith('http')) return;
    if (href.includes('discord')) return;
    if (href === '/' || href === path) return;
    items.push(href); // keep raw (server already percent-encodes) to avoid double-encoding
  });
  return items;
}

// ---- quality / codec / language detection from a file name -----------------
function parseQuality(name) {
  const l = name.toLowerCase();
  if (/2160p|\b4k\b|uhd/.test(l)) return '2160p';
  if (/1080p|bluray|1080/.test(l)) return '1080p';
  if (/720p/.test(l)) return '720p';
  if (/480p/.test(l)) return '480p';
  if (/360p/.test(l)) return '360p';
  return 'Unknown';
}

function detectLanguage(name) {
  const l = name.toLowerCase();
  const map = [
    ['hindi','Hindi'],['english','English'],['tamil','Tamil'],['telugu','Telugu'],
    ['malayalam','Malayalam'],['kannada','Kannada'],['bengali','Bengali'],['punjabi','Punjabi'],
    ['gujarati','Gujarati'],['marathi','Marathi'],['spanish','Spanish'],['french','French'],
    ['german','German'],['japanese','Japanese'],['korean','Korean'],['chinese','Chinese'],
    ['arabic','Arabic'],['russian','Russian'],['portuguese','Portuguese'],['italian','Italian'],
    ['turkish','Turkish'],['thai','Thai'],['multi','Multi'],['dual','Dual'],
  ];
  for (const [pat, name2] of map) if (l.includes(pat)) return name2;
  return null;
}

function detectCodecs(name) {
  const l = name.toLowerCase();
  const out = [];
  if (l.includes('dolby vision') || l.includes('dv') && /\.dv\.|\bdv\b/.test(l)) out.push('DV');
  if (l.includes('hdr10+')) out.push('HDR10+');
  else if (l.includes('hdr')) out.push('HDR');
  if (l.includes('av1')) out.push('AV1');
  else if (l.includes('x265') || l.includes('hevc')) out.push('H.265');
  else if (l.includes('x264') || l.includes('h264')) out.push('H.264');
  if (l.includes('atmos')) out.push('Atmos');
  if (l.includes('dts-hd ma') || l.includes('dtshdma')) out.push('DTS-HD MA');
  else if (l.includes('dts')) out.push('DTS');
  if (l.includes('eac3') || l.includes('dd+')) out.push('EAC3');
  else if (l.includes('ac3')) out.push('AC3');
  if (l.includes('10bit') || l.includes('10-bit')) out.push('10-bit');
  return out;
}

function fileToStream(title, path, quality) {
  const baseName = decodeURIComponent(path.split('/').pop());
  const lang = detectLanguage(baseName);
  const codecs = detectCodecs(baseName);
  const q = quality || parseQuality(baseName);
  const name = `111477 - ${q}${lang ? ` | ${lang}` : ''}${codecs.length ? ` | ${codecs.join(' ')}` : ''}`;
  return {
    name,
    title: `${title} - ${baseName}`,
    url: `${BASE_URL}${path}`,
    quality: q,
    codecs,
    type: 'direct',
    headers: {
      'User-Agent': UA,
      'Referer': `${BASE_URL}/`,
    },
  };
}

function isVideoFile(href) {
  return /\.(mkv|mp4|avi|mov|webm|wmv|flv)$/i.test(href);
}

// ---- main endpoint ---------------------------------------------------------
async function getStreamsFromTmdbId(tmdbType, tmdbId, seasonNum = null, episodeNum = null) {
  try {
    const mediaType = tmdbType === 'tv' || tmdbType === 'series' ? 'tv' : 'movie';
    const info = await resolveTmdb(tmdbId, mediaType);
    if (!info || !info.title) return [];
    const title = info.title;
    const year = info.year || '';
    const streams = [];

    if (mediaType === 'movie') {
      // /movies/Title (Year)/  -> direct files
      const moviePath = `/movies/${encodeURIComponent(`${title} (${year})`)}/`;
      const files = await fetchListing(moviePath);
      if (!files) return [];
      for (const f of files) {
        if (!isVideoFile(f)) continue;
        streams.push(fileToStream(title, f));
      }
    } else {
      // /tvs/Series/  -> Season folders -> episodes
      if (seasonNum == null || episodeNum == null) return [];
      const seriesPath = `/tvs/${encodeURIComponent(title)}/`;
      const seasonDirs = await fetchListing(seriesPath);
      if (!seasonDirs) return [];
      const seasonDir = seasonDirs.find(d => {
        const dec = decodeURIComponent(d);
        const m = dec.match(/\/Season\s*(\d+)\/?$/i);
        return m && parseInt(m[1], 10) === parseInt(seasonNum, 10);
      });
      if (!seasonDir) return [];
      const seasonPath = seasonDir.endsWith('/') ? seasonDir : seasonDir + '/';
      const epFiles = await fetchListing(seasonPath);
      if (!epFiles) return [];
      const epPad = String(episodeNum).padStart(2, '0');
      const sePad = String(seasonNum).padStart(2, '0');
      const want_rx = new RegExp(`\\(?[sS]${sePad}[eE]${epPad}\\)?|(^|\\D)${epPad}($|\\D)`);
      for (const f of epFiles) {
        if (!isVideoFile(f)) continue;
        const baseName = f.split('/').pop();
        // prefer explicit SxxEyy match
        if (/S\d{2}E\d{2}|s\d{2}e\d{2}/i.test(baseName)) {
          if (!new RegExp(`[sS]${sePad}[eE]${epPad}`, 'i').test(baseName)) continue;
        }
        streams.push(fileToStream(`${title} S${sePad}E${epPad}`, f, parseQuality(baseName)));
      }
    }

    // de-dupe by URL
    const seen = new Set();
    const unique = streams.filter(s => { if (seen.has(s.url)) return false; seen.add(s.url); return true; });

    // sort by quality desc
    const qOrder = { '2160p': 0, '1080p': 1, '720p': 2, '480p': 3, '360p': 4, 'Unknown': 5 };
    unique.sort((a, b) => (qOrder[a.quality] ?? 9) - (qOrder[b.quality] ?? 9));
    console.log(`[111477] ${mediaType} "${title}" -> ${unique.length} stream(s)`);
    return unique;
  } catch (e) {
    console.error(`[111477] error: ${e.message}`);
    return [];
  }
}

module.exports = { getStreamsFromTmdbId, BASE_URL };