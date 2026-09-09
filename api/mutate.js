const { loadDB, saveDB, applyMutation, touchPresence, pushEvent, readJson } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end('method not allowed'); return; }
  let body = {}; try { body = await readJson(req); } catch (e) {}
  const state = await loadDB();
  const r = applyMutation(state, { action: body.action, payload: body.payload, actor: body.actor });
  if (!r.ok) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false })); return; }
  await saveDB(state);
  let evObj = null;
  if (r.event) evObj = await pushEvent({ text: r.event, actor: body.actor });
  await touchPresence(body.me || {});
  const fresh = await loadDB();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, event: evObj, state: { trips: fresh.trips } }));
};
