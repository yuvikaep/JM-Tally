import process from "node:process"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Local dev: browser calls /api/* on the Vite port; proxy to server.mjs (default 4173).
// Run in another terminal: node server.mjs (with DATABASE_URL, JWT_SECRET, FRONTEND_URL=http://localhost:5173)
const API_TARGET = process.env.VITE_DEV_API_PROXY || "http://127.0.0.1:4173"

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
})
