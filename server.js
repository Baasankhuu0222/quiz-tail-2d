'use strict';
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
// Админы код. Render дээр ADMIN_CODE орчны хувьсагчаар солих боломжтой.
const ADMIN_CODE = String(process.env.ADMIN_CODE || '536478');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'state.json');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server);

/* ---------------- state ---------------- */
const defaultSetup = () => ({ questions: [], participants: [], captainNames: [], rounds: 3, answerMode: 'all' });
let DB = { setup: defaultSetup(), game: null };

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    DB.setup = Object.assign(defaultSetup(), raw.setup || {});
    DB.game = raw.game || null;
    console.log('Өгөгдөл ачааллаа:', DATA_FILE);
  } catch (e) { /* анхны ажиллагаа */ }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(DB));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    } catch (e) { console.error('Хадгалж чадсангүй:', e.message); }
  }, 300);
}
load();

/* ---------------- helpers ---------------- */
const rid = () => crypto.randomBytes(5).toString('hex');
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function sanitizeSetup(s) {
  s = s || {};
  const questions = (Array.isArray(s.questions) ? s.questions : []).slice(0, 2000).map(q => ({
    id: str(q.id, 24).replace(/[^a-zA-Z0-9]/g, '') || rid(),
    topic: str(q.topic, 80), points: clamp(parseInt(q.points, 10) || 0, 0, 1000000),
    q: str(q.q, 2000), a: str(q.a, 1000)
  })).filter(q => q.topic && q.q && q.a && q.points > 0);
  const seen = new Set(), participants = [];
  (Array.isArray(s.participants) ? s.participants : []).forEach(n => { n = str(n, 60); if (n && !seen.has(n)) { seen.add(n); participants.push(n); } });
  const capSet = new Set(Array.isArray(s.captainNames) ? s.captainNames.map(n => str(n, 60)) : []);
  return {
    questions, participants: participants.slice(0, 500),
    captainNames: participants.filter(p => capSet.has(p)),
    rounds: clamp(parseInt(s.rounds, 10) || 1, 1, 50),
    answerMode: s.answerMode === 'picker' ? 'picker' : 'all'
  };
}

function newCode(taken) {
  for (;;) {
    const c = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (c !== ADMIN_CODE && !taken.has(c)) { taken.add(c); return c; }
  }
}

const teamIds = g => (g.order && g.order.length ? g.order : g.captainIds);
function draftInfo(g) {
  const order = teamIds(g), n = order.length, picks = g.draft.picks;
  const caps = new Set(g.captainIds.map(id => g.captains[id].name));
  const picked = new Set(picks.map(p => p.name));
  const pool = g.participants.filter(p => !caps.has(p) && !picked.has(p));
  const k = picks.length, r = Math.floor(k / n), pos = k % n, idx = r % 2 === 0 ? pos : n - 1 - pos;
  return { pool, picker: pool.length ? order[idx] : null };
}
function cmpTb(a, b) { const L = Math.max(a.length, b.length); for (let i = 0; i < L; i++) { const x = a[i] == null ? -1 : a[i], y = b[i] == null ? -1 : b[i]; if (x !== y) return x - y; } return 0; }
function tieGroups(g) {
  const arr = teamIds(g).map(id => ({ id, score: g.scores[id] || 0, tb: g.tb[id] || [] }));
  arr.sort((a, b) => (b.score - a.score) || cmpTb(b.tb, a.tb));
  const groups = [];
  for (let i = 0; i < arr.length;) {
    let j = i + 1;
    while (j < arr.length && arr[j].score === arr[i].score && cmpTb(arr[j].tb, arr[i].tb) === 0) j++;
    if (j - i > 1) groups.push(arr.slice(i, j).map(x => x.id));
    i = j;
  }
  return groups;
}
const eligible = (g, capId) => (g.answerMode === 'picker' ? [capId] : teamIds(g).slice());
const remaining = g => g.bank.filter(q => !g.used[q.id]);

function endGame(g) {
  g.play.current = null;
  g.tiebreak = null;
  g.phase = tieGroups(g).length ? 'tiebreak' : 'finished';
}

function logoutCaptains(msg) {
  for (const s of io.sockets.sockets.values()) {
    if (s.data.role && s.data.role !== 'admin') { s.data.role = null; s.emit('loggedout', msg); }
  }
}

/* ---------------- views ---------------- */
function viewFor(role) {
  const isAdmin = role === 'admin';
  const v = { role, setup: isAdmin ? DB.setup : null, game: null };
  const g = DB.game;
  if (!g) return v;
  const captains = {};
  g.captainIds.forEach(id => {
    const c = g.captains[id];
    captains[id] = { name: c.name, registered: c.registered };
    if (isAdmin) captains[id].code = c.code;
  });
  const pubQ = (cur) => {
    if (!cur) return null;
    const o = Object.assign({}, cur);
    if (!isAdmin && cur.status !== 'done') o.answer = null;
    return o;
  };
  const answers = {};
  [g.play.current, g.tiebreak].forEach(cur => {
    if (!cur) return;
    const all = g.answers[cur.key] || {};
    const out = {};
    Object.keys(all).forEach(capId => {
      if (isAdmin || cur.status === 'done' || capId === role) out[capId] = all[capId].text;
    });
    answers[cur.key] = out;
  });
  v.game = {
    id: g.id, phase: g.phase, rounds: g.rounds, answerMode: g.answerMode, topics: g.topics,
    qmeta: g.bank.map(q => ({ id: q.id, topic: q.topicId, points: q.points })),
    participants: g.participants, captainIds: g.captainIds, captains, order: g.order,
    draft: { picks: g.draft.picks },
    play: { round: g.play.round, turn: g.play.turn, current: pubQ(g.play.current) },
    used: g.used, scores: g.scores, log: g.log, tb: g.tb, tiebreak: pubQ(g.tiebreak), answers
  };
  return v;
}
function broadcast() {
  for (const s of io.sockets.sockets.values()) {
    if (s.data.role) s.emit('state', viewFor(s.data.role));
  }
}
function changed() { save(); broadcast(); }

/* ---------------- actions ---------------- */
const ADMIN_ONLY = new Set(['setup.update', 'game.start', 'game.shuffle', 'game.startdraft', 'game.undopick', 'game.startplay',
  'play.award', 'play.cancel', 'play.next', 'game.end', 'tb.start', 'tb.judge', 'tb.finish', 'game.reset', 'captain.newcode']);

function handle(socket, m) {
  const role = socket.data.role;
  if (!role) return { error: 'Нэвтэрнэ үү.' };
  const isAdmin = role === 'admin';
  if (ADMIN_ONLY.has(m.type) && !isAdmin) return { error: 'Зөвхөн админ хийнэ.' };
  const g = DB.game;
  // Админ ахлагчийн өмнөөс үйлдэл хийж болно (m.as)
  const actor = isAdmin ? (m.as && g && g.captains[m.as] ? m.as : 'admin') : role;

  switch (m.type) {
    case 'setup.update': {
      if (g && g.phase !== 'setup') return { error: 'Тоглолт явагдаж байхад тохиргоог өөрчлөхгүй.' };
      DB.setup = sanitizeSetup(m.setup); return;
    }
    case 'game.start': {
      const s = DB.setup;
      if (!s.questions.length) return { error: 'Асуулт оруулаагүй байна.' };
      if (s.captainNames.length < 2) return { error: 'Дор хаяж 2 ахлагч хэрэгтэй.' };
      const topicNames = [...new Set(s.questions.map(q => q.topic))];
      const topics = topicNames.map((n, i) => ({ id: 't' + i, name: n }));
      const tid = {}; topics.forEach(t => (tid[t.name] = t.id));
      const taken = new Set(), captains = {}, captainIds = [];
      s.captainNames.forEach((n, i) => { const id = 'c' + i; captainIds.push(id); captains[id] = { name: n, code: newCode(taken), registered: false }; });
      logoutCaptains('Шинэ тоглоом эхэллээ. Шинэ кодоороо нэвтэрнэ үү.');
      DB.game = {
        id: rid(), phase: 'register', rounds: s.rounds, answerMode: s.answerMode, topics,
        bank: s.questions.map(q => ({ id: q.id, topicId: tid[q.topic], points: q.points, q: q.q, a: q.a })),
        participants: s.participants.slice(), captainIds, captains, order: [], draft: { picks: [] },
        play: { round: 1, turn: 0, current: null }, used: {}, scores: {}, log: [], tb: {}, tbCount: 0, tiebreak: null, answers: {}
      };
      return;
    }
    case 'game.reset': {
      DB.game = null;
      logoutCaptains('Тоглоом дууссан.');
      return;
    }
  }

  if (!g) return { error: 'Тоглоом эхлээгүй байна.' };

  switch (m.type) {
    case 'captain.newcode': {
      const c = g.captains[m.capId]; if (!c) return { error: 'Ахлагч олдсонгүй.' };
      const taken = new Set(g.captainIds.map(id => g.captains[id].code));
      c.code = newCode(taken);
      for (const s of io.sockets.sockets.values()) if (s.data.role === m.capId) { s.data.role = null; s.emit('loggedout', 'Таны код шинэчлэгдлээ.'); }
      return;
    }
    case 'game.shuffle': {
      if (!['register', 'order'].includes(g.phase)) return { error: 'Одоо дараалал сугалах боломжгүй.' };
      g.order = shuffle(g.captainIds); g.scores = {}; g.order.forEach(id => (g.scores[id] = 0)); g.phase = 'order'; return;
    }
    case 'game.startdraft': {
      if (g.phase !== 'order') return { error: 'Буруу үе шат.' };
      g.phase = draftInfo(g).pool.length ? 'draft' : 'play'; return;
    }
    case 'draft.pick': {
      if (g.phase !== 'draft') return { error: 'Драфт явагдаагүй байна.' };
      const d = draftInfo(g);
      if (!d.picker) return { error: 'Драфт дууссан.' };
      if (actor !== 'admin' && actor !== d.picker) return { error: 'Таны ээлж биш.' };
      if (!d.pool.includes(m.name)) return { error: 'Энэ хүн сонгогдсон байна.' };
      g.draft.picks.push({ capId: d.picker, name: m.name }); return;
    }
    case 'game.undopick': { if (g.phase === 'draft') g.draft.picks.pop(); return; }
    case 'game.startplay': {
      if (!['draft', 'order'].includes(g.phase)) return { error: 'Буруу үе шат.' };
      g.phase = 'play'; g.play = { round: 1, turn: 0, current: null }; return;
    }
    case 'play.pick': {
      if (g.phase !== 'play' || g.play.current) return { error: 'Одоо сонгох боломжгүй.' };
      const picker = g.order[g.play.turn];
      if (actor !== 'admin' && actor !== picker) return { error: 'Таны ээлж биш.' };
      const q = g.bank.find(x => x.id === m.qid);
      if (!q || g.used[q.id]) return { error: 'Энэ асуулт ашиглагдсан.' };
      g.play.current = { key: 'q_' + q.id, qid: q.id, topic: q.topicId, points: q.points, text: q.q, capId: picker, status: 'open', answer: q.a, results: null };
      return;
    }
    case 'play.answer': {
      const cur = m.key && m.key.startsWith('tb') ? g.tiebreak : g.play.current;
      if (!cur || cur.key !== m.key || cur.status !== 'open') return { error: 'Хариулт хүлээн авахгүй байна.' };
      if (actor === 'admin') return { error: 'Ахлагчийг сонгоно уу.' };
      const elig = cur.group ? cur.group : eligible(g, cur.capId);
      if (!elig.includes(actor)) return { error: 'Энэ асуултад таны баг хариулахгүй.' };
      const text = str(m.text, 500); if (!text) return { error: 'Хариултаа бичнэ үү.' };
      g.answers[cur.key] = g.answers[cur.key] || {};
      g.answers[cur.key][actor] = { text, at: Date.now() };
      return;
    }
    case 'play.award': {
      const cur = g.play.current; if (!cur || cur.status !== 'open') return { error: 'Идэвхтэй асуулт алга.' };
      const elig = eligible(g, cur.capId), grades = m.grades || {};
      if (elig.some(id => grades[id] == null || isNaN(Number(grades[id])))) return { error: 'Баг бүрийн оноог тэмдэглэнэ үү.' };
      const results = {};
      elig.forEach(id => { results[id] = clamp(Number(grades[id]), -1000000, 1000000); g.scores[id] = (g.scores[id] || 0) + results[id]; });
      g.used[cur.qid] = true; cur.status = 'done'; cur.results = results;
      g.log.push({ round: g.play.round, qid: cur.qid, capId: cur.capId, points: cur.points, results });
      return;
    }
    case 'play.cancel': { if (g.play.current && g.play.current.status === 'open') { delete g.answers[g.play.current.key]; g.play.current = null; } return; }
    case 'play.next': {
      if (g.phase !== 'play') return;
      let round = g.play.round, turn = g.play.turn + 1;
      if (turn >= g.order.length) { turn = 0; round++; }
      if (round > g.rounds || remaining(g).length === 0) { endGame(g); return; }
      g.play = { round, turn, current: null }; return;
    }
    case 'game.end': { if (g.phase === 'play') endGame(g); return; }
    case 'tb.start': {
      if (g.phase !== 'tiebreak' || (g.tiebreak && g.tiebreak.status === 'open')) return { error: 'Буруу үе шат.' };
      const group = tieGroups(g)[0]; if (!group) return { error: 'Тэнцсэн баг алга.' };
      g.tbCount = (g.tbCount || 0) + 1;
      const key = 'tb' + g.tbCount, un = remaining(g);
      if (un.length) {
        const q = un[crypto.randomInt(un.length)];
        g.used[q.id] = true;
        const t = g.topics.find(x => x.id === q.topicId);
        g.tiebreak = { key, group, qid: q.id, topicName: t ? t.name : '', text: q.q, status: 'open', answer: q.a, results: null };
      } else {
        const q = str(m.q, 2000), a = str(m.a, 1000);
        if (!q || !a) return { error: 'Асуулт, хариултаа бичнэ үү.' };
        g.tiebreak = { key, group, qid: null, topicName: '', text: q, status: 'open', answer: a, results: null };
      }
      return;
    }
    case 'tb.judge': {
      const tb = g.tiebreak; if (!tb || tb.status !== 'open') return { error: 'Идэвхтэй асуулт алга.' };
      const grades = m.grades || {};
      if (tb.group.some(id => grades[id] == null)) return { error: 'Баг бүрийг тэмдэглэнэ үү.' };
      const results = {};
      tb.group.forEach(id => { results[id] = Number(grades[id]) ? 1 : 0; g.tb[id] = (g.tb[id] || []).concat([results[id]]); });
      tb.status = 'done'; tb.results = results; return;
    }
    case 'tb.finish': {
      if (g.phase !== 'tiebreak' || tieGroups(g).length) return { error: 'Тэнцээ шийдэгдээгүй байна.' };
      g.phase = 'finished'; return;
    }
  }
  return { error: 'Үл мэдэгдэх үйлдэл.' };
}

/* ---------------- sockets ---------------- */
const fails = new Map(); // ip -> {n, until}
function clientIp(socket) {
  const xf = socket.handshake.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0] : socket.handshake.address || '').trim();
}

io.on('connection', socket => {
  socket.data.role = null;

  socket.on('auth', (code, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const ip = clientIp(socket), now = Date.now(), f = fails.get(ip) || { n: 0, until: 0 };
    if (f.until > now) return ack({ ok: false, error: `Олон удаа буруу оруулсан. ${Math.ceil((f.until - now) / 1000)} секунд хүлээнэ үү.` });
    code = String(code || '').trim();
    let role = null;
    if (code && code === ADMIN_CODE) role = 'admin';
    else if (code && DB.game) role = DB.game.captainIds.find(id => DB.game.captains[id].code === code) || null;
    if (!role) {
      f.n++; if (f.n >= 8) { f.until = now + 60000; f.n = 0; }
      fails.set(ip, f);
      return ack({ ok: false, error: DB.game ? 'Код буруу байна.' : 'Код буруу эсвэл тоглоом эхлээгүй байна.' });
    }
    fails.delete(ip);
    socket.data.role = role;
    if (role !== 'admin' && !DB.game.captains[role].registered) { DB.game.captains[role].registered = true; changed(); }
    ack({ ok: true, role });
    socket.emit('state', viewFor(role));
  });

  socket.on('logout', () => { socket.data.role = null; });

  socket.on('act', (m, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    try {
      const r = handle(socket, m || {});
      if (r && r.error) return ack({ ok: false, error: r.error });
      ack({ ok: true });
      changed();
    } catch (e) {
      console.error(e);
      ack({ ok: false, error: 'Серверийн алдаа.' });
    }
  });
});

server.listen(PORT, () => console.log(`Багийн квиз: http://localhost:${PORT}`));
