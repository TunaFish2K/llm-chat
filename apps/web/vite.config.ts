import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const apiTarget = process.env.LLM_CHAT_DEV_API ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        name: "Chat",
        short_name: "Chat",
        description: "单用户 LLM 聊天与 Agent 工作台",
        lang: "zh-CN",
        theme_color: "#0d100e",
        background_color: "#0d100e",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icons/icon-192-v2.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512-v2.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-1024-v2.png", sizes: "1024x1024", type: "image/png" },
          { src: "/icons/icon-maskable-512-v2.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest,woff2}"],
        maximumFileSizeToCacheInBytes: 1024 * 1024
      }
    })
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
        configure(proxy) {
          proxy.on("proxyRes", (proxyRes) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
            }
          });
        }
      }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replaceAll("\\", "/");
          if (!path.includes("/node_modules/")) return undefined;
          if (path.includes("/react@") || path.includes("/react-dom@") || path.includes("/scheduler@")) return "react-vendor";
          if (path.includes("/streamdown@") || path.includes("/unified@") || path.includes("/remark-") || path.includes("/rehype-") || path.includes("/shiki@")) return "markdown";
          if (path.includes("/katex@")) return "katex";
          if (path.includes("/radix-ui@") || path.includes("/@radix-ui+")) return "radix";
          return undefined;
        }
      }
    }
  }
});
