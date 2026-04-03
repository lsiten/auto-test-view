import { build } from "esbuild";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

// Collect all .ts files under electron/
const collectFiles = (dir) => {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectFiles(full));
    } else if (full.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
};

const entryPoints = collectFiles("electron");

await build({
  entryPoints,
  outdir: "dist/electron",
  outbase: "electron",
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  packages: "external",
  logLevel: "info",
});
