# Repository Guidelines

## Project Structure & Module Organization

- `backend/` — FastAPI + WebSocket server (authoritative tick loop).
  - `backend/app/main.py` — HTTP routes (`/rooms`, `/play/`, `/healthz`) + WebSocket at `/ws`.
  - `backend/app/rooms.py` — room/lobby management, start/force-start, tick scheduling.
  - `backend/app/game/` — core simulation (movement, bites, fruits).
- `frontend/` — Vite + TypeScript + Three.js client.
  - `frontend/src/main.ts` — UI (intro + lobby), networking, input, sound hooks.
  - `frontend/src/render.ts` — cube + snake + fruit rendering.
  - `frontend/src/protocol.ts` — shared message types (keep in sync with backend).
  - `frontend/public/assets/` — static assets (e.g. `assets/video/intro.mp4`).
- `scripts/` — helper scripts (e.g. Fly single-machine deploy).
- `Dockerfile`, `fly.toml`, `DEPLOY_FLY.md` — deployment.

## Build, Test, and Development Commands

- Backend install: `python -m venv .venv && source .venv/bin/activate && pip install -r backend/requirements.txt`
- Run backend: `uvicorn app.main:app --reload --port 8000` (from `backend/`)
- Frontend install: `npm -C frontend install`
- Frontend dev: `npm -C frontend run dev` (Vite dev server; backend stays on `:8000`)
- Frontend build: `npm -C frontend run build` (runs `tsc` then `vite build`)

## Coding Style & Naming Conventions

- TypeScript: 2-space indentation, `camelCase` vars/functions, `PascalCase` classes/types.
- Python: 4-space indentation, `snake_case` names, type hints where practical.
- Keep `frontend/src/protocol.ts` and backend message schema aligned when changing networking.

## Testing Guidelines

- No dedicated automated test suite yet.
- Before PRs: run `npm -C frontend run build` and `python -m py_compile backend/app/main.py backend/app/rooms.py`.

## Commit & Pull Request Guidelines

- Commit messages: short, imperative, and specific (examples in history: “Fix …”, “Add …”, “Update …”).
- PRs should include: what changed, how to test locally, and screenshots for UI/visual changes.
- If deployment-related: note Fly changes and whether `./scripts/fly-deploy-single.sh` was used.

## Configuration & Deployment Notes

- Fly.io single server: `./scripts/fly-deploy-single.sh` (keeps Machine count at 1).
- Intro video (optional): place at `frontend/public/assets/video/intro.mp4`.
