import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    // Teammate preview via Cloudflare quick tunnels: the tunneled hostname
    // must be allowed or Vite 403s ("Blocked request ... not allowed").
    allowedHosts: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:4000", changeOrigin: false },
      "/uploads": { target: "http://127.0.0.1:4000", changeOrigin: false },
    },
  },
});
