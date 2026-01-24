import { NetClient } from "./net";
import type { Dir, LobbyState } from "./protocol";
import { Renderer } from "./render";
import type { S2C } from "./protocol";
import { Sfx } from "./sfx";

type RoomInfo = {
  roomId: string;
  name: string;
  capacity: number;
  count: number;
  players: string[];
  phase?: string;
  joinable?: boolean;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLPreElement>("status");
const logEl = $<HTMLTextAreaElement>("log");

const appEl = $<HTMLDivElement>("app");
const view = $<HTMLDivElement>("view");

const loginOverlay = $<HTMLDivElement>("loginOverlay");
const loginName = $<HTMLInputElement>("loginName");
const roomSelectEl = $<HTMLDivElement>("roomSelect");
const roomLobbyEl = $<HTMLDivElement>("roomLobby");
const roomTitleEl = $<HTMLDivElement>("roomTitle");
const playersListEl = $<HTMLDivElement>("playersList");
const lobbyNoteEl = $<HTMLDivElement>("lobbyNote");
const settingsNoteEl = $<HTMLSpanElement>("settingsNote");
const roomList = $<HTMLDivElement>("roomList");
const loginStatus = $<HTMLDivElement>("loginStatus");

const readyBtn = $<HTMLButtonElement>("ready");
const leaveRoomBtn = $<HTMLButtonElement>("leaveRoom");
const applySettingsBtn = $<HTMLButtonElement>("applySettings");
const forceStartBtn = $<HTMLButtonElement>("forceStart");
const snakeColorEl = $<HTMLDivElement>("snakeColor");
const cubeNInput = $<HTMLInputElement>("cubeN");
const roundSecondsInput = $<HTMLInputElement>("roundSeconds");
const tickRateInput = $<HTMLInputElement>("tickRate");
const fruitPerFaceInput = $<HTMLInputElement>("fruitPerFace");

const countdownOverlay = $<HTMLDivElement>("countdownOverlay");
const countdownText = $<HTMLDivElement>("countdownText");

const introOverlay = $<HTMLDivElement>("introOverlay");
const introVideo = $<HTMLVideoElement>("introVideo");
const introSkipBtn = $<HTMLButtonElement>("introSkip");
const introTapToPlayBtn = $<HTMLButtonElement>("introTapToPlay");

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
const sfx = new Sfx();
let renderer: Renderer | null = null;

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
let currentRoomName: string | null = null;
let inRound = false;
let playingThisRound = false;
let populateColorOptionsFn: (() => void) | null = null;
let audioActive = false;
let prevFruitIds = new Set<string>();
let prevSnakeInfo = new Map<string, { alive: boolean; len: number }>();

function tryEnableAudio() {
  // Browsers require a user gesture; we'll call this from clicks/keys.
  sfx.resume();
}

const INTRO_VIDEO_PATH = "assets/video/intro.mp4";

function introVideoUrl() {
  let base = import.meta.env.BASE_URL || "/";
  if (!base.endsWith("/")) base += "/";
  return `${base}${INTRO_VIDEO_PATH}`;
}

const PALETTE_8: number[] = [
  0xdb2777, // magenta
  0xef4444, // red
  0xf97316, // orange
  0xfacc15, // yellow
  0x22c55e, // green
  0x06b6d4, // cyan
  0x3b82f6, // blue
  0x8b5cf6 // violet
];
const PALETTE_NAMES: Record<number, string> = {
  0xdb2777: "Magenta",
  0xef4444: "Red",
  0xf97316: "Orange",
  0xfacc15: "Yellow",
  0x22c55e: "Green",
  0x06b6d4: "Cyan",
  0x3b82f6: "Blue",
  0x8b5cf6: "Violet"
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
    `phase: ${inRound ? "running" : "lobby"}`,
    "",
    "players:"
  ];
  for (const p of lobby.players) lines.push(`- ${p.name} ${p.ready ? "(ready)" : ""} ${p.playerId === lobby.hostId ? "[host]" : ""}`.trim());
  lines.push(
    "",
    `settings: cubeN=${lobby.settings.cubeN} roundSeconds=${lobby.settings.roundSeconds} tickRate=${lobby.settings.tickRate} fruitPerFace=${lobby.settings.fruitPerFace}`
  );
  setStatus(lines.join("\n"));
}

function defaultWsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const host = location.hostname || "localhost";
  const isLocal = host === "localhost" || host === "127.0.0.1";
  // If the frontend is served from the backend (Fly/prod), use same-origin /ws.
  // If running Vite locally, default to the backend at :8000.
  const isLikelyViteDev = isLocal && location.port !== "8000" && location.port !== "8080";
  return isLikelyViteDev ? `${proto}://${host}:8000/ws` : `${proto}://${location.host}/ws`;
}

function ensureRenderer() {
  if (renderer) return renderer;
  renderer = new Renderer(view, {
    onFaceChange: () => {
      if (!audioActive) return;
      sfx.playRotate();
    }
  });
  return renderer;
}

function showRoomSelect() {
  roomLobbyEl.classList.add("hidden");
  roomSelectEl.classList.remove("hidden");
  loginOverlay.classList.remove("hidden");
  loginName.disabled = false;
  inRound = false;
  playingThisRound = false;
  currentRoomName = null;
  hideCountdown();
  appEl.classList.add("hidden");
}

function showRoomLobby() {
  roomSelectEl.classList.add("hidden");
  roomLobbyEl.classList.remove("hidden");
  loginOverlay.classList.remove("hidden");
  loginName.disabled = true;
}

function showGame() {
  loginOverlay.classList.add("hidden");
  appEl.classList.remove("hidden");
  audioActive = true;
  if (lastState) {
    prevFruitIds = new Set<string>(lastState.fruits.map((f) => f.id));
    prevSnakeInfo = new Map(lastState.snakes.map((s) => [s.playerId, { alive: s.alive, len: s.cells.length }]));
  }
}

function hideGame() {
  appEl.classList.add("hidden");
  audioActive = false;
}

function showCountdown() {
  countdownOverlay.classList.remove("hidden");
}

function hideCountdown() {
  if (countdownTimer != null) window.clearInterval(countdownTimer);
  countdownTimer = null;
  countdownOverlay.classList.add("hidden");
  countdownText.classList.remove("start");
}

function resetClientState() {
  myPlayerId = null;
  lobby = null;
  isHost = false;
  ready = false;
  inRound = false;
  playingThisRound = false;
  audioActive = false;
  prevFruitIds = new Set<string>();
  prevSnakeInfo = new Map();
  lastServerTick = -1;
  nextInputTick = 0;
  desiredDir = null;
  lastJoined = null;
  lastLobby = null;
  lastStart = null;
  lastState = null;
  lastEnd = null;
  lastError = null;
  playerColors = {};
  readyBtn.disabled = true;
  leaveRoomBtn.disabled = false;
  applySettingsBtn.disabled = true;
  applySettingsBtn.classList.add("hidden");
  forceStartBtn.classList.add("hidden");
  forceStartBtn.disabled = true;
  readyBtn.textContent = "Ready";
  loginStatus.textContent = "";
  lobbyNoteEl.textContent = "";
  settingsNoteEl.textContent = "";
  snakeColorEl.innerHTML = "";
  playersListEl.innerHTML = "";
}

function wireUI() {
  const logPauseBtn = $<HTMLButtonElement>("logPause");
  const logClearBtn = $<HTMLButtonElement>("logClear");
  const logCopyBtn = $<HTMLButtonElement>("logCopy");
  const logCopyDebugBtn = $<HTMLButtonElement>("logCopyDebug");
  const logState = $<HTMLInputElement>("logState");
  const logRaw = $<HTMLInputElement>("logRaw");
  const logMax = $<HTMLInputElement>("logMax");

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
      const disabled = inRound || (taken.has(c) && c !== myColor);
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

  readyBtn.onclick = () => {
    tryEnableAudio();
    ready = !ready;
    readyBtn.textContent = ready ? "Unready" : "Ready";
    net.sendReady(ready);
    view.focus?.();
  };

  leaveRoomBtn.onclick = () => {
    tryEnableAudio();
    net.close();
    resetClientState();
    showRoomSelect();
    startRoomsPolling();
    setStatus("disconnected");
  };

  applySettingsBtn.onclick = () => {
    tryEnableAudio();
    const cubeN = parseIntSafe(cubeNInput.value, 24);
    const roundSeconds = parseIntSafe(roundSecondsInput.value, 180);
    const tickRate = parseIntSafe(tickRateInput.value, 12);
    const fruitPerFace = parseIntSafe(fruitPerFaceInput.value, 1);
    net.sendSettings(cubeN, roundSeconds, tickRate, fruitPerFace);
  };

  forceStartBtn.onclick = () => {
    tryEnableAudio();
    if (!isHost) return;
    lobbyNoteEl.textContent = "Force starting… (unready players will be skipped)";
    net.sendForceStart();
  };

  const onNameChange = () => {
    const v = loginName.value.trim();
    if (v) localStorage.setItem("snakeName", v);
  };
  loginName.addEventListener("change", onNameChange);
  loginName.addEventListener("blur", onNameChange);

  // Expose for event handlers in this module.
  populateColorOptionsFn = populateColorOptions;
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

let roomsPollTimer: number | null = null;
let lastRoomsError: string | null = null;
let lastRoomsErrorLogged: string | null = null;

async function fetchRooms(): Promise<RoomInfo[]> {
  try {
    const host = location.hostname || "localhost";
    const isLocal = host === "localhost" || host === "127.0.0.1";
    const isLikelyViteDev = isLocal && location.port !== "8000" && location.port !== "8080";
    const origin = isLikelyViteDev ? `${location.protocol}//${host}:8000` : location.origin;
    const res = await fetch(new URL("/rooms", origin), { cache: "no-store" });
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      lastRoomsError = `HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 140)}` : ""}`;
      return [];
    }
    if (!ct.includes("application/json")) {
      const body = await res.text().catch(() => "");
      lastRoomsError = `Unexpected content-type: ${ct || "unknown"}${body ? ` — ${body.slice(0, 140)}` : ""}`;
      return [];
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch (e) {
      lastRoomsError = `Invalid JSON from /rooms: ${e instanceof Error ? e.message : String(e)}`;
      return [];
    }
    const rooms = Array.isArray(json?.rooms) ? (json.rooms as RoomInfo[]) : [];
    lastRoomsError = rooms.length ? null : "No rooms returned.";
    return rooms;
  } catch (e) {
    lastRoomsError = `Network error while loading rooms: ${e instanceof Error ? e.message : String(e)}`;
    return [];
  }
}

function renderRooms(rooms: RoomInfo[]) {
  roomList.innerHTML = "";
  for (const r of rooms) {
    const row = document.createElement("div");
    row.className = "roomRow";

    const btn = document.createElement("button");
    btn.className = "roomBtn";
    btn.textContent = r.name;

    const phase = String(r.phase ?? "lobby").toLowerCase();
    const joinable = r.joinable ?? (phase === "lobby" && r.count < r.capacity);
    btn.disabled = !joinable || r.count >= r.capacity;

    const users = document.createElement("div");
    users.className = "roomUsers";
    users.textContent = r.players && r.players.length ? r.players.join(", ") : "empty";

    btn.onclick = () => connectToRoom(r.roomId, r.name);

    row.appendChild(btn);
    row.appendChild(users);
    roomList.appendChild(row);
  }
}

async function refreshRoomsOnce() {
  const rooms = await fetchRooms();
  if (!rooms.length) {
    const msg = lastRoomsError ? `Loading failed: ${lastRoomsError}` : "Loading rooms…";
    loginStatus.textContent = msg;
    if (lastRoomsError && lastRoomsError !== lastRoomsErrorLogged) {
      lastRoomsErrorLogged = lastRoomsError;
      appendLog(`rooms: ${lastRoomsError}`);
    }
    return;
  }
  lastRoomsErrorLogged = null;
  loginStatus.textContent = "";
  renderRooms(rooms);
}

function startRoomsPolling() {
  if (roomsPollTimer != null) window.clearInterval(roomsPollTimer);
  roomsPollTimer = window.setInterval(refreshRoomsOnce, 2000);
  refreshRoomsOnce();
}

function stopRoomsPolling() {
  if (roomsPollTimer != null) window.clearInterval(roomsPollTimer);
  roomsPollTimer = null;
}

let countdownTimer: number | null = null;

function startCountdownTo(startServerTimeMs: number, onDone: () => void) {
  hideCountdown();
  showCountdown();

  if (countdownTimer != null) window.clearInterval(countdownTimer);

  let done = false;
  const tick = () => {
    const now = Date.now();
    const remaining = startServerTimeMs - now;
    const n = Math.ceil(remaining / 1000) - 1;
    if (n >= 3) {
      countdownText.textContent = "3";
      countdownText.classList.remove("start");
    } else if (n === 2) {
      countdownText.textContent = "2";
      countdownText.classList.remove("start");
    } else if (n === 1) {
      countdownText.textContent = "1";
      countdownText.classList.remove("start");
    } else {
      countdownText.textContent = "START!";
      countdownText.classList.add("start");
    }

    // Give the "START!" frame a moment, then switch to the game view.
    if (!done && remaining <= -150) {
      done = true;
      if (countdownTimer != null) window.clearInterval(countdownTimer);
      countdownTimer = null;
      hideCountdown();
      onDone();
    }
  };
  tick();
  countdownTimer = window.setInterval(tick, 80);
}

function setLoginError(msg: string) {
  loginStatus.textContent = msg;
}

function setLobbyNote(msg: string) {
  lobbyNoteEl.textContent = msg;
}

function colorHex(c: number) {
  return `#${(c >>> 0).toString(16).padStart(6, "0")}`;
}

function renderPlayersList() {
  if (!lobby) {
    playersListEl.innerHTML = "";
    return;
  }
  const players = [...lobby.players].sort((a, b) => a.playerId.localeCompare(b.playerId));
  playersListEl.innerHTML = "";
  for (const p of players) {
    const row = document.createElement("div");
    row.className = "playerRow";

    const sw = document.createElement("div");
    sw.className = "swatch";
    sw.style.height = "16px";
    sw.style.borderRadius = "6px";
    sw.style.borderWidth = "2px";
    sw.style.background = colorHex(p.color);
    sw.style.opacity = "0.95";

    const name = document.createElement("div");
    name.className = "playerName";
    name.textContent = p.playerId === myPlayerId ? `${p.name} (you)` : p.name;

    const meta = document.createElement("div");
    meta.className = "playerMeta";

    const cName = document.createElement("span");
    cName.className = "pill";
    cName.textContent = PALETTE_NAMES[p.color] ?? `#${(p.color >>> 0).toString(16).padStart(6, "0")}`;

    const st = document.createElement("span");
    st.className = "pill";
    st.textContent = p.ready ? "Ready" : "Preparing";
    if (p.ready) st.style.borderColor = "rgba(34,197,94,0.45)";

    meta.appendChild(cName);
    meta.appendChild(st);
    row.appendChild(sw);
    row.appendChild(name);
    row.appendChild(meta);
    playersListEl.appendChild(row);
  }
}

function syncSettingsUIFromLobby() {
  if (!lobby) return;
  cubeNInput.value = String(lobby.settings.cubeN);
  roundSecondsInput.value = String(lobby.settings.roundSeconds);
  tickRateInput.value = String(lobby.settings.tickRate);
  fruitPerFaceInput.value = String(lobby.settings.fruitPerFace);
}

function syncLobbyControls() {
  if (!lobby || !myPlayerId) return;
  const amHost = lobby.hostId === myPlayerId;
  isHost = amHost;

  readyBtn.disabled = inRound;
  forceStartBtn.classList.toggle("hidden", !amHost);
  const readyCount = lobby.players.filter((p) => p.ready).length;
  forceStartBtn.disabled = inRound || !ready || readyCount <= 0;

  settingsNoteEl.textContent = amHost ? "" : "(only room admin can change these)";
  cubeNInput.disabled = !amHost || inRound;
  roundSecondsInput.disabled = !amHost || inRound;
  tickRateInput.disabled = !amHost || inRound;
  fruitPerFaceInput.disabled = !amHost || inRound;
  applySettingsBtn.disabled = !amHost || inRound;
  applySettingsBtn.classList.toggle("hidden", !amHost);
}

function refreshRoomLobbyUI() {
  if (!lobby) return;
  roomTitleEl.textContent = currentRoomName ? currentRoomName : lobby.roomId;
  populateColorOptionsFn?.();
  syncSettingsUIFromLobby();
  renderPlayersList();
  syncLobbyControls();
  renderLobby();
}

function connectToRoom(roomId: string, roomName: string) {
  tryEnableAudio();
  const name = loginName.value.trim();
  if (!name) {
    setLoginError("Please enter a name first.");
    loginName.focus();
    return;
  }
  localStorage.setItem("snakeName", name);

  stopRoomsPolling();
  resetClientState();
  setLoginError("");
  currentRoomName = roomName;
  showRoomLobby();
  roomTitleEl.textContent = roomName;
  setLobbyNote(`Connecting to ${roomName}…`);
  setStatus("connecting…");

  const url = defaultWsUrl();
  net.connect(url, name, roomId, {
    onLog: appendLog,
    onClose: () => {
      hideCountdown();
      hideGame();
      resetClientState();
      showRoomSelect();
      startRoomsPolling();
      setLoginError("Disconnected.");
      setStatus("disconnected");
    },
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
      inRound = false;
      playingThisRound = false;

      readyBtn.disabled = false;
      readyBtn.textContent = "Ready";
      setLobbyNote(isHost ? "You are the host. Set options, then click Ready." : "Pick a color and click Ready.");
      refreshRoomLobbyUI();
    },
    onLobby: (l) => {
      lobby = l;
      lastLobby = l;
      rebuildPlayerColorsFromLobby(lobby);
      if (!inRound) {
        const you = myPlayerId ? lobby.players.find((p) => p.playerId === myPlayerId) : null;
        if (you) ready = !!you.ready;
        readyBtn.textContent = ready ? "Unready" : "Ready";
      }
      refreshRoomLobbyUI();
    },
    onStart: (data) => {
      tickRate = data.settings.tickRate;
      lastStart = data;
      playerColors = {};
      for (const p of data.players) playerColors[p.playerId] = p.color;
      inRound = true;
      playingThisRound = !!(myPlayerId && data.players.some((p) => p.playerId === myPlayerId));
      refreshRoomLobbyUI();

      if (!playingThisRound) {
        setLobbyNote("Round started, but you were not Ready. Wait for the next round.");
        readyBtn.disabled = true;
        return;
      }

      setLobbyNote("Starting…");
      startCountdownTo(data.startServerTimeMs, () => {
        showGame();
        const r = ensureRenderer();
        r.setCubeN(data.settings.cubeN);
        if (lastState) r.update(lastState.snakes, lastState.fruits, myPlayerId, playerColors);
        if (!inputLoopStarted) startInputLoop();
        view.focus?.();
      });

      setStatus(
        [
          `room: ${lobby?.roomId ?? "?"}`,
          `phase: running`,
          `cubeN: ${data.settings.cubeN}`,
          `tickRate: ${data.settings.tickRate}`,
          `roundSeconds: ${data.settings.roundSeconds}`,
          `fruitPerFace: ${data.settings.fruitPerFace}`,
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
      if (renderer) renderer.update(data.snakes, data.fruits, myPlayerId, playerColors);

      // Hurt/death sounds from snake state transitions.
      if (audioActive) {
        const curSnakes = new Map<string, { alive: boolean; len: number }>();
        for (const s of data.snakes) {
          const info = { alive: s.alive, len: s.cells.length };
          curSnakes.set(s.playerId, info);
          const prev = prevSnakeInfo.get(s.playerId);
          if (!prev) continue;

          // "Hurt" = length cut while still alive.
          if (prev.alive && info.alive && info.len < prev.len) {
            const loss = prev.len - info.len;
            const level = s.playerId === myPlayerId ? 1 : 0.45;
            sfx.playHurt(loss, level);
          }

          // "Die" = alive -> dead transition.
          if (prev.alive && !info.alive) {
            const level = s.playerId === myPlayerId ? 1 : 0.6;
            sfx.playDie(level);
          }
        }
        prevSnakeInfo = curSnakes;
      } else {
        prevSnakeInfo = new Map(data.snakes.map((s) => [s.playerId, { alive: s.alive, len: s.cells.length }]));
      }

      // Fruit-eat sound: play when a fruit disappears between ticks.
      const cur = new Set<string>();
      for (const f of data.fruits) cur.add(f.id);
      if (audioActive) {
        let removed = 0;
        for (const id of prevFruitIds) if (!cur.has(id)) removed++;
        if (removed > 0) sfx.playEat(removed);
      }
      prevFruitIds = cur;

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
      inRound = false;
      playingThisRound = false;
      hideCountdown();
      hideGame();
      showRoomLobby();
      setLobbyNote("Round ended. Get ready for the next one!");
      ready = false;
      readyBtn.textContent = "Ready";
      readyBtn.disabled = false;
      setStatus(["phase: ended", "", "finalScores:", JSON.stringify(data.finalScores, null, 2)].join("\n"));
    },
    onError: (data) => {
      lastError = data;
      if (lobby) {
        setLobbyNote(`${data.message}`);
        refreshRoomLobbyUI();
      } else {
        setLoginError(`${data.message}`);
        resetClientState();
        showRoomSelect();
        startRoomsPolling();
      }
      setStatus(`error: ${data.code}\n${data.message}`);
    }
  });
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
    if (!playingThisRound) return;
    if (lastServerTick < 0) return;
    const t = nextInputTick;
    nextInputTick++;
    if (desiredDir !== null) {
      const mapped = renderer?.mapScreenDirToFaceDir(desiredDir) ?? null;
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

function bootApp() {
  wireUI();
  wireInput();
  setStatus("disconnected");
  appendLog("log ready (use Pause / Copy debug if needed)");

  // Lobby boot
  loginName.value = (localStorage.getItem("snakeName") || "").trim();
  resetClientState();
  showRoomSelect();
  startRoomsPolling();

  // Attempt to enable audio once a user interacts.
  window.addEventListener("pointerdown", tryEnableAudio, { capture: true });
  window.addEventListener("keydown", tryEnableAudio, { capture: true });
}

function playIntroVideo(): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    let overlayPointerHandler: ((ev: PointerEvent) => void) | null = null;
    // Safety timeout: only to avoid blocking forever on a bad/missing asset.
    // Cleared as soon as we see any sign of successful loading/playback.
    const loadTimeoutMs = 60000;
    const loadTimer = window.setTimeout(() => finish(), loadTimeoutMs);
    const clearLoadTimer = () => window.clearTimeout(loadTimer);

    const finish = () => {
      if (finished) return;
      finished = true;
      clearLoadTimer();
      if (overlayPointerHandler) introOverlay.removeEventListener("pointerdown", overlayPointerHandler, true);
      introVideo.pause();
      introVideo.removeAttribute("src");
      introVideo.load();
      introOverlay.classList.add("hidden");
      introOverlay.setAttribute("aria-hidden", "true");
      introTapToPlayBtn.classList.add("hidden");

      introSkipBtn.onclick = null;
      introTapToPlayBtn.onclick = null;
      introVideo.onloadedmetadata = null;
      introVideo.oncanplay = null;
      introVideo.onplay = null;
      introVideo.onplaying = null;
      introVideo.ontimeupdate = null;
      introVideo.onended = null;
      introVideo.onerror = null;
      resolve();
    };

    const enableSound = async () => {
      tryEnableAudio();
      introVideo.muted = false;
      introVideo.volume = 1;
      try {
        await introVideo.play();
      } catch {
        // ignore
      }
      introTapToPlayBtn.classList.add("hidden");
    };

    const attemptStart = async () => {
      // Prefer starting with sound. If autoplay-with-sound is blocked (most browsers),
      // fall back to muted autoplay and show a clear "Enable sound" overlay button.
      introTapToPlayBtn.textContent = "Enable sound";
      introVideo.muted = false;
      introVideo.volume = 1;
      try {
        await introVideo.play();
        return;
      } catch {
        // fall through
      }

      introVideo.muted = true;
      try {
        await introVideo.play();
      } catch {
        // If even muted autoplay is blocked, wait for a user gesture.
      }
      introTapToPlayBtn.classList.remove("hidden");
    };

    introOverlay.classList.remove("hidden");
    introOverlay.setAttribute("aria-hidden", "false");

    introSkipBtn.onclick = finish;
    introTapToPlayBtn.onclick = () => void enableSound();

    // If the intro is running muted, allow any click/tap (except Skip) to enable sound.
    overlayPointerHandler = (ev: PointerEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t === introSkipBtn) return;
      if (!introVideo.muted) return;
      void enableSound();
    };
    introOverlay.addEventListener("pointerdown", overlayPointerHandler, true);

    introVideo.onloadedmetadata = clearLoadTimer;
    introVideo.oncanplay = clearLoadTimer;
    introVideo.onplay = clearLoadTimer;
    introVideo.onplaying = () => {
      clearLoadTimer();
    };
    introVideo.ontimeupdate = () => {
      if (introVideo.currentTime > 0) clearLoadTimer();
    };
    introVideo.onended = finish;
    introVideo.onerror = finish;

    introVideo.playsInline = true;
    introVideo.autoplay = true;
    introVideo.preload = "auto";
    introVideo.src = introVideoUrl();
    introVideo.currentTime = 0;

    void attemptStart();
  });
}

async function start() {
  // Keep login hidden until the intro has finished (or fails to load).
  loginOverlay.classList.add("hidden");
  appEl.classList.add("hidden");

  await playIntroVideo();
  bootApp();
}

void start();
