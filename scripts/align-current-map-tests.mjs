import { readFile, writeFile } from "node:fs/promises";

const path = "tests/map-clusters.test.ts";
let source = await readFile(path, "utf8");

function replaceOnce(before, after, label) {
  if (!source.includes(before)) throw new Error(`Expected ${label} assertion was not found`);
  source = source.replace(before, after);
}

replaceOnce('      category_color: "#e11d48",', '      category_color: "#f43f5e",', "concert color");
replaceOnce('      category_color: "#4338ca",', '      category_color: "#d946ef",', "nightlife color");
replaceOnce(
  "  assert.equal(spreadCoincidentMapPoints(points, 20, EVENT_CLUSTER_TERMINAL_ZOOM), points);",
  "  assert.equal(\n    spreadCoincidentMapPoints(\n      points,\n      EVENT_CLUSTER_TERMINAL_ZOOM - 1,\n      EVENT_CLUSTER_TERMINAL_ZOOM,\n    ),\n    points,\n  );",
  "pre-terminal spiderfication",
);
replaceOnce(
  `  assert.deepEqual(eventCategoryVisual("concert"), {\n    color: "#e11d48",\n    icon: "🎸",\n    imageId: "event-category-concerts",\n  });\n  assert.deepEqual(eventCategoryVisual("unknown-category"), {\n    color: "#64748b",\n    icon: "✨",\n    imageId: "event-category-other",\n  });`,
  `  assert.deepEqual(eventCategoryVisual("concert"), {\n    slug: "concerts",\n    color: "#f43f5e",\n    colorEnd: "#be123c",\n    imageId: "event-category-concerts",\n  });\n  assert.deepEqual(eventCategoryVisual("unknown-category"), {\n    slug: "other",\n    color: "#f472b6",\n    colorEnd: "#be185d",\n    imageId: "event-category-other",\n  });`,
  "category visual shape",
);
replaceOnce(
  '  assert.equal(eventCategoryTextColor("soirees"), "#ffffff");',
  '  assert.equal(eventCategoryTextColor("soirees"), "#111827");',
  "nightlife text contrast",
);
replaceOnce(
  "  assert.ok(EVENT_CLUSTER_MAX_ZOOM >= 17);",
  "  assert.ok(EVENT_CLUSTER_MAX_ZOOM >= 12);\n  assert.equal(EVENT_CLUSTER_TERMINAL_ZOOM, EVENT_CLUSTER_MAX_ZOOM + 1);",
  "cluster zoom threshold",
);
replaceOnce(
  "  assert.equal(shouldOpenClusterSelection(20, EVENT_CLUSTER_TERMINAL_ZOOM), false);",
  "  assert.equal(\n    shouldOpenClusterSelection(\n      EVENT_CLUSTER_TERMINAL_ZOOM - 1,\n      EVENT_CLUSTER_TERMINAL_ZOOM,\n    ),\n    false,\n  );",
  "terminal cluster expansion",
);

await writeFile(path, source, "utf8");
