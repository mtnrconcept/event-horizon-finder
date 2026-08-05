import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vercel", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  eslintPluginPrettier,
  {
    files: [
      "src/components/ui/**/*.{ts,tsx}",
      "src/lib/i18n.tsx",
    ],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    files: [
      "scripts/apply-poi-map-layer.mjs",
      "scripts/apply-home-place-search.mjs",
      "scripts/apply-place-scraper-enrichment.mjs",
      "scripts/apply-map-consistency-performance.mjs",
      "scripts/apply-adaptive-map-rendering.mjs",
      "supabase/functions/global-place-discovery/index.ts",
      "supabase/functions/global-place-discovery/enrichment.ts",
      "supabase/functions/ladecadanse-discovery/**/*.ts",
      "src/components/home-place-search-results.tsx",
      "src/components/place-detail-dialog.tsx",
      "src/hooks/usePlaceMapDiscovery.ts",
      "src/hooks/usePlaceMapLayer.ts",
      "src/lib/place-discovery.ts",
      "src/lib/place-pin-session-cache.ts",
      "tests/map-clusters.test.ts",
      "tests/place-pin-session-cache.test.ts",
    ],
    rules: {
      "prettier/prettier": "off",
    },
  },
  {
    files: [
      "supabase/functions/global-place-discovery/enrichment.ts",
      "supabase/functions/ladecadanse-discovery/**/*.ts",
    ],
    rules: {
      "no-useless-escape": "off",
    },
  },
);
