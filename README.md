# TaiXiu Predictor API

Dự đoán Tài Xỉu bằng thuật toán **RandomForest**, backend bằng FastAPI, lưu trữ SQLite, deploy lên Railway.

## Tính năng

- **Dự đoán Tài/Xỉu** tiếp theo dựa trên lịch sử 500 phiên gần nhất
- **Lịch sử dự đoán** với thống kê đúng/sai
- **Chuỗi đúng/sai dài nhất** hiển thị trên dashboard
- **Auto-refresh** mỗi 5 giây, tự động phát hiện phiên mới
- **Lưu trữ SQLite** cho lịch sử dự đoán (max 500 phiên)

## API Endpoints

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/api/predict` | Dự đoán kết quả tiếp theo |
| POST | `/api/refresh` | Cập nhật dữ liệu & retrain model |
| GET | `/api/history?limit=500` | Lịch sử dự đoán (max 500 phiên) |
| GET | `/api/stats` | Thống kê + chuỗi đúng/sai dài nhất |
| GET | `/api/check-update` | Kiểm tra phiên mới |
| GET | `/health` | Health check |

## Chạy local

```bash
pip install -r requirements.txt
python main.py
# Mở http://localhost:8000
```

## Deploy lên Railway

1. Push code lên GitHub
2. Vào [railway.app](https://railway.app) → New Project → Connect GitHub repo
3. Railway tự động detect Python, deploy
4. Sau khi deploy xong, cập nhật `API_BASE` trong `templates/index.html` thành URL Railway của bạn

## Cấu trúc

```
/
├── main.py              # FastAPI backend (API + auto-refresh + SQLite)
├── templates/
│   └── index.html       # Frontend dashboard
├── requirements.txt
├── railway.json
├── ARCHITECTURE.md
└── .gitignore
```
