import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  // Read only the proxy port and direct-browser opt-in here. AI_* never enters the client bundle.
  const env = loadEnv(mode, process.cwd(), "");
  const gatewayPort = env.AI_GATEWAY_PORT || env.DSPY_GATEWAY_PORT || "8001";
  if (!/^\d+$/.test(gatewayPort) || Number(gatewayPort) < 1 || Number(gatewayPort) > 65535) {
    throw new Error("AI_GATEWAY_PORT must be a valid port number.");
  }
  const gateway = `http://127.0.0.1:${gatewayPort}`;
  const directBrowser = Boolean(env.VITE_AI_API_URL?.trim());
  return {
    server: {
      proxy: {
        "/v1": gateway,
        "/health": gateway,
        ...(!directBrowser && { "/config/runtime-config.js": gateway }),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            "react-vendor": ["react", "react-dom"],
            "chart-vendor": [
              "chart.js",
              "react-chartjs-2",
              "chartjs-plugin-annotation",
              "chartjs-plugin-zoom"
            ],
            "data-vendor": ["xlsx", "papaparse", "jstat"],
            "ui-vendor": ["lucide-react", "@tanstack/react-table", "react-dropzone"]
          }
        }
      }
    }
  };
});
