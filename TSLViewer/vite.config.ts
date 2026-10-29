import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and never clears the screen so Rust errors stay visible.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
