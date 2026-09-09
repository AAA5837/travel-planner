const { AMAP_KEY, USE_UPSTASH } = require('./_lib');

module.exports = async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, amap: !!AMAP_KEY, storage: USE_UPSTASH ? 'upstash' : 'local' }));
};
