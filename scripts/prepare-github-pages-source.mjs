import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const basePath = `/${(process.env.GITHUB_PAGES_BASE_PATH ?? "/event-horizon-finder/")
  .replace(/^\/+|\/+$/g, "")}/`;

async function read(path) {
  return readFile(path, "utf8");
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Expected ${label} fragment was not found`);
  }
  return source.replace(before, after);
}

async function update(path, transform) {
  const current = await read(path);
  const next = transform(current);
  if (next === current) throw new Error(`No change was produced for ${path}`);
  await write(path, next);
}

const DEPLOYMENT_PATHS_SOURCE = "function normalizeBasePath(value: string | undefined): string {\n  const normalized = (value ?? \"/\").trim().replace(/^\\/+|\\/+$/g, \"\");\n  return normalized ? `/${normalized}` : \"\";\n}\n\nexport const APP_BASE_PATH = normalizeBasePath(import.meta.env.BASE_URL);\nexport const APP_ROUTER_BASE_PATH = APP_BASE_PATH || \"/\";\n\nexport function withAppBasePath(value = \"/\"): string {\n  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith(\"//\")) return value;\n\n  const normalized = value.startsWith(\"/\") ? value : `/${value}`;\n  if (!APP_BASE_PATH) return normalized;\n  if (\n    normalized === APP_BASE_PATH ||\n    normalized.startsWith(`${APP_BASE_PATH}/`) ||\n    normalized.startsWith(`${APP_BASE_PATH}?`) ||\n    normalized.startsWith(`${APP_BASE_PATH}#`)\n  ) {\n    return normalized;\n  }\n  return normalized === \"/\" ? `${APP_BASE_PATH}/` : `${APP_BASE_PATH}${normalized}`;\n}\n\nexport function appAbsoluteUrl(\n  value = \"/\",\n  origin = typeof window !== \"undefined\"\n    ? window.location.origin\n    : \"https://event-horizon-finder.vercel.app\",\n): string {\n  return new URL(withAppBasePath(value), `${origin.replace(/\\/+$/, \"\")}/`).toString();\n}\n";
const PWA_RUNTIME_SOURCE = "import { useEffect } from \"react\";\n\nconst STORAGE_KEY = \"global-party-sw-reloaded\";\n\nexport function PwaRuntime() {\n  useEffect(() => {\n    if (!(\"serviceWorker\" in navigator)) return;\n\n    let active = true;\n    const serviceWorkerUrl = `${import.meta.env.BASE_URL}sw.js`;\n    const serviceWorkerScope = import.meta.env.BASE_URL;\n\n    const register = async () => {\n      try {\n        const registration = await navigator.serviceWorker.register(serviceWorkerUrl, {\n          scope: serviceWorkerScope,\n          updateViaCache: \"none\",\n        });\n        if (!active) return;\n        await registration.update();\n\n        navigator.serviceWorker.addEventListener(\"controllerchange\", () => {\n          if (sessionStorage.getItem(STORAGE_KEY) === \"1\") return;\n          sessionStorage.setItem(STORAGE_KEY, \"1\");\n          window.location.reload();\n        });\n      } catch (error) {\n        console.warn(\"[PWA] Service worker registration failed\", error);\n      }\n    };\n\n    void register();\n    return () => {\n      active = false;\n    };\n  }, []);\n\n  return null;\n}\n";
const SERVICE_WORKER_SOURCE = "const VERSION = \"global-party-v5-2026-08-01\";\nconst STATIC_CACHE = `${VERSION}-static`;\nconst RUNTIME_CACHE = `${VERSION}-runtime`;\nconst REGISTRATION_SCOPE = new URL(self.registration.scope);\nconst SCOPE_PATH = REGISTRATION_SCOPE.pathname.replace(/\\/$/, \"\");\n\nconst scopedPath = (path) => {\n  const normalized = path.startsWith(\"/\") ? path : `/${path}`;\n  return `${SCOPE_PATH}${normalized}` || \"/\";\n};\n\nconst appRelativePath = (pathname) => {\n  if (!SCOPE_PATH) return pathname;\n  if (pathname === SCOPE_PATH) return \"/\";\n  return pathname.startsWith(`${SCOPE_PATH}/`) ? pathname.slice(SCOPE_PATH.length) : pathname;\n};\n\nconst OFFLINE_URL = scopedPath(\"/offline.html\");\nconst STATIC_ASSETS = [\n  scopedPath(\"/\"),\n  OFFLINE_URL,\n  scopedPath(\"/manifest.webmanifest\"),\n  scopedPath(\"/brand/global-party-logo.png\"),\n  scopedPath(\"/brand/global-party-intro-poster.jpg\"),\n];\n\nconst SENSITIVE_PATHS = [\n  \"/auth\",\n  \"/reset-password\",\n  \"/favorites\",\n  \"/settings\",\n  \"/organizer\",\n  \"/admin\",\n  \"/mcp\",\n  \"/api\",\n];\n\nself.addEventListener(\"install\", (event) => {\n  event.waitUntil(\n    caches\n      .open(STATIC_CACHE)\n      .then((cache) => Promise.allSettled(STATIC_ASSETS.map((asset) => cache.add(asset))))\n      .then(() => self.skipWaiting()),\n  );\n});\n\nself.addEventListener(\"activate\", (event) => {\n  event.waitUntil(\n    caches\n      .keys()\n      .then((keys) =>\n        Promise.all(\n          keys\n            .filter(\n              (key) =>\n                key.startsWith(\"global-party-\") &&\n                ![STATIC_CACHE, RUNTIME_CACHE].includes(key),\n            )\n            .map((key) => caches.delete(key)),\n        ),\n      )\n      .then(() => self.clients.claim()),\n  );\n});\n\nconst isSensitivePath = (pathname) =>\n  SENSITIVE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));\n\nasync function networkOnly(request) {\n  try {\n    return await fetch(request);\n  } catch {\n    if (request.mode === \"navigate\") {\n      const cached = await caches.match(OFFLINE_URL);\n      if (cached) return cached;\n    }\n    throw new Error(\"network_unavailable\");\n  }\n}\n\nasync function staleWhileRevalidate(request) {\n  const cache = await caches.open(RUNTIME_CACHE);\n  const cached = await cache.match(request);\n  const fresh = fetch(request)\n    .then((response) => {\n      if (response.ok && response.type === \"basic\") {\n        void cache.put(request, response.clone());\n      }\n      return response;\n    })\n    .catch(() => null);\n  return cached ?? (await fresh) ?? Response.error();\n}\n\nself.addEventListener(\"fetch\", (event) => {\n  const request = event.request;\n  if (request.method !== \"GET\") return;\n\n  const url = new URL(request.url);\n  const relativePath = appRelativePath(url.pathname);\n  if (\n    url.origin !== self.location.origin ||\n    isSensitivePath(relativePath) ||\n    relativePath.startsWith(\"/rest/\") ||\n    relativePath.startsWith(\"/functions/\")\n  ) {\n    event.respondWith(networkOnly(request));\n    return;\n  }\n\n  if (request.mode === \"navigate\") {\n    event.respondWith(networkOnly(request));\n    return;\n  }\n\n  if (\n    url.pathname.startsWith(scopedPath(\"/assets/\")) ||\n    [\"style\", \"script\", \"font\", \"image\"].includes(request.destination)\n  ) {\n    event.respondWith(staleWhileRevalidate(request));\n  }\n});\n";

await update("vite.config.ts", (initial) => {
  let source = replaceOnce(
    initial,
    '  "";\n\nexport default defineConfig({',
    `  "";\n\nconst isGitHubPagesBuild = process.env.GITHUB_PAGES === "true";\nconst githubPagesBase = ${JSON.stringify(basePath)};\n\nexport default defineConfig({`,
    "GitHub Pages build flag",
  );
  source = replaceOnce(
    source,
    "  vite: {\n    define:",
    "  vite: {\n    base: isGitHubPagesBuild ? githubPagesBase : \"/\",\n    define:",
    "Vite base path",
  );
  source = replaceOnce(
    source,
    '    server: { entry: "server" },\n  },',
    '    server: { entry: "server" },\n    ...(isGitHubPagesBuild ? { spa: { enabled: true } } : {}),\n  },',
    "TanStack Start SPA mode",
  );
  return source;
});

await write("src/lib/deployment-paths.ts", DEPLOYMENT_PATHS_SOURCE);

await update("src/router.tsx", (initial) => {
  let source = replaceOnce(
    initial,
    'import { createRouter } from "@tanstack/react-router";',
    'import { createRouter } from "@tanstack/react-router";\nimport { APP_ROUTER_BASE_PATH } from "@/lib/deployment-paths";',
    "router base path import",
  );
  source = replaceOnce(
    source,
    "    routeTree,\n    context:",
    "    routeTree,\n    basepath: APP_ROUTER_BASE_PATH,\n    context:",
    "router base path",
  );
  return source;
});

await update("src/integrations/supabase/client.ts", (source) =>
  replaceOnce(
    source,
    '    proxyOrigin = typeof window !== "undefined" ? window.location.origin : null,',
    '    proxyOrigin =\n      import.meta.env.VITE_SERVER_ORIGIN?.trim() ||\n      (typeof window !== "undefined" ? window.location.origin : null),',
    "Supabase proxy origin",
  ),
);

await update("src/routes/__root.tsx", (initial) => {
  let source = replaceOnce(
    initial,
    'import { LanguageProvider, useTranslation } from "@/lib/i18n";',
    'import { LanguageProvider, useTranslation } from "@/lib/i18n";\nimport { withAppBasePath } from "@/lib/deployment-paths";',
    "root deployment path import",
  );
  source = replaceOnce(
    source,
    '          href="/"',
    '          href={withAppBasePath("/")}',
    "root home link",
  );
  for (const asset of [
    "/brand/global-party-logo.png",
    "/favicon.ico",
    "/manifest.webmanifest",
  ]) {
    source = source.replaceAll(`href: "${asset}"`, `href: withAppBasePath("${asset}")`);
  }
  return source;
});

await update("src/components/brand/brand-logo.tsx", (initial) => {
  let source = replaceOnce(
    initial,
    'import type { ComponentProps } from "react";',
    'import type { ComponentProps } from "react";\nimport { withAppBasePath } from "@/lib/deployment-paths";',
    "brand logo deployment path import",
  );
  source = replaceOnce(
    source,
    '        href="/brand/global-party-logo.png"',
    '        href={withAppBasePath("/brand/global-party-logo.png")}',
    "brand logo asset",
  );
  return source;
});

await update("src/components/brand/brand-arrival.tsx", (initial) => {
  let source = replaceOnce(
    initial,
    'import "./brand-arrival.css";',
    'import { withAppBasePath } from "@/lib/deployment-paths";\nimport "./brand-arrival.css";',
    "brand arrival deployment path import",
  );
  source = replaceOnce(
    source,
    'poster="/brand/global-party-intro-poster.jpg"',
    'poster={withAppBasePath("/brand/global-party-intro-poster.jpg")}',
    "brand arrival poster",
  );
  source = replaceOnce(
    source,
    'src="/brand/global-party-intro.mp4"',
    'src={withAppBasePath("/brand/global-party-intro.mp4")}',
    "brand arrival video",
  );
  return source;
});

await update("src/components/brand/brand-arrival.css", (source) =>
  source.replaceAll(
    'url("/brand/global-party-intro-poster.jpg")',
    `url("${basePath}brand/global-party-intro-poster.jpg")`,
  ),
);

await update("src/routes/auth.tsx", (initial) => {
  let source = replaceOnce(
    initial,
    'import { useTranslation } from "@/lib/i18n";',
    'import { useTranslation } from "@/lib/i18n";\nimport { appAbsoluteUrl, withAppBasePath } from "@/lib/deployment-paths";',
    "auth deployment path import",
  );
  source = replaceOnce(
    source,
    "    else window.location.assign(target);",
    "    else window.location.assign(withAppBasePath(target));",
    "auth navigation",
  );
  source = replaceOnce(
    source,
    '            emailRedirectTo: new URL(\n              accountType === "organizer" ? "/organizer" : destination,\n              window.location.origin,\n            ).toString(),',
    '            emailRedirectTo: appAbsoluteUrl(\n              accountType === "organizer" ? "/organizer" : destination,\n            ),',
    "auth signup callback",
  );
  source = replaceOnce(
    source,
    '          redirectTo: `${window.location.origin}/reset-password`,',
    '          redirectTo: appAbsoluteUrl("/reset-password"),',
    "auth reset callback",
  );
  return source;
});

await update("src/lib/monetization.ts", (initial) => {
  let source = replaceOnce(
    initial,
    'import { supabase } from "@/integrations/supabase/client";',
    'import { supabase } from "@/integrations/supabase/client";\nimport { appAbsoluteUrl } from "@/lib/deployment-paths";',
    "monetization deployment path import",
  );
  source = source.replaceAll(
    'const returnUrl = `${window.location.origin}/organizer/billing`;',
    'const returnUrl = appAbsoluteUrl("/organizer/billing");',
  );
  return source;
});

await update("src/lib/ad-queries.ts", (initial) => {
  let source = replaceOnce(
    initial,
    'import { getClientSessionId } from "@/lib/client-analytics";',
    'import { getClientSessionId } from "@/lib/client-analytics";\nimport { appAbsoluteUrl } from "@/lib/deployment-paths";',
    "ad deployment path import",
  );
  source = replaceOnce(
    source,
    '  const returnUrl = `${window.location.origin}/organizer/ads`;',
    '  const returnUrl = appAbsoluteUrl("/organizer/ads");',
    "ad return URL",
  );
  return source;
});

await write("src/components/pwa-runtime.tsx", PWA_RUNTIME_SOURCE);
await write("public/sw.js", SERVICE_WORKER_SOURCE);

console.log(`Prepared source for GitHub Pages at ${basePath}`);
