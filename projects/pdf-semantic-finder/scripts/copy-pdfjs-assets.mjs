// Copies the PDF.js runtime assets that match the installed `pdfjs-dist` version
// into `public/pdfjs/`, so the library and its runtime assets stay pinned together.
//
// CMaps are required for Japanese PDFs: without them, non-embedded CID fonts
// (90ms-RKSJ-H, UniJIS-UCS2-H, ...) cannot be mapped to Unicode and
// `getTextContent()` returns empty or unusable text.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve("pdfjs-dist/package.json");
const packageRoot = dirname(packageJsonPath);
const { version } = JSON.parse(await readFile(packageJsonPath, "utf8"));

const destinationRoot = new URL("../public/pdfjs/", import.meta.url).pathname;
const directories = ["cmaps", "standard_fonts", "wasm", "iccs"];

await rm(destinationRoot, { force: true, recursive: true });
await mkdir(destinationRoot, { recursive: true });

for (const directory of directories) {
    await cp(join(packageRoot, directory), join(destinationRoot, directory), { recursive: true });
}

// Recorded so a stale copy is detectable, and so the served assets can be traced
// back to the library version that produced them.
await writeFile(join(destinationRoot, "version.json"), `${JSON.stringify({ pdfjsDist: version }, null, 4)}\n`);

console.log(`Copied pdfjs-dist ${version} runtime assets into public/pdfjs/`);
