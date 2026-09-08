'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const AMAP_KEY = process.env.AMAP_KEY || '';
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ----------------------------- Data store ----------------------------- */
function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const s = JSON.parse(raw);
    if (s && Array.isArray(s.trips)) return s;
  } catch (e) { /* ignore */ }
  // first-run seed: one empty trip + one day so the UI isn't blank
  return { trips: [seedTrip()] };
}
function seedTrip() {
  return {
    id: id(),
    name: '示例旅行',
    createdAt: Date.now(),
    days: [{ id: id(), label: 'Day 1', date: null, startStopId: null, stops: [], images: [], xhs: [], comments: [] }]
  };
}
function id() { return crypto.randomBytes(6).toString('hex'); }

let state = loadState();
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
    } catch (e) { console.error('save error', e); }
  }, 200);
}

/* ----------------------------- Helpers ----------------------------- */
function findTrip(tripId) { return state.trips.find(t => t.id === tripId); }
function findDay(tripId, dayId) { const t = findTrip(tripId); return t ? t.days.find(d => d.id === dayId) : null; }
function findStop(tripId, dayId, stopId) { const d = findDay(tripId, dayId); return d ? d.stops.find(s => s.id === stopId) : null; }
function targetOf(p) { return p.stopId ? findStop(p.tripId, p.dayId, p.stopId) : findDay(p.tripId, p.dayId); }
function modeLabel(m) { return ({ driving: '自驾', rail: '高铁', walking: '步行', transit: '公交', flight: '飞机' })[m] || '未设'; }
function haversine(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return 0;
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function normalizeStop(s) {
  return {
    id: s.id || id(),
    name: s.name || '未命名地点',
    address: s.address || '',
    lat: Number(s.lat), lng: Number(s.lng),
    arriveTime: s.arriveTime || '', leaveTime: s.leaveTime || '',
    notes: s.notes || '',
    transportFromPrev: s.transportFromPrev || null,
    transportNote: s.transportNote || '',
    images: Array.isArray(s.images) ? s.images : [],
    xhs: Array.isArray(s.xhs) ? s.xhs : [],
    comments: Array.isArray(s.comments) ? s.comments : []
  };
}

function optimizeDay(day, metric) {
  const stops = day.stops.slice();
  if (stops.length < 2) return;
  const start = day.startStopId ? stops.find(s => s.id === day.startStopId) : stops[0];
  const remaining = stops.filter(s => s !== start);
  const ordered = [start];
  let cur = start;
  while (remaining.length) {
    let bestI = 0, bestCost = Infinity;
    remaining.forEach((s, i) => {
      const dist = haversine(cur, s);
      const cost = metric === 'distance' ? dist : dist / 80; // time metric ~80km/h avg
      if (cost < bestCost) { bestCost = cost; bestI = i; }
    });
    cur = remaining.splice(bestI, 1)[0];
    ordered.push(cur);
  }
  day.stops = ordered;
}

/* ----------------------------- Mutations ----------------------------- */
function applyMutation(msg) {
  const actor = (msg.actor || '某人').toString().slice(0, 20);
  const a = msg.action;
  const p = msg.payload || {};
  let event = '';
  switch (a) {
    case 'trip.create': {
      const trip = { id: id(), name: p.name || '未命名旅行', createdAt: Date.now(), days: [] };
      state.trips.push(trip);
      event = `${actor} 创建了旅行「${trip.name}」`;
      break;
    }
    case 'trip.rename': {
      const t = findTrip(p.tripId); if (!t) return { ok: false };
      t.name = p.name; event = `${actor} 重命名旅行为「${p.name}」`; break;
    }
    case 'trip.delete': {
      const i = state.trips.findIndex(t => t.id === p.tripId); if (i < 0) return { ok: false };
      const [r] = state.trips.splice(i, 1); event = `${actor} 删除了旅行「${r.name}」`; break;
    }
    case 'day.create': {
      const t = findTrip(p.tripId); if (!t) return { ok: false };
      const day = { id: id(), label: p.label || `Day ${t.days.length + 1}`, date: null, startStopId: null, stops: [], images: [], xhs: [], comments: [] };
      t.days.push(day); event = `${actor} 在「${t.name}」新增 ${day.label}`; break;
    }
    case 'day.update': {
      const d = findDay(p.tripId, p.dayId); if (!d) return { ok: false };
      if (p.label !== undefined) d.label = p.label;
      if (p.date !== undefined) d.date = p.date;
      event = `${actor} 更新了 ${d.label}`; break;
    }
    case 'day.delete': {
      const t = findTrip(p.tripId); if (!t) return { ok: false };
      const i = t.days.findIndex(d => d.id === p.dayId); if (i < 0) return { ok: false };
      const [r] = t.days.splice(i, 1); event = `${actor} 删除了 ${r.label}`; break;
    }
    case 'day.setStart': {
      const d = findDay(p.tripId, p.dayId); if (!d) return { ok: false };
      d.startStopId = p.stopId || null; event = `${actor} 设置了 ${d.label} 的起点`; break;
    }
    case 'day.reorder': {
      const d = findDay(p.tripId, p.dayId); if (!d) return { ok: false };
      const map = {}; d.stops.forEach(s => map[s.id] = s);
      d.stops = p.stopIds.map(sid => map[sid]).filter(Boolean);
      event = `${actor} 调整了 ${d.label} 的顺序`; break;
    }
    case 'stop.add': {
      const d = findDay(p.tripId, p.dayId); if (!d) return { ok: false };
      const stop = normalizeStop(p.stop); d.stops.push(stop);
      event = `${actor} 添加了站点 ${stop.name}`; break;
    }
    case 'stop.update': {
      const s = findStop(p.tripId, p.dayId, p.stopId); if (!s) return { ok: false };
      const patch = p.patch || {};
      ['name', 'address', 'lat', 'lng', 'arriveTime', 'leaveTime', 'notes'].forEach(k => { if (k in patch) s[k] = patch[k]; });
      event = `${actor} 更新了 ${s.name}`; break;
    }
    case 'stop.delete': {
      const d = findDay(p.tripId, p.dayId); if (!d) return { ok: false };
      const i = d.stops.findIndex(s => s.id === p.stopId); if (i < 0) return { ok: false };
      const [r] = d.stops.splice(i, 1);
      if (d.startStopId === p.stopId) d.startStopId = null;
      event = `${actor} 删除了站点 ${r.name}`; break;
    }
    case 'stop.setTransport': {
      const s = findStop(p.tripId, p.dayId, p.stopId); if (!s) return { ok: false };
      s.transportFromPrev = p.mode || null; if (p.note !== undefined) s.transportNote = p.note;
      event = `${actor} 设置 ${s.name} 交通为 ${modeLabel(p.mode)}`; break;
    }
    case 'image.add': {
      const t = targetOf(p); if (!t) return { ok: false };
      t.images = t.images || [];
      t.images.push({ id: id(), type: p.image.type, value: p.image.value, name: p.image.name || '' });
      event = `${actor} 添加了一张图片`; break;
    }
    case 'image.remove': {
      const t = targetOf(p); if (!t) return { ok: false };
      t.images = (t.images || []).filter(im => im.id !== p.imageId);
      event = `${actor} 删除了一张图片`; break;
    }
    case 'xhs.add': {
      const t = targetOf(p); if (!t) return { ok: false };
      t.xhs = t.xhs || [];
      t.xhs.push({ id: id(), url: p.xhs.url, title: p.xhs.title || '' });
      event = `${actor} 添加了小红书链接`; break;
    }
    case 'xhs.remove': {
      const t = targetOf(p); if (!t) return { ok: false };
      t.xhs = (t.xhs || []).filter(x => x.id !== p.xhsId);
      event = `${actor} 删除了小红书链接`; break;
    }
    case 'comment.add': {
      const t = targetOf(p); if (!t) return { ok: false };
      t.comments = t.comments || [];
      t.comments.push({ id: id(), author: actor, text: (p.text || '').toString().slice(0, 2000), ts: Date.now() });
      event = ''; break;
    }
    case 'comment.remove': {
      const t = targetOf(p); if (!t) return { ok: false };
      t.comments = (t.comments || []).filter(c => c.id !== p.commentId);
      event = ''; break;
    }
    case 'optimize': {
      const d = findDay(p.tripId, p.dayId); if (!d) return { ok: false };
      optimizeDay(d, p.metric || 'time');
      event = `${actor} 用「${p.metric === 'distance' ? '最短距离' : '最短时间'}」重排了 ${d.label}`; break;
    }
    case 'replace': {
      if (!Array.isArray(p.trips)) return { ok: false };
      state.trips = p.trips; saveState();
      event = `${actor} 导入了行程数据`; break;
    }
    default: return { ok: false };
  }
  saveState();
  return { ok: true, event };
}

/* ----------------------------- HTTP / API ----------------------------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

async function geocode(q) {
  if (!q) return { results: [] };
  if (AMAP_KEY) {
    const u = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(q)}&key=${AMAP_KEY}`;
    const r = await fetch(u); const j = await r.json();
    if (j.status === '1' && j.geocodes && j.geocodes.length) {
      const g = j.geocodes[0]; const [lng, lat] = g.location.split(',').map(Number);
      return { results: [{ lng, lat, formatted: g.formatted_address }] };
    }
    return { results: [] };
  }
  const u = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`;
  const r = await fetch(u, { headers: { 'User-Agent': 'travel-planner/1.0' } });
  const j = await r.json();
  const feats = (j && j.features) || [];
  return {
    results: feats.map(f => {
      const c = f.geometry.coordinates;
      const p = f.properties || {};
      const parts = [p.name, p.district, p.city, p.state, p.country].filter(Boolean);
      return { lng: Number(c[0]), lat: Number(c[1]), formatted: parts.join(', ') };
    })
  };
}

function decodeAMAP(str) {
  const coords = []; let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    let result = 1, shift = 0, b;
    do { b = str.charCodeAt(index++) - 63 - 1; result += b << shift; shift += 5; } while (b >= 0x1f);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 1; shift = 0;
    do { b = str.charCodeAt(index++) - 63 - 1; result += b << shift; shift += 5; } while (b >= 0x1f);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

async function route(from, to, mode) {
  if (!from || !to || from.lat == null || to.lat == null) throw new Error('invalid coords');
  if (AMAP_KEY && (mode === 'driving' || mode === 'walking' || mode === 'transit')) {
    const am = mode === 'walking' ? 'walking' : mode === 'transit' ? 'transit' : 'driving';
    const u = `https://restapi.amap.com/v3/direction/${am}?origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&key=${AMAP_KEY}`;
    const r = await fetch(u); const j = await r.json();
    if (j.status === '1' && j.route && j.route.paths && j.route.paths[0]) {
      const path = j.route.paths[0];
      let coords = [];
      path.steps.forEach(s => { if (s.polyline) coords = coords.concat(decodeAMAP(s.polyline)); });
      return { mode, coords, distanceMeters: Number(path.distance), durationSec: Number(path.duration) };
    }
    throw new Error(j.info || 'amap route failed');
  }
  // OSRM dev fallback (road geometry) for driving/walking; transit -> driving
  const profile = mode === 'walking' ? 'walking' : 'driving';
  const u = `https://router.project-osrm.org/route/v1/${profile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  try {
    const r = await fetch(u); const j = await r.json();
    if (j.code === 'Ok' && j.routes && j.routes[0]) {
      const coords = j.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
      return { mode, coords, distanceMeters: j.routes[0].distance, durationSec: j.routes[0].duration };
    }
  } catch (e) { /* fall through to straight line */ }
  return { mode, coords: [[from.lat, from.lng], [to.lat, to.lng]], distanceMeters: haversine(from, to) * 1000, durationSec: null };
}

function apiHandler(req, res, u) {
  const p = u.pathname;
  if (p === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, amap: !!AMAP_KEY })); }
  if (p === '/api/geocode' && req.method === 'POST') {
    return readBody(req).then(async body => {
      try { const r = await geocode(body.q || ''); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); }
      catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e) })); }
    });
  }
  if (p === '/api/route' && req.method === 'POST') {
    return readBody(req).then(async body => {
      try { const r = await route(body.from, body.to, body.mode || 'driving'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); }
      catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e) })); }
    });
  }
  res.writeHead(404); res.end('not found');
}

function requestHandler(req, res) {
  const u = url.parse(req.url, true);
  if (u.pathname.startsWith('/api/')) return apiHandler(req, res, u);
  let fp = u.pathname === '/' ? '/index.html' : u.pathname;
  fp = path.join(PUBLIC_DIR, path.normalize(fp));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ----------------------------- WebSocket ----------------------------- */
const server = http.createServer(requestHandler);
const wss = new WebSocketServer({ server });
const clients = new Map();
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#9b59b6', '#f39c12', '#1abc9c', '#e67e22', '#34495e'];
let colorIdx = 0;

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data);
}
function presenceList() {
  return [...clients.values()].map(m => ({ id: m.id, name: m.name, color: m.color }));
}
function broadcastPresence() { broadcast({ type: 'presence', users: presenceList() }); }

wss.on('connection', (ws) => {
  const meta = { id: id(), name: '旅伴', color: COLORS[colorIdx++ % COLORS.length] };
  clients.set(ws, meta);
  ws.isAlive = true;
  ws.send(JSON.stringify({ type: 'welcome', id: meta.id, state }));
  broadcastPresence();
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello') {
      if (msg.name) meta.name = msg.name.toString().slice(0, 20);
      if (msg.color) meta.color = msg.color;
      broadcastPresence();
      ws.send(JSON.stringify({ type: 'presence', users: presenceList() }));
      return;
    }
    if (msg.type === 'mutate') {
      const r = applyMutation(msg);
      if (r.ok) {
        broadcast({ type: 'state', trips: state.trips });
        if (r.event) broadcast({ type: 'event', text: r.event, actor: msg.actor || '某人', ts: Date.now() });
      }
    }
  });
  ws.on('close', () => { clients.delete(ws); broadcastPresence(); });
  ws.on('pong', () => { ws.isAlive = true; });
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Travel Planner running at http://localhost:${PORT}  (amap key: ${AMAP_KEY ? 'yes' : 'no - using dev fallback'})`);
});
