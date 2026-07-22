import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const candidateDirectories = [
  ".output/public/assets",
  "dist/assets",
  "build/client/assets",
  ".vercel/output/static/assets",
];

const assetsDirectory = candidateDirectories.find((directory) => existsSync(directory));
if (!assetsDirectory) {
  console.error(`Aucun dossier d’assets trouvé parmi : ${candidateDirectories.join(", ")}`);
  process.exit(1);
}

const limits = {
  singleJavaScriptGzip: 500 * 1024,
  totalJavaScriptGzip: 2.5 * 1024 * 1024,
  totalCssGzip: 450 * 1024,
};

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const assets = walk(assetsDirectory).filter((path) => /\.(?:js|css)$/i.test(path));
const measurements = assets.map((path) => {
  const content = readFileSync(path);
  return {
    path,
    type: path.endsWith(".css") ? "css" : "js",
    raw: content.byteLength,
    gzip: gzipSync(content, { level: 9 }).byteLength,
  };
});

const js = measurements.filter((asset) => asset.type === "js");
const css = measurements.filter((asset) => asset.type === "css");
const totalJsGzip = js.reduce((sum, asset) => sum + asset.gzip, 0);
const totalCssGzip = css.reduce((sum, asset) => sum + asset.gzip, 0);
const oversized = js.filter((asset) => asset.gzip > limits.singleJavaScriptGzip);
const kb = (value) => `${(value / 1024).toFixed(1)} KiB`;

console.log(`Assets analysés : ${assetsDirectory}`);
console.log(`JavaScript gzip total : ${kb(totalJsGzip)} / ${kb(limits.totalJavaScriptGzip)}`);
console.log(`CSS gzip total : ${kb(totalCssGzip)} / ${kb(limits.totalCssGzip)}`);
console.log("Plus gros fichiers :");
for (const asset of [...measurements].sort((a, b) => b.gzip - a.gzip).slice(0, 12)) {
  console.log(`- ${asset.path}: ${kb(asset.gzip)} gzip (${kb(asset.raw)} brut)`);
}

const failures = [];
if (totalJsGzip > limits.totalJavaScriptGzip) failures.push(`JavaScript total supérieur au budget (${kb(totalJsGzip)})`);
if (totalCssGzip > limits.totalCssGzip) failures.push(`CSS total supérieur au budget (${kb(totalCssGzip)})`);
failures.push(...oversized.map((asset) => `Chunk JavaScript trop volumineux : ${asset.path} (${kb(asset.gzip)})`));

if (failures.length) {
  console.error("\nBudget de performance dépassé :");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("Budget de bundle respecté.");
