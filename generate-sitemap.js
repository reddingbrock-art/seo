// generate-sitemap.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.join(__dirname, "docs");
const baseUrl = "https://local.field-built.com";

const files = fs.readdirSync(docsDir)
  .filter(f => f.endsWith(".html") && f !== "index.html");

const urls = files.map(f => {
  const slug = f.replace(".html", "");
  const stat = fs.statSync(path.join(docsDir, f));
  return `  <url>
    <loc>${baseUrl}/${slug}</loc>
    <lastmod>${stat.mtime.toISOString().split("T")[0]}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`;
}).join("\n");

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

fs.writeFileSync(path.join(docsDir, "sitemap.xml"), xml);
console.log(`✓ Sitemap written: ${files.length} URLs`);
