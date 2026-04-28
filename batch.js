#!/usr/bin/env node

/**
 * Field-Built Systems — Programmatic SEO Page Generator
 * Reads targets.csv, calls Claude API, writes HTML files to /docs
 *
 * Usage:
 *   node batch.js                  → process all rows
 *   node batch.js --limit 10       → process first 10 rows
 *   node batch.js --slug some-slug → regenerate one specific page
 */

import Anthropic from "@anthropic-ai/sdk";
import { parse } from "csv-parse/sync";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

// ─── Config ────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  csvPath: path.join(__dirname, "targets.csv"),
  outputDir: path.join(__dirname, "docs"),
  logFile: path.join(__dirname, "batch.log"),
  errorFile: path.join(__dirname, "batch-errors.log"),
  model: "claude-opus-4-6",
  maxTokens: 8000,
  rateLimit: {
    requestsPerMinute: 20,
    delayBetweenMs: 3000,
    retryDelayMs: 10000,
    maxRetries: 3,
  },
};

// ─── Arg parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const limitFlag = args.indexOf("--limit");
const slugFlag = args.indexOf("--slug");
const csvFlag = args.indexOf("--csv");
const LIMIT = limitFlag !== -1 ? parseInt(args[limitFlag + 1]) : null;
const TARGET_SLUG = slugFlag !== -1 ? args[slugFlag + 1] : null;
const CUSTOM_CSV = csvFlag !== -1 ? args[csvFlag + 1] : null;

// ─── Utilities ─────────────────────────────────────────────────────────────

function log(msg, level = "INFO") {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(CONFIG.logFile, line + "\n");
}

function logError(slug, msg) {
  const line = `[${new Date().toISOString()}] FAILED ${slug}: ${msg}`;
  console.error(line);
  fs.appendFileSync(CONFIG.errorFile, line + "\n");
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Prompt builder ────────────────────────────────────────────────────────

function buildPrompt(row) {
  const { vertical, city, state, page_type, angle, slug } = row;

  const angleQualifiers = {
    general: `${vertical} companies`,
    "small-business": `small ${vertical} companies`,
    "owner-operator": `${vertical} owner-operators`,
    "scaling-up": `${vertical} companies scaling up`,
    "switching-servicetitan": `${vertical} companies switching from ServiceTitan`,
    "switching-jobber": `${vertical} companies switching from Jobber`,
    "new-business": `new ${vertical} companies`,
  };

  const pageTypeTitles = {
    crm: `Best CRM for ${angleQualifiers[angle]} in ${city}, ${state}`,
    automation: `Automation Software for ${angleQualifiers[angle]} in ${city}, ${state}`,
    "ai-chat": `AI Chat Agent for ${angleQualifiers[angle]} in ${city}, ${state}`,
    "lead-followup": `Lead Follow-Up System for ${angleQualifiers[angle]} in ${city}, ${state}`,
    reviews: `Google Review Automation for ${angleQualifiers[angle]} in ${city}, ${state}`,
  };

  const competitorColumn =
    angle === "switching-servicetitan"
      ? "ServiceTitan"
      : angle === "switching-jobber"
      ? "Jobber"
      : "Generic CRM";

  const h1 = pageTypeTitles[page_type];

  return `You are writing a conversion-optimized SEO landing page for Field-Built Systems (field-built.com), a done-for-you automation agency serving field service businesses.

TARGET KEYWORD: "${h1}"
VERTICAL: ${vertical}
CITY: ${city}, ${state}
PAGE TYPE: ${page_type}
ANGLE: ${angle}
SLUG: ${slug}
COMPETITOR COLUMN LABEL: ${competitorColumn}

WRITING STYLE RULES — follow these exactly, no exceptions:
- Practitioner voice: sounds like someone who has actually run a ${vertical} business
- Specific and opinionated — name real local pain points, actual neighborhoods, real seasonal patterns for ${city}
- Forbidden phrases: "in today's competitive landscape", "game-changer", "seamless", "leverage", "unlock your potential", "supercharge", "revolutionize"
- Never invent statistics or claim specific percentages — use directional language only: "most", "significantly more", "faster than"
- Never reference "companies we work with" or imply existing client results — this is a new business
- Varied sentence rhythm — mix short punchy sentences with longer explanatory ones
- Use contractions throughout. Always "you" and "your".
- Problem section: one paragraph maximum — make it hurt fast, then move on
- City context must be real and specific: actual neighborhoods, real seasonal demand patterns, local market conditions

OUTPUT: Return ONLY a complete, standalone HTML file. No markdown. No explanation. No code fences. Start with <!DOCTYPE html>.

PAGE STRUCTURE (follow this order exactly):

1. HERO
   - H1: "${h1}"
   - Subhead: one sharp line about what this page delivers (color: #94a3b8)
   - Primary CTA button: "Book a Free 30-Minute Call" → https://field-built.com/book
   - Below the button: smaller secondary link "Or try the AI demo first →" → https://field-built.com/demo

2. INTRO PARAGRAPH
   - Who this is for (${vertical} owners in ${city} with 1–15 trucks, $300K–$5M revenue)
   - Why now (specific to ${city} market conditions)

3. PROBLEM SECTION (one paragraph max)
   - Name the real operational pain — missed leads, manual follow-up, chasing reviews
   - Specific to ${vertical} in ${city} — mention real neighborhoods, seasonal demand, local competition
   - Real stakes — what it costs them to stay stuck

4. SOLUTION SECTION
   - What Field-Built delivers, done-for-you framing
   - Built on GoHighLevel + AI, fully configured, live in 10–14 days
   - No generic "software" language — describe actual outcomes

5. FEATURE CARDS (exactly 4 cards in a 2-column grid)
   - Each card: bold title + 2–3 sentence description
   - Specific to ${page_type} and ${vertical}, no fluff
   a) AI chat/voice agent — captures leads after hours
   b) Automated lead follow-up — texts and emails, timed sequences
   c) Google review requests — triggered after job close
   d) Pipeline + job tracking — visibility without manual updates
   Adapt to the most relevant for ${page_type}

6. COMPARISON TABLE
   Header columns: Field-Built Systems | ${competitorColumn} | DIY
   Rows (exactly these, in this order):
   - Done-for-you setup: ✓ | ✗ | ✗
   - AI chat + voice agent: ✓ | ✗ | ✗
   - Automated review requests: ✓ | ✗ | ✗
   - Lead follow-up sequences: ✓ | Manual | ✗
   - Launch timeline: 10–14 days | Months | Never

7. FAQ (4–5 questions)
   - Real objections from ${vertical} owners, not generic software questions
   - Direct answers, no restating the question
   - Use accordion style: each question is a <details><summary> block

8. CTA SECTION (dark, mirrors hero)
   - Low-commitment framing: 30 minutes, no pitch deck, no pressure
   - Button: "Book a Free 30-Minute Call" → https://field-built.com/book
   - Secondary link: "Or try the AI demo first →" → https://field-built.com/demo
   - One line of reassurance beneath both

HTML/CSS REQUIREMENTS:

Use a single <style> block in <head>. No external CSS. Only Google Fonts (Inter) as external dependency.

DESIGN SYSTEM — dark theme throughout:

  Colors:
    --bg: #080C14                          (page background)
    --bg-card: #0E1420                     (card/surface background)
    --bg-alt: #0A0F1A                      (alternate section background)
    --border: rgba(255,255,255,0.08)       (default border)
    --text: #ffffff
    --text-muted: #B0BECE
    --cyan: #00D4FF
    --gradient: linear-gradient(135deg, #1B98E0, #8B5CF6)
    --radius: 12px
    --radius-sm: 8px

  Typography:
    font-family: 'Inter', system-ui, sans-serif
    body font-size: 16px, line-height: 1.7
    -webkit-font-smoothing: antialiased

  NAV:
    position: fixed; top:0; left:0; right:0; z-index:100
    background: rgba(8,12,20,0.92); backdrop-filter: blur(20px)
    border-bottom: 1px solid rgba(255,255,255,0.08); height: 64px
    inner layout: flex, space-between, align-items center, max-width 1140px, margin auto, padding 0 24px
    Left: logo image only → <img src="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png" height="44" alt="Field-Built Systems" style="display:block">
    Right: "Try a Demo" link → https://field-built.com/demo — styled with gradient text (background: linear-gradient(135deg,#1B98E0,#8B5CF6); -webkit-background-clip:text; -webkit-text-fill-color:transparent; font-weight:600; text-decoration:none)

  HERO:
    padding: 130px 24px 90px; text-align: center
    background: linear-gradient(135deg, #080C14 0%, #0f0c1e 100%)
    Add a subtle grid overlay: a ::before pseudo on the hero div with:
      background-image: linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px)
      background-size: 60px 60px
      position:absolute; inset:0; pointer-events:none
    H1: color #ffffff; font-size: clamp(34px,5vw,56px); font-weight:800; line-height:1.1; letter-spacing:-1.5px; max-width:820px; margin:0 auto 20px
    Subhead: color #94a3b8; font-size:20px; max-width:560px; margin:0 auto 36px
    Primary CTA button:
      background: linear-gradient(135deg,#1B98E0,#8B5CF6); color:#fff
      padding:16px 36px; border-radius:8px; font-size:16px; font-weight:700
      box-shadow: 0 0 20px rgba(0,212,255,0.25); text-decoration:none; display:inline-block
      transition: box-shadow 0.2s, transform 0.2s
      :hover — box-shadow: 0 0 32px rgba(0,212,255,0.45); transform:translateY(-1px)
    Demo link below button: color #64748b; font-size:14px; margin-top:14px; display:block; text-decoration:none
      :hover — color:#00D4FF

  SECTION LAYOUT:
    All sections: padding 80px 24px
    Inner content: max-width 1140px; margin: 0 auto (use .container class)
    Narrow content (intro, problem, FAQ): max-width 780px; margin 0 auto

  SECTION BACKGROUNDS (alternate for rhythm):
    Intro: #080C14
    Problem: #0A0F1A
    Solution: #080C14
    Features: #0A0F1A
    Table: #080C14
    FAQ: #0A0F1A
    Bottom CTA: linear-gradient(135deg, #080C14 0%, #0f0c1e 100%) — mirrors hero

  SECTION LABELS (above h2):
    font-size:12px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:#00D4FF; margin-bottom:14px

  SECTION H2:
    background: linear-gradient(135deg,#1B98E0,#8B5CF6); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text
    font-size: clamp(28px,3.5vw,40px); font-weight:800; line-height:1.15; letter-spacing:-0.8px; margin-bottom:20px

  BODY TEXT:
    color: #B0BECE; font-size:17px; line-height:1.75

  FEATURE CARDS (2-col grid, gap 20px):
    background: #0E1420; border: 1px solid rgba(255,255,255,0.08); border-radius:12px; padding:28px
    On hover: border-color changes to rgba(0,212,255,0.3); box-shadow: 0 0 20px rgba(0,212,255,0.08)
    Add transition: border-color 0.25s, box-shadow 0.25s
    Card icon div: width:44px; height:44px; border-radius:10px; background:rgba(27,152,224,0.12); border:1px solid rgba(27,152,224,0.2); display:flex; align-items:center; justify-content:center; font-size:20px; margin-bottom:16px
    Card h3: font-size:18px; font-weight:700; color:#ffffff; margin-bottom:10px
    Card p: font-size:15px; color:#B0BECE; line-height:1.65

  COMPARISON TABLE:
    Wrapper: border-radius:12px; border:1px solid rgba(255,255,255,0.08); overflow:hidden; overflow-x:auto
    table: width:100%; border-collapse:collapse
    thead th: padding:16px 20px; font-size:14px; font-weight:700; text-align:left; background:#0E1420; border-bottom:1px solid rgba(255,255,255,0.08)
    FBS header column: color:#00D4FF
    td: padding:14px 20px; font-size:15px; border-bottom:1px solid rgba(255,255,255,0.06); color:#B0BECE; vertical-align:middle
    Even rows: background rgba(255,255,255,0.015)
    FBS column cells: background rgba(27,152,224,0.04)
    Row label (first td): font-weight:500; color:#ffffff
    ✓ checkmarks: color:#22D87A; font-size:18px; font-weight:700
    ✗ crosses: color:#EF4444; font-size:18px
    "Manual" text: color:#F59E0B; font-size:14px; font-weight:500
    FBS timeline/cost cells: color:#00D4FF; font-weight:600

  FAQ — use <details><summary> accordion:
    Each <details>: border-bottom:1px solid rgba(255,255,255,0.08); padding:0
    <summary>: padding:20px 0; font-size:17px; font-weight:600; color:#ffffff; cursor:pointer; list-style:none; display:flex; justify-content:space-between; align-items:center
    summary::after: content:"+"; font-size:20px; color:#B0BECE; transition:transform 0.2s; flex-shrink:0
    details[open] summary::after: content:"×"; color:#00D4FF
    Answer div inside details: padding:0 0 20px; font-size:15px; color:#B0BECE; line-height:1.75

  BOTTOM CTA SECTION:
    text-align:center
    h2: same gradient as above, font-size clamp(30px,4vw,48px)
    p: color:#B0BECE; font-size:18px; max-width:480px; margin:0 auto 36px
    Button: same as hero CTA button
    Demo link: color:#64748b; font-size:14px; margin-top:14px; display:block; text-decoration:none
    Reassurance line: font-size:13px; color:#B0BECE; margin-top:16px; opacity:0.7

  FOOTER:
    border-top:1px solid rgba(255,255,255,0.08); padding:40px 24px; text-align:center
    font-size:14px; color:#64748b; background:#080C14
    "© 2026 Field-Built Systems · field-built.com" — field-built.com is an <a> styled color:#64748b, text-decoration:none, :hover color:#00D4FF

  MOBILE (max-width: 768px):
    Nav logo image: height 36px
    Hero padding: 100px 20px 64px
    Feature grid: grid-template-columns:1fr
    All sections: padding 56px 20px
    Table: min-width 520px on inner table so it scrolls horizontally
    FAQ summary font-size: 15px

META TAGS:
  <title>${h1} | Field-Built Systems</title>
  <meta name="description" content="Done-for-you ${page_type} for ${angleQualifiers[angle]} in ${city}, ${state}. AI chat, automated follow-up, and Google review automation. Live in 10–14 days.">
  <link rel="canonical" href="https://seo.field-built.com/${slug}">
  <meta property="og:title" content="${h1} | Field-Built Systems">
  <meta property="og:description" content="Done-for-you automation for ${vertical} companies in ${city}, ${state}. Live in 10–14 days.">`;
}

// ─── API call with retry ────────────────────────────────────────────────────

async function generatePage(client, row) {
  const prompt = buildPrompt(row);
  let attempt = 0;

  while (attempt < CONFIG.rateLimit.maxRetries) {
    try {
      const response = await client.messages.create({
        model: CONFIG.model,
        max_tokens: CONFIG.maxTokens,
        messages: [{ role: "user", content: prompt }],
      });

      const content = response.content[0];
      if (content.type !== "text") throw new Error("Unexpected response type");

      let html = content.text.trim();

      // Strip accidental markdown fences
      if (html.startsWith("```")) {
        html = html.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
      }

      if (!html.startsWith("<!DOCTYPE")) {
        throw new Error("Response did not start with <!DOCTYPE html>");
      }

      return html;
    } catch (err) {
      attempt++;
      if (attempt >= CONFIG.rateLimit.maxRetries) throw err;
      log(
        `Retry ${attempt}/${CONFIG.rateLimit.maxRetries} for ${row.slug}: ${err.message}`,
        "WARN"
      );
      await sleep(CONFIG.rateLimit.retryDelayMs * attempt);
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  log("=== Field-Built Systems Batch Generator started ===");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ERROR: ANTHROPIC_API_KEY not set in .env");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const csvPath = CUSTOM_CSV ? path.resolve(CUSTOM_CSV) : CONFIG.csvPath;

  if (!fs.existsSync(csvPath)) {
    console.error(`ERROR: CSV not found at ${csvPath}`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(csvPath, "utf8");
  let rows = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (TARGET_SLUG) {
    rows = rows.filter((r) => r.slug === TARGET_SLUG);
    if (rows.length === 0) {
      console.error(`ERROR: No row found with slug "${TARGET_SLUG}"`);
      process.exit(1);
    }
  }

  if (LIMIT) rows = rows.slice(0, LIMIT);

  ensureDir(CONFIG.outputDir);

  log(`Processing ${rows.length} pages...`);

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const { slug } = row;

    if (!slug) {
      log(`Row ${i + 1}: missing slug, skipping`, "WARN");
      skipped++;
      continue;
    }

    const outputPath = path.join(CONFIG.outputDir, `${slug}.html`);

    // Skip if exists unless --slug used to force regenerate
    if (!TARGET_SLUG && fs.existsSync(outputPath)) {
      log(`[${i + 1}/${rows.length}] SKIP ${slug} (already exists)`);
      skipped++;
      continue;
    }

    log(`[${i + 1}/${rows.length}] Generating ${slug}...`);

    try {
      const html = await generatePage(client, row);
      fs.writeFileSync(outputPath, html, "utf8");
      log(`[${i + 1}/${rows.length}] OK ${slug}`);
      generated++;
    } catch (err) {
      logError(slug, err.message);
      failed++;
    }

    if (i < rows.length - 1) {
      await sleep(CONFIG.rateLimit.delayBetweenMs);
    }
  }

  log(`=== Done. Generated: ${generated} | Skipped: ${skipped} | Failed: ${failed} ===`);

  if (failed > 0) {
    log(`Check batch-errors.log for failed slugs. Re-run with --slug to retry individual pages.`, "WARN");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
