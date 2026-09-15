/**
 * ShowBox provider for LovePeaceKarma.
 * Uses the yoruix/nuvio-providers ShowBox flow, fully self-contained (verified live 2026-09-15):
 *   1. TMDB id -> ShowBox mid via https://id-mapping-api-showbox-proxy.hf.space
 *      GET /api/media/movie/{tmdbId}?cookie=...   or   /api/media/tv/{id}/{s}/{e}?cookie=...
 *   2. febbox.com /mbp/to_share_page?box_type={1|2}&mid={mid}&json=1 -> share_link -> share_key
 *   3. /file/file_share_list?share_key=... (&parent_id= for TV season folders) -> files
 *   4. /console/video_quality_list?fid={fid}&share_key=... (REQUIRES valid FebBox ui= cookie)
 *      -> HTML with data-url/data-quality entries (ORG mp4 + HLS m3u8 variants)
 * The user MUST supply their own FebBox JWT via SHOWBOX_UI_COOKIE env
 * (login to febbox.com, copy the `ui=` cookie value).
 */
require('dotenv').config();
const { resolveTmdb } = require('../utils/tmdb');
const { getCache, setCache } = require('../utils/cache');

const MAPPING_API = 'https://id-mapping-api-showbox-proxy.hf.space/api/media';
const FEB = 'https://www.febbox.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEBUG = process.env.DEBUG === 'true';
const log = DEBUG ? console.log : () => {};
const logWarn = DEBUG ? console.warn : () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getUiCookie() {
  const raw = process.env.SHOWBOX_UI_COOKIE || '';
  if (!raw) return null;
  // Accept "eyJ..." (jwt itself) or "ui=eyJ..." or "ui%3D..." forms
  let t = String(raw).trim();
  if (t.toLowerCase().startsWith('ui=')) t = t.slice(3);
  try { t = decodeURIComponent(t); } catch (e) {}
  if (t.toLowerCase().startsWith('ui=')) t = t.slice(3);
  return t;
}

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en', ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function mapperLookup(mediaType, tmdbId, cookie, season, episode) {
  let u;
  if (mediaType === 'tv' && season && episode) {
    u = `${MAPPING_API}/tv/${tmdbId}/${season}/${episode}?cookie=${encodeURIComponent('ui=' + cookie)}`;
  } else {
    u = `${MAPPING_API}/movie/${tmdbId}?cookie=${encodeURIComponent('ui=' + cookie)}`;
  }
  const d = await getJSON(u);
  const mid = d && (d.id || d.mid);
  if (!mid) throw new Error('mapper returned no mid');
  return Number(mid);
}

function extractQualityUrls(html) {
  const out = [];
  const re = /data-url="([^"]+)"[^>]*data-quality="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ url: m[1], quality: m[2] });
  }
  return out;
}

function qualityLabel(q) {
  switch (String(q).toLowerCase()) {
    case 'org': return 'ORG (original bitrate)';
    default: return q;
  }
}

async function getShowBoxStreams(tmdbId, type = 'movie', season = null, episode = null) {
  const mediaType = type === 'series' || type === 'tv' ? 'tv' : 'movie';
  const cookie = getUiCookie();
  if (!cookie) {
    // Gracefully emit nothing when no user cookie is set
    log('[showbox] no SHOWBOX_UI_COOKIE configured - skipping');
    return [];
  }
  const cacheKey = `streams_${mediaType}_${tmdbId}${season ? `_s${season}e${episode}` : ''}`;
  const cached = await getCache('showbox', cacheKey, 1800000);
  if (cached) return cached;

  try {
    const info = await resolveTmdb(tmdbId, mediaType);
    if (!info || !info.title) return [];
    const title = info.title;
    const year = info.year ? String(info.year).slice(0, 4) : '';

    // 1. mapper
    const mid = await mapperLookup(mediaType, tmdbId, cookie, season, episode);
    log(`[showbox] tmdb ${tmdbId} -> mid ${mid}`);

    // 2. febbox share page -> share_key
    const boxType = mediaType === 'tv' ? 2 : 1;
    const share = await getJSON(`${FEB}/mbp/to_share_page?box_type=${boxType}&mid=${mid}&json=1`, { Referer: `${FEB}/`, Cookie: `ui=${cookie}` });
    const shareLink = (share.data && (share.data.share_link || share.data.shareLink)) || '';
    if (!shareLink) throw new Error('no share_link returned');
    const shareKey = String(shareLink).split('/').pop();
    log(`[showbox] shareKey = ${shareKey}`);

    // 3. file list (TV: pick season folder first, then SxxEyy files)
    let fids = [];
    if (mediaType === 'movie') {
      const lst = await getJSON(`${FEB}/file/file_share_list?share_key=${shareKey}`, { Cookie: `ui=${cookie}` });
      fids = (lst.data && lst.data.file_list) ? lst.data.file_list.filter((f) => !f.is_dir) : [];
    } else {
      const lst = await getJSON(`${FEB}/file/file_share_list?share_key=${shareKey}`, { Cookie: `ui=${cookie}` });
      const fl = (lst.data && lst.data.file_list) || [];
      const seasonFolder = fl.find((f) => (f.file_name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === `season${String(season).padStart(2, '0')}`)
        || fl.find((f) => (f.file_name || '').toLowerCase() === `season ${season}`)
        || fl.find((f) => new RegExp(`^season\\s*${season}$`, 'i').test((f.file_name || '').trim()));
      if (!seasonFolder) { log(`[showbox] season folder not found for S${season}`); return []; }
      const epList = await getJSON(`${FEB}/file/file_share_list?share_key=${shareKey}&parent_id=${seasonFolder.fid}&page=1`, { Cookie: `ui=${cookie}` });
      const slug = String(episode).padStart(2, '0');
      fids = ((epList.data && epList.data.file_list) || []).filter((f) =>
        (f.file_name || '').toLowerCase().includes(`s${String(season).padStart(2, '0')}e${slug}`)
        || (f.file_name || '').toLowerCase().includes(`s${season}e${episode}`));
    }

    if (!fids.length) { log('[showbox] no matching files in share'); return []; }
    log(`[showbox] ${fids.length} candidate files`);

    // 4. fetch qualities per file
    const streams = [];
    const seen = new Set();
    for (const f of fids.slice(0, 3)) {
      try {
        const d = await getJSON(`${FEB}/console/video_quality_list?fid=${f.fid}&share_key=${shareKey}`, { Cookie: `ui=${cookie}` });
        const html = d && d.html;
        if (!html) continue;
        const entries = extractQualityUrls(html);
        for (const { url, quality: rawQ } of entries) {
          if (seen.has(url)) continue;
          seen.add(url);
          const isHls = /\.m3u8\?/i.test(url) || /hls\./i.test(url);
          const quality = /ORG/i.test(rawQ) ? undefined : (/4K|2160/i.test(rawQ) ? '2160p' : /1080/i.test(rawQ) ? '1080p' : /720/i.test(rawQ) ? '720p' : /360/i.test(rawQ) ? '360p' : undefined);
          streams.push({
            name: `ShowBox - ${qualityLabel(rawQ)}`,
            title: `${title}${year ? ` (${year})` : ''}\n${f.file_name || ''}${isHls ? ' | HLS' : ' | MP4'}`.trim(),
            url,
            quality,
            behaviorHints: { bingeGroup: `showbox-${mid}` },
          });
        }
      } catch (e) {
        logWarn(`[showbox] quality fetch failed for fid ${f.fid}: ${e.message}`);
      }
      await sleep(250);
    }

    log(`[showbox] tmdb ${tmdbId} -> ${streams.length} streams`);
    await setCache('showbox', cacheKey, streams);
    return streams;
  } catch (e) {
    logWarn(`[showbox] tmdb ${tmdbId} failed: ${e.message}`);
    return [];
  }
}

module.exports = { getShowBoxStreams };
