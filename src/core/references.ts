import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bundled reference files ship as a sibling `references/` directory (repo
 * root in dev and tests, plugin root once installed) rather than static
 * imports — modules run from different depths (src/... two deep, the
 * built bin/waybill.mjs one deep), so the search walks up from whichever
 * module is running until it finds `references/<file>`.
 */
export function findReferenceFile(filename: string): string {
  const pluginRoot = process.env["CLAUDE_PLUGIN_ROOT"];
  if (pluginRoot) {
    const p = join(pluginRoot, "references", filename);
    if (existsSync(p)) return p;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const p = join(dir, "references", filename);
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`bundled reference file not found: ${filename}`);
}
