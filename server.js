require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getRouter } = require('stremio-addon-sdk');
const builder = require('./addon');

const app = express();
app.use(cors());
app.use(express.json());

// Extract user cookie/region from query or path params into request-scoped config
app.use((req, res, next) => {
  const pathParams = {};
  if (req.path && req.path !== '/manifest.json' && !req.path.endsWith('/manifest.json')) {
    const segments = req.path.split('/').filter(Boolean);
    if (segments.length && segments[segments.length - 1] === 'manifest.json') segments.pop();
    const streamIdx = segments.indexOf('stream');
    const params = streamIdx !== -1 ? segments.slice(0, streamIdx) : segments;
    for (const seg of params) {
      const parts = seg.split('=');
      if (parts.length === 2) pathParams[parts[0]] = parts[1];
    }
  }

  const config = {};
  const cookie = pathParams.cookie || req.query.cookie;
  const region = pathParams.region || req.query.region;
  if (cookie) {
    try { config.cookie = decodeURIComponent(cookie); } catch (e) { config.cookie = cookie; }
  }
  if (region) config.region = String(region).toUpperCase();

  global.currentRequestConfig = config;
  req.nuvioConfig = config;
  next();
});

// Static landing page (optional)
app.use(express.static(path.join(__dirname, 'views')));

// Configure route (Stremio config UI) - simple HTML page
app.get('*configure', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>LovePeaceKarma</title>
<style>body{font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;color:#222}h1{color:#8e24aa}
code{background:#f3f3f3;padding:2px 6px;border-radius:4px}</style></head><body>
<h1>LovePeaceKarma</h1>
<p>Direct HTTP streams from <b>4KHDHub, HDHub4u, 111477</b>. Metadata from TMDB.</p>
<p>Copy the addon URL into Stremio to install.</p>
</body></html>`);
});

// Mount the stremio-addon-sdk router (manifest + stream + catalog)
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);
app.use(router);

const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => console.log(`LovePeaceKarma listening on :${port}`));
}

module.exports = app;
