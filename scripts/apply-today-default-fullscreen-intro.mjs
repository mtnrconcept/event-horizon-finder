import { readFile, writeFile } from "node:fs/promises";

const indexPath = new URL("../src/routes/index.tsx", import.meta.url);
const mapPath = new URL("../src/routes/map.tsx", import.meta.url);
const introCssPath = new URL("../src/components/brand/brand-arrival.css", import.meta.url);
const testPath = new URL("../tests/today-default-fullscreen-intro.test.ts", import.meta.url);

async function replaceOnce(path, before, after, label) {
  let source = await readFile(path, "utf8");
  if (source.includes(after)) return;
  if (!source.includes(before)) {
    throw new Error(`Expected ${label} fragment was not found`);
  }
  source = source.replace(before, after);
  await writeFile(path, source);
}

await replaceOnce(
  indexPath,
  '  const [range, setRange] = useState<QuickRange>("year");',
  '  const [range, setRange] = useState<QuickRange>("today");',
  "home default range",
);

await replaceOnce(
  mapPath,
  '  const [range, setRange] = useState<QuickRange>("year");',
  '  const [range, setRange] = useState<QuickRange>("today");',
  "map default range",
);

await replaceOnce(
  introCssPath,
  `.brand-arrival {
  position: fixed;
  z-index: 1000;
  right: max(1rem, env(safe-area-inset-right));
  bottom: max(1rem, env(safe-area-inset-bottom));
  display: grid;
  place-items: center;
  width: min(24rem, calc(100vw - 2rem));
  overflow: visible;
  isolation: isolate;
  contain: layout paint;
  color: white;
  background: transparent;
  opacity: 1;
  transition: opacity 280ms ease;
  touch-action: manipulation;
  pointer-events: none;
}`,
  `.brand-arrival {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  isolation: isolate;
  contain: layout paint;
  color: white;
  background: #000;
  opacity: 1;
  transition: opacity 280ms ease;
  touch-action: none;
  pointer-events: auto;
}`,
  "fullscreen arrival shell",
);

await replaceOnce(
  introCssPath,
  `.brand-arrival::before {
  position: absolute;
  z-index: -2;
  inset: -1rem;
  content: "";
  background:
    linear-gradient(180deg, rgb(2 4 10 / 12%), rgb(2 4 10 / 68%)),
    url("/brand/global-party-intro-poster.jpg") center / cover no-repeat;
  border-radius: 2rem;
  filter: blur(22px) saturate(1.2);
  opacity: 0.45;
}`,
  `.brand-arrival::before {
  position: absolute;
  z-index: -2;
  inset: 0;
  content: "";
  background:
    linear-gradient(180deg, rgb(2 4 10 / 10%), rgb(2 4 10 / 46%)),
    url("/brand/global-party-intro-poster.jpg") center / cover no-repeat;
  filter: blur(18px) saturate(1.15) scale(1.06);
  opacity: 0.72;
}`,
  "fullscreen arrival backdrop",
);

await replaceOnce(
  introCssPath,
  `.brand-arrival::after {
  position: absolute;
  z-index: -1;
  inset: 0;
  border-radius: 1.25rem;
  content: "";
  pointer-events: none;
  background:
    radial-gradient(circle at 50% 44%, rgb(61 215 255 / 10%), transparent 36%),
    linear-gradient(90deg, rgb(0 0 0 / 58%), transparent 34% 66%, rgb(0 0 0 / 58%));
}`,
  `.brand-arrival::after {
  position: absolute;
  z-index: -1;
  inset: 0;
  content: "";
  pointer-events: none;
  background:
    radial-gradient(circle at 50% 44%, rgb(61 215 255 / 8%), transparent 40%),
    linear-gradient(90deg, rgb(0 0 0 / 32%), transparent 30% 70%, rgb(0 0 0 / 32%));
}`,
  "fullscreen arrival overlay",
);

await replaceOnce(
  introCssPath,
  `.brand-arrival__stage {
  position: relative;
  width: 100%;
  max-height: min(72vh, 46rem);
  max-height: min(72dvh, 46rem);
  aspect-ratio: 512 / 910;
  overflow: hidden;
  border-radius: 1.25rem;
  background: #000;
  box-shadow:
    0 0 0 1px rgb(126 223 255 / 12%),
    0 0 80px rgb(35 178 255 / 14%),
    0 0 140px rgb(138 83 255 / 10%);
  pointer-events: auto;
}`,
  `.brand-arrival__stage {
  position: relative;
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: #000;
  pointer-events: auto;
}`,
  "fullscreen video stage",
);

await replaceOnce(
  introCssPath,
  `  object-fit: contain;
  background: #000;`,
  `  object-fit: cover;
  object-position: center;
  background: #000;`,
  "fullscreen video fit",
);

await replaceOnce(
  introCssPath,
  `@media (max-width: 767px) and (orientation: portrait) {
  .brand-arrival {
    right: max(0.5rem, env(safe-area-inset-right));
    bottom: max(0.5rem, env(safe-area-inset-bottom));
    width: min(21rem, calc(100vw - 1rem));
  }

  .brand-arrival__stage {
    max-height: 64vh;
    max-height: 64dvh;
  }

  .brand-arrival__video {
    object-fit: contain;
  }
}`,
  `@media (max-width: 767px) and (orientation: portrait) {
  .brand-arrival__video {
    object-fit: cover;
    object-position: center;
  }
}`,
  "mobile fullscreen intro",
);

await replaceOnce(
  introCssPath,
  `@media (max-aspect-ratio: 9 / 20) and (max-width: 767px) {
  .brand-arrival__video {
    object-fit: contain;
  }
}`,
  `@media (max-aspect-ratio: 9 / 20) and (max-width: 767px) {
  .brand-arrival__video {
    object-fit: cover;
    object-position: center;
  }
}`,
  "narrow mobile fullscreen intro",
);

const testSource = `import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\n\nconst home = await readFile(new URL("../src/routes/index.tsx", import.meta.url), "utf8");\nconst map = await readFile(new URL("../src/routes/map.tsx", import.meta.url), "utf8");\nconst introCss = await readFile(new URL("../src/components/brand/brand-arrival.css", import.meta.url), "utf8");\n\ntest("home and map default to today's events", () => {\n  assert.match(home, /useState<QuickRange>\\(\"today\"\\)/);\n  assert.match(map, /useState<QuickRange>\\(\"today\"\\)/);\n  assert.doesNotMatch(home, /useState<QuickRange>\\(\"year\"\\)/);\n  assert.doesNotMatch(map, /useState<QuickRange>\\(\"year\"\\)/);\n});\n\ntest("brand arrival occupies the complete viewport", () => {\n  assert.match(introCss, /\\.brand-arrival \\{[\\s\\S]*inset: 0;/);\n  assert.match(introCss, /height: 100dvh;/);\n  assert.match(introCss, /\\.brand-arrival__stage \\{[\\s\\S]*width: 100vw;[\\s\\S]*height: 100dvh;/);\n  assert.match(introCss, /object-fit: cover;/);\n});\n`;
await writeFile(testPath, testSource);
