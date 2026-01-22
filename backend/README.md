# Backend (Python)

WebSocket multiplayer server for the 3D cube-surface snake game.

## Requirements

- Python 3.11+ recommended

## Install

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
uvicorn app.main:app --reload --port 8000
```

Endpoints:

- `http://localhost:8000/` (simple test page)
- `http://localhost:8000/play/` (serves `frontend/dist` if present)
- `http://localhost:8000/healthz`
- `ws://localhost:8000/ws`
