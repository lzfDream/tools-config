import { resolve } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  root: resolve(import.meta.dirname, "web"),
  plugins: [vue()],
  build: {
    cssMinify: false,
    cssTarget: "chrome107",
    outDir: resolve(import.meta.dirname, "web-dist"),
    emptyOutDir: true,
  },
});
