import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [react(), VitePWA({
    strategies: "injectManifest",
    srcDir: "src",
    filename: "sw.ts",
    registerType: "prompt",
    injectRegister: false,
    manifest: {
      name: "llm-chat",
      short_name: "llm-chat",
      description: "聊天与日常工作助手",
      theme_color: "#147a5b",
      background_color: "#f6f8f7",
      display: "standalone",
      start_url: "/",
      scope: "/",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
      ]
    },
    injectManifest: {
      globPatterns: [
        "index.html",
        "manifest.webmanifest",
        "icons/*.png",
        "assets/index-*.{js,css}",
        "assets/_commonjsHelpers-*.js",
        "assets/react-vendor-*.js",
        "assets/createClass-*.js",
        "assets/clsx-*.js",
        "assets/antd-*.js",
        "assets/Middleware-*.js",
        "assets/interopRequireDefault-*.js",
        "assets/WarningOutlined-*.js",
        "assets/purify.es-*.js",
        "assets/ant-x-*.js",
        "assets/workbox-window*.js"
      ],
      maximumFileSizeToCacheInBytes: 512 * 1024
    }
  })],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000"
    }
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          const path = id.replaceAll("\\", "/");
          if (!path.includes("/node_modules/")) return undefined;
          if (path.includes("/react@") || path.includes("/react-dom@") || path.includes("/scheduler@")) return "react-vendor";
          if (path.includes("/@ant-design+x@")) return "ant-x";
          if (path.includes("/@ant-design+icons@")) return "antd-icons";
          if (path.includes("/@ant-design+cssinjs@")) return "antd-style";
          if (path.includes("/antd@")) return "antd";
          if (path.includes("/@rc-component+") || path.includes("/rc-")) return "antd-rc";
          return undefined;
        }
      }
    }
  }
});
