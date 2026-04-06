const express = require('express');
const https = require('https');
const WebSocket = require('ws');
const app = express();
const PORT = process.env.PORT || 3000;

const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '5848a1b6c31c549ee87fa61fd1b3f3f6';
const NICKNAME = process.env.NICKNAME || 'vuhao212';
const API_BASE = 'https://wtxmd52.tele68.com/v1/txmd5';
const WS_URL = 'wss://wtxmd52.tele68.com/txmd5/?EIO=4&transport=websocket';
const LOGIN_URL = 'https://wlb.tele68.com/v1/lobby/auth/login?cp=R&cl=R&pf=web';

let sessions = [];
let lastId = 0;
let currentBet = null;
let jwtToken = null;
let wsClient = null;
let reconnectTimer = null;

// ===== LOGIN =====
function getJWT() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ nickName: NICKNAME, accessToken: ACCESS_TOKEN });
    const url = new URL(LOGIN_URL);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          if (d.token) { console.log('🔑 JWT refreshed'); resolve(d.token); }
          else reject(new Error('No token: ' + data));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ===== HTTP POLL =====
function fetchSessions() {
  return new Promise((resolve, reject) => {
    https.get(`${API_BASE}/lite-sessions?cp=R&cl=R&pf=web&at=${ACCESS_TOKEN}`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function poll() {
  try {
    const data = await fetchSessions();
    if (!data.list) return;
    let newCount = 0;
    for (const item of data.list) {
      if (item.id <= lastId) continue;
      if (sessions.find(s => s.Phien === item.id)) continue;
      const record = {
        Phien: item.id, Hash: item._id,
        Xuc_xac_1: item.dices[0], Xuc_xac_2: item.dices[1], Xuc_xac_3: item.dices[2],
        Tong: item.point, Ket_qua: item.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu',
        time: new Date().toISOString()
      };
      sessions.unshift(record);
      newCount++;
      console.log(`✅ #${record.Phien} | ${record.Xuc_xac_1}-${record.Xuc_xac_2}-${record.Xuc_xac_3} = ${record.Tong} → ${record.Ket_qua}`);
    }
    if (data.list.length > 0) lastId = Math.max(lastId, ...data.list.map(i => i.id));
    if (sessions.length > 500) sessions = sessions.slice(0, 500);
  } catch(e) { console.error('❌ Poll:', e.message); }
}

// ===== WS =====
async function connectWS() {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) return;
  try {
    if (!jwtToken) jwtToken = await getJWT();
  } catch(e) {
    console.error('❌ Login failed:', e.message);
    setTimeout(connectWS, 10000);
    return;
  }

  console.log('🔌 Connecting WS...');
  wsClient = new WebSocket(WS_URL, {
    headers: { 'Origin': 'https://wtxmd52.tele68.com' },
    rejectUnauthorized: false
  });

  let hb = null;

  wsClient.on('open', () => {
    console.log('✅ WS connected!');
    wsClient.send(`40/txmd5,{"token":"${jwtToken}"}`);
    hb = setInterval(() => {
      if (wsClient.readyState === WebSocket.OPEN) wsClient.send('2');
    }, 25000);
  });

  wsClient.on('message', (data) => {
    try {
      const msg = data.toString();
      const match = msg.match(/^42\/txmd5,(\[.+\])$/);
      if (!match) return;
      const [evt, payload] = JSON.parse(match[1]);

      if (evt === 'tick-update' && payload?.data) {
        currentBet = {
          sessionId: payload.id,
          state: payload.state,
          md5: payload.md5,
          tick: payload.tick,
          subTick: payload.subTick,
          timestamp: payload.timestamp,
          taiUsers: payload.data.totalUsersPerType?.TAI || 0,
          xiuUsers: payload.data.totalUsersPerType?.XIU || 0,
          taiAmount: payload.data.totalAmountPerType?.TAI || 0,
          xiuAmount: payload.data.totalAmountPerType?.XIU || 0,
          totalUsers: payload.data.totalUniqueUsers || 0,
          totalAmount: payload.data.totalAmount || 0,
          updatedAt: new Date().toISOString()
        };
      }

      if (evt === 'session-info') {
        currentBet = { ...currentBet, sessionId: payload.id, state: payload.state, md5: payload.md5 };
      }

      if (evt === 'session-result') {
        console.log('🎲 Result:', JSON.stringify(payload));
        setTimeout(poll, 2000);
      }
    } catch(e) {}
  });

  wsClient.on('close', (code) => {
    console.log(`🔴 WS closed: ${code}`);
    if (hb) clearInterval(hb);
    // Nếu token expired, refresh
    if (code === 4001 || code === 4003) jwtToken = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, 5000);
  });

  wsClient.on('error', (e) => console.error('⚠️ WS:', e.message));
}

// ===== API =====
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/lichsu', (req, res) => res.json(sessions.slice(0, parseInt(req.query.limit) || 200)));
app.get('/api/bet', (req, res) => res.json(currentBet || {}));
app.get('/api/status', (req, res) => res.json({
  sessions: sessions.length, lastId,
  ws: wsClient ? ['CONNECTING','OPEN','CLOSING','CLOSED'][wsClient.readyState] : 'NULL',
  hasJWT: !!jwtToken,
  currentBet,
  uptime: Math.floor(process.uptime()) + 's'
}));
app.get('/', (req, res) => res.send(`<h2>🎲 TX</h2><p>Sessions:${sessions.length} WS:${wsClient?['CONNECTING','OPEN','CLOSING','CLOSED'][wsClient.readyState]:'NULL'}</p><a href="/api/lichsu">/api/lichsu</a> | <a href="/api/bet">/api/bet</a>`));

app.listen(PORT, () => {
  console.log(`🚀 Port ${PORT}`);
  poll();
  setInterval(poll, 20000);
  // Refresh JWT mỗi 7 tiếng
  setInterval(async () => { try { jwtToken = await getJWT(); } catch(e) {} }, 7 * 60 * 60 * 1000);
  connectWS();
});
