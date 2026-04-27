#!/usr/bin/env node

/**
 * Field-Built Systems — Programmatic SEO Page Generator
 * Reads targets.csv, calls Claude API, writes HTML files to /output
 *
 * Usage:
 *   node batch.js                  → process all rows
 *   node batch.js --limit 10       → process first 10 rows
 *   node batch.js --slug some-slug → regenerate one specific page
 *
 * Setup:
 *   npm install @anthropic-ai/sdk csv-parse dotenv
 *   Add ANTHROPIC_API_KEY to .env
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
    requestsPerMinute: 20,       // stay well under API limits
    delayBetweenMs: 3000,        // 3s between requests
    retryDelayMs: 10000,         // 10s before retry
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

  // Derive human-readable strings from angle
  const angleModifiers = {
    general: "",
    "small-business": "small ",
    "owner-operator": "",
    "scaling-up": "",
    "switching-servicetitan": "",
    "switching-jobber": "",
    "new-business": "new ",
  };

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
   - Subhead: one sharp line about what this page delivers
   - Primary CTA button: "Book a Free 30-Minute Call" → https://field-built.com/book
   - Below the button: a smaller secondary link "Or try the AI demo first →" → https://field-built.com/demo, styled in gradient text, no underline

2. INTRO PARAGRAPH
   - Who this is for (${vertical} owners in ${city} with 1–15 trucks, $300K–$5M revenue)
   - Why now (be specific about ${city} market conditions)

3. PROBLEM SECTION (one paragraph max)
   - Name the real operational pain — missed leads, manual follow-up, chasing reviews
   - Make it specific to ${vertical} in ${city} — mention real neighborhoods, seasonal demand, local competition
   - Stakes must be real — what it costs them to stay stuck

4. SOLUTION SECTION
   - What Field-Built delivers, done-for-you framing
   - Built on GoHighLevel + AI, fully configured, live in 10–14 days
   - No generic "software" language — describe actual outcomes

5. FEATURE CARDS (exactly 4 cards)
   - Each card: bold title + 2–3 sentence description
   - Cards must be specific to ${page_type} and ${vertical}
   - No fluff, no adjectives that don't mean anything
   Card ideas for reference (adapt to page type):
   a) AI chat/voice agent — captures leads after hours
   b) Automated lead follow-up — texts and emails, timed sequences
   c) Google review requests — triggered after job close
   d) Pipeline + job tracking — visibility without manual updates
   Pick the 4 most relevant to ${page_type}

6. COMPARISON TABLE
   Header columns: Field-Built Systems | ${competitorColumn} | DIY
   Rows (exactly these, in this order):
   - Done-for-you setup: ✓ | ✗ | ✗
   - AI chat + voice agent: ✓ | ✗ | ✗
   - Automated review requests: ✓ | ✗ | ✗
   - Lead follow-up sequences: ✓ | Manual | ✗
   - Launch timeline: 10–14 days | Months | Never

7. FAQ (4–5 questions)
   - Real objections from ${vertical} owners — not generic software questions
   - Direct answers, no restating the question
   - Sample objections: "Do I have to learn new software?", "What if I'm not tech-savvy?", "How is this different from just buying GoHighLevel?", "What happens after setup?"

8. CTA SECTION
   - Low-commitment framing: 30 minutes, no pitch deck, no pressure
   - Button: "Book a Free 30-Minute Call" → https://field-built.com/book
   - Below the button: a smaller secondary link "Or try the AI demo first →" → https://field-built.com/demo, styled in gradient text, no underline
   - One line of reassurance beneath both

HTML/CSS REQUIREMENTS:
- Complete standalone file, no external dependencies except Google Fonts (Inter)
- Inline styles only — no external CSS files
- LIGHT MODE — dark text throughout. No dark backgrounds anywhere except the hero.
- Color palette:
    page background: #ffffff
    hero background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%) — dark, rich, makes hero pop
    hero text: #ffffff
    surface (cards, table rows): #f8fafc
    border: #e2e8f0
    text primary: #0f172a
    text muted: #64748b
    brand gradient: linear-gradient(135deg, #1B98E0, #8B5CF6)
    CTA button text: #ffffff
- Font: Inter from Google Fonts
- NAV: 
    - Background: #ffffff, border-bottom: 1px solid #e2e8f0, padding 16px 24px, display flex, align-items center, justify-content space-between
    - Left side: logo image only — <img src="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69929aab54da04ad2c3450ae.jpg" height="52" alt="Field-Built Systems" style="display:block;"> — no text next to it, the logo contains the name already
    - Right side: "Try a Demo" link → https://field-built.com/demo, styled with brand gradient text (-webkit-background-clip: text; -webkit-text-fill-color: transparent; background: linear-gradient(135deg, #1B98E0, #8B5CF6); font-weight: 600;)
- HERO SECTION:
    - Background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%)
    - Text color: #ffffff
    - H1: white text, large (48px desktop / 32px mobile), font-weight 800, no gradient on H1 — white looks better on dark hero
    - Subhead: color #cbd5e1, font-size 20px
    - Padding: 100px 24px desktop, 64px 24px mobile
    - CTA button: background: linear-gradient(135deg, #1B98E0, #8B5CF6); color #ffffff; border-radius 6px; padding 16px 32px; font-weight 600; font-size 16px
    - Demo link below button: color #94a3b8, no gradient needed on dark background
- SECTION BACKGROUNDS (alternate to create visual rhythm):
    - Intro paragraph section: #ffffff
    - Problem section: #f8fafc
    - Solution section: #ffffff
    - Feature cards section: #f1f5f9
    - Comparison table section: #ffffff
    - FAQ section: #f8fafc
    - Bottom CTA section: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%) with white text — mirrors the hero
- SECTION HEADINGS (h2): apply brand gradient — background: linear-gradient(135deg, #1B98E0, #8B5CF6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-weight: 700; font-size: 32px;
- CTA buttons (non-hero): background: linear-gradient(135deg, #1B98E0, #8B5CF6); color: #ffffff; border: none; border-radius: 6px; padding: 14px 28px; font-weight: 600; cursor: pointer;
- Feature cards: white background, border: 1px solid #e2e8f0, border-radius 12px, padding 28px, box-shadow: 0 1px 3px rgba(0,0,0,0.06)
- Feature card titles: brand gradient text
- Comparison table: header row background: linear-gradient(135deg, #1B98E0, #8B5CF6) with white text; alternating row backgrounds #ffffff / #f8fafc; horizontally scrollable on mobile
- Mobile responsive using media queries inline in a <style> block
- Feature cards: 2-column grid on desktop, 1-column on mobile
- Meta tags: title, description, canonical (https://seo.field-built.com/${slug}), og:title, og:description
- No JavaScript required
- Footer: background #0f172a, color #64748b, "© 2026 Field-Built Systems · field-built.com" centered, padding 32px, small font — no redundant wordmark text, just the copyright line`;
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

      // Strip accidental markdown fences if model wraps anyway
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

  // Read CSV — use chunk file if --csv flag passed
  const csvPath = CUSTOM_CSV
    ? path.resolve(CUSTOM_CSV)
    : CONFIG.csvPath;

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

  // Filter by slug if --slug flag passed
  if (TARGET_SLUG) {
    rows = rows.filter((r) => r.slug === TARGET_SLUG);
    if (rows.length === 0) {
      console.error(`ERROR: No row found with slug "${TARGET_SLUG}"`);
      process.exit(1);
    }
  }

  // Apply limit
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

    // Skip if exists (unless --slug was used to force regenerate)
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

    // Rate limiting — don't sleep after the last item
    if (i < rows.length - 1) {
      await sleep(CONFIG.rateLimit.delayBetweenMs);
    }
  }

  log(
    `=== Done. Generated: ${generated} | Skipped: ${skipped} | Failed: ${failed} ===`
  );

  if (failed > 0) {
    log(`Check batch-errors.log for failed slugs. Re-run with --slug to retry individual pages.`, "WARN");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
