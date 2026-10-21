import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    // Listen on every interface so the app is reachable from the LAN, not only localhost.
    host: true,
    port: 5173,
    strictPort: true,
    // xfwd: the server checks the origin of uploads against the host people actually use.
    proxy: { "/api": { target: "http://localhost:3000", xfwd: true } },
  },
});
