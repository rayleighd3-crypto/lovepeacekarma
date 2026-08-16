/**
 * LovePeaceKarma provider smoke test.
 * Usage: node test/run.js [provider]   (omit to test all)
 * Pass MOVIEBOX_PRIMARY_KEY in env to test MovieBox.
 */
require('dotenv').config();

const PROVIDERS = [
  { key: '4khdhub', fn: (m) => m.get4KHDHubStreams(27205, 'movie') },
  { key: 'hdhub4u', fn: (m) => m.getHDHub4uStreams(27205, 'movie') },
  { key: '111477', fn: (m) => m.getStreamsFromTmdbId('movie', 27205) },
];

async function main() {
  const only = process.argv[2];
  const list = only ? PROVIDERS.filter(p => p.key === only) : PROVIDERS;

  console.log('=== LovePeaceKarma provider smoke test (Inception TMDB 27205) ===\n');

  for (const p of list) {
    const started = Date.now();
    try {
      const mod = require(`../providers/${p.key}.js`);
      const streams = await Promise.race([
        p.fn(mod),
        new Promise(res => setTimeout(() => res('TIMEOUT'), 45000)),
      ]);
      const ms = Date.now() - started;
      if (streams === 'TIMEOUT') {
        console.log(`[${p.key}] TIMEOUT after ${ms}ms`);
      } else if (Array.isArray(streams) && streams.length > 0) {
        console.log(`[${p.key}] ✓ ${streams.length} stream(s) in ${ms}ms`);
        for (const s of streams.slice(0, 3)) {
          console.log(`    - ${s.name} | ${s.title} | ${s.url}`);
        }
      } else {
        console.log(`[${p.key}] ✗ no streams (${ms}ms) ${mod.EXTRA_NOTE ? mod.EXTRA_NOTE : ''}`);
      }
    } catch (e) {
      console.log(`[${p.key}] ERROR: ${e.message}`);
    }
    console.log('');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
