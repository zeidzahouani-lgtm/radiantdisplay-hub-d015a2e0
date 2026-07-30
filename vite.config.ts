import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

const LEGACY_BROWSER_TARGET = "es2017";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const rawBase = (env.VITE_APP_BASE_PATH || "/").trim();
  const base =
    rawBase === "/" || rawBase === ""
      ? "/"
      : `/${rawBase.replace(/^\/+|\/+$/g, "")}/`;

  return {
    base,
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
    },
    build: {
      target: LEGACY_BROWSER_TARGET,
    },
    esbuild: {
      target: LEGACY_BROWSER_TARGET,
    },
    plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
    resolve: {
      alias: [
        {
          find: "@/integrations/supabase/client",
          replacement: path.resolve(__dirname, "./src/integrations/supabase/runtime-client.ts"),
        },
        {
          find: "@",
          replacement: path.resolve(__dirname, "./src"),
        },
      ],
      dedupe: ["react", "react-dom", "react/jsx-runtime", "@tanstack/react-query"],
    },
    optimizeDeps: {
      include: ["react", "react-dom", "@tanstack/react-query"],
      esbuildOptions: {
        target: LEGACY_BROWSER_TARGET,
      },
    },
  };
});
