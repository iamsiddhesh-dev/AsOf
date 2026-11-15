import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The API is a separate process during development, so the proxy keeps every
 * request same-origin. That means no CORS middleware on the server and no
 * second base URL in the client.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:8787" },
      "/health": { target: "http://localhost:8787" },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
