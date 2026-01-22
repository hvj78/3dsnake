import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  // When the frontend is served by the backend, it is mounted at `/play/`.
  // Vite needs `base` so built asset URLs point to `/play/assets/...` instead of `/assets/...`.
  base: command === "build" ? "/play/" : "/",
  server: {
    port: 5173
  }
}));
