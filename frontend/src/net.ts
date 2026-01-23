import type { C2S, Dir, LobbyState, S2C, Turn } from "./protocol";

export type NetEvents = {
  onJoined: (data: Extract<S2C, { type: "joined" }>["payload"]) => void;
  onLobby: (lobby: LobbyState) => void;
  onStart: (data: Extract<S2C, { type: "start" }>["payload"]) => void;
  onState: (data: Extract<S2C, { type: "state" }>["payload"]) => void;
  onEnd: (data: Extract<S2C, { type: "end" }>["payload"]) => void;
  onError: (data: Extract<S2C, { type: "error" }>["payload"]) => void;
  onLog: (line: string) => void;
  onAnyMessage?: (msg: S2C, raw: string) => void;
  onClose?: () => void;
};

export class NetClient {
  private ws: WebSocket | null = null;
  private connected = false;

  connect(url: string, name: string, roomId: string | undefined, events: NetEvents) {
    if (this.ws) this.ws.close();
    this.ws = new WebSocket(url);
    this.connected = false;

    events.onLog(`connecting -> ${url}`);

    this.ws.onopen = () => {
      this.connected = true;
      const join: C2S = { v: 1, type: "join", payload: roomId ? { name, roomId } : { name } };
      this.ws?.send(JSON.stringify(join));
    };

    this.ws.onmessage = (ev) => {
      let parsed: S2C | null = null;
      try {
        parsed = JSON.parse(ev.data) as S2C;
      } catch {
        events.onLog(`in: <non-json> (${String(ev.data).length} bytes)`);
        return;
      }
      if (!parsed || parsed.v !== 1) return;
      events.onAnyMessage?.(parsed, ev.data);
      switch (parsed.type) {
        case "joined":
          events.onJoined(parsed.payload);
          break;
        case "lobby_state":
          events.onLobby(parsed.payload.lobby);
          break;
        case "start":
          events.onStart(parsed.payload);
          break;
        case "state":
          events.onState(parsed.payload);
          break;
        case "end":
          events.onEnd(parsed.payload);
          break;
        case "error":
          events.onError(parsed.payload);
          break;
        case "pong":
          break;
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      events.onLog("socket closed");
      events.onClose?.();
    };
    this.ws.onerror = () => events.onLog("socket error");
  }

  isConnected() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    } finally {
      this.ws = null;
      this.connected = false;
    }
  }

  sendReady(ready: boolean) {
    if (!this.isConnected()) return;
    const m: C2S = { v: 1, type: "ready", payload: { ready } };
    this.ws!.send(JSON.stringify(m));
  }

  sendSettings(cubeN: number, roundSeconds: number, tickRate: number) {
    if (!this.isConnected()) return;
    const m: C2S = { v: 1, type: "set_settings", payload: { cubeN, roundSeconds, tickRate } };
    this.ws!.send(JSON.stringify(m));
  }

  sendColor(color: number) {
    if (!this.isConnected()) return;
    const m: C2S = { v: 1, type: "set_color", payload: { color } };
    this.ws!.send(JSON.stringify(m));
  }

  sendForceStart() {
    if (!this.isConnected()) return;
    const m: C2S = { v: 1, type: "force_start", payload: {} };
    this.ws!.send(JSON.stringify(m));
  }

  sendTurn(tick: number, turn: Turn) {
    if (!this.isConnected()) return;
    const m: C2S = { v: 1, type: "input", payload: { inputs: [{ tick, turn }] } };
    this.ws!.send(JSON.stringify(m));
  }

  sendDir(tick: number, dir: Dir) {
    if (!this.isConnected()) return;
    const m: C2S = { v: 1, type: "input", payload: { inputs: [{ tick, dir }] } };
    this.ws!.send(JSON.stringify(m));
  }
}
