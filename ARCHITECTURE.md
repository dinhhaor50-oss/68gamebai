# TaiXiu API - Backend

## Cấu trúc thư mục
```
/
├── main.py              # FastAPI backend (API + auto-refresh + SQLite)
├── templates/
│   └── index.html       # Frontend UI
├── requirements.txt
├── railway.json
└── .gitignore
```

## API Endpoints

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/api/predict` | Dự đoán kết quả tiếp theo |
| POST | `/api/refresh` | Cập nhật dữ liệu & retrain model |
| GET | `/api/history` | Lịch sử dự đoán (max 500 phiên) |
| GET | `/api/stats` | Thống kê + chuỗi đúng/sai dài nhất |
| GET | `/api/check-update` | Kiểm tra phiên mới |
| GET | `/health` | Health check |

## Database (SQLite)
- File: `taixiu.db`
- Bảng `predictions`: lưu lịch sử dự đoán (max 500 dòng, tự xóa cũ)
- Bảng `meta`: lưu trạng thái model, phiên mới nhất

## Triển khai Railway
- Runtime: Python 3.11
- Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Free tier: 500MB RAM, shared CPU
