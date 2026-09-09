const { loadDB, touchPresence, loadEvents } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.writeHead(405); res.end('method not allowed'); return; }
  const u = new URL(req.url, 'http://localhost');
  const me = { id: u.searchParams.get('me'), name: u.searchParams.get('name'), color: u.searchParams.get('color') };
  const since = Number(u.searchParams.get('since') || 0);
  const state = await loadDB();
  const presence = await touchPresence(me);
  const events = await loadEvents(since);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ state: { trips: state.trips }, presence, events }));
};
