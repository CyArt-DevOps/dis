import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5180,
    // `npm run dev` here talks to the bot's API on WEB_PORT.
    proxy: { "/api": { target: "http://localhost:8090", changeOrigin: true } },
  },
});
