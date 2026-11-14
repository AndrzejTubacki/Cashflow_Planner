import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "../public",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/legacy": "http://127.0.0.1:3000"
    }
  }
});
