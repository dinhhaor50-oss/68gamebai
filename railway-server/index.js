const express = require('express');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const GAME_WS_URL = process.env.GAME_WS_URL || 'wss://xyambju0tz.cq.qnwxdhwica.com';

// Lưu RAM - 500 phiên gần nhất
let sessions = [];
let currentSession = null;
let wsClient = null;
let reconnectTimer = null;
let isConnecting = false;

// ===== DECODE HELPERS =====

function decodeVarint(buf, offset) {
  let val = 0, shift = 0;
  while (offset < buf.length) {
    const b = buf[offset++];
    val |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { val, offset };
}

function parseGameEnd(buf) {
  // Find {X-Y-Z} pattern in buffer text
  const text = buf.toString('utf8', 0, buf.length);
  const diceMatch = text.match(/\{(\d+)-(\d+)-(\d+)\}/);
  if (!diceMatch) return null;

  const d1 = parseInt(diceMatch[1]);
  const d2 = parseInt(diceMatch[2]);
  const d3 = parseInt(diceMatch[3]);
  const total = d1 + d2 + d3;
  const result = total >= 11 ? 'Tài' : 'Xỉu';

  return { Xuc_xac_1: d1, Xuc_xac_2: d2, Xuc_xac_3: d3, Tong: total, Ket_qua: result };
}

function parseGameStart(buf) {
  // Find "mnmdsbgamestart" then read session varint + hash
  const marker = Buffer.from('mnmdsbgamestart');
  const idx = buf.indexOf(marker);
  if (idx < 0) return null;

  const after = buf.slice(idx + marker.length);

  // Session: field 1 varint (0x08 + varint bytes), chia 2 để ra số phiên thực
  let session = null;
  if (after[0] === 0x08) {
    const r = decodeVarint(after, 1);
    session = Math.round(r.val / 2);
  }

  // Hash: field 2 length-delimited (0x12 0x20 + 32 bytes ASCII)
  let hash = null;
  const hashMarker = Buffer.from([0x12, 0x20]);
  const hashIdx = after.indexOf(hashMarker);
  if (hashIdx >= 0 && hashIdx + 2 + 32 <= after.length) {
    hash = after.slice(hashIdx + 2, hashIdx + 2 + 32).toString('ascii');
  }

  return { session, hash };
}

function processMessage(data) {
  let buf;
  if (Buffer.isBuffer(data)) {
    buf = data;
  } else if (data instanceof ArrayBuffer) {
    buf = Buffer.from(data);
  } else {
    return;
  }

  const text = buf.toString('utf8', 0, Math.min(buf.length, 200));

  // gamestart → lưu session + hash
  if (text.includes('mnmdsbgamestart')) {
    const info = parseGameStart(buf);
    if (info) {
      currentSession = { Phien: info.session, Hash: info.hash };
      console.log(`🎲 Phiên mới: #${info.session} hash=${info.hash}`);
    }
    return;
  }

  // gameend → lưu kết quả
  if (text.includes('mnmdsbgameend')) {
    const dice = parseGameEnd(buf);
    if (!dice) return;

    const phien = currentSession ? currentSession.Phien : null;
    const hash = currentSession ? currentSession.Hash : null;

    if (!phien) {
      console.log('⚠️ gameend nhưng không có session, bỏ qua');
      return;
    }

    const record = {
      Phien: phien,
      Hash: hash,
      Xuc_xac_1: dice.Xuc_xac_1,
      Xuc_xac_2: dice.Xuc_xac_2,
      Xuc_xac_3: dice.Xuc_xac_3,
      Tong: dice.Tong,
      Ket_qua: dice.Ket_qua,
      time: new Date().toISOString()
    };

    console.log(`✅ Kết quả: Phiên #${phien} | ${dice.Xuc_xac_1}-${dice.Xuc_xac_2}-${dice.Xuc_xac_3} = ${dice.Tong} → ${dice.Ket_qua}`);

    // Thêm vào RAM
    sessions.unshift(record);
    if (sessions.length > 500) sessions = sessions.slice(0, 500);
    console.log(`✅ #${phien} | ${dice.Xuc_xac_1}-${dice.Xuc_xac_2}-${dice.Xuc_xac_3} = ${dice.Tong} → ${dice.Ket_qua}`);
    currentSession = null;
    return;
  }
}

// ===== WEBSOCKET CLIENT =====
function connectWS() {
  if (isConnecting || (wsClient && wsClient.readyState === WebSocket.OPEN)) return;
  isConnecting = true;

  console.log(`🔌 Kết nối WS: ${GAME_WS_URL}`);

  wsClient = new WebSocket(GAME_WS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Origin': 'https://68gbvn88.bar',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    },
    rejectUnauthorized: false,
    perMessageDeflate: true
  });

  wsClient.on('open', () => {
    isConnecting = false;
    console.log('✅ WS connected!');
    clearTimeout(reconnectTimer);
  });

  wsClient.on('message', (data) => {
    try {
      processMessage(data);
    } catch (e) {
      console.error('❌ processMessage error:', e.message);
    }
  });

  wsClient.on('close', (code, reason) => {
    isConnecting = false;
    console.log(`🔴 WS closed: ${code} ${reason}`);
    scheduleReconnect();
  });

  wsClient.on('error', (err) => {
    isConnecting = false;
    console.error('⚠️ WS error:', err.message);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log('🔄 Reconnecting...');
    connectWS();
  }, 5000);
}

// ===== EXPRESS API =====
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// API lấy lịch sử (giống format cũ)
app.get('/api/lichsu', (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  res.json(sessions.slice(0, limit));
});

// API status
app.get('/api/status', (req, res) => {
  res.json({
    ws_status: wsClient ? ['CONNECTING','OPEN','CLOSING','CLOSED'][wsClient.readyState] : 'NOT_STARTED',
    sessions_count: sessions.length,
    latest: sessions[0] || null,
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.send(`
    <h2>🎲 Tài Xỉu Collector</h2>
    <p>WS: ${wsClient ? ['CONNECTING','OPEN','CLOSING','CLOSED'][wsClient.readyState] : 'NOT_STARTED'}</p>
    <p>Sessions: ${sessions.length}</p>
    <p><a href="/api/lichsu">/api/lichsu</a> | <a href="/api/status">/api/status</a></p>
  `);
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  connectWS();
});
