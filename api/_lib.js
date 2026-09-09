'use strict';
/* Shared logic for Vercel serverless functions.
 * - Pure stateless helpers: coordinate transform, amap decode, geocode, route, mutations.
 * - Storage layer: Upstash Redis (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) with
 *   a local-file fallback (data/*.json) when those env vars are absent (local dev / no config). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AMAP_KEY = process.env.AMAP_KEY || '';

/* ----------------------------- storage layer ----------------------------- */
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PRESENCE_FILE = path.join(DATA_DIR, 'presence.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const DB_KEY = 'travel-planner:db';
const PRES_KEY = 'travel-planner:presence';
const EV_KEY = 'travel-planner:events';
const PRESENCE_TTL = 20000; // ms — a user counts as online if seen within this window

let Redis = null;
try { Redis = require('@upstash/redis').Redis; } catch (e) { /* missing dep -> file mode */ }
const USE_UPSTASH = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN && Redis);
let redis = null;
if (USE_UPSTASH) {
  redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}

function loadJsonFile(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; } }
function saveJsonFile(p, o) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); } catch (e) { /* ignore */ } }

async function loadDB() {
  if (USE_UPSTASH) { const raw = await redis.get(DB_KEY); if (raw != null) return raw; return seedState(); }
  return loadJsonFile(DB_FILE, seedState());
}
async function saveDB(state) {
  if (USE_UPSTASH) { await redis.set(DB_KEY, state); return; }
  saveJsonFile(DB_FILE, state);
}
async function touchPresence(me) {
  if (!me || !me.id) return [];
  const now = Date.now();
  let pres = USE_UPSTASH ? (await redis.get(PRES_KEY) || {}) : loadJsonFile(PRESENCE_FILE, {});
  pres[me.id] = { id: me.id, name: me.name || '旅伴', color: me.color || '#888', lastSeen: now };
  const cutoff = now - PRESENCE_TTL;
  const cleaned = {}; const online = [];
  for (const k in pres) { if (pres[k].lastSeen >= cutoff) { cleaned[k] = pres[k]; online.push(pres[k]); } }
  if (USE_UPSTASH) await redis.set(PRES_KEY, cleaned); else saveJsonFile(PRESENCE_FILE, cleaned);
  return online;
}
async function loadEvents(since) {
  let evs = USE_UPSTASH ? (await redis.get(EV_KEY) || []) : loadJsonFile(EVENTS_FILE, []);
  if (since) evs = evs.filter(e => e.ts > since);
  return evs;
}
async function pushEvent(ev) {
  const e = { id: Date.now() + '-' + Math.floor(Math.random() * 1000), ts: Date.now(), text: ev.text, actor: ev.actor };
  let evs = USE_UPSTASH ? (await redis.get(EV_KEY) || []) : loadJsonFile(EVENTS_FILE, []);
  evs.push(e);
  if (evs.length > 50) evs = evs.slice(-50);
  if (USE_UPSTASH) await redis.set(EV_KEY, evs); else saveJsonFile(EVENTS_FILE, evs);
  return e;
}

/* ----------------------------- data model ----------------------------- */
function id() { return crypto.randomBytes(6).toString('hex'); }
function seedTrip() {
  return { id: id(), name: '示例旅行', createdAt: Date.now(), days: [{ id: id(), label: 'Day 1', date: null, startStopId: null, stops: [], images: [], xhs: [], comments: [] }] };
}
function seedState() { return { trips: [seedTrip()] }; }

/* ----------------------------- helpers ----------------------------- */
function haversine(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return 0;
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function modeLabel(m) { return ({ driving: '自驾', rail: '高铁', walking: '步行', transit: '公交', flight: '飞机' })[m] || '未设'; }

/* GCJ-02 (高德火星坐标) -> WGS-84，对齐 OSM 底图，消除偏移 */
function outOfChina(lng, lat) { return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55); }
function transformLatGCJ(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return ret;
}
function transformLngGCJ(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return ret;
}
function gcj2wgs(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  const a = 6378245.0, ee = 0.00669342162296594323;
  let dlat = transformLatGCJ(lng - 105.0, lat - 35.0);
  let dlng = transformLngGCJ(lng - 105.0, lat - 35.0);
  const radlat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radlat);
  magic = 1 - ee * magic * magic;
  const sqrtmagic = Math.sqrt(magic);
  dlat = (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * Math.PI);
  dlng = (dlng * 180.0) / (a / sqrtmagic * Math.cos(radlat) * Math.PI);
  const mglat = lat + dlat, mglng = lng + dlng;
  return [lng * 2 - mglng, lat * 2 - mglat];
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
      const cost = metric === 'distance' ? dist : dist / 80;
      if (cost < bestCost) { bestCost = cost; bestI = i; }
    });
    cur = remaining.splice(bestI, 1)[0];
    ordered.push(cur);
  }
  day.stops = ordered;
}

/* ----------------------------- mutations (stateless) ----------------------------- */
function applyMutation(state, msg) {
  const actor = (msg.actor || '某人').toString().slice(0, 20);
  const a = msg.action;
  const p = msg.payload || {};
  let event = '';
  const findTrip = (tid) => state.trips.find(t => t.id === tid);
  const findDay = (tid, did) => { const t = findTrip(tid); return t ? t.days.find(d => d.id === did) : null; };
  const findStop = (tid, did, sid) => { const d = findDay(tid, did); return d ? d.stops.find(s => s.id === sid) : null; };
  const targetOf = (pp) => pp.stopId ? findStop(pp.tripId, pp.dayId, pp.stopId) : findDay(pp.tripId, pp.dayId);
  switch (a) {
    case 'trip.create': {
      const trip = { id: id(), name: p.name || '未命名旅行', createdAt: Date.now(), days: [] };
      state.trips.push(trip); event = `${actor} 创建了旅行「${trip.name}」`; break;
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
      state.trips = p.trips; event = `${actor} 导入了行程数据`; break;
    }
    default: return { ok: false };
  }
  return { ok: true, event };
}

/* ----------------------------- geocode / route ----------------------------- */
async function geocode(q) {
  if (!q) return { results: [], engine: null };
  if (AMAP_KEY) {
    try {
      const u = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(q)}&key=${AMAP_KEY}`;
      const r = await fetch(u); const j = await r.json();
      if (j.status === '1' && j.geocodes && j.geocodes.length) {
        const g = j.geocodes[0];
        const [glng, glat] = g.location.split(',').map(Number);
        const [lng, lat] = gcj2wgs(glng, glat);
        return { results: [{ lng, lat, formatted: g.formatted_address }], engine: 'amap' };
      }
    } catch (e) { /* fall through to Photon */ }
  }
  try {
    const u = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`;
    const r = await fetch(u, { headers: { 'User-Agent': 'travel-planner/1.0' } });
    const j = await r.json();
    const feats = (j && j.features) || [];
    return {
      engine: 'photon',
      results: feats.map(f => {
        const c = f.geometry.coordinates;
        const p = f.properties || {};
        const parts = [p.name, p.district, p.city, p.state, p.country].filter(Boolean);
        return { lng: Number(c[0]), lat: Number(c[1]), formatted: parts.join(', ') };
      })
    };
  } catch (e) {
    return { results: [], engine: 'photon', error: 'geocode service unreachable' };
  }
}

function decodeAMAP(str) {
  const coords = []; let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    let result = 0, shift = 0, b;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0; shift = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e5, lng / 1e5]); // [lat, lng] in GCJ-02
  }
  return coords;
}

async function route(from, to, mode) {
  if (!from || !to || from.lat == null || to.lat == null) throw new Error('invalid coords');
  if (mode === 'rail' || mode === 'flight') {
    return { mode, coords: [[from.lat, from.lng], [to.lat, to.lng]], distanceMeters: haversine(from, to) * 1000, durationSec: null, straight: true };
  }
  if (AMAP_KEY && (mode === 'driving' || mode === 'walking')) {
    const svc = mode === 'walking' ? 'walking' : 'driving';
    const u = `https://restapi.amap.com/v3/direction/${svc}?origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&key=${AMAP_KEY}&extensions=base`;
    try {
      const r = await fetch(u); const j = await r.json();
      if (j.status === '1' && j.route && j.route.paths && j.route.paths[0]) {
        const path = j.route.paths[0];
        let coords = [];
        (path.steps || []).forEach(s => {
          if (!s.polyline) return;
          decodeAMAP(s.polyline).forEach(p => {
            const [wLng, wLat] = gcj2wgs(p[1], p[0]);
            coords.push([wLat, wLng]);
          });
        });
        if (coords.length < 2) coords = [[from.lat, from.lng], [to.lat, to.lng]];
        return { mode, coords, distanceMeters: Number(path.distance), durationSec: Number(path.duration), engine: 'amap' };
      }
    } catch (e) { /* fall through to OSRM */ }
  }
  const profile = mode === 'walking' ? 'walking' : 'driving';
  const u = `https://router.project-osrm.org/route/v1/${profile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  try {
    const r = await fetch(u); const j = await r.json();
    if (j.code === 'Ok' && j.routes && j.routes[0]) {
      const coords = j.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
      return { mode, coords, distanceMeters: j.routes[0].distance, durationSec: j.routes[0].duration, engine: AMAP_KEY ? 'osrm-fallback' : 'osrm' };
    }
  } catch (e) { /* fall through to straight line */ }
  return { mode, coords: [[from.lat, from.lng], [to.lat, to.lng]], distanceMeters: haversine(from, to) * 1000, durationSec: null, straight: true };
}

/* ----------------------------- http helpers ----------------------------- */
function readJson(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}

module.exports = {
  AMAP_KEY, USE_UPSTASH,
  loadDB, saveDB, touchPresence, loadEvents, pushEvent,
  id, seedState,
  applyMutation, haversine, modeLabel, gcj2wgs, normalizeStop, optimizeDay,
  geocode, decodeAMAP, route, readJson
};
