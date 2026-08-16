/**
 * Lightweight cache for LovePeaceKarma providers.
 * In-memory Map + optional file-system persistence (writes only on Vercel to /tmp,
 * which is ephemeral per-instance but fine for cache warming within a request lifecycle).
 * No external services (no Redis/Upstash) required.
 */
const fs = require('fs').promises;
const path = require('path');

const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';

const memCache = new Map();

function getCacheDir() {
  // Vercel: only /tmp is writable. Local: project .cache dir.
  return process.env.VERCEL
    ? path.join('/tmp', '.lovepeacekarma_cache')
    : path.join(__dirname, '..', '.cache');
}

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    /* ignore */
  }
}

/**
 * Get a cached value.
 * @param {string} provider provider name (used for subdir)
 * @param {string} key cache key
 * @param {number} ttlMs TTL in milliseconds
 */
async function getCache(provider, key, ttlMs = 0) {
  if (!CACHE_ENABLED) return null;

  const mkey = `${provider}:${key}`;
  const mem = memCache.get(mkey);
  if (mem) {
    if (ttlMs && Date.now() - mem.t > ttlMs) {
      memCache.delete(mkey);
    } else {
      return mem.v;
    }
  }

  // File fallback
  try {
    const file = path.join(getCacheDir(), provider, `${key}.json`);
    const raw = await fs.readFile(file, 'utf-8');
    const data = JSON.parse(raw);
    if (ttlMs && Date.now() - data.t > ttlMs) {
      return null;
    }
    memCache.set(mkey, data);
    return data.v;
  } catch (e) {
    return null;
  }
}

async function setCache(provider, key, value) {
  if (!CACHE_ENABLED) return;
  const entry = { t: Date.now(), v: value };
  memCache.set(`${provider}:${key}`, entry);

  // Fire-and-forget file write
  try {
    const sub = path.join(getCacheDir(), provider);
    await ensureDir(sub);
    await fs.writeFile(path.join(sub, `${key}.json`), JSON.stringify(entry), 'utf-8');
  } catch (e) {
    /* ignore */
  }
}

module.exports = { getCache, setCache, CACHE_ENABLED };
