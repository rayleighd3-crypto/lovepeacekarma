require('dotenv').config();
const axios = require('axios');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

/**
 * Resolve a TMDB ID to { id, type: 'movie'|'tv', title, year, originalLanguage }.
 * Accepts an already-tmdb numeric id (with expected type) or an IMDb tt-id.
 * @param {string|number} rawId e.g. "27205", "tt1375666"
 * @param {string} expectedType 'movie'|'series'|'tv'
 */
async function resolveTmdb(rawId, expectedType = null) {
  const isSeries = expectedType === 'tv' || expectedType === 'series';
  const idStr = String(rawId);

  // IMDb id -> TMDB find API
  if (/^tt\d+$/i.test(idStr)) {
    const url = `${TMDB_BASE_URL}/find/${idStr}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    const res = await axios.get(url, { timeout: 10000 });
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
    const url = `${TMDB_BASE_URL}/${type}/${idStr}?api_key=${TMDB_API_KEY}`;
    const res = await axios.get(url, { timeout: 10000 });
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

module.exports = { resolveTmdb, TMDB_API_KEY };
