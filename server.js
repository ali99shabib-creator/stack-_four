/**
 * Stack Four — Online server (matchmaking + private rooms + ratings + leaderboard)
 *
 * Run:   npm install && npm start
 * Env:   PORT=8080
 *        ALLOWED_ORIGINS=https://www.crazygames.com,https://your-domain.com   (optional but recommended)
 *        DATA_FILE=./players.json   (where ratings are stored)
 *
 * The server is authoritative: it validates every move and decides the winner.
 * Put it behind HTTPS/WSS (Render, Railway, Fly.io, a VPS with Caddy/nginx...).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'players.json');
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const TURN_MS = 60000;

/* ---------------- persistence ---------------- */
let players = {};
try { players = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) {}
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; fs.writeFile(DATA, JSON.stringify(players), () => {}); } }, 5000);
process.on('SIGTERM', () => { try { fs.writeFileSync(DATA, JSON.stringify(players)); } catch (e) {} process.exit(0); });

// Add words here to block them in player names (UGC moderation).
const BAD_WORDS = [];
function cleanName(n) {
  n = String(n || '').replace(/[\u0000-\u001f<>&"'`\\]/g, '').trim().slice(0, 16);
  const low = n.toLowerCase();
  if (!n || BAD_WORDS.some(w => low.includes(w))) return 'Player';
  return n;
}
function getPlayer(id, name) {
  let p = players[id];
  if (!p) p = players[id] = { name, rating: 1000, w: 0, l: 0, d: 0, t: Date.now() };
  if (name) p.name = name;
  dirty = true;
  return p;
}
function elo(a, b, sa) { const ea = 1 / (1 + Math.pow(10, (b - a) / 400)); return Math.round(24 * (sa - ea)); }

/* ---------------- game rules ---------------- */
const LINES = [];
for (let r = 0; r < 4; r++) LINES.push([r * 4, r * 4 + 1, r * 4 + 2, r * 4 + 3]);
for (let c = 0; c < 4; c++) LINES.push([c, c + 4, c + 8, c + 12]);
LINES.push([0, 5, 10, 15], [3, 6, 9, 12]);
function newGame(first) { return { board: Array.from({ length: 16 }, () => []), hand: [[3, 3, 3], [3, 3, 3]], turn: first, over: false }; }
function topOwner(g, i) { const s = g.board[i]; return s.length ? s[s.length - 1] >> 2 : -1; }
function canPlace(g, i, s) { const st = g.board[i]; return !st.length || (st[st.length - 1] & 3) < s; }
function hasMove(g, p) { for (let s = 0; s < 3; s++) if (g.hand[p][s] > 0) for (let i = 0; i < 16; i++) if (canPlace(g, i, s)) return true; return false; }
function winLine(g, p) { for (const L of LINES) if (L.every(i => topOwner(g, i) === p)) return L; return null; }

/* ---------------- state ---------------- */
const conns = new Map();   // ws -> {id,name,room,seat,lastEmote,msgs}
const rooms = new Map();   // code -> room
let queue = [];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = ''; for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
const send = (ws, o) => { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch (e) {} } };

function startRoom(room) {
  room.g = newGame(room.first);
  room.rematch = [false, false];
  room.games++;
  for (let seat = 0; seat < 2; seat++) {
    const ws = room.seats[seat], opp = room.seats[1 - seat];
    if (!ws || !opp) return;
    const op = players[conns.get(opp).id];
    send(ws, { t: 'start', seat, first: room.first, opp: { name: op.name, rating: op.rating }, code: room.code, turnMs: TURN_MS });
  }
  armTimer(room);
}
function armTimer(room) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => { if (room.g && !room.g.over) endGame(room, 1 - room.g.turn, 'timeout'); }, TURN_MS + 2000);
}
function endGame(room, winner, reason, line) {
  const g = room.g; if (!g || g.over) return;
  g.over = true; clearTimeout(room.timer);
  const info = [0, 1].map(s => room.seats[s] && conns.get(room.seats[s]));
  const pl = info.map(c => c && players[c.id]);
  const ratings = pl.map(p => p ? p.rating : 1000);
  const deltas = [0, 0];
  if (pl[0] && pl[1]) {
    const sa = winner === -1 ? 0.5 : winner === 0 ? 1 : 0;
    deltas[0] = elo(ratings[0], ratings[1], sa);
    deltas[1] = elo(ratings[1], ratings[0], 1 - sa);
    for (let s = 0; s < 2; s++) {
      const p = pl[s];
      p.rating = Math.max(100, p.rating + deltas[s]);
      if (winner === -1) p.d++; else if (winner === s) p.w++; else p.l++;
    }
    dirty = true;
  }
  for (let s = 0; s < 2; s++) {
    send(room.seats[s], { t: 'over', winner, line: line || null, reason, rating: pl[s] ? pl[s].rating : null, delta: deltas[s], oppRating: pl[1 - s] ? pl[1 - s].rating : null });
  }
}
function leaveRoom(ws) {
  const c = conns.get(ws); if (!c) return;
  queue = queue.filter(x => x !== ws);
  const room = c.room; if (!room) return;
  c.room = null;
  const seat = room.seats.indexOf(ws);
  if (seat >= 0) room.seats[seat] = null;
  if (room.g && !room.g.over && room.seats[1 - seat]) endGame(room, 1 - seat, 'leave');
  const other = room.seats[1 - seat];
  if (other) send(other, { t: 'oppleft' });
  if (!room.seats[0] && !room.seats[1]) { clearTimeout(room.timer); rooms.delete(room.code); }
}
function makeRoom() {
  const code = newCode();
  const room = { code, seats: [null, null], g: null, first: Math.random() < .5 ? 0 : 1, rematch: [false, false], timer: null, games: 0 };
  rooms.set(code, room);
  return room;
}
function seatIn(room, ws) {
  const seat = room.seats[0] ? 1 : 0;
  room.seats[seat] = ws; conns.get(ws).room = room;
  return seat;
}
function tryMatch() {
  queue = queue.filter(w => w.readyState === 1 && conns.get(w) && !conns.get(w).room);
  while (queue.length >= 2) {
    const a = queue.shift(), b = queue.shift();
    const room = makeRoom();
    seatIn(room, a); seatIn(room, b);
    startRoom(room);
  }
}

/* ---------------- message handling ---------------- */
function leaderboard(id) {
  const arr = Object.entries(players).filter(([, p]) => p.w + p.l + p.d > 0).sort((a, b) => b[1].rating - a[1].rating);
  const top = arr.slice(0, 50).map(([, p]) => ({ n: p.name, r: p.rating, w: p.w }));
  const idx = arr.findIndex(([pid]) => pid === id);
  return { t: 'lb', top, me: { rank: idx >= 0 ? idx + 1 : null, rating: players[id] ? players[id].rating : 1000 } };
}
function handle(ws, m) {
  const c = conns.get(ws);
  if (!c || typeof m !== 'object' || !m) return;
  if (m.t === 'ping') return send(ws, { t: 'pong' });
  if (m.t === 'hello') {
    if (typeof m.id !== 'string' || !/^[a-f0-9]{16,64}$/.test(m.id)) return ws.close();
    c.id = m.id; c.name = cleanName(m.name);
    const p = getPlayer(c.id, c.name);
    return send(ws, { t: 'welcome', rating: p.rating, wins: p.w, losses: p.l, draws: p.d, online: conns.size });
  }
  if (!c.id) return;
  switch (m.t) {
    case 'name': { c.name = cleanName(m.name); getPlayer(c.id, c.name); break; }
    case 'queue': {
      if (c.room) return send(ws, { t: 'err', m: 'busy' });
      if (!queue.includes(ws)) queue.push(ws);
      send(ws, { t: 'queued' }); tryMatch(); break;
    }
    case 'create': {
      if (c.room) return send(ws, { t: 'err', m: 'busy' });
      const room = makeRoom(); seatIn(room, ws);
      send(ws, { t: 'room', code: room.code }); break;
    }
    case 'join': {
      if (c.room) return send(ws, { t: 'err', m: 'busy' });
      const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'err', m: 'notfound' });
      if (room.seats[0] && room.seats[1]) return send(ws, { t: 'err', m: 'full' });
      seatIn(room, ws); startRoom(room); break;
    }
    case 'leave': leaveRoom(ws); break;
    case 'move': {
      const room = c.room; if (!room || !room.g || room.g.over) return send(ws, { t: 'err', m: 'illegal' });
      const g = room.g, seat = room.seats.indexOf(ws);
      const i = m.i | 0, s = m.s | 0;
      if (g.turn !== seat || i < 0 || i > 15 || s < 0 || s > 2 || g.hand[seat][s] <= 0 || !canPlace(g, i, s)) return send(ws, { t: 'err', m: 'illegal' });
      g.board[i].push(seat * 4 + s); g.hand[seat][s]--;
      const win = winLine(g, seat);
      let next, passed = false;
      if (win) next = -1;
      else {
        next = 1 - seat;
        if (!hasMove(g, next)) { if (hasMove(g, seat)) { next = seat; passed = true; } else next = -2; }
      }
      g.turn = next;
      for (const w of room.seats) send(w, { t: 'moved', seat, i, s, next: next < 0 ? -1 : next, passed });
      if (win) endGame(room, seat, 'line', win);
      else if (next === -2) endGame(room, -1, 'draw');
      else armTimer(room);
      break;
    }
    case 'rematch': {
      const room = c.room; if (!room || !room.g || !room.g.over) return;
      const seat = room.seats.indexOf(ws); room.rematch[seat] = true;
      const other = room.seats[1 - seat]; if (!other) return;
      if (room.rematch[0] && room.rematch[1]) { room.first = 1 - room.first; startRoom(room); }
      else send(other, { t: 'rematch' });
      break;
    }
    case 'emote': {
      const room = c.room; const now = Date.now();
      if (!room || now - (c.lastEmote || 0) < 1500) return;
      c.lastEmote = now;
      const e = m.e | 0; if (e < 0 || e > 4) return;
      const other = room.seats[1 - room.seats.indexOf(ws)]; send(other, { t: 'emote', e });
      break;
    }
    case 'lb': send(ws, leaderboard(c.id)); break;
  }
}

/* ---------------- http + websocket ---------------- */
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, online: conns.size, rooms: rooms.size })); }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({
  server, maxPayload: 2048,
  verifyClient: info => !ORIGINS.length || !info.origin || ORIGINS.some(o => info.origin === o || info.origin.endsWith(o.replace(/^https?:\/\//, '.')))
});
wss.on('connection', ws => {
  conns.set(ws, { id: null, name: 'Player', room: null, msgs: 0, lastEmote: 0 });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => {
    const c = conns.get(ws); if (!c) return;
    c.msgs++;
    if (c.msgs > 60) return ws.close();           // simple flood protection (reset every second)
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    try { handle(ws, m); } catch (e) { console.error(e); }
  });
  ws.on('close', () => { leaveRoom(ws); conns.delete(ws); });
  ws.on('error', () => {});
});
setInterval(() => { for (const c of conns.values()) c.msgs = 0; }, 1000);
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} }
}, 30000);
setInterval(() => { const n = conns.size; for (const ws of wss.clients) send(ws, { t: 'online', n }); }, 10000);

server.listen(PORT, () => console.log(`Stack Four server listening on :${PORT}`));
