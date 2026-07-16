import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const roots = ["src/routes", "src/components"];
const ignored = new Set([path.normalize("src/components/ui")]);

async function collectTsx(directory) {
  if (ignored.has(path.normalize(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTsx(child);
      return entry.name.endsWith(".tsx") ? [child] : [];
    }),
  );
  return nested.flat();
}

test("application JSX does not contain untranslated visible text nodes", async () => {
  const files = (await Promise.all(roots.map(collectTsx))).flat();
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (ts.isJsxText(node)) {
        const value = node.getText(tree).replace(/\s+/g, " ").trim();
        if (
          /[A-Za-zÀ-ÿА-Яа-я]/.test(value) &&
          ![
            "GLOBAL PARTY",
            "Clubbing & Festivals",
            "Clubbing &amp; Festivals",
            "km",
            "PMR",
            "Mio",
            "×",
          ].includes(value)
        ) {
          const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
          violations.push(`${file}:${line}: ${value}`);
        }
      }
      if (
        ts.isJsxAttribute(node) &&
        ["placeholder", "aria-label", "title"].includes(node.name.getText(tree)) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer)
      ) {
        const value = node.initializer.text.trim();
        if (/[A-Za-zÀ-ÿА-Яа-я]/.test(value) && !/^https?:/.test(value)) {
          const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
          violations.push(`${file}:${line}: ${node.name.getText(tree)}="${value}"`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }

  assert.deepEqual(violations, [], `Untranslated JSX text:\n${violations.join("\n")}`);
});

test("all supported locales remain declared", async () => {
  const source = await readFile("src/lib/i18n.tsx", "utf8");
  for (const locale of ["fr", "en", "pl", "it", "ru", "es"]) {
    assert.match(source, new RegExp(`["]${locale}["]`));
  }
});
