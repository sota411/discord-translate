import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve("docs/diagrams");
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
  await writeFile(svgPath, `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`, "utf8");
}
