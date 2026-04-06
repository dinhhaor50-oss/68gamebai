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

let sessions = [];       // lịch sử kết quả
let predictions = {};    // { sessionId: { result, reasons, taiScore, xiuScore, betSnapshot } }
let currentBet = null;   // tiền cược real-time
let betHistory = [];     // trend tiền cược trong phiên
let jwtToken = null;
let wsClient = null;
let reconnectTimer = null;
let lastSessionId = null;

// ===== FORMAT =====
function fmt(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(0)+'K';
  return String(n);
}

// ===== THUẬT TOÁN DỰ ĐOÁN =====
function predict(bet, hist) {
  let taiScore = 0, xiuScore = 0;
  const reasons = [];

  if (bet && bet.taiAmount > 0) {
    const total = bet.taiAmount + bet.xiuAmount;
    const tR = bet.taiAmount / total;
    const xR = 1 - tR;
    const tU = bet.taiUsers, xU = bet.xiuUsers;
    const totalU = tU + xU;
    const tUR = totalU > 0 ? tU / totalU : 0.5;
    const avgT = tU > 0 ? bet.taiAmount / tU : 0;
    const avgX = xU > 0 ? bet.xiuAmount / xU : 0;

    // Rule 1: Tiền áp đảo
    if (tR > 0.65) { xiuScore += 4; reasons.push(`💰 Tiền Tài áp đảo ${(tR*100).toFixed(0)}%`); }
    else if (xR > 0.65) { taiScore += 4; reasons.push(`💰 Tiền Xỉu áp đảo ${(xR*100).toFixed(0)}%`); }
    else if (tR > 0.55) { xiuScore += 2; reasons.push(`📊 Tiền Tài nhiều hơn (${(tR*100).toFixed(0)}%)`); }
    else if (xR > 0.55) { taiScore += 2; reasons.push(`📊 Tiền Xỉu nhiều hơn (${(xR*100).toFixed(0)}%)`); }

    // Rule 2: Cá mập
    if (avgT > avgX * 2) { xiuScore += 3; reasons.push(`🐋 Cá mập Tài TB ${fmt(avgT)}/người`); }
    else if (avgX > avgT * 2) { taiScore += 3; reasons.push(`🐋 Cá mập Xỉu TB ${fmt(avgX)}/người`); }
    else if (avgT > avgX * 1.4) { xiuScore += 1; reasons.push(`🐟 Tiền/người Tài cao hơn`); }
    else if (avgX > avgT * 1.4) { taiScore += 1; reasons.push(`🐟 Tiền/người Xỉu cao hơn`); }

    // Rule 3: Số người
    if (tUR > 0.60) { xiuScore += 1; reasons.push(`👥 Đám đông chọn Tài (${tU}/${totalU})`); }
    else if (tUR < 0.40) { taiScore += 1; reasons.push(`👥 Đám đông chọn Xỉu (${xU}/${totalU})`); }

    // Rule 4: HÚP/NHẢ detection
    const diff = tR - tUR;
    if (diff > 0.15) { xiuScore += 2; reasons.push(`🏦 HÚP Tài (tiền>người ${(diff*100).toFixed(0)}%)`); }
    else if (diff < -0.15) { taiScore += 2; reasons.push(`🏦 HÚP Xỉu (tiền>người ${(Math.abs(diff)*100).toFixed(0)}%)`); }

    // Rule 5: Momentum cuối phiên
    if (betHistory.length >= 5) {
      const early = betHistory.slice(0, 3);
      const late = betHistory.slice(-3);
      const earlyTR = early.reduce((s,b)=>s+b.tR,0)/early.length;
      const lateTR = late.reduce((s,b)=>s+b.tR,0)/late.length;
      const momentum = lateTR - earlyTR;
      if (momentum > 0.08) { xiuScore += 2; reasons.push(`📈 Tiền Tài tăng mạnh cuối phiên`); }
      else if (momentum < -0.08) { taiScore += 2; reasons.push(`📉 Tiền Xỉu tăng mạnh cuối phiên`); }
    }

    // Rule 6: Phiên lớn
    if (bet.totalAmount > 500e6) {
      if (tR > 0.52) { xiuScore += 1; reasons.push(`💎 Phiên lớn ${fmt(bet.totalAmount)}`); }
      else if (xR > 0.52) { taiScore += 1; reasons.push(`💎 Phiên lớn ${fmt(bet.totalAmount)}`); }
    }
  }

  // Rule 7: Pattern lịch sử
  if (hist.length >= 3) {
    const last = hist[0].Ket_qua;
    let streak = 1;
    for (let i = 1; i < hist.length; i++) {
      if (hist[i].Ket_qua === last) streak++; else break;
    }
    if (streak >= 5) {
      if (last === 'Tài') { xiuScore += 3; reasons.push(`🔄 Cầu Tài x${streak} → Đảo`); }
      else { taiScore += 3; reasons.push(`🔄 Cầu Xỉu x${streak} → Đảo`); }
    } else if (streak >= 3) {
      if (last === 'Tài') { xiuScore += 1; reasons.push(`🔄 Cầu Tài x${streak}`); }
      else { taiScore += 1; reasons.push(`🔄 Cầu Xỉu x${streak}`); }
    }
    if (hist[0].Ket_qua === 'Tài' && hist[0].Tong >= 15) { xiuScore += 2; reasons.push(`📊 Tổng ${hist[0].Tong} cực cao`); }
    else if (hist[0].Ket_qua === 'Xỉu' && hist[0].Tong <= 5) { taiScore += 2; reasons.push(`📊 Tổng ${hist[0].Tong} cực thấp`); }
  }

  const total = taiScore + xiuScore || 1;
  const result = taiScore >= xiuScore ? 'Tài' : 'Xỉu';
  const conf = Math.min(80, 50 + Math.abs(taiScore-xiuScore)/total*35);
  if (reasons.length === 0) reasons.push('⚖️ Không đủ tín hiệu');
  return { result, conf: Math.round(conf), reasons, taiScore, xiuScore };
}

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
        try { const d = JSON.parse(data); if (d.token) resolve(d.token); else reject(new Error('No token')); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
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
      if (sessions.find(s => s.Phien === item.id)) continue;
      const record = {
        Phien: item.id, Hash: item._id,
        Xuc_xac_1: item.dices[0], Xuc_xac_2: item.dices[1], Xuc_xac_3: item.dices[2],
        Tong: item.point, Ket_qua: item.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu',
        time: new Date().toISOString()
      };
      // Gắn kết quả dự đoán nếu có
      if (predictions[item.id]) {
        record.prediction = predictions[item.id].result;
        record.predCorrect = predictions[item.id].result === record.Ket_qua;
        record.predReasons = predictions[item.id].reasons;
        record.betSnapshot = predictions[item.id].betSnapshot;
        console.log(`${record.predCorrect ? '✅' : '❌'} #${record.Phien} | Dự đoán: ${record.prediction} | Thực tế: ${record.Ket_qua}`);
      }
      sessions.unshift(record);
      newCount++;
    }
    if (sessions.length > 1000) sessions = sessions.slice(0, 1000);
  } catch(e) { console.error('❌ Poll:', e.message); }
}

// ===== WS =====
async function connectWS() {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) return;
  try { if (!jwtToken) jwtToken = await getJWT(); }
  catch(e) { console.error('❌ Login:', e.message); setTimeout(connectWS, 10000); return; }

  wsClient = new WebSocket(WS_URL, {
    headers: { 'Origin': 'https://wtxmd52.tele68.com' },
    rejectUnauthorized: false
  });

  let hb = null;
  wsClient.on('open', () => {
    console.log('✅ WS connected!');
    wsClient.send(`40/txmd5,{"token":"${jwtToken}"}`);
    hb = setInterval(() => { if (wsClient.readyState === WebSocket.OPEN) wsClient.send('2'); }, 25000);
  });

  wsClient.on('message', (data) => {
    try {
      const msg = data.toString();
      const match = msg.match(/^42\/txmd5,(\[.+\])$/);
      if (!match) return;
      const [evt, payload] = JSON.parse(match[1]);

      if (evt === 'tick-update' && payload?.data) {
        const d = payload.data;
        const newBet = {
          sessionId: payload.id, state: payload.state,
          tick: payload.tick, subTick: payload.subTick,
          timestamp: payload.timestamp,
          taiUsers: d.totalUsersPerType?.TAI || 0,
          xiuUsers: d.totalUsersPerType?.XIU || 0,
          taiAmount: d.totalAmountPerType?.TAI || 0,
          xiuAmount: d.totalAmountPerType?.XIU || 0,
          totalUsers: d.totalUniqueUsers || 0,
          totalAmount: d.totalAmount || 0,
          updatedAt: new Date().toISOString()
        };

        // Reset trend khi phiên mới
        if (newBet.sessionId !== lastSessionId) {
          betHistory = [];
          lastSessionId = newBet.sessionId;
        }

        currentBet = newBet;
        const total = newBet.taiAmount + newBet.xiuAmount;
        if (total > 0) betHistory.push({ tR: newBet.taiAmount/total, time: Date.now() });
        if (betHistory.length > 30) betHistory.shift();

        // Tạo dự đoán khi BETTING và tick > 10
        if (payload.state === 'BETTING' && payload.tick > 10) {
          const nextId = payload.id + 1;
          if (!predictions[nextId]) {
            const pred = predict(newBet, sessions);
            predictions[nextId] = {
              ...pred,
              betSnapshot: {
                taiAmount: newBet.taiAmount, xiuAmount: newBet.xiuAmount,
                taiUsers: newBet.taiUsers, xiuUsers: newBet.xiuUsers,
                totalAmount: newBet.totalAmount, tick: payload.tick
              },
              createdAt: new Date().toISOString()
            };
            console.log(`🎯 Dự đoán #${nextId}: ${pred.result} (${pred.conf}%) | ${pred.reasons[0]}`);
          }
        }
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
    if (code === 4001 || code === 4003) jwtToken = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, 5000);
  });

  wsClient.on('error', (e) => console.error('⚠️ WS:', e.message));
}

// ===== STATS =====
function getStats() {
  const withPred = sessions.filter(s => s.prediction);
  const correct = withPred.filter(s => s.predCorrect).length;
  const wrong = withPred.length - correct;
  let maxStreak = 0, curStreak = 0;
  withPred.forEach(s => {
    if (!s.predCorrect) { curStreak++; maxStreak = Math.max(maxStreak, curStreak); }
    else curStreak = 0;
  });
  return {
    total: withPred.length, correct, wrong,
    accuracy: withPred.length > 0 ? Math.round(correct/withPred.length*100) : 0,
    maxWrongStreak: maxStreak
  };
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
app.get('/api/bet', (req, res) => res.json(currentBet || {}));
app.get('/api/prediction', (req, res) => {
  // Dự đoán phiên tiếp theo
  const nextId = currentBet ? currentBet.sessionId + 1 : null;
  const pred = nextId && predictions[nextId] ? predictions[nextId] : null;
  res.json({ nextSession: nextId, prediction: pred, currentBet });
});
app.get('/api/stats', (req, res) => res.json(getStats()));
app.get('/api/status', (req, res) => res.json({
  sessions: sessions.length,
  predictions: Object.keys(predictions).length,
  ws: wsClient ? ['CONNECTING','OPEN','CLOSING','CLOSED'][wsClient.readyState] : 'NULL',
  hasJWT: !!jwtToken,
  currentBet,
  stats: getStats(),
  uptime: Math.floor(process.uptime())+'s'
}));
app.get('/', (req, res) => res.send(`
  <h2>🎲 TX MD5 Server</h2>
  <p>Sessions: ${sessions.length} | WS: ${wsClient?['CONNECTING','OPEN','CLOSING','CLOSED'][wsClient.readyState]:'NULL'}</p>
  <p>Stats: ${JSON.stringify(getStats())}</p>
  <a href="/api/lichsu">/api/lichsu</a> | 
  <a href="/api/bet">/api/bet</a> | 
  <a href="/api/prediction">/api/prediction</a> | 
  <a href="/api/stats">/api/stats</a>
`));

app.listen(PORT, () => {
  console.log(`🚀 Port ${PORT}`);
  poll();
  setInterval(poll, 20000);
  setInterval(async () => { try { jwtToken = await getJWT(); } catch(e) {} }, 7*60*60*1000);
  connectWS();
});
