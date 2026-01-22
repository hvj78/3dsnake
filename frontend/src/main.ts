import { NetClient } from "./net";
import type { Dir, LobbyState } from "./protocol";
import { Renderer } from "./render";
import type { S2C } from "./protocol";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const statusEl = $("status") as HTMLPreElement;
const logEl = $("log") as HTMLTextAreaElement;

let logPaused = false;
let logStateEnabled = false;
let logRawEnabled = false;
let logMaxLines = 300;
const logLines: string[] = [];
const logPending: string[] = [];

const appendLog = (line: string) => {
  const ts = new Date().toLocaleTimeString();
  const entry = `[${ts}] ${line}`;
  if (logPaused) {
    logPending.push(entry);
    return;
  }
  logLines.push(entry);
  while (logLines.length > logMaxLines) logLines.shift();
  logEl.value = logLines.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
};

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    appendLog("copied to clipboard");
  } catch {
    // Fallback for restricted clipboard contexts.
    window.prompt("Copy to clipboard:", text);
  }
}

const net = new NetClient();
const view = $("view");
const renderer = new Renderer(view);

const backendUrlInput = document.getElementById("backendUrl") as HTMLInputElement;
if (!backendUrlInput.value) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const host = location.hostname || "localhost";
  const isLocal = host === "localhost" || host === "127.0.0.1";
  // If the frontend is served from the backend (Fly/prod), use same-origin /ws.
  // If running Vite locally, default to the backend at :8000.
  backendUrlInput.value = isLocal ? `${proto}://${host}:8000/ws` : `${proto}://${location.host}/ws`;
  if (location.port === "8000") backendUrlInput.value = `${proto}://${location.host}/ws`;
}
const roomIdInput = document.getElementById("roomId") as HTMLInputElement;
if (!roomIdInput.value) {
  const h = (location.hash || "").replace(/^#/, "").trim();
  if (/^[A-Z0-9]{6}$/.test(h)) roomIdInput.value = h;
  else roomIdInput.value = "ABC123";
}

let myPlayerId: string | null = null;
let isHost = false;
let lobby: LobbyState | null = null;
let ready = false;

let lastServerTick = -1;
let nextInputTick = 0;
let desiredDir: Dir | null = null;
let tickRate = 12;
let inputLoopStarted = false;

let lastJoined: Extract<S2C, { type: "joined" }>["payload"] | null = null;
let lastLobby: LobbyState | null = null;
let lastStart: Extract<S2C, { type: "start" }>["payload"] | null = null;
let lastState: Extract<S2C, { type: "state" }>["payload"] | null = null;
let lastEnd: Extract<S2C, { type: "end" }>["payload"] | null = null;
let lastError: Extract<S2C, { type: "error" }>["payload"] | null = null;
let playerColors: Record<string, number> = {};
let connectNow: (() => void) | null = null;

const PALETTE_8: number[] = [
  0x16a34a, // green
  0xdc2626, // red
  0x2563eb, // blue
  0xf59e0b, // orange
  0x7c3aed, // purple
  0xdb2777, // magenta
  0x0d9488, // teal
  0x334155 // slate/gray
];
const PALETTE_NAMES: Record<number, string> = {
  0x16a34a: "Green",
  0xdc2626: "Red",
  0x2563eb: "Blue",
  0xf59e0b: "Orange",
  0x7c3aed: "Purple",
  0xdb2777: "Magenta",
  0x0d9488: "Teal",
  0x334155: "Gray"
};

function rebuildPlayerColorsFromLobby(l: LobbyState | null) {
  if (!l) return;
  playerColors = {};
  for (const p of l.players) playerColors[p.playerId] = p.color;
}

function setStatus(text: string) {
  statusEl.textContent = text;
}

function parseIntSafe(value: string, fallback: number) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function renderLobby() {
  if (!lobby) return;
  const you = myPlayerId ? lobby.players.find((p) => p.playerId === myPlayerId) : null;
  const lines = [
    `room: ${lobby.roomId}`,
    `you: ${you?.name ?? "?"} (${myPlayerId ?? "?"})`,
    `host: ${lobby.hostId ?? "-"}`,
    `phase: lobby`,
    "",
    "players:"
  ];
  for (const p of lobby.players) lines.push(`- ${p.name} ${p.ready ? "(ready)" : ""} ${p.playerId === lobby.hostId ? "[host]" : ""}`.trim());
  lines.push("", `settings: cubeN=${lobby.settings.cubeN} roundSeconds=${lobby.settings.roundSeconds} tickRate=${lobby.settings.tickRate}`);
  setStatus(lines.join("\n"));
}

function wireUI() {
  const connectBtn = $("connect") as HTMLButtonElement;
  const readyBtn = $("ready") as HTMLButtonElement;
  const applySettingsBtn = $("applySettings") as HTMLButtonElement;
  const copyRoomBtn = $("copyRoom") as HTMLButtonElement;
  const logPauseBtn = $("logPause") as HTMLButtonElement;
  const logClearBtn = $("logClear") as HTMLButtonElement;
  const logCopyBtn = $("logCopy") as HTMLButtonElement;
  const logCopyDebugBtn = $("logCopyDebug") as HTMLButtonElement;
  const logState = document.getElementById("logState") as HTMLInputElement;
  const logRaw = document.getElementById("logRaw") as HTMLInputElement;
  const logMax = document.getElementById("logMax") as HTMLInputElement;
  const snakeColorEl = document.getElementById("snakeColor") as HTMLDivElement;

  const populateColorOptions = () => {
    const taken = new Set<number>();
    if (lobby) {
      for (const p of lobby.players) {
        if (p.playerId !== myPlayerId) taken.add(p.color);
      }
    }
    const myColor = lobby?.players.find((p) => p.playerId === myPlayerId)?.color;

    snakeColorEl.innerHTML = "";
    for (const c of PALETTE_8) {
      const disabled = taken.has(c) && c !== myColor;
      const btn = document.createElement("div");
      btn.className = `swatch${c === myColor ? " selected" : ""}`;
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", disabled ? "-1" : "0");
      btn.setAttribute("aria-disabled", disabled ? "true" : "false");
      btn.title = `${PALETTE_NAMES[c] ?? "Color"} (#${c.toString(16).padStart(6, "0")})`;
      btn.style.background = `#${c.toString(16).padStart(6, "0")}`;

      const send = () => {
        if (disabled) return;
        net.sendColor(c);
      };
      btn.onclick = send;
      btn.onkeydown = (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          send();
        }
      };

      snakeColorEl.appendChild(btn);
    }
  };
  populateColorOptions();

  logState.onchange = () => (logStateEnabled = !!logState.checked);
  logRaw.onchange = () => (logRawEnabled = !!logRaw.checked);
  logMax.onchange = () => {
    const n = Number.parseInt(logMax.value, 10);
    if (Number.isFinite(n) && n >= 50 && n <= 5000) logMaxLines = n;
    logMax.value = String(logMaxLines);
    while (logLines.length > logMaxLines) logLines.shift();
    logEl.value = logLines.join("\n");
  };

  logPauseBtn.onclick = () => {
    logPaused = !logPaused;
    logPauseBtn.textContent = logPaused ? "Resume" : "Pause";
    if (!logPaused && logPending.length) {
      appendLog(`flushing ${logPending.length} pending log lines`);
      for (const line of logPending.splice(0, logPending.length)) appendLog(line.replace(/^\[[^\]]+\]\s/, ""));
    }
  };
  logClearBtn.onclick = () => {
    logLines.length = 0;
    logPending.length = 0;
    logEl.value = "";
  };
  logCopyBtn.onclick = () => copyToClipboard(logEl.value);
  logCopyDebugBtn.onclick = () => {
    const debug = {
      client: {
        myPlayerId,
        isHost,
        lastServerTick,
        tickRate
      },
      lastJoined,
      lastLobby,
      lastStart,
      lastState,
      lastEnd,
      lastError
    };
    copyToClipboard(JSON.stringify(debug, null, 2));
  };
  copyRoomBtn.onclick = () => {
    const rid = (roomIdInput.value || lobby?.roomId || "").trim();
    if (!rid) return;
    copyToClipboard(rid);
  };

  connectNow = () => {
    const url = (document.getElementById("backendUrl") as HTMLInputElement).value.trim();
    const name = (document.getElementById("name") as HTMLInputElement).value.trim() || "Player";
    const roomId = roomIdInput.value.trim();

    myPlayerId = null;
    lobby = null;
    isHost = false;
    ready = false;
    lastServerTick = -1;
    nextInputTick = 0;
    desiredDir = null;
    lastJoined = null;
    lastLobby = null;
    lastStart = null;
    lastState = null;
    lastEnd = null;
    lastError = null;
    readyBtn.disabled = true;
    applySettingsBtn.disabled = true;
    setStatus("connecting...");

    net.connect(url, name, roomId ? roomId : undefined, {
      onLog: appendLog,
      onAnyMessage: (m, raw) => {
        if (logRawEnabled) appendLog(`raw: ${raw}`);
        if (m.type === "state") {
          if (!logStateEnabled) return;
          const p = m.payload;
          const alive = p.snakes.filter((s) => s.alive).length;
          appendLog(`state: tick=${p.tick} alive=${alive} fruits=${p.fruits.length}`);
          return;
        }
        if (m.type === "lobby_state") {
          const p = m.payload.lobby;
          appendLog(`lobby: players=${p.players.length} host=${(p.hostId ?? "").slice(0, 6)} cubeN=${p.settings.cubeN}`);
          return;
        }
        appendLog(`in: ${m.type}`);
      },
      onJoined: (data) => {
        myPlayerId = data.playerId;
        isHost = data.isHost;
        lobby = data.lobby;
        lastJoined = data;
        lastLobby = data.lobby;
        rebuildPlayerColorsFromLobby(lobby);
        roomIdInput.value = data.roomId;
        location.hash = `#${data.roomId}`;
        readyBtn.disabled = false;
        applySettingsBtn.disabled = !isHost;
        populateColorOptions();
        renderLobby();
      },
      onLobby: (l) => {
        lobby = l;
        lastLobby = l;
        rebuildPlayerColorsFromLobby(lobby);
        applySettingsBtn.disabled = !myPlayerId || lobby.hostId !== myPlayerId;
        populateColorOptions();
        renderLobby();
      },
      onStart: (data) => {
        renderer.setCubeN(data.settings.cubeN);
        tickRate = data.settings.tickRate;
        lastStart = data;
        playerColors = {};
        for (const p of data.players) playerColors[p.playerId] = p.color;
        if (!inputLoopStarted) startInputLoop();
        // Ensure key events go to the game area (esp. on Safari / when a form element has focus).
        view.focus?.();
        setStatus(
          [
            `room: ${lobby?.roomId ?? "?"}`,
            `phase: running`,
            `cubeN: ${data.settings.cubeN}`,
            `tickRate: ${data.settings.tickRate}`,
            `roundSeconds: ${data.settings.roundSeconds}`,
            `fruitTarget: ${data.settings.fruitTarget}`,
            "",
            "waiting for state..."
          ].join("\n")
        );
      },
      onState: (data) => {
        lastServerTick = data.tick;
        nextInputTick = Math.max(nextInputTick, data.tick + 1);
        lastState = data;
        renderer.update(data.snakes, data.fruits, myPlayerId, playerColors);

        const scores = Object.entries(data.scores)
          .sort((a, b) => b[1] - a[1])
          .map(([pid, sc]) => {
            const name = lobby?.players.find((p) => p.playerId === pid)?.name ?? pid.slice(0, 6);
            return `${name}: ${sc}`;
          });

        setStatus(
          [
            `room: ${lobby?.roomId ?? "?"}`,
            `phase: running`,
            `tick: ${data.tick}`,
            `timerMsLeft: ${data.timerMsLeft}`,
            "",
            "scores:",
            ...scores
          ].join("\n")
        );
      },
      onEnd: (data) => {
        lastEnd = data;
        setStatus(["phase: ended", "", "finalScores:", JSON.stringify(data.finalScores, null, 2)].join("\n"));
      },
      onError: (data) => {
        lastError = data;
        setStatus(`error: ${data.code}\n${data.message}`);
      }
    });
  };
  connectBtn.onclick = connectNow;

  readyBtn.onclick = () => {
    ready = !ready;
    readyBtn.textContent = ready ? "Unready" : "Ready";
    net.sendReady(ready);
    view.focus?.();
  };

  applySettingsBtn.onclick = () => {
    const cubeN = parseIntSafe((document.getElementById("cubeN") as HTMLInputElement).value, 24);
    const roundSeconds = parseIntSafe((document.getElementById("roundSeconds") as HTMLInputElement).value, 180);
    const tickRate = parseIntSafe((document.getElementById("tickRate") as HTMLInputElement).value, 12);
    net.sendSettings(cubeN, roundSeconds, tickRate);
  };
}

function wireInput() {
  const handler = (ev: KeyboardEvent) => {
    const k = ev.key.toLowerCase();
    // Screen-relative directions: up/down/left/right on the currently viewed face.
    if (ev.key === "ArrowUp" || k === "w") {
      ev.preventDefault();
      desiredDir = 0;
    }
    if (ev.key === "ArrowRight" || k === "d") {
      ev.preventDefault();
      desiredDir = 1;
    }
    if (ev.key === "ArrowDown" || k === "s") {
      ev.preventDefault();
      desiredDir = 2;
    }
    if (ev.key === "ArrowLeft" || k === "a") {
      ev.preventDefault();
      desiredDir = 3;
    }
  };
  // Capture phase improves reliability when an element handles/binds key events.
  window.addEventListener("keydown", handler, { capture: true });
}

function startInputLoop() {
  inputLoopStarted = true;
  let lastSend = performance.now();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const intervalMs = 1000 / Math.max(5, Math.min(30, tickRate));
    if (now - lastSend < intervalMs) return;
    lastSend = now;
    if (!net.isConnected()) return;
    if (lastServerTick < 0) return;
    const t = nextInputTick;
    nextInputTick++;
    if (desiredDir !== null) {
      const mapped = renderer.mapScreenDirToFaceDir(desiredDir);
      const dirToSend = (mapped ?? desiredDir) as Dir;
      const myDir = myPlayerId ? lastState?.snakes.find((s) => s.playerId === myPlayerId)?.dir : null;
      if (myDir != null) {
        const opposite = (((dirToSend + 2) % 4) as Dir) === myDir;
        if (!opposite) net.sendDir(t, dirToSend);
      } else net.sendDir(t, dirToSend);
    }
  };
  requestAnimationFrame(loop);
}

wireUI();
wireInput();
setStatus("disconnected");
appendLog("log ready (use Pause / Copy debug if needed)");

// Auto-connect when using the default room (helps projected / kiosk usage).
if (roomIdInput.value.trim().toUpperCase() === "ABC123") {
  // Give the UI a moment to render before connecting.
  setTimeout(() => {
    if (connectNow) connectNow();
  }, 50);
}
