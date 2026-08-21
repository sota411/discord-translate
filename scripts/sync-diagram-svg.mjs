import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const directory = path.resolve("docs/diagrams");
const [mode, ...extraArguments] = process.argv.slice(2);
if ((mode !== undefined && mode !== "--check") || extraArguments.length > 0) {
  throw new Error(`未対応の引数です: ${process.argv.slice(2).join(" ")}`);
}
const checkOnly = mode === "--check";
const staleFiles = [];
const fontStyle = '<style>@import url("https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&amp;family=Geist:wght@400;500;600&amp;family=Geist+Mono:wght@400;500;600&amp;display=swap");</style>';
const htmlFiles = (await readdir(directory))
  .filter((file) => file.endsWith(".html"))
  .sort();

for (const htmlFile of htmlFiles) {
  const htmlPath = path.join(directory, htmlFile);
  const html = await readFile(htmlPath, "utf8");
  const match = /<svg\b[\s\S]*<\/svg>/u.exec(html);
  if (!match) throw new Error(`${htmlFile}にSVGがありません`);
  const svg = match[0].replace("<defs>", `<defs>\n        ${fontStyle}`);
  const svgPath = path.join(directory, htmlFile.replace(/\.html$/u, ".svg"));
  const expected = `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`;

  if (!checkOnly) {
    await writeFile(svgPath, expected, "utf8");
    continue;
  }

  try {
    const current = await readFile(svgPath, "utf8");
    if (current !== expected) staleFiles.push(path.relative(process.cwd(), svgPath));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    staleFiles.push(path.relative(process.cwd(), svgPath));
  }
}

if (staleFiles.length > 0) {
  throw new Error(
    `SVGがHTMLと同期されていません: ${staleFiles.join(", ")}\n`
      + "pnpm diagrams:sync を実行してください",
  );
}
