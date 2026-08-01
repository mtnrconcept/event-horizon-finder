import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outputDirectory = ".github-pages-site";
const basePath = `/${(process.env.GITHUB_PAGES_BASE_PATH ?? "/event-horizon-finder/").replace(
  /^\/+|\/+$/g,
  "",
)}/`;
const candidates = [".output/public", "dist/client", "dist", "build/client"];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

let sourceDirectory = null;
for (const candidate of candidates) {
  if (
    (await exists(join(candidate, "_shell.html"))) ||
    (await exists(join(candidate, "index.html")))
  ) {
    sourceDirectory = candidate;
    break;
  }
}

if (!sourceDirectory) {
  throw new Error(`GitHub Pages output not found. Checked: ${candidates.join(", ")}`);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(sourceDirectory, outputDirectory, { recursive: true });

const shellPath = (await exists(join(outputDirectory, "_shell.html")))
  ? join(outputDirectory, "_shell.html")
  : join(outputDirectory, "index.html");
const shell = await readFile(shellPath, "utf8");
await writeFile(join(outputDirectory, "index.html"), shell, "utf8");
await writeFile(join(outputDirectory, "404.html"), shell, "utf8");
await writeFile(join(outputDirectory, ".nojekyll"), "", "utf8");

const manifestPath = join(outputDirectory, "manifest.webmanifest");
if (await exists(manifestPath)) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.id = basePath;
  manifest.start_url = basePath;
  manifest.scope = basePath;
  manifest.icons = (manifest.icons ?? []).map((icon) => ({
    ...icon,
    src: `${basePath}${String(icon.src ?? "").replace(/^\/+/, "")}`,
  }));
  manifest.shortcuts = (manifest.shortcuts ?? []).map((shortcut) => ({
    ...shortcut,
    url: `${basePath}${String(shortcut.url ?? "").replace(/^\/+/, "")}`,
  }));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

const offlinePath = join(outputDirectory, "offline.html");
if (await exists(offlinePath)) {
  const offline = (await readFile(offlinePath, "utf8")).replaceAll(
    'src="/brand/',
    `src="${basePath}brand/`,
  );
  await writeFile(offlinePath, offline, "utf8");
}

for (const required of ["index.html", "404.html", "sw.js", "manifest.webmanifest"]) {
  if (!(await exists(join(outputDirectory, required)))) {
    throw new Error(`Missing GitHub Pages artifact: ${required}`);
  }
}

if (!shell.includes(basePath)) {
  throw new Error(`Generated shell does not reference the GitHub Pages base path ${basePath}`);
}

console.log(
  `Prepared GitHub Pages artifact from ${sourceDirectory} at ${outputDirectory} with base ${basePath}`,
);
