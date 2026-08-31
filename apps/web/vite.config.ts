import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
