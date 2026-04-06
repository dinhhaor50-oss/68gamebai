const express = require('express');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3000;
const GAME_WS_URL = 'wss://xyambju0tz.cq.qnwxdhwica.com';
const TOKEN = process.env.GAME_TOKEN || 'c89a6fd48bc0488cbfe9fc4479de7f9ea685c3c0cac04984a74dfd2620cb529c';
const PROXY_URL = process.env.PROXY_URL || ''; // http://user:pass@ip:port

let sessions = [];
let currentSession = null;
let wsClient = null;
let reconnectTimer = null;

// ===== PACKETS =====
function buildHandshake() {
  const body = JSON.stringify({ sys: { platform: 'js-websocket', clientBuildNumber: '0.0.1', clientVersion: '0a21481d746f92f8428e1b6deeb76fea' } });
  const buf = Buffer.alloc(4 + body.length);
  buf[0] = 0x01; buf[1] = 0x00; buf[2] = 0x00; buf[3] = body.length;
  Buffer.from(body).copy(buf, 4);
  return buf;
}
function buildHeartbeat() { return Buffer.from([0x02, 0x00, 0x00, 0x00]); }
function buildLogin(token) {
  const t = Buffer.from(token, 'ascii');
  return Buffer.concat([Buffer.from([0x04,0x00,0x00,0x4d,0x01,0x01,0x00,0x01,0x08,0x02,0x10,0xca,0x01,0x1a,0x40]), t, Buffer.from([0x42,0x00])]);
}
function buildGetGameList() { return Buffer.from('0400001c0002196c6f6262792e6163636f756e742e67657467616d656c697374','hex'); }

// ===== DECODE =====
function decodeVarint(buf, offset) {
  let val = 0, shift = 0;
  while (offset < buf.length) {
    const b = buf[offset++]; val |= (b & 0x7f) << shift; shift += 7;
    if (!(b & 0x80)) break;
  }
  return { val, offset };
}

function processMessage(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const text = buf.toString('utf8');
  if (text.includes('mnmdsbgamestart')) {
    const hashMatch = text.match(/[0-9a-f]{32}/);
    const mi = text.indexOf('mnmdsbgamestart');
    const after = buf.slice(mi + 'mnmdsbgamestart'.length);
    let session = null;
    if (after[0] === 0x08) { const r = decodeVarint(after, 1); session = Math.round(r.val / 2); }
    currentSession = { session, hash: hashMatch ? hashMatch[0] : null };
    console.log(`🎲 Phiên #${session}`);
    return;
  }
  if (text.includes('mnmdsbgameend')) {
    const m = text.match(/\{(\d+)-(\d+)-(\d+)\}/);
    if (!m) return;
    const d1=+m[1], d2=+m[2], d3=+m[3], total=d1+d2+d3;
    const s = currentSession || {};
    const record = { Phien: s.session, Hash: s.hash, Xuc_xac_1:d1, Xuc_xac_2:d2, Xuc_xac_3:d3, Tong:total, Ket_qua: total>=11?'Tài':'Xỉu', time: new Date().toISOString() };
    if (!sessions.find(x => x.Phien === record.Phien)) {
      sessions.unshift(record);
      if (sessions.length > 500) sessions = sessions.slice(0, 500);
      console.log(`✅ #${s.session} | ${d1}-${d2}-${d3} = ${total} → ${record.Ket_qua}`);
    }
    currentSession = null;
  }
}

// ===== WS =====
function connectWS() {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) return;
  console.log(`🔌 Connecting... ${PROXY_URL ? '(via proxy)' : '(direct)'}`);

  const wsOptions = {
    headers: { 'Origin': 'https://68gbvn88.bar', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
    rejectUnauthorized: false
  };
  if (PROXY_URL) wsOptions.agent = new HttpsProxyAgent(PROXY_URL);

  wsClient = new WebSocket(GAME_WS_URL, wsOptions);
  let hbInterval = null;

  wsClient.on('open', () => {
    console.log('✅ Connected! Logging in...');
    wsClient.send(buildHandshake());
    setTimeout(() => wsClient.send(buildHeartbeat()), 500);
    setTimeout(() => wsClient.send(buildLogin(TOKEN)), 1000);
    setTimeout(() => wsClient.send(buildGetGameList()), 2000);
    hbInterval = setInterval(() => { if (wsClient.readyState === WebSocket.OPEN) wsClient.send(buildHeartbeat()); }, 25000);
  });

  wsClient.on('message', (data) => { try { processMessage(data); } catch(e) {} });

  wsClient.on('close', (code) => {
    console.log(`🔴 Closed: ${code} - retry in 5s`);
    if (hbInterval) clearInterval(hbInterval);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, 5000);
  });

  wsClient.on('error', (e) => console.error('⚠️', e.message));
}

// ===== API =====
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/api/lichsu', (req, res) => res.json(sessions.slice(0, parseInt(req.query.limit)||200)));
app.get('/api/status', (req, res) => res.json({
  ws: wsClient ? ['CONNECTING','OPEN','CLOSING','CLOSED'][wsClient.readyState] : 'NULL',
  proxy: PROXY_URL ? 'YES' : 'NO',
  sessions: sessions.length, latest: sessions[0]||null, uptime: Math.floor(process.uptime())+'s'
}));
app.get('/', (req, res) => res.send(`<h2>🎲 TX Collector</h2><p>WS: ${wsClient?['CONNECTING','OPEN','CLOSING','CLOSED'][wsClient.readyState]:'NULL'} | Sessions: ${sessions.length}</p><a href="/api/lichsu">/api/lichsu</a>`));

app.listen(PORT, () => { console.log(`🚀 Port ${PORT}`); connectWS(); });
