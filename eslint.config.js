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
      "scripts/apply-poi-map-layer.mjs",
      "scripts/apply-home-place-search.mjs",
      "scripts/apply-place-scraper-enrichment.mjs",
      "supabase/functions/global-place-discovery/index.ts",
      "supabase/functions/global-place-discovery/enrichment.ts",
      "src/components/home-place-search-results.tsx",
      "src/components/place-detail-dialog.tsx",
      "src/lib/place-discovery.ts",
      "tests/map-clusters.test.ts",
    ],
    rules: {
      "prettier/prettier": "off",
    },
  },
  {
    files: ["supabase/functions/global-place-discovery/enrichment.ts"],
    rules: {
      "no-useless-escape": "off",
    },
  },
);
