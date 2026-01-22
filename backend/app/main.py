from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.protocol import msg
from app.rooms import RoomManager
from app.util.time import now_ms

app = FastAPI()
rooms = RoomManager()

_ROOT = Path(__file__).resolve().parents[2]
_FRONTEND_DIST = _ROOT / "frontend" / "dist"
if _FRONTEND_DIST.exists():
    app.mount("/play", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="play")


def _as_int(v: Any) -> Optional[int]:
    try:
        return int(v)
    except Exception:
        return None


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def index() -> HTMLResponse:
    return HTMLResponse(
        """
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>3dsnake backend</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 24px; }
      code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
      .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
      input { padding: 8px; }
      button { padding: 8px 12px; cursor: pointer; }
      #log { white-space: pre-wrap; background: #111; color: #ddd; padding: 12px; border-radius: 8px; min-height: 180px; }
    </style>
  </head>
  <body>
    <h1>3dsnake backend</h1>
    <p>This service exposes a WebSocket at <code>/ws</code> and a health check at <code>/healthz</code>.</p>
    <p>If you built the frontend, it will be served at <code>/play/</code>.</p>

    <div class="row">
      <label>Name <input id="name" value="Player" /></label>
      <label>Room ID (optional) <input id="roomId" placeholder="ABC123" /></label>
      <button id="connect">Connect</button>
      <button id="ready" disabled>Ready</button>
    </div>

    <p><small>Tip: open this page in multiple tabs to simulate multiple players.</small></p>

    <h3>Log</h3>
    <div id="log"></div>

    <script>
      const $ = (id) => document.getElementById(id);
      const log = (line) => { $("log").textContent += line + "\\n"; $("log").scrollTop = $("log").scrollHeight; };

      let ws = null;
      let ready = false;

      $("connect").onclick = () => {
        if (ws) { ws.close(); ws = null; }
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const url = `${proto}://${location.host}/ws`;
        ws = new WebSocket(url);
        log(`connecting -> ${url}`);

        ws.onopen = () => {
          ready = false;
          $("ready").disabled = false;
          $("ready").textContent = "Ready";
          const payload = { name: $("name").value || "Player" };
          const roomId = $("roomId").value.trim();
          if (roomId) payload.roomId = roomId;
          ws.send(JSON.stringify({ v: 1, type: "join", payload }));
        };

        ws.onmessage = (ev) => log(`<- ${ev.data}`);
        ws.onclose = () => { log("socket closed"); $("ready").disabled = true; };
        ws.onerror = () => log("socket error");
      };

      $("ready").onclick = () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ready = !ready;
        $("ready").textContent = ready ? "Unready" : "Ready";
        ws.send(JSON.stringify({ v: 1, type: "ready", payload: { ready } }));
      };
    </script>
  </body>
</html>
""".strip()
    )


@app.get("/play")
def play_redirect() -> RedirectResponse:
    return RedirectResponse(url="/play/", status_code=307)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()

    room = None
    player = None
    try:
        join_raw = await asyncio.wait_for(ws.receive_json(), timeout=10)
        if not isinstance(join_raw, dict) or join_raw.get("type") != "join":
            await ws.send_json(msg("error", {"code": "bad_join", "message": "first message must be join"}))
            await ws.close()
            return

        payload = join_raw.get("payload") or {}
        name = str(payload.get("name") or "Player")
        room_id = payload.get("roomId")
        if room_id is not None:
            room_id = str(room_id)

        room, player, is_host = await rooms.join(room_id=room_id, name=name, ws=ws)

        await ws.send_json(msg("joined", {"playerId": player.player_id, "roomId": room.room_id, "isHost": is_host, "lobby": room.lobby_state()}))
        await room.broadcast(msg("lobby_state", {"lobby": room.lobby_state()}))

        while True:
            raw = await ws.receive_json()
            if not isinstance(raw, dict):
                continue
            mtype = raw.get("type")
            payload = raw.get("payload") or {}

            if mtype == "leave":
                await ws.close()
                return

            if mtype == "ping":
                await ws.send_json(msg("pong", {"clientTimeMs": payload.get("clientTimeMs"), "serverTimeMs": now_ms()}))
                continue

            if room is None or player is None:
                continue

            if mtype == "set_settings":
                async with room.lock:
                    if room.phase != "lobby":
                        continue
                    if room.host_id != player.player_id:
                        continue
                    cube_n = _as_int(payload.get("cubeN"))
                    round_seconds = _as_int(payload.get("roundSeconds"))
                    tick_rate = _as_int(payload.get("tickRate"))
                    if cube_n is not None:
                        room.settings.cube_n = max(8, min(80, cube_n))
                    if round_seconds is not None:
                        room.settings.round_seconds = max(30, min(60 * 30, round_seconds))
                    if tick_rate is not None:
                        room.settings.tick_rate = max(5, min(30, tick_rate))
                await room.broadcast(msg("lobby_state", {"lobby": room.lobby_state()}))
                continue

            if mtype == "ready":
                ready = bool(payload.get("ready"))
                async with room.lock:
                    if room.phase != "lobby":
                        continue
                    room.players[player.player_id].ready = ready
                await room.broadcast(msg("lobby_state", {"lobby": room.lobby_state()}))
                await room.maybe_start()
                continue

            if mtype == "input":
                inputs = payload.get("inputs")
                if not isinstance(inputs, list):
                    continue
                async with room.lock:
                    for item in inputs:
                        if not isinstance(item, dict):
                            continue
                        tick = _as_int(item.get("tick"))
                        turn_value = _as_int(item.get("turn"))
                        if tick is None or turn_value not in (-1, 0, 1):
                            continue
                        room.players[player.player_id].input_by_tick[tick] = turn_value
                continue

    except WebSocketDisconnect:
        pass
    except asyncio.TimeoutError:
        try:
            await ws.send_json(msg("error", {"code": "join_timeout", "message": "join timed out"}))
        except Exception:
            pass
    except Exception as e:
        try:
            await ws.send_json(msg("error", {"code": "server_error", "message": str(e)}))
        except Exception:
            pass
    finally:
        if room is not None and player is not None:
            await rooms.leave(room, player.player_id)
            try:
                await room.broadcast(msg("lobby_state", {"lobby": room.lobby_state()}))
            except Exception:
                pass
