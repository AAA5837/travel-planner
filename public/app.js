'use strict';
/* ---------------- constants & helpers ---------------- */
const DAY_PALETTE = ['#2f6df6', '#e5484d', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e'];
const MODES = {
  driving: { icon: '🚗', label: '自驾' },
  rail: { icon: '🚄', label: '高铁' },
  walking: { icon: '🚶', label: '步行' },
  transit: { icon: '🚌', label: '公交' },
  flight: { icon: '✈️', label: '飞机' }
};
const ROUTE_COLOR = { driving: '#2f6df6', walking: '#2ecc71', transit: '#9b59b6', rail: '#e6a23c', flight: '#8a93a3' };

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function haversineKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return 0;
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function suggestMode(a, b) {
  const d = haversineKm(a, b);
  if (d < 1) return { mode: 'walking', eta: Math.round(d / 0.08) + ' 分钟', km: d };
  if (d < 5) return { mode: 'walking', eta: Math.round(d / 0.08) + ' 分钟', km: d };
  if (d < 300) return { mode: 'driving', eta: Math.round(d / 80 * 60) + ' 分钟', km: d };
  if (d < 1500) return { mode: 'rail', eta: Math.round(d / 250 * 60) + ' 分钟', km: d };
  return { mode: 'flight', eta: Math.round(d / 700 * 60) + ' 分钟', km: d };
}

/* ---------------- state ---------------- */
let ST = { trips: [] };
let PRESENCE = [];
let UI = { tripId: null, view: 'all', activeDayId: null, expandedDays: {}, expandedStops: {}, pickMode: false, focusStopId: null, scrollStopId: null };

function loadMe() {
  try { const m = JSON.parse(localStorage.getItem('tp_me') || 'null'); if (m && m.name) return m; } catch (e) { }
  const colors = DAY_PALETTE; const c = colors[Math.floor(Math.random() * colors.length)];
  return { id: null, name: '旅伴' + Math.floor(Math.random() * 90 + 10), color: c };
}
let ME = loadMe();
function saveMe() { localStorage.setItem('tp_me', JSON.stringify(ME)); }

/* ---------------- websocket ---------------- */
let WS;
function mutate(action, payload) { if (WS && WS.readyState === 1) WS.send(JSON.stringify({ type: 'mutate', action, payload, actor: ME.name })); }
function connect() {
  WS = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  WS.onopen = () => WS.send(JSON.stringify({ type: 'hello', name: ME.name, color: ME.color }));
  WS.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'welcome') { ST = { trips: m.state.trips }; ensureTrip(); render(); }
    else if (m.type === 'state') { ST = { trips: m.trips }; ensureTrip(); render(); }
    else if (m.type === 'presence') { PRESENCE = m.users || []; renderPresence(); }
    else if (m.type === 'event') { toast(m.text); }
  };
  WS.onclose = () => { toast('连接已断开，正在重连…'); setTimeout(connect, 2000); };
}
connect();

/* ---------------- selectors ---------------- */
function trip() { return ST.trips.find(t => t.id === UI.tripId); }
function day(did) { const t = trip(); return t && t.days.find(d => d.id === did); }
function stop(did, sid) { const d = day(did); return d && d.stops.find(s => s.id === sid); }
function dayColor(did) { const t = trip(); if (!t) return DAY_PALETTE[0]; const i = t.days.findIndex(d => d.id === did); return DAY_PALETTE[i % DAY_PALETTE.length]; }
function ensureTrip() {
  if (!ST.trips.length) { UI.tripId = null; UI.view = 'all'; UI.activeDayId = null; return; }
  if (!UI.tripId || !trip()) UI.tripId = ST.trips[0].id;
  const t = trip();
  if (UI.view !== 'all' && !day(UI.view)) UI.view = 'all';
  if (!UI.activeDayId || !day(UI.activeDayId)) UI.activeDayId = t.days[0] ? t.days[0].id : null;
}

/* ---------------- render ---------------- */
function render() {
  renderTopbar();
  renderPanel();
  renderViewSeg();
  renderAddDaySelect();
  renderPresence();
  renderMap();
  if (UI.focusStopId) {
    const el = document.querySelector(`[data-focus="${UI.focusStopId}"]`);
    if (el) el.focus();
    UI.focusStopId = null;
  }
  if (UI.scrollStopId) {
    const el = document.getElementById('stop-' + UI.scrollStopId);
    if (el) el.scrollIntoView({ block: 'center' });
    UI.scrollStopId = null;
  }
}

function renderTopbar() {
  const sel = document.getElementById('tripSelect');
  sel.innerHTML = ST.trips.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  sel.value = UI.tripId || '';
  document.getElementById('meName').textContent = ME.name;
  document.getElementById('meDot').style.background = ME.color;
}

function renderPresence() {
  const box = document.getElementById('presence');
  box.innerHTML = PRESENCE.map(u => {
    const ini = (u.name || '?').slice(0, 1);
    return `<div class="av" style="background:${u.color}" title="${esc(u.name)}${u.id === ME.id ? '（我）' : ''}">${esc(ini)}</div>`;
  }).join('');
}

function renderViewSeg() {
  const t = trip(); const seg = document.getElementById('viewSeg');
  if (!t) { seg.innerHTML = ''; return; }
  let html = `<button data-view="all" class="${UI.view === 'all' ? 'on' : ''}">全程</button>`;
  t.days.forEach(d => { html += `<button data-view="${d.id}" class="${UI.view === d.id ? 'on' : ''}">${esc(d.label)}</button>`; });
  seg.innerHTML = html;
}

function renderAddDaySelect() {
  const t = trip(); const sel = document.getElementById('addDaySelect');
  if (!t) { sel.innerHTML = ''; return; }
  sel.innerHTML = t.days.map(d => `<option value="${d.id}">添加到：${esc(d.label)}</option>`).join('');
  sel.value = UI.activeDayId || (t.days[0] && t.days[0].id) || '';
}

function renderPanel() {
  const panel = document.getElementById('panel');
  if (!ST.trips.length) { panel.innerHTML = `<div class="empty">还没有旅行。<br>点右上角「+ 旅行」开始规划吧。</div>`; return; }
  const t = trip();
  if (!t) { panel.innerHTML = `<div class="empty">请选择或新建一个旅行。</div>`; return; }
  let html = `<div class="trip-head"><input data-field="name" data-trip="1" value="${esc(t.name)}" /></div>`;
  t.days.forEach(d => { html += renderDay(d); });
  panel.innerHTML = html;
}

function renderDay(d) {
  const color = dayColor(d.id);
  const exp = UI.expandedDays[d.id];
  let h = `<div class="day" style="border-left:4px solid ${color}">`;
  h += `<div class="day-head">
      <div class="dlabel"><input data-field="label" data-day="${d.id}" value="${esc(d.label)}" /></div>
      <input type="date" class="ddate" data-field="date" data-day="${d.id}" value="${esc(d.date || '')}" />
      <button class="icon-btn" data-act="delDay" data-day="${d.id}" title="删除这天">🗑</button>
    </div>`;
  h += `<div class="day-tools">
      <span class="chip" data-act="sortTime" data-day="${d.id}">⚡ 最短时间排序</span>
      <span class="chip" data-act="sortDist" data-day="${d.id}">📏 最短距离排序</span>
      <span class="chip" data-act="toggleDay" data-day="${d.id}">${exp ? '收起' : '展开/详情'}</span>
    </div>`;
  // stops
  d.stops.forEach((s, i) => { if (i > 0) h += renderLeg(d, d.stops[i - 1], s); h += renderStop(d, s, i); });
  if (d.stops.length === 0) h += `<div style="padding:8px 12px;color:var(--muted);font-size:12px">还没有站点，用上方搜索或地图选点添加。</div>`;
  // day-level 灵感/相册
  if (exp) {
    h += `<div class="detail" style="margin:0 12px 12px">
      <label>📔 当日灵感 / 相册（整天的图与小红书）</label>
      ${renderMedia(d, null, d.id)}
      <label>💬 当天讨论</label>
      ${renderComments(d, null, d.id)}
    </div>`;
  }
  h += `</div>`;
  return h;
}

function renderLeg(d, a, b) {
  const sug = suggestMode(a, b);
  const mode = b.transportFromPrev || 'driving';
  const m = MODES[mode] || MODES.driving;
  const opts = Object.keys(MODES).map(k => `<option value="${k}" ${k === mode ? 'selected' : ''}>${MODES[k].icon} ${MODES[k].label}</option>`).join('');
  let html = `<div class="leg">
      <select class="mode-btn" data-act="setTransport" data-stop="${b.id}" data-day="${d.id}">${opts}</select>`;
  if (mode === 'rail' || mode === 'flight') {
    html += `<input class="leg-note" data-field="transportNote" data-stop="${b.id}" data-day="${d.id}" placeholder="车次/航班/备注" value="${esc(b.transportNote || '')}" style="width:130px;font-size:12px;border:1px solid var(--line);border-radius:6px;padding:3px 6px" />`;
  } else {
    html += `<span class="leg-meta">约 ${sug.km.toFixed(1)} km</span>`;
    if (!b.transportFromPrev) html += `<span class="suggest" data-act="applySuggest" data-stop="${b.id}" data-day="${d.id}">建议 ${MODES[sug.mode].icon}${MODES[sug.mode].label}(${sug.eta})</span>`;
  }
  html += `</div>`;
  return html;
}

function renderStop(d, s, i) {
  const exp = UI.expandedStops[s.id];
  const num = i + 1;
  let h = `<div class="stop" id="stop-${s.id}"><div class="num">${num}</div>`;
  h += `<div class="sname"><input data-field="name" data-stop="${s.id}" data-day="${d.id}" data-focus="${s.id}" value="${esc(s.name)}" /></div>`;
  h += `<div class="saddr"><input data-field="address" data-stop="${s.id}" data-day="${d.id}" placeholder="地址/备注" value="${esc(s.address || '')}" /></div>`;
  h += `<div class="stime">🕒<input type="time" data-field="arriveTime" data-stop="${s.id}" data-day="${d.id}" value="${esc(s.arriveTime || '')}" />→<input type="time" data-field="leaveTime" data-stop="${s.id}" data-day="${d.id}" value="${esc(s.leaveTime || '')}" /></div>`;
  h += `<div class="row-actions">
      <button class="icon-btn" data-act="toggleStop" data-stop="${s.id}" data-day="${d.id}">${exp ? '▲ 收起' : '▼ 详情'}</button>
      <button class="icon-btn" data-act="setStart" data-stop="${s.id}" data-day="${d.id}" title="设为当天起点">⚑ 起点</button>
      <button class="icon-btn" data-act="moveUp" data-stop="${s.id}" data-day="${d.id}">↑</button>
      <button class="icon-btn" data-act="moveDown" data-stop="${s.id}" data-day="${d.id}">↓</button>
      <button class="icon-btn" data-act="delStop" data-stop="${s.id}" data-day="${d.id}">🗑</button>
    </div>`;
  if (exp) {
    h += `<div class="detail">
        <label>📝 备注</label>
        <textarea data-field="notes" data-stop="${s.id}" data-day="${d.id}" placeholder="这里玩什么、吃什么、注意事项…">${esc(s.notes || '')}</textarea>
        <label>🖼 图片（网址或上传）</label>
        ${renderMedia(s, s.id, d.id)}
        <label>🔗 小红书链接</label>
        ${renderXhs(s, s.id, d.id)}
        <label>💬 讨论</label>
        ${renderComments(s, s.id, d.id)}
      </div>`;
  }
  h += `</div>`;
  return h;
}

function renderMedia(obj, stopId, dayId) {
  const imgs = obj.images || [];
  let h = `<div class="thumbs">`;
  imgs.forEach(im => {
    h += `<div class="thumb"><img src="${esc(im.value)}" alt="${esc(im.name || '')}" /><button class="x" data-act="delImg" data-img="${im.id}" ${stopId ? `data-stop="${stopId}"` : ''} data-day="${dayId}">×</button></div>`;
  });
  h += `</div>`;
  const scope = stopId ? `data-stop="${stopId}"` : '';
  h += `<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
      <input class="inp" placeholder="图片网址 https://…" id="imgurl-${stopId || dayId}" style="flex:1 1 140px" />
      <button class="btn-mini" data-act="addImgUrl" ${scope} data-day="${dayId}">加网址图</button>
      <label class="btn-mini" style="cursor:pointer">上传<input type="file" accept="image/*" data-act="addImgFile" ${scope} data-day="${dayId}" style="display:none" /></label>
    </div>`;
  return h;
}

function renderXhs(obj, stopId, dayId) {
  const list = obj.xhs || [];
  let h = `<div class="linklist">`;
  list.forEach(x => { h += `<div class="li">🔗<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || x.url)}</a><button class="x" data-act="delXhs" data-xhs="${x.id}" ${stopId ? `data-stop="${stopId}"` : ''} data-day="${dayId}">×</button></div>`; });
  h += `</div>`;
  const scope = stopId ? `data-stop="${stopId}"` : '';
  h += `<div style="display:flex;gap:6px;margin-top:4px"><input class="inp" placeholder="小红书链接 https://xhslink.com/…" id="xhsurl-${stopId || dayId}" style="flex:1 1 140px" /><button class="btn-mini" data-act="addXhs" ${scope} data-day="${dayId}">加链接</button></div>`;
  return h;
}

function renderComments(obj, stopId, dayId) {
  const cs = obj.comments || [];
  let h = `<div class="comments">`;
  cs.forEach(c => { h += `<div class="c"><b>${esc(c.author)}</b>${esc(c.text)}<button class="x" data-act="delComment" data-comment="${c.id}" ${stopId ? `data-stop="${stopId}"` : ''} data-day="${dayId}">×</button></div>`; });
  h += `</div>`;
  const scope = stopId ? `data-stop="${stopId}"` : '';
  h += `<div class="comment-add"><input class="inp" placeholder="说点什么…" id="cmt-${stopId || dayId}" /><button class="btn-mini" data-act="addComment" ${scope} data-day="${dayId}">发送</button></div>`;
  return h;
}

/* ---------------- map ---------------- */
let map, mapLayers;
function initMap() {
  map = L.map('map', { zoomControl: true }).setView([35.0, 105.0], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  mapLayers = L.layerGroup().addTo(map);
  map.on('click', e => {
    if (!UI.pickMode) return;
    const d = day(UI.activeDayId); if (!d) { toast('请先选择要添加到的那天'); return; }
    mutate('stop.add', { tripId: UI.tripId, dayId: d.id, stop: { name: '新地点', lat: e.latlng.lat, lng: e.latlng.lng } });
    toast('已添加新地点，记得改名');
  });
}

function makeIcon(color, num) {
  return L.divIcon({ className: '', html: `<div class="num-marker" style="background:${color}"><span>${num}</span></div>`, iconSize: [24, 24], iconAnchor: [12, 24] });
}
function labelIcon(text) {
  return L.divIcon({ className: '', html: `<div style="background:#fff;border:1px solid #e6a23c;border-radius:10px;padding:1px 6px;font-size:11px;white-space:nowrap;color:#b07d2b;">${esc(text)}</div>`, iconSize: [80, 18], iconAnchor: [40, 9] });
}

const routeCache = {};
function fetchRoute(a, b, mode) {
  const key = `${a.lat},${a.lng}|${b.lat},${b.lng}|${mode}`;
  if (routeCache[key]) return Promise.resolve(routeCache[key]);
  return fetch('/api/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: { lat: a.lat, lng: a.lng }, to: { lat: b.lat, lng: b.lng }, mode }) })
    .then(r => r.json())
    .then(r => { routeCache[key] = r; return r; })
    .catch(() => ({ mode, coords: [[a.lat, a.lng], [b.lat, b.lng]] }));
}

function renderMap() {
  if (!map) return;
  mapLayers.clearLayers();
  const t = trip(); if (!t) return;
  let stops = [];
  if (UI.view === 'all') t.days.forEach(d => d.stops.forEach((s, i) => stops.push({ s, d })));
  else { const d = day(UI.view); if (d) d.stops.forEach((s) => stops.push({ s, d })); }
  const pts = [];
  stops.forEach((it, k) => {
    const s = it.s; if (s.lat == null || s.lng == null) return;
    pts.push([s.lat, s.lng]);
    const m = L.marker([s.lat, s.lng], { icon: makeIcon(dayColor(it.d.id), k + 1) }).addTo(mapLayers);
    m.bindPopup(`<b>${esc(s.name)}</b><br>${esc(s.address || '')}`);
    m.on('click', () => { UI.expandedStops[s.id] = true; UI.scrollStopId = s.id; renderPanel(); });
  });
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1].s, b = stops[i].s;
    if (a.lat == null || b.lat == null) continue;
    const mode = b.transportFromPrev || 'driving';
    if (mode === 'rail' || mode === 'flight') {
      const mid = [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2];
      L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color: ROUTE_COLOR[mode], weight: 3, dashArray: '6,6' }).addTo(mapLayers);
      L.marker(mid, { icon: labelIcon(`${MODES[mode].icon}${MODES[mode].label}${b.transportNote ? ' ' + b.transportNote : ''}`), interactive: false }).addTo(mapLayers);
    } else {
      fetchRoute(a, b, mode).then(r => {
        L.polyline(r.coords, { color: ROUTE_COLOR[mode] || '#2f6df6', weight: 4, opacity: .85 }).addTo(mapLayers);
      });
    }
  }
  if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
}

/* ---------------- events ---------------- */
const panel = document.getElementById('panel');
panel.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, did = el.dataset.day, sid = el.dataset.stop;
  switch (act) {
    case 'toggleDay': UI.expandedDays[did] = !UI.expandedDays[did]; renderPanel(); break;
    case 'toggleStop': UI.expandedStops[sid] = !UI.expandedStops[sid]; renderPanel(); break;
    case 'delDay': if (confirm('确定删除这一天及其所有站点？')) mutate('day.delete', { tripId: UI.tripId, dayId: did }); break;
    case 'delStop': if (confirm('确定删除该站点？')) mutate('stop.delete', { tripId: UI.tripId, dayId: did, stopId: sid }); break;
    case 'setStart': { const d = day(did); mutate('day.setStart', { tripId: UI.tripId, dayId: did, stopId: (d.startStopId === sid ? null : sid) }); break; }
    case 'sortTime': mutate('optimize', { tripId: UI.tripId, dayId: did, metric: 'time' }); break;
    case 'sortDist': mutate('optimize', { tripId: UI.tripId, dayId: did, metric: 'distance' }); break;
    case 'applySuggest': { const d = day(did), a = d.stops.find((_, i) => d.stops[i].id === sid) && d.stops[d.stops.findIndex(x => x.id === sid) - 1]; const b = stop(did, sid); const sug = suggestMode(a, b); mutate('stop.setTransport', { tripId: UI.tripId, dayId: did, stopId: sid, mode: sug.mode }); break; }
    case 'moveUp':
    case 'moveDown': {
      const d = day(did); const ids = d.stops.map(s => s.id); const idx = ids.indexOf(sid);
      const j = act === 'moveUp' ? idx - 1 : idx + 1; if (j < 0 || j >= ids.length) break;
      [ids[idx], ids[j]] = [ids[j], ids[idx]]; mutate('day.reorder', { tripId: UI.tripId, dayId: did, stopIds: ids }); break;
    }
    case 'addImgUrl': { const v = (document.getElementById('imgurl-' + (sid || did)) || {}).value; if (v) mutate('image.add', { tripId: UI.tripId, dayId: did, stopId: sid || null, image: { type: 'url', value: v, name: '' } }); break; }
    case 'addXhs': { const v = (document.getElementById('xhsurl-' + (sid || did)) || {}).value; if (v) mutate('xhs.add', { tripId: UI.tripId, dayId: did, stopId: sid || null, xhs: { url: v, title: '' } }); break; }
    case 'delImg': mutate('image.remove', { tripId: UI.tripId, dayId: did, stopId: sid || null, imageId: el.dataset.img }); break;
    case 'delXhs': mutate('xhs.remove', { tripId: UI.tripId, dayId: did, stopId: sid || null, xhsId: el.dataset.xhs }); break;
    case 'addComment': { const v = (document.getElementById('cmt-' + (sid || did)) || {}).value; if (v) mutate('comment.add', { tripId: UI.tripId, dayId: did, stopId: sid || null, text: v }); break; }
    case 'delComment': mutate('comment.remove', { tripId: UI.tripId, dayId: did, stopId: sid || null, commentId: el.dataset.comment }); break;
    case 'addImgFile': {
      const file = el.files && el.files[0]; if (!file) break;
      const reader = new FileReader();
      reader.onload = () => mutate('image.add', { tripId: UI.tripId, dayId: did, stopId: sid || null, image: { type: 'upload', value: reader.result, name: file.name } });
      reader.readAsDataURL(file);
      break;
    }
  }
});
panel.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset && el.dataset.act === 'setTransport') {
    mutate('stop.setTransport', { tripId: UI.tripId, dayId: el.dataset.day, stopId: el.dataset.stop, mode: el.value });
    return;
  }
  if (el.dataset && el.dataset.field) {
    const field = el.dataset.field, did = el.dataset.day, sid = el.dataset.stop, tid = el.dataset.trip;
    const val = el.value;
    if (tid) { mutate('trip.rename', { tripId: UI.tripId, name: val }); return; }
    if (sid) { mutate('stop.update', { tripId: UI.tripId, dayId: did, stopId: sid, patch: { [field]: val } }); return; }
    if (did) { mutate('day.update', { tripId: UI.tripId, dayId: did, patch: { [field]: val } }); return; }
  }
});

/* top bar / controls */
document.getElementById('tripSelect').addEventListener('change', e => { UI.tripId = e.target.value; ensureTrip(); render(); });
document.getElementById('newTrip').addEventListener('click', () => { const name = prompt('旅行名称：', '我的旅行'); if (name) mutate('trip.create', { name }); });
document.getElementById('delTrip').addEventListener('click', () => { if (confirm('确定删除当前整个旅行？')) mutate('trip.delete', { tripId: UI.tripId }); });
document.getElementById('editName').addEventListener('click', () => { const n = prompt('你的昵称（会显示给旅伴）：', ME.name); if (n) { ME.name = n.slice(0, 20); saveMe(); WS.send(JSON.stringify({ type: 'hello', name: ME.name, color: ME.color })); renderPresence(); renderTopbar(); } });
document.getElementById('viewSeg').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (!b) return; UI.view = b.dataset.view; if (UI.view !== 'all') UI.activeDayId = UI.view; render(); });
document.getElementById('addDaySelect').addEventListener('change', e => { UI.activeDayId = e.target.value; });
document.getElementById('pickBtn').addEventListener('click', () => { UI.pickMode = !UI.pickMode; document.getElementById('pickBtn').classList.toggle('active', UI.pickMode); toast(UI.pickMode ? '选点模式：点击地图添加站点' : '已退出选点模式'); });

/* 备份 / 恢复（应对 Render 免费磁盘临时、重部署清空数据） */
document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(ST, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); const t = trip();
  a.href = URL.createObjectURL(blob);
  a.download = (t ? t.name : 'travel') + '-备份-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('已导出备份文件，建议存好');
});
document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.trips)) throw new Error('不是有效的备份文件');
      if (!confirm('导入将覆盖当前所有行程，确定恢复吗？')) { e.target.value = ''; return; }
      mutate('replace', { trips: data.trips });
      toast('正在恢复行程…');
    } catch (err) { toast('恢复失败：' + err.message); }
    e.target.value = '';
  };
  reader.readAsText(f);
});

/* search */
document.getElementById('searchBtn').addEventListener('click', doSearch);
document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
function doSearch() {
  const q = document.getElementById('searchInput').value.trim(); if (!q) return;
  const box = document.getElementById('searchResults');
  box.innerHTML = '<div class="item">搜索中…</div>';
  fetch('/api/geocode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q }) })
    .then(r => r.json()).then(j => {
      const rs = j.results || [];
      if (!rs.length) { box.innerHTML = '<div class="item">没找到，换个关键词试试</div>'; return; }
      box.innerHTML = rs.map((r, i) => `<div class="item" data-i="${i}">${esc(r.formatted)}</div>`).join('');
      box._results = rs;
    }).catch(() => box.innerHTML = '<div class="item">搜索失败（检查网络）</div>');
}
document.getElementById('searchResults').addEventListener('click', e => {
  const it = e.target.closest('.item'); if (!it || !it.dataset.i) return;
  const box = document.getElementById('searchResults');
  const r = box._results[+it.dataset.i]; if (!r) return;
  const did = UI.activeDayId; if (!did) { toast('请先选择要添加到的那天'); return; }
  mutate('stop.add', { tripId: UI.tripId, dayId: did, stop: { name: (r.formatted || '地点').split(',')[0], address: r.formatted, lat: r.lat, lng: r.lng } });
  box.innerHTML = ''; document.getElementById('searchInput').value = '';
});
document.addEventListener('click', e => { if (!e.target.closest('.search-row')) document.getElementById('searchResults').innerHTML = ''; });

/* toast */
function toast(text) {
  const box = document.getElementById('toasts');
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = text;
  box.appendChild(t); setTimeout(() => t.remove(), 2600);
}

/* boot */
initMap();
toast('正在连接协作服务…');
