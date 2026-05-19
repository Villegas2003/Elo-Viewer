// API endpoint: fetches a chess-results.com tournament and returns structured JSON.
// Usage: /api/cr/1413614.json
//
// Strategy:
//   1) Fetch starting-rank page (art=16) → tournament metadata + player roster
//   2) Detect rounds played from the "Board Pairings" links in the metadata
//   3) Fetch each round's board pairings (art=3) → individual board games
//   4) Return clean JSON the frontend can render

import { parse } from 'node-html-parser';

export const prerender = false;

const CR_HOSTS = [
  'https://chess-results.com',
  'https://s1.chess-results.com',
  'https://s2.chess-results.com',
  'https://s3.chess-results.com',
];

async function fetchCR(path) {
  let lastErr;
  for (const host of CR_HOSTS) {
    try {
      const res = await fetch(host + path, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChessEloManager/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return await res.text();
      lastErr = new Error(`${host}${path} → ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All chess-results hosts unreachable');
}

const TITLES = new Set(['GM','IM','FM','CM','NM','WGM','WIM','WFM','WCM','AIM','AFM','AGM','CAM']);

// Limpia el texto de una celda: trim + colapsar espacios
function txt(node) {
  if (!node) return '';
  return (node.text || node.textContent || '').replace(/\s+/g, ' ').trim();
}

function parseStartingRank(rawHtml) {
  const root = parse(rawHtml);

  // Tournament name
  let tName = 'Torneo';
  const titleEl = root.querySelector('title');
  if (titleEl) {
    const full = txt(titleEl);
    const i = full.lastIndexOf(' - ');
    tName = i >= 0 ? full.substring(i + 3).trim() : full;
  }

  // Number of rounds: buscar el texto y la celda siguiente
  let nRounds = 0;
  const allTds = root.querySelectorAll('td');
  for (let i = 0; i < allTds.length; i++) {
    if (txt(allTds[i]) === 'Number of rounds' && i + 1 < allTds.length) {
      const n = parseInt(txt(allTds[i + 1]), 10);
      if (!isNaN(n)) nRounds = n;
      break;
    }
  }

  // Tournament year: buscar "Date" en metadata; formato típico "2025/03/14 to 2025/03/16"
  // Tomamos el primer año de 4 dígitos que aparezca cerca de las etiquetas Date/From
  let tYear = 0;
  for (let i = 0; i < allTds.length - 1; i++) {
    const label = txt(allTds[i]);
    if (label === 'Date' || label === 'Date of last update' || label === 'Date round' || label === 'From' || label === 'Last update') {
      const val = txt(allTds[i + 1]);
      const ym = val.match(/(19|20)\d{2}/);
      if (ym) { tYear = parseInt(ym[0], 10); if (label === 'Date' || label === 'From') break; }
    }
  }
  // Fallback: buscar año en el título o en el HTML completo
  if (!tYear) {
    const ym = (tName.match(/(19|20)\d{2}/) || []);
    if (ym[0]) tYear = parseInt(ym[0], 10);
  }

  // Rondas jugadas: contar links Rd.N en el bloque "Board Pairings"
  let playedRounds = 0;
  const text = root.text || '';
  const bpIdx = text.indexOf('Board Pairings');
  const rlIdx = text.indexOf('Ranking list');
  if (bpIdx >= 0 && rlIdx > bpIdx) {
    const slice = text.substring(bpIdx, rlIdx);
    const rds = slice.match(/Rd\.\d+/g) || [];
    playedRounds = rds.length;
  }

  // Tabla de jugadores: buscar la tabla que contenga links snr=.
  // Cada fila es <tr> con celdas en orden: rank, [flag], title, [name link], fideId, rating, fed, team, board
  // Distinción clave: filas de jugador tienen 1 link snr=; filas de board pairing tienen 2.
  const players = [];
  const seen = new Set();
  const trs = root.querySelectorAll('tr');
  for (const tr of trs) {
    // Contar TODOS los links snr= en la fila (incluyendo anidados)
    const snrAnchors = tr.querySelectorAll('a[href*="snr="]');
    if (snrAnchors.length !== 1) continue;  // 0 = no es de jugador; 2+ = board pairing
    const snrAnchor = snrAnchors[0];
    const href = snrAnchor.getAttribute('href') || '';
    const sm = href.match(/snr=(\d+)/);
    if (!sm) continue;
    const snr = parseInt(sm[1], 10);

    // FIDE id link (puede no existir para jugadores sin FIDE)
    const fideAnchor = tr.querySelector('a[href*="ratings.fide.com/profile/"]');
    const fide = fideAnchor ? (fideAnchor.getAttribute('href').match(/profile\/(\d+)/) || [])[1] || '' : '';
    // Evitar duplicados por snr
    if (seen.has(snr)) continue;

    const name = txt(snrAnchor);
    if (!name) continue;

    // Para starting rank, las CELDAS DIRECTAS del tr son las columnas principales.
    // Usamos solo hijos directos para evitar tablas anidadas.
    const cells = tr.childNodes
      .filter(n => n.tagName && (n.tagName.toUpperCase() === 'TD' || n.tagName.toUpperCase() === 'TH'))
      .map(c => txt(c));

    if (cells.length < 2) continue;  // Filas muy cortas no son de jugador

    seen.add(snr);

    // Title: primera celda que matchee
    let title = '';
    for (const c of cells) {
      if (TITLES.has(c)) { title = c; break; }
    }

    // Rating: primer número en rango
    let rating = 0;
    for (const c of cells) {
      const r = parseInt(c, 10);
      if (!isNaN(r) && r >= 800 && r <= 2900 && c.length === 4) { rating = r; break; }
    }

    // Federación: código de 3 letras mayúsculas que NO sea un título (AIM, AFM, etc. son títulos)
    let fed = '';
    let fedCellIdx = -1;
    for (let i = 0; i < cells.length; i++) {
      if (/^[A-Z]{3}$/.test(cells[i]) && !TITLES.has(cells[i])) { fed = cells[i]; fedCellIdx = i; break; }
    }

    // Team y board: después de fed. Team es texto, board es número 1-30.
    let team = '';
    let board = 0;
    if (fedCellIdx >= 0) {
      // El último número pequeño (1-30) en la fila después de fed es el board
      let boardCellIdx = -1;
      for (let i = cells.length - 1; i > fedCellIdx; i--) {
        const b = parseInt(cells[i], 10);
        if (!isNaN(b) && b >= 1 && b <= 30 && cells[i].length <= 2) { board = b; boardCellIdx = i; break; }
      }
      const teamEnd = boardCellIdx >= 0 ? boardCellIdx : cells.length;
      team = cells.slice(fedCellIdx + 1, teamEnd).join(' ').trim();
    }

    players.push({ snr, name, title, fide, rating, fed, team, board });
  }

  return { tName, tYear, nRounds, playedRounds, players };
}

function parseBoardPairings(rawHtml) {
  const root = parse(rawHtml);
  const matches = [];
  let curMatch = null;
  let individualMatch = null;  // synthetic match para torneos individuales (sin headers de equipo)

  // Helper: parsear score "2½:1½" o "3 : 1" → [2.5, 1.5]
  const parseScore = (s) => {
    const clean = s.trim().replace(',', '.');
    const m = clean.match(/^(\d*)(½)?$/);
    if (m) {
      const intPart = m[1] ? parseInt(m[1], 10) : 0;
      return intPart + (m[2] ? 0.5 : 0);
    }
    return parseFloat(clean);
  };

  // Recorrer todos los <tr> en orden de aparición
  const trs = root.querySelectorAll('tr');
  for (const tr of trs) {
    // Celdas DIRECTAS (no de tablas anidadas)
    const cells = tr.childNodes
      .filter(n => n.tagName && (n.tagName.toUpperCase() === 'TD' || n.tagName.toUpperCase() === 'TH'))
      .map(c => txt(c));

    if (cells.length === 0) continue;

    // ── Team match header: ["Bo.", "2", "UCR", "Rtg", "-", "9", "Cenfotec", "Rtg", "2½:1½", ...]
    if (cells[0] === 'Bo.' && cells.length >= 8) {
      const scoreCellIdx = cells.findIndex(c => /^[\d½.,]+\s*:\s*[\d½.,]+$/.test(c));
      if (scoreCellIdx >= 7) {
        const score = cells[scoreCellIdx].split(':').map(parseScore);
        const teamA = cells[2] || '';
        const teamB = cells[6] || '';
        if (teamA && teamB) {
          curMatch = { teamA, teamB, scoreA: score[0], scoreB: score[1], boards: [] };
          matches.push(curMatch);
          continue;
        }
      }
    }

    // ── Detectar fila de partida (team o individual):
    // - Tiene 2 links snr= (blanco y negro)
    // - Tiene un resultado (1-0, 0-1, ½-½, +-, etc.)
    const anchors = tr.querySelectorAll('a[href*="snr="]');
    if (anchors.length < 2) continue;

    const snrs = [];
    for (const a of anchors) {
      const m = (a.getAttribute('href') || '').match(/snr=(\d+)/);
      if (m) snrs.push(parseInt(m[1], 10));
      if (snrs.length >= 2) break;
    }
    if (snrs.length < 2) continue;

    let result = null;
    for (const c of cells) {
      const n = c.replace(/\s+/g, '');
      if (n === '1-0') { result = 1; break; }
      if (n === '0-1') { result = 0; break; }
      if (n === '½-½' || n === '0.5-0.5' || n === '1/2-1/2') { result = 0.5; break; }
      if (n === '+--' || n === '+-0') { result = 1; break; }
      if (n === '--+' || n === '0-+') { result = 0; break; }
    }
    if (result === null) continue;

    // Distinguir: formato team ("N.M" en cells[0]) vs individual ("N" en cells[0])
    const teamBoardM = cells[0].match(/^(\d+)\.(\d+)$/);
    if (teamBoardM && curMatch) {
      curMatch.boards.push({ board: parseInt(teamBoardM[2], 10), white: snrs[0], black: snrs[1], result });
    } else {
      // Individual: sintetizar un único "match" por ronda
      const indBoardM = cells[0].match(/^(\d+)$/);
      const boardNum = indBoardM ? parseInt(indBoardM[1], 10) : (individualMatch ? individualMatch.boards.length + 1 : 1);
      if (!individualMatch) {
        individualMatch = { teamA: '', teamB: '', scoreA: 0, scoreB: 0, boards: [], individual: true };
        matches.push(individualMatch);
      }
      individualMatch.boards.push({ board: boardNum, white: snrs[0], black: snrs[1], result });
    }
  }

  return matches;
}

// Parser de la página individual del jugador (art=9). Extrae:
// - Rating international (FIDE)
// - Year of birth (para calcular K factor correctamente)
function parsePlayerPage(rawHtml) {
  const root = parse(rawHtml);
  const tds = root.querySelectorAll('td');
  let intl = 0;
  let yob = 0;
  for (let i = 0; i < tds.length - 1; i++) {
    const label = txt(tds[i]);
    if (label === 'Rating international') {
      const v = parseInt(txt(tds[i + 1]), 10);
      if (!isNaN(v) && v >= 800 && v <= 2900) intl = v;
    } else if (label === 'Year of birth') {
      const v = parseInt(txt(tds[i + 1]), 10);
      if (!isNaN(v) && v >= 1900 && v <= 2030) yob = v;
    }
  }
  return { ratingIntl: intl, yob: yob };
}

// Cálculo del K factor FIDE oficial.
// Reglas:
//   K = 40 si jugador es <18 años Y rating <2300
//   K = 10 si rating ≥ 2400 (en producción FIDE: "una vez alcanzado, permanece en 10").
//          Esto es una aproximación con el rating actual.
//   K = 20 en el resto de casos (default para adultos con rating <2400)
// La regla de "K=40 para jugador nuevo (<30 partidas)" no se aplica porque
// requiere historial FIDE que no tenemos.
function computeKFactor(rating, yob, tournamentYear) {
  if (yob > 0 && tournamentYear > 0) {
    const age = tournamentYear - yob;
    if (age < 18 && rating < 2300) return 40;
  }
  if (rating >= 2400) return 10;
  return 20;
}

// Fetch en paralelo con concurrencia limitada (no martillar chess-results)
async function parallelMap(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); } catch (e) { results[i] = null; }
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export async function GET({ params }) {
  const tnr = (params.tnr || '').replace(/\D/g, '');
  if (!tnr) {
    return new Response(JSON.stringify({ error: 'tnr requerido' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }

  try {
    // Intentamos varias URLs para la lista de jugadores. Algunos torneos no tienen
    // starting rank por equipos (art=16/flag=30), o usan una vista distinta.
    const urls = [
      `/tnr${tnr}.aspx?lan=1&art=16&turdet=YES&flag=30`,  // starting rank teams
      `/tnr${tnr}.aspx?lan=1&art=0&turdet=YES&flag=30`,   // general / players
      `/tnr${tnr}.aspx?lan=1&art=1&turdet=YES`,           // alphabetical list
      `/tnr${tnr}.aspx?lan=1&art=16&turdet=YES`,          // starting rank sin flag=30
    ];
    let srHtml = null, meta = null, srUrl = '';
    for (const u of urls) {
      try {
        const html = await fetchCR(u);
        const m = parseStartingRank(html);
        if (m.players.length) { srHtml = html; meta = m; srUrl = u; break; }
        if (!meta) { meta = m; srHtml = html; srUrl = u; }  // guardar el primero como fallback para metadata
      } catch (e) { /* probar siguiente */ }
    }

    if (!meta || !meta.players.length) {
      // Diagnóstico: intentar dar pistas de por qué no hay jugadores
      const hasContent = srHtml && srHtml.length > 500;
      const looksLikeError = srHtml && /no.{0,5}found|not.{0,5}exist|error/i.test(srHtml.slice(0, 2000));
      let reason = 'Lista de jugadores vacía';
      if (!hasContent) reason = 'La página del torneo está vacía o el torneo no existe';
      else if (looksLikeError) reason = 'chess-results devolvió una página de error (¿torneo eliminado?)';
      else if (meta && meta.tName === 'Torneo') reason = 'Estructura de página no reconocida (¿torneo aún sin lista publicada?)';
      return new Response(JSON.stringify({
        error: reason,
        tnr,
        tName: meta ? meta.tName : '',
        debug: { triedUrl: srUrl, htmlSize: srHtml ? srHtml.length : 0 }
      }), { status: 422, headers: { 'content-type': 'application/json' } });
    }

    // Fetch board pairings de todas las rondas en paralelo.
    // Probamos art=2 (individual) y art=3 (equipos). El que más matches devuelva es el correcto.
    const playedR = meta.playedRounds || 0;
    const roundIdxs = Array.from({ length: playedR }, (_, i) => i + 1);
    const rounds = await parallelMap(roundIdxs, 4, async (r) => {
      const arts = ['3', '2'];  // try team first (más estricto), luego individual
      let best = [];
      for (const a of arts) {
        try {
          const bpHtml = await fetchCR(`/tnr${tnr}.aspx?lan=1&art=${a}&rd=${r}&turdet=YES&flag=30`);
          const ms = parseBoardPairings(bpHtml);
          const totalBoards = ms.reduce((s, m) => s + (m.boards || []).length, 0);
          const bestBoards = best.reduce((s, m) => s + (m.boards || []).length, 0);
          if (totalBoards > bestBoards) best = ms;
        } catch (e) { /* probar siguiente */ }
      }
      return { round: r, matches: best };
    });
    rounds.sort((a, b) => a.round - b.round);

    // Fetch página individual de cada jugador para extraer Rating internacional (FIDE)
    // y año de nacimiento (yob). En paralelo, limitando a 8 concurrentes.
    const playerInfo = await parallelMap(meta.players, 8, async (p) => {
      try {
        const html = await fetchCR(`/tnr${tnr}.aspx?lan=1&art=9&turdet=YES&flag=30&snr=${p.snr}`);
        return parsePlayerPage(html);
      } catch (e) {
        return { ratingIntl: 0, yob: 0 };
      }
    });
    // Mergear: si hay rating internacional, lo usamos como primario; guardamos ambos
    // También guardamos yob para que el frontend calcule K correctamente
    meta.players.forEach((p, i) => {
      const info = playerInfo[i] || { ratingIntl: 0, yob: 0 };
      p.ratingNational = p.rating;
      p.ratingIntl = info.ratingIntl || 0;
      p.yob = info.yob || 0;
      // Si tiene FIDE intl, ese es el rating "principal"; sino, el nacional
      if (p.ratingIntl > 0) p.rating = p.ratingIntl;
    });

    // Año del torneo: usar el extraído del HTML, o como fallback el año actual
    const tYear = meta.tYear || new Date().getFullYear();

    const data = {
      tnr,
      name: meta.tName,
      year: tYear,
      nRounds: meta.nRounds,
      playedRounds: playedR,
      fetchedAt: new Date().toISOString(),
      players: meta.players,
      rounds,
      source: 'chess-results',
    };

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 's-maxage=300, stale-while-revalidate=3600',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
}
