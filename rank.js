/* REVERSE — ranked rules shared by the game and the server: leagues, rating math, seasons, league emblems. */
(function (root) {
  'use strict';
  var START = 1000;      // rating of a new account
  var PLACEMENT = 3;     // ranked games before a player shows up in the leaderboards
  var CC_COOLDOWN = 30 * 864e5;

  // six leagues, three divisions each (III → II → I), Master has none
  var TIERS = [
    { id: 'bronze', min: -1e9, floor: 700, divs: [800, 900], c1: '#f0b183', c2: '#9a5a33', gem: 'circle' },
    { id: 'silver', min: 1000, divs: [1100, 1200], c1: '#e8eef8', c2: '#7c89a6', gem: 'square' },
    { id: 'gold', min: 1300, divs: [1400, 1500], c1: '#ffd866', c2: '#c27a0e', gem: 'tri' },
    { id: 'platinum', min: 1600, divs: [1700, 1800], c1: '#86f2db', c2: '#1d8f86', gem: 'hex' },
    { id: 'diamond', min: 1900, divs: [2000, 2100], c1: '#a9c4ff', c2: '#3d5be0', gem: 'diamond' },
    { id: 'master', min: 2200, divs: [], c1: '#ffc2f3', c2: '#9343d8', gem: 'crown' }
  ];
  var ROMAN = ['', 'I', 'II', 'III'];

  function tierIndex(r) { for (var i = TIERS.length - 1; i >= 0; i--) if (r >= TIERS[i].min) return i; return 0; }
  // full league position: tier, division, and progress inside the division (0..1)
  function rankOf(r) {
    var i = tierIndex(r), t = TIERS[i], next = TIERS[i + 1];
    if (!next) return { tier: t.id, idx: i, div: 0, lo: t.min, hi: null, progress: 1 };
    var b = [i === 0 ? t.floor : t.min].concat(t.divs, [next.min]), d = 0;
    while (d < 2 && r >= b[d + 1]) d++;
    var lo = b[d], hi = b[d + 1];
    return { tier: t.id, idx: i, div: 3 - d, lo: lo, hi: hi, progress: Math.max(0, Math.min(1, (r - lo) / (hi - lo))) };
  }
  function divKey(r) { var k = rankOf(r); return k.idx * 4 + (k.div ? 3 - k.div : 3); } // grows with every promotion

  /* ---------- Elo with a fast calibration phase ---------- */
  function expected(ra, rb) { return 1 / (1 + Math.pow(10, (rb - ra) / 400)); }
  function kFactor(games, rating) { return games < 10 ? 40 : rating < 2000 ? 28 : 20; }
  // s: 1 win, 0.5 draw, 0 loss; mult: anti-farming factor for repeated pairings
  function delta(ra, rb, s, games, mult) {
    var d = Math.round(kFactor(games, ra) * (s - expected(ra, rb)) * (mult == null ? 1 : mult));
    if (mult !== 0 && s === 1 && d < 3) d = 3;
    if (mult !== 0 && s === 0 && d > -3) d = -3;
    if (ra + d < 0) d = -ra;
    return d;
  }

  /* ---------- monthly seasons (UTC) ---------- */
  function seasonId(t) { var d = new Date(t == null ? Date.now() : t); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
  function seasonEnd(id) { var p = id.split('-'); return Date.UTC(+p[0], +p[1], 1); }
  function seasonNumber(id) { var p = id.split('-'); return Math.max(1, (+p[0] - 2026) * 12 + (+p[1] - 10) + 1); } // season 1 = Oct 2026
  function softReset(r) { return Math.round(START + (r - START) * 0.6); }

  /* ---------- league emblem: two counter-turning rings around a gem, pips = division ---------- */
  function gemPath(g) {
    switch (g) {
      case 'circle': return '<circle cx="32" cy="30" r="6"/>';
      case 'square': return '<rect x="26.5" y="24.5" width="11" height="11" rx="2" transform="rotate(45 32 30)"/>';
      case 'tri': return '<path d="M32 22.5l7.5 12.5h-15z" stroke-linejoin="round" stroke-width="2"/>';
      case 'hex': return '<path d="M32 22.5l6.6 3.8v7.6L32 37.7l-6.6-3.8v-7.6z"/>';
      case 'diamond': return '<path d="M25 27.5l3.2-4.5h7.6l3.2 4.5L32 37.5z"/><path d="M25 27.5h14M28.2 23l3.8 14.5 3.8-14.5" fill="none" stroke="#0004" stroke-width="1"/>';
      default: return '<path d="M23.5 35.5l-1.5-11 5.8 4.2L32 22l4.2 6.7 5.8-4.2-1.5 11z" stroke-linejoin="round" stroke-width="1.5"/>';
    }
  }
  function badge(rating, size, games) {
    size = size || 24;
    var svg = '<svg class="emblem" viewBox="0 0 64 64" width="' + size + '" height="' + size + '" aria-hidden="true">';
    if (games != null && games < PLACEMENT) {   // still calibrating
      svg += '<circle cx="32" cy="32" r="28" fill="#1a1238" stroke="#5c5486" stroke-width="2.5"/>' +
        '<circle cx="32" cy="32" r="21" fill="none" stroke="#8d85b8" stroke-width="5" stroke-linecap="round" stroke-dasharray="9 7.5"/>' +
        '<text x="32" y="38.5" text-anchor="middle" font-family="Unbounded,sans-serif" font-weight="900" font-size="17" fill="#cfc8ee">?</text></svg>';
      return svg;
    }
    var k = rankOf(rating), t = TIERS[k.idx];
    if (t.id === 'master') svg += '<circle cx="32" cy="32" r="31" fill="none" stroke="' + t.c1 + '" stroke-opacity=".35" stroke-width="2"/>';
    svg += '<circle cx="32" cy="32" r="28" fill="#170f33" stroke="' + t.c2 + '" stroke-width="2.5"/>' +
      '<circle cx="32" cy="32" r="22" fill="none" stroke="' + t.c1 + '" stroke-width="5" stroke-linecap="round" stroke-dasharray="104 34" transform="rotate(-62 32 32)"/>' +
      '<circle cx="32" cy="32" r="14.5" fill="none" stroke="' + t.c2 + '" stroke-width="4" stroke-linecap="round" stroke-dasharray="62 29" transform="rotate(118 32 32)"/>' +
      '<g fill="' + t.c1 + '" stroke="' + t.c1 + '">' + gemPath(t.gem) + '</g>';
    for (var i = 0, n = k.div ? 4 - k.div : 0; i < n; i++) svg += '<circle cx="' + (32 + (i - (n - 1) / 2) * 6) + '" cy="44" r="2.1" fill="' + t.c1 + '"/>';
    return svg + '</svg>';
  }

  var api = {
    START: START, PLACEMENT: PLACEMENT, CC_COOLDOWN: CC_COOLDOWN, TIERS: TIERS, ROMAN: ROMAN,
    rankOf: rankOf, divKey: divKey, expected: expected, kFactor: kFactor, delta: delta,
    seasonId: seasonId, seasonEnd: seasonEnd, seasonNumber: seasonNumber, softReset: softReset, badge: badge
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Rank = api;
})(this);
