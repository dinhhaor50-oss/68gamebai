"""
TAI XIU PREDICTOR - FastAPI Backend
Thuật toán: RandomForest (82.7% accuracy)
Lưu lịch sử dự đoán vào SQLite (max 500 phiên)
Tự động phát hiện phiên mới và cập nhật
"""
import asyncio
import json
import ssl
import sqlite3
import threading
import time
import uuid
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime
from pathlib import Path

import httpx
import numpy as np
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

# ===================== CONFIG =====================
TAI = "Tài"
XIU = "Xỉu"
WINDOW_SIZE = 20
API_URL = "https://lc79-server-production.up.railway.app/api/lichsu"
DB_PATH = Path(__file__).parent / "taixiu.db"
HISTORY_LIMIT = 500

# app khởi tạo tạm, sẽ được override bên dưới sau khi định nghĩa lifespan

templates = Jinja2Templates(directory="templates")

# ===================== DATABASE =====================
def init_db():
    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS predictions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phien TEXT NOT NULL,
                du_doan TEXT NOT NULL,
                ket_qua TEXT,
                xuc_xac TEXT,
                tong INTEGER,
                xac_suat REAL,
                dung_sai TEXT,
                da_xac_nhan INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)
        db.execute("""
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_phien ON predictions(phien)
        """)
        db.execute("DELETE FROM predictions")

@contextmanager
def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        yield conn.cursor()
        conn.commit()
    finally:
        conn.close()

# ===================== MODEL STATE =====================
model_state = {
    'trees': [],
    'initialized': False,
    'history': [],
    'tong_data': [],
    'latest_phien': None,
    'last_update': None,
    'full_data': [],
    'auto_refresh_active': False,
    'refresh_lock': threading.Lock(),
    'latest_prediction': None,  # (pred, prob) cho phiên mới nhất
}

# ===================== RANDOM FOREST =====================
def build_tree(X, y, depth=0, max_depth=6, min_samples=10):
    if depth >= max_depth or len(y) < min_samples:
        return {'leaf': 1, 'prob': float(np.mean(y))}

    best_gain = -1
    best_split = None

    for feature_idx in range(X.shape[1]):
        thresholds = np.percentile(X[:, feature_idx], [25, 50, 75])
        for t in thresholds:
            left_mask = X[:, feature_idx] <= t
            right_mask = ~left_mask
            if np.sum(left_mask) < 2 or np.sum(right_mask) < 2:
                continue
            gain = (np.var(y) - np.var(y[left_mask]) * np.sum(left_mask) / len(y)
                    - np.var(y[right_mask]) * np.sum(right_mask) / len(y))
            if gain > best_gain:
                best_gain = gain
                best_split = (feature_idx, t)

    if best_split is None or best_gain <= 0:
        return {'leaf': 1, 'prob': float(np.mean(y))}

    fi, t = best_split
    left_mask = X[:, fi] <= t
    right_mask = ~left_mask

    return {
        'leaf': 0,
        'feature': fi,
        'threshold': float(t),
        'left': build_tree(X[left_mask], y[left_mask], depth + 1, max_depth, min_samples),
        'right': build_tree(X[right_mask], y[right_mask], depth + 1, max_depth, min_samples)
    }

def predict_tree(x, tree):
    if tree['leaf']:
        return tree['prob']
    if x[tree['feature']] <= tree['threshold']:
        return predict_tree(x, tree['left'])
    return predict_tree(x, tree['right'])

# ===================== FEATURE EXTRACTION =====================
def extract_features(history_kq, history_tong):
    if len(history_kq) < WINDOW_SIZE:
        return None

    history = history_kq[-WINDOW_SIZE:]
    tong_hist = history_tong[-WINDOW_SIZE:]

    tai_count = history.count(TAI)
    xiu_count = history.count(XIU)

    streak = 1
    for i in range(len(history) - 1, -1, -1):
        if history[i] == history[-1]:
            streak += 1
        else:
            break

    switches = sum(1 for i in range(len(history) - 1) if history[i] != history[i + 1])
    tai_prob = tai_count / WINDOW_SIZE

    if history[-1] == XIU:
        x_streak = streak
        t_streak = 0
    else:
        t_streak = streak
        x_streak = 0

    t_point = tong_hist[-1] if tong_hist else 10
    avg_tong = sum(tong_hist) / len(tong_hist)
    dist_mean = abs(avg_tong - 10.5)

    p1 = 1 if history[-2] == TAI else 0 if len(history) >= 2 else 0
    p2 = 1 if history[-1] == TAI else 0
    pp1 = 1 if history[-3] == TAI else 0 if len(history) >= 3 else 0
    pp2 = 1 if history[-2] == TAI else 0 if len(history) >= 2 else 0
    pp3 = 1 if history[-1] == TAI else 0

    return [
        tai_prob,
        t_streak if history[-1] == TAI else -x_streak,
        switches / WINDOW_SIZE,
        t_streak,
        x_streak,
        t_point,
        avg_tong,
        dist_mean,
        1 if tai_count >= 2 else 0,
        1 if tai_count >= 3 else 0,
        1 if xiu_count >= 2 else 0,
        1 if xiu_count >= 3 else 0,
        p1,
        p2,
        pp1,
        pp2,
        pp3,
    ]

def history_before_row_index(kq, tong, idx):
    end = idx + 1 + WINDOW_SIZE
    if end > len(kq):
        return None
    chunk_k = kq[idx + 1:end]
    chunk_t = tong[idx + 1:end]
    return list(reversed(chunk_k)), list(reversed(chunk_t))

def history_for_next_roll(kq, tong):
    if len(kq) < WINDOW_SIZE:
        return None
    return list(reversed(kq[:WINDOW_SIZE])), list(reversed(tong[:WINDOW_SIZE]))

# ===================== DATA FETCHING =====================
async def fetch_data_from_api():
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(API_URL, headers={'User-Agent': 'Mozilla/5.0'})
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        print(f"[!] Error fetching data: {e}")
        return None

# ===================== MODEL TRAINING =====================
async def initialize_model():
    """Train model từ API data"""
    print("[*] Fetching data from API...")
    data = await fetch_data_from_api()

    if not data:
        print("[!] Failed to fetch data from API")
        return False

    print(f"[+] Fetched {len(data)} records from API")

    kq = [x["Ket_qua"] for x in data]
    tong = [x["Tong"] for x in data]
    phien_list = [x["Phien"] for x in data]

    model_state['full_data'] = data
    model_state['history'] = kq
    model_state['tong_data'] = tong
    model_state['latest_phien'] = phien_list[0] if phien_list else None

    # Train
    features = []
    labels = []
    n_train = len(data) - WINDOW_SIZE
    for i in range(n_train):
        ht = history_before_row_index(kq, tong, i)
        if not ht:
            break
        hist_k, hist_t = ht
        f = extract_features(hist_k, hist_t)
        if f:
            features.append(f)
            labels.append(1 if kq[i] == TAI else 0)

    if len(features) < 50:
        print("[!] Not enough data to train model")
        return False

    X = np.array(features)
    y = np.array(labels)

    np.random.seed(42)

    print("[*] Training RandomForest model...")
    n_trees = 50
    trees = []
    for i in range(n_trees):
        if (i + 1) % 10 == 0:
            print(f"    Training tree {i + 1}/{n_trees}")
        idx = np.random.choice(len(X), size=len(X), replace=True)
        tree = build_tree(X[idx], y[idx])
        trees.append(tree)

    model_state['trees'] = trees
    model_state['initialized'] = True
    model_state['last_update'] = datetime.now().isoformat()

    print(f"[+] Model trained with {len(features)} samples")
    return True

async def check_for_new_phien():
    """Kiểm tra phiên mới từ API"""
    data = await fetch_data_from_api()
    if not data:
        return False

    new_phien = data[0]["Phien"]

    if model_state['latest_phien'] is None:
        return await initialize_model()

    if new_phien != model_state['latest_phien']:
        print(f"[*] New phien detected: {model_state['latest_phien']} -> {new_phien}")
        kq = [x["Ket_qua"] for x in data]
        tong = [x["Tong"] for x in data]
        model_state['full_data'] = data
        model_state['history'] = kq
        model_state['tong_data'] = tong
        model_state['latest_phien'] = new_phien
        model_state['last_update'] = datetime.now().isoformat()

        # Cập nhật DB: xác nhận phiên trước + lưu dự đoán mới
        await _confirm_and_save_predictions()

        return True

    return False

async def _confirm_and_save_predictions():
    """Xác nhận kết quả phiên trước trong DB, lưu dự đoán mới cho phiên tiếp"""
    with get_db() as db:
        # Xác nhận phiên mới nhất trong DB (chưa xác nhận)
        db.execute("""
            UPDATE predictions
            SET ket_qua = ?,
                dung_sai = CASE WHEN du_doan = ? THEN 'Đúng' ELSE 'Sai' END,
                da_xac_nhan = 1
            WHERE da_xac_nhan = 0
            AND phien = (
                SELECT phien FROM predictions WHERE da_xac_nhan = 0
                ORDER BY created_at DESC LIMIT 1
            )
        """, (model_state['history'][0], model_state['history'][0]))

    # Lưu dự đoán mới nhất vào DB
    pred, prob, _ = predict_next_fast()
    if pred and model_state['full_data']:
        await save_prediction_to_db(
            phien=model_state['full_data'][0]['Phien'],
            du_doan=pred,
            ket_qua=None,
            xuc_xac=None,
            tong=None,
            xac_suat=prob / 100.0,
        )

def predict_single(idx):
    """Dự đoán cho phiên tại index idx"""
    if not model_state['initialized'] or not model_state['trees']:
        return None, None

    ht = history_before_row_index(
        model_state['history'], model_state['tong_data'], idx
    )
    if not ht:
        return None, None
    history, tong_hist = ht

    f = extract_features(history, tong_hist)
    if f is None:
        return None, None

    X = np.array([f])

    probs = [predict_tree(X[0], tree) for tree in model_state['trees']]
    avg_prob = np.mean(probs)
    prediction = TAI if avg_prob >= 0.5 else XIU

    return prediction, avg_prob

def predict_next_fast():
    """Dự đoán kết quả tiếp theo (không truy cập model_state trong thread)"""
    if not model_state['initialized'] or not model_state['trees']:
        return None, None, None

    kq = model_state['history']
    tong = model_state['tong_data']
    if len(kq) < WINDOW_SIZE:
        return None, None, None

    ht = history_for_next_roll(kq, tong)
    if not ht:
        return None, None, None
    hist_k, hist_t = ht

    f = extract_features(hist_k, hist_t)
    if f is None:
        return None, None, None

    X = np.array([f])
    probs = [predict_tree(X[0], tree) for tree in model_state['trees']]
    avg_prob = np.mean(probs)
    prediction = TAI if avg_prob >= 0.5 else XIU
    confidence = abs(avg_prob - 0.5) * 2 * 100

    return prediction, round(avg_prob * 100, 1), round(confidence, 1)

# ===================== DATABASE OPERATIONS =====================
async def save_prediction_to_db(phien, du_doan, ket_qua, xuc_xac, tong, xac_suat):
    """Lưu dự đoán vào DB, giới hạn 500 dòng"""
    with get_db() as db:
        db.execute("""
            INSERT INTO predictions (phien, du_doan, ket_qua, xuc_xac, tong, xac_suat, dung_sai, da_xac_nhan)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            phien, du_doan, ket_qua,
            f"{xuc_xac[0]}-{xuc_xac[1]}-{xuc_xac[2]}" if xuc_xac else None,
            tong, xac_suat,
            'Đúng' if ket_qua and du_doan == ket_qua else ('Sai' if ket_qua else None),
            1 if ket_qua else 0
        ))

        # Giới hạn 500 dòng
        db.execute("""
            DELETE FROM predictions WHERE id NOT IN (
                SELECT id FROM predictions ORDER BY created_at DESC LIMIT ?
            )
        """, (HISTORY_LIMIT,))

def get_history_from_db(limit=HISTORY_LIMIT):
    """Lấy lịch sử từ DB"""
    with get_db() as db:
        db.execute("""
            SELECT phien, du_doan, ket_qua, xuc_xac, tong, xac_suat, dung_sai
            FROM predictions
            ORDER BY created_at DESC
            LIMIT ?
        """, (limit,))
        rows = db.fetchall()
        return [dict(r) for r in rows]

def get_streaks():
    """Tính chuỗi đúng/sai dài nhất"""
    history = get_history_from_db(HISTORY_LIMIT)
    if not history:
        return {'longest_correct': 0, 'longest_wrong': 0, 'current_streak_correct': 0, 'current_streak_wrong': 0}

    confirmed = [r for r in history if r['dung_sai'] in ('Đúng', 'Sai')]
    if not confirmed:
        return {'longest_correct': 0, 'longest_wrong': 0, 'current_streak_correct': 0, 'current_streak_wrong': 0}

    longest_correct = longest_wrong = 0
    current_correct = current_wrong = 0

    for r in confirmed:
        if r['dung_sai'] == 'Đúng':
            current_correct += 1
            current_wrong = 0
            longest_correct = max(longest_correct, current_correct)
        else:
            current_wrong += 1
            current_correct = 0
            longest_wrong = max(longest_wrong, current_wrong)

    return {
        'longest_correct': longest_correct,
        'longest_wrong': longest_wrong,
        'current_streak_correct': current_correct,
        'current_streak_wrong': current_wrong,
    }

# ===================== AUTO REFRESH =====================
async def auto_refresh_worker():
    while model_state['auto_refresh_active']:
        try:
            await check_for_new_phien()
        except Exception as e:
            print(f"[!] Auto refresh error: {e}")
        await asyncio.sleep(5)

# ===================== API ROUTES =====================
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    await initialize_model()
    model_state['auto_refresh_active'] = True
    task = asyncio.create_task(auto_refresh_worker())
    print("[+] Auto-refresh started (every 5s)")
    yield
    model_state['auto_refresh_active'] = False
    task.cancel()

app = FastAPI(title="TaiXiu Predictor API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# --- Pydantic models ---
class RefreshResponse(BaseModel):
    status: str
    message: str
    latest_phien: str | None

# --- Endpoints ---

@app.get("/api/predict")
async def get_prediction():
    """Dự đoán kết quả tiếp theo"""
    if not model_state['initialized']:
        await initialize_model()

    await check_for_new_phien()

    pred, prob, confidence = predict_next_fast()

    if pred is None:
        return {
            'error': 'Không đủ dữ liệu để dự đoán',
            'prediction': None,
            'probability': None,
            'confidence': None
        }

    model_state['latest_prediction'] = (pred, prob)

    return {
        'prediction': pred,
        'probability': prob,
        'confidence': confidence,
        'model': 'RandomForest',
        'latest_phien': model_state['latest_phien'],
        'last_update': model_state['last_update'],
        'status': 'success'
    }

@app.post("/api/refresh", response_model=RefreshResponse)
async def refresh_data():
    """Cập nhật dữ liệu mới & retrain model"""
    with model_state['refresh_lock']:
        success = await initialize_model()

    if success:
        # Rebuild DB from scratch sau khi retrain
        await _rebuild_db_from_model()
        return {
            'status': 'success',
            'message': 'Model đã được cập nhật',
            'latest_phien': model_state['latest_phien']
        }
    return {
        'status': 'error',
        'message': 'Không thể cập nhật dữ liệu',
        'latest_phien': model_state['latest_phien']
    }

async def _rebuild_db_from_model():
    """Xóa DB cũ, rebuild lại từ model (đảm bảo max 500 phiên)"""
    with get_db() as db:
        db.execute("DELETE FROM predictions")

    n = len(model_state['full_data'])
    max_i = n - WINDOW_SIZE
    row_count = min(HISTORY_LIMIT, max_i)

    for i in range(row_count):
        actual_result = model_state['full_data'][i]["Ket_qua"]
        phien = model_state['full_data'][i]["Phien"]
        tong = model_state['full_data'][i]["Tong"]
        x1 = model_state['full_data'][i]["Xuc_xac_1"]
        x2 = model_state['full_data'][i]["Xuc_xac_2"]
        x3 = model_state['full_data'][i]["Xuc_xac_3"]

        pred, prob = predict_single(i)
        if pred:
            is_correct = pred == actual_result
            xuc_xac = f"{x1}-{x2}-{x3}"
            with get_db() as db:
                db.execute("""
                    INSERT INTO predictions (phien, du_doan, ket_qua, xuc_xac, tong, xac_suat, dung_sai, da_xac_nhan)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                """, (phien, pred, actual_result, xuc_xac, tong, prob, 'Đúng' if is_correct else 'Sai'))

@app.get("/api/history")
async def get_history(limit: int = 500):
    """Lấy lịch sử dự đoán từ DB (max 500 phiên)"""
    if not model_state['initialized']:
        await initialize_model()

    limit = min(limit, HISTORY_LIMIT)
    history = get_history_from_db(limit)

    confirmed = [r for r in history if r['dung_sai'] in ('Đúng', 'Sai')]
    correct = sum(1 for r in confirmed if r['dung_sai'] == 'Đúng')
    total = len(confirmed)
    accuracy = round(correct / total * 100, 2) if total > 0 else 0

    return {
        'status': 'success',
        'total_predictions': total,
        'correct': correct,
        'wrong': total - correct,
        'accuracy': accuracy,
        'latest_phien': model_state['latest_phien'],
        'last_update': model_state['last_update'],
        'history': history
    }

@app.get("/api/stats")
async def get_stats():
    """Thống kê + chuỗi đúng/sai dài nhất"""
    if not model_state['initialized']:
        await initialize_model()

    streaks = get_streaks()
    history = get_history_from_db(HISTORY_LIMIT)

    kq = model_state['history']
    tai_count = kq.count(TAI)
    xiu_count = kq.count(XIU)

    confirmed = [r for r in history if r['dung_sai'] in ('Đúng', 'Sai')]
    correct = sum(1 for r in confirmed if r['dung_sai'] == 'Đúng')
    total = len(confirmed)
    accuracy = round(correct / total * 100, 2) if total > 0 else 0

    return {
        'status': 'success',
        'total_records': len(kq),
        'tai_count': tai_count,
        'xiu_count': xiu_count,
        'tai_ratio': round(tai_count / len(kq) * 100, 2) if kq else 0,
        'xiu_ratio': round(xiu_count / len(kq) * 100, 2) if kq else 0,
        'model': 'RandomForest',
        'total_predictions': total,
        'correct': correct,
        'accuracy': accuracy,
        **streaks,
        'latest_phien': model_state['latest_phien'],
        'last_update': model_state['last_update']
    }

@app.get("/api/check-update")
async def check_update():
    """Kiểm tra có phiên mới không"""
    old_phien = model_state['latest_phien']
    await check_for_new_phien()

    return {
        'status': 'success',
        'has_update': old_phien != model_state['latest_phien'],
        'current_phien': model_state['latest_phien'],
        'previous_phien': old_phien
    }

@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": model_state['initialized']}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
