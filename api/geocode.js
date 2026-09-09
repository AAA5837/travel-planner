const { geocode, readJson } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end('method not allowed'); return; }
  let body = {}; try { body = await readJson(req); } catch (e) {}
  try {
    const r = await geocode(body.q || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
};
