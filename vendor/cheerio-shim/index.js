// See package.json: this shim exists only so third-party providers that import
// 'cheerio-without-node-native' reuse LovePeaceKarma's existing cheerio instead of
// pulling in ~89 legacy packages (request, har-validator, uuid@3, ...).
module.exports = require('cheerio');
