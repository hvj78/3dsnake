export type Msg<T extends string, P> = { v: 1; type: T; payload: P };

export type Turn = -1 | 0 | 1;
export type Dir = 0 | 1 | 2 | 3; // N,E,S,W in-face
export type CellId = number;

export type GameSettings = {
  cubeN: number;
  roundSeconds: number;
  tickRate: number;
  fruitTarget: number;
};

export type LobbyState = {
  roomId: string;
  hostId: string | null;
  players: Array<{ playerId: string; name: string; ready: boolean; color: number }>;
  settings: { cubeN: number; roundSeconds: number; tickRate: number };
};

export type SnakeState = {
  playerId: string;
  alive: boolean;
  dir: Dir;
  cells: CellId[];
  respawnInMs?: number | null;
};

export type FruitState = {
  id: string;
  cell: CellId;
  kind: "berry" | "apple" | "banana" | "watermelon";
  value: 2 | 3 | 5 | 10;
};

export type C2S =
  | Msg<"join", { name: string; roomId?: string }>
  | Msg<"set_settings", { cubeN: number; roundSeconds: number; tickRate: number }>
  | Msg<"set_color", { color: number }>
  | Msg<"ready", { ready: boolean }>
  | Msg<"force_start", {}>
  | Msg<"input", { inputs: Array<{ tick: number; dir?: Dir; turn?: Turn }> }>
  | Msg<"leave", {}>
  | Msg<"ping", { clientTimeMs: number }>;

export type S2C =
  | Msg<"joined", { playerId: string; roomId: string; isHost: boolean; lobby: LobbyState }>
  | Msg<"lobby_state", { lobby: LobbyState }>
  | Msg<"start", { settings: GameSettings; seed: number; startTick: number; startServerTimeMs: number; players: Array<{ playerId: string; name: string; color: number }> }>
  | Msg<"state", { tick: number; serverTimeMs: number; timerMsLeft: number; snakes: SnakeState[]; fruits: FruitState[]; scores: Record<string, number>; inputAck: Record<string, number> }>
  | Msg<"end", { finalScores: Record<string, number> }>
  | Msg<"error", { code: string; message: string }>
  | Msg<"pong", { clientTimeMs: number; serverTimeMs: number }>;
