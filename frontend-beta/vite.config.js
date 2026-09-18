import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/beta/",
  plugins: [react()],
  build: {
    outDir: "../public-beta",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/styles": "http://127.0.0.1:3000",
      "/favicon.png": "http://127.0.0.1:3000"
    }
  }
});
