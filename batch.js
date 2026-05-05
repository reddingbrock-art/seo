#!/usr/bin/env node

/**
 * Field-Built Systems — Programmatic SEO Page Generator
 * Reads targets.csv → calls Claude API → writes HTML to /docs
 *
 * Usage:
 *   node batch.js                    → process all rows
 *   node batch.js --limit 10         → process first N rows
 *   node batch.js --slug some-slug   → regenerate one specific page
 *   node batch.js --chunk 2 --of 5   → process chunk 2 of 5 (for parallel CI)
 *   node batch.js --skip-existing    → skip slugs that already have an HTML file
 *
 * Setup:
 *   npm install @anthropic-ai/sdk csv-parse dotenv
 *   ANTHROPIC_API_KEY in .env or environment
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
  csvPath:    path.join(__dirname, "targets.csv"),
  outputDir:  path.join(__dirname, "docs"),
  logFile:    path.join(__dirname, "batch.log"),
  errorFile:  path.join(__dirname, "batch-errors.log"),
  cname:      "local.field-built.com",   // GitHub Pages custom domain — written on every run
  model:      "claude-haiku-4-5-20251001",
  maxTokens:  8000,
  rate: {
    delayBetweenMs: 100,    // Tier 2: 2,000 req/min — generation time is the real bottleneck
    retryDelayMs:   15000,
    maxRetries:     3,
  },
};

// ─── Arg parsing ───────────────────────────────────────────────────────────

const args         = process.argv.slice(2);
const flag         = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasFlag      = (f) => args.includes(f);
const LIMIT        = flag("--limit")  ? parseInt(flag("--limit"))  : null;
const TARGET_SLUG  = flag("--slug")   ?? null;
const CHUNK_INDEX  = flag("--chunk")  ? parseInt(flag("--chunk"))  : null;  // 1-based
const CHUNK_TOTAL  = flag("--of")     ? parseInt(flag("--of"))     : null;
const SKIP_EXISTING = hasFlag("--skip-existing");

// ─── Logging ───────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(CONFIG.logFile, line + "\n");
}

function logError(slug, err) {
  const line = `[${new Date().toISOString()}] ERROR ${slug}: ${err.message ?? err}`;
  console.error(line);
  fs.appendFileSync(CONFIG.errorFile, line + "\n");
}

// ─── Prompt builder ────────────────────────────────────────────────────────

function buildPrompt(row) {
  const { vertical, city, state, page_type, angle, slug } = row;

  // Derive the keyword-targeted H1 from page_type + angle
  const angleLabel = {
    "general":              `${vertical} companies`,
    "small-business":       `small ${vertical} companies`,
    "owner-operator":       `${vertical} owner-operators`,
    "scaling-up":           `${vertical} companies scaling up`,
    "switching-servicetitan": `${vertical} companies switching from ServiceTitan`,
    "switching-jobber":     `${vertical} companies switching from Jobber`,
    "new-business":         `new ${vertical} companies`,
  }[angle] ?? `${vertical} companies`;

  const pageLabel = {
    "crm":          `Best CRM for ${angleLabel} in ${city}, ${state}`,
    "automation":   `Automation Software for ${angleLabel} in ${city}, ${state}`,
    "ai-chat":      `AI Chat Agent for ${angleLabel} in ${city}, ${state}`,
    "lead-followup":`Lead Follow-Up System for ${angleLabel} in ${city}, ${state}`,
    "reviews":      `Google Review Automation for ${angleLabel} in ${city}, ${state}`,
  }[page_type] ?? `Automation System for ${angleLabel} in ${city}, ${state}`;

  const h1 = pageLabel;

  // For competitor-angle pages, swap the middle column header
  const midColHeader =
    angle === "switching-servicetitan" ? "ServiceTitan" :
    angle === "switching-jobber"       ? "Jobber"       :
    "Generic CRM";

  return `You are writing a single, complete, production-ready HTML page for Field-Built Systems — a done-for-you automation agency serving field service businesses.

TARGET KEYWORD / H1: "${h1}"
VERTICAL: ${vertical}
CITY: ${city}
STATE: ${state}
PAGE TYPE: ${page_type}
ANGLE: ${angle}
SLUG: ${slug}

═══════════════════════════════════════════════════
WRITING STYLE — ENFORCE EVERY RULE, NO EXCEPTIONS
═══════════════════════════════════════════════════
- Practitioner voice: sounds like someone who has actually run a field service business
- Specific and opinionated — real local pain, real neighborhoods, real seasonal patterns
- Contractions throughout. "You" and "your" always.
- Varied sentence rhythm: short punchy lines mixed with longer explanatory ones
- NEVER use: "in today's competitive landscape", "game-changer", "seamless", "leverage", "unlock your potential", "supercharge", "streamline", "busy owner", "hard-working", "tight-knit community"
- NEVER open a paragraph with "You're running", "As a ${vertical} owner", "The ${city} market is", or any sentence that reads like a mail-merge
- NEVER invent statistics or percentages — use directional language: "most", "significantly more", "faster than"
- NEVER reference existing clients or imply past results
- City context must earn its place: a specific seasonal pressure, a named neighborhood dynamic, a real market condition — not the city name inserted into a generic sentence

═══════════════════════════════════════════════════
PAGE STRUCTURE — FOLLOW EXACTLY, IN ORDER
═══════════════════════════════════════════════════

1. HERO
   - H1: exactly "${h1}"
   - One-line subhead: specific pain + what FBS delivers, no fluff
   - Single CTA button: "Book a Free 30-Minute Call" → https://field-built.com/book
   - Small badge above H1: "Done-for-you · Live in 10–14 days"

2. INTRO PARAGRAPH
   - 2–3 short paragraphs max
   - DO NOT open with "You're running X trucks" — that's a template. Start mid-thought, like
     you're already in the conversation. Lead with what's actually happening in their business
     or their market right now.
   - The revenue/truck range (1–15 trucks, $300K–$5M) must be woven in naturally, not stated
     as a qualification checklist
   - "Why this city" must be a real observation — a seasonal pattern, a neighborhood dynamic,
     a competitive pressure specific to ${city} — not just the city name dropped into a sentence
   - BANNED openers: "You're running", "If you're a", "As a ${vertical} owner", "Running a
     ${vertical} business in ${city}", "The ${city} ${vertical} market"

3. PROBLEM SECTION (one paragraph MAX)
   - One paragraph. Hard stop.
   - Name the operational failure, not the category. Not "missed leads" — describe what actually
     happens: the phone rings at 7pm, nobody answers, they text the next guy in Google Maps.
   - Real local texture: a specific season, a specific part of ${city}, a specific customer behavior
   - End on consequence, not setup. No transition sentence into the solution.
   - BANNED: any sentence that begins "Without a system", "Most ${vertical} owners", "The problem is"

4. SOLUTION SECTION
   - What Field-Built delivers
   - Done-for-you framing throughout — not "you'll configure" but "we install"
   - Built on GoHighLevel + AI stack
   - Live in 10–14 days

5. FOUR FEATURE CARDS (2×2 grid desktop, 1-col mobile)
   Card titles must be specific capabilities, not generic labels. Examples:
   - "AI Chat Agent — Answers While You're on the Roof"
   - "Automated Review Requests After Every Job"
   - "Lead Follow-Up That Runs Without You"
   - "Your Pipeline, Built and Configured for You"

6. COMPARISON TABLE
   Columns: Field-Built Systems | ${midColHeader} | DIY
   Exactly these 6 rows, in this order:
   Row 1: Done-for-you setup       | ✓ | ✗ | ✗
   Row 2: AI chat + voice agent    | ✓ | ✗ | ✗
   Row 3: Automated review requests| ✓ | ✗ | ✗
   Row 4: Lead follow-up sequences | ✓ | Manual | ✗
   Row 5: Launch timeline          | 10–14 days | Months | Never
   Row 6: Monthly cost             | $500/mo all-in | $300–800+ DIY config | Your time
   ✓ = #22D87A  |  ✗ = #EF4444  |  Manual = #F59E0B  |  FBS values = #00D4FF

7. FAQ (4–5 questions)
   - Real objections from ${vertical} owners — not generic software questions
   - Direct answers, no restating the question, no fluff
   - Example objections: "Do I have to learn new software?", "What if I'm already using GoHighLevel?",
     "How is this different from just buying a CRM?", "What happens after setup — are you done?",
     "How fast will I actually see results?"
   - Each FAQ question: wrap in <h3>

8. CTA SECTION
   - H2: "Ready to See What This Looks Like for Your ${vertical} Business?"
   - Low-commitment framing: "30 minutes. No pitch deck. No pressure."
   - Button: "Book a Free 30-Minute Call" → https://field-built.com/book
   - One line of reassurance beneath: "Most clients are live within 10–14 days."

═══════════════════════════════════════════════════
DESIGN SYSTEM — MATCH THE HOMEPAGE EXACTLY
═══════════════════════════════════════════════════

COLORS (use CSS custom properties):
  --bg:        #080C14    /* page background */
  --bg-card:   #0E1420    /* card / section alt background */
  --bg-alt:    #0A0F1A    /* subtle alternating section tint */
  --border:    rgba(255,255,255,0.07)
  --text:      #F1F5F9    /* primary text */
  --text-muted:#8B9AB4    /* secondary / caption text */
  --cyan:      #1B98E0    /* gradient start / accent */
  --violet:    #8B5CF6    /* gradient end */
  --green:     #22D87A    /* ✓ checkmarks */
  --red:       #EF4444    /* ✗ marks */
  --amber:     #F59E0B    /* Manual label */
  --fbs-val:   #00D4FF    /* FBS table values */

GRADIENT (use on H2 accent words, CTA button, and hero badge):
  background: linear-gradient(90deg, #1B98E0, #8B5CF6);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;

TYPOGRAPHY:
  - Font: Inter from Google Fonts (weights 400, 500, 600, 700, 800, 900)
  - H1: font-size clamp(36px, 5vw, 64px); font-weight: 900; color: #F1F5F9; line-height: 1.1
  - H2: font-size clamp(28px, 4vw, 48px); font-weight: 800; color: #F1F5F9
       2–4 words per H2 should use the gradient span class
  - Body: font-size 18px; color: var(--text); line-height: 1.75
  - Muted: color: var(--text-muted); font-size: 17px

NAV (fixed, matches homepage exactly):
  <header> fixed top-0, z-index 100, border-bottom: 1px solid var(--border),
  background: rgba(8,12,20,0.9), backdrop-filter: blur(20px), height: 64px.

  LEFT: Logo img + "Field-Built Systems" wordmark
    Logo: <img src="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png"
               alt="Field-Built Systems" style="height:40px;width:auto;object-fit:contain">
    Wordmark: font-size 22px; font-weight 700; color #F1F5F9; margin-left 12px

  CENTER LINKS (hidden on mobile): Home | Services | About | Demo
    href values: https://field-built.com | /services | /about | /demo
    Active (Home): color #1B98E0
    Inactive: color #8B9AB4; hover: color #1B98E0; transition 0.2s

  RIGHT: "Book a Free Call" button
    gradient background (--cyan → --violet), border-radius 999px,
    padding 10px 22px, font-size 14px, font-weight 600, color #fff,
    no border, cursor pointer

  MOBILE HAMBURGER: visible below 768px; clicking toggles a full-width dropdown menu
  with all nav links + CTA stacked vertically on --bg-card background.
  Implement with a <script> block — no frameworks.

HERO SECTION — use this exact HTML structure, no deviations:
  <section class="hero">
    <div class="hero-orb hero-orb--1"></div>
    <div class="hero-orb hero-orb--2"></div>
    <div class="hero-inner">
      <div class="hero-badge">Done-for-you · Live in 10–14 days</div>
      <h1>[TARGET KEYWORD VERBATIM]</h1>
      <p class="hero-sub">[ONE-LINE SUBHEAD]</p>
      <a href="https://field-built.com/book" class="btn-primary">Book a Free 30-Minute Call</a>
    </div>
  </section>

  Required CSS for hero:
  .hero {
    position: relative; overflow: hidden;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    text-align: center; padding: 120px 24px 80px;
    background: radial-gradient(ellipse 80% 60% at 50% 40%, rgba(27,152,224,0.12) 0%, var(--bg) 70%);
    background-color: var(--bg);
  }
  .hero::before {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background-image: linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
    background-size: 40px 40px;
  }
  .hero-orb { position: absolute; border-radius: 50%; filter: blur(80px); pointer-events: none; }
  .hero-orb--1 { width: 400px; height: 400px; background: rgba(27,152,224,0.15); top: -80px; left: -80px; }
  .hero-orb--2 { width: 300px; height: 300px; background: rgba(139,92,246,0.12); bottom: -60px; right: -60px; }
  .hero-inner {
    position: relative; z-index: 1;
    max-width: 860px; margin: 0 auto;
    display: flex; flex-direction: column; align-items: center; gap: 24px;
  }
  .hero-badge {
    display: inline-block; padding: 6px 18px; border-radius: 999px;
    border: 1px solid rgba(27,152,224,0.4); background: rgba(27,152,224,0.1);
    font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
    background: linear-gradient(90deg, #1B98E0, #8B5CF6);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  }
  .hero h1 {
    font-size: clamp(36px, 5vw, 64px); font-weight: 900; color: #F1F5F9;
    line-height: 1.1; letter-spacing: -1px; margin: 0;
  }
  .hero-sub {
    color: var(--text-muted); font-size: 18px; line-height: 1.6;
    max-width: 520px; margin: 0;
  }
  .btn-primary {
    display: inline-block; padding: 16px 36px; border-radius: 999px;
    background: linear-gradient(135deg, #1B98E0, #8B5CF6);
    color: #fff; font-size: 16px; font-weight: 700; text-decoration: none;
    box-shadow: 0 0 32px rgba(27,152,224,0.35); transition: box-shadow 0.2s, transform 0.2s;
  }
  .btn-primary:hover { box-shadow: 0 0 48px rgba(27,152,224,0.55); transform: translateY(-2px); }

SECTIONS:
  - padding: 80px 24px (desktop); 60px 20px (mobile)
  - max-width container: 1100px, margin auto
  - Section labels (eyebrow text): font-size 11px, uppercase, letter-spacing 0.1em, color var(--cyan)
  - Alternate section backgrounds: --bg → --bg-alt → --bg → --bg-card etc.

INTRO SECTION (the first section after the hero) — give it visual presence:
  - background: var(--bg-alt)
  - border-top: 1px solid var(--border)
  - max-width for text content: 720px, centered
  - The eyebrow label ("WHO THIS IS FOR") must sit above a visible divider:
      display: block; margin-bottom: 20px; padding-bottom: 20px;
      border-bottom: 1px solid var(--border)
  - Body paragraphs: font-size 19px; line-height 1.8; color var(--text)
  - First paragraph: first letter or first 3–4 words in color var(--cyan), font-weight 700
    — makes the section feel like it has an entry point, not a flat wall of text

CARDS (feature cards):
  - background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px; padding: 28px
  - On hover: border-color rgba(27,152,224,0.3); box-shadow: 0 0 20px rgba(27,152,224,0.08)
  - Icon tile: 48px square, border-radius 12px, gradient background, icon in white
  - Card title: H3, font-size 18px, font-weight 700, color var(--text)
  - Card body: font-size 16px, color var(--text-muted), line-height 1.65

COMPARISON TABLE:
  - border-collapse: separate; border-spacing: 0; width: 100%; border-radius: 12px; overflow hidden
  - Header row: background linear-gradient(135deg, rgba(27,152,224,0.15), rgba(139,92,246,0.1))
  - FBS column header: color var(--fbs-val); font-weight 800
  - Odd rows: background rgba(255,255,255,0.02); even: transparent
  - Cell padding: 16px 20px; border-bottom: 1px solid var(--border)
  - ✓ spans: color var(--green); font-weight 700
  - ✗ spans: color var(--red); font-weight 700
  - Manual spans: color var(--amber); font-weight 600
  - FBS value cells: color var(--fbs-val); font-weight 600
  - Wrap table in horizontally scrollable div on mobile

FAQ:
  - Accordion-style, pure CSS or minimal JS
  - Each item: border-bottom 1px solid var(--border); padding 20px 0
  - Question (H3): font-size 17px; font-weight 600; color var(--text); cursor pointer
  - Answer: font-size 17px; color var(--text-muted); line-height 1.7; padding-top 12px

CTA SECTION:
  - Background: radial-gradient from rgba(27,152,224,0.08) center over --bg
  - H2: white with gradient accent words
  - Subhead: var(--text-muted)
  - Button: gradient bg, rounded-full, padding 18px 44px, font-size 17px weight 700, glow shadow

FOOTER (matches homepage):
  - background: #080C14; border-top: 1px solid var(--border); padding: 48px 24px
  - 4-column grid (desktop): col-span-2 brand block + Company nav + Legal nav
  - Brand block: logo img + "Field-Built Systems" wordmark, tagline, phone + email links
      Logo: same src as nav, height 32px
      Phone: (817) 518-7791 → tel:8175187791
      Email: info@field-built.com
  - Company links: Services → /services; About → /about; Contact → /contact
  - Legal links: Privacy Policy → /privacy; Terms of Service → /terms; Service Agreement → /service-agreement
  - Bottom bar: "© 2026 Field-Built Systems. All rights reserved." centered, font-size 13px, color var(--text-muted)
  - All footer links: color var(--text-muted); hover: color var(--cyan)
  - On mobile: stack to 1 column

═══════════════════════════════════════════════════
META / TECHNICAL REQUIREMENTS
═══════════════════════════════════════════════════
- Complete standalone HTML file: <!DOCTYPE html> through </html>
- <head> includes:
    - charset UTF-8, viewport meta
    - <title>${h1} | Field-Built Systems</title>
    - <meta name="description"> — 140–160 chars, keyword-rich, action-oriented
    - <link rel="canonical" href="https://seo.field-built.com/${slug}">
    - og:title, og:description, og:url, og:type="website"
    - Google Fonts: Inter 400,500,600,700,800,900
    - All CSS in one <style> block — no external stylesheets
    - Three JSON-LD <script> blocks (see schema below)
- No external JS libraries
- Mobile responsive with inline media queries
- Hamburger nav JS in a <script> block at bottom of <body>
- H TAG STRATEGY:
    - ONE H1 per page — the exact target keyword
    - H2s: keyword-rich descriptive headings. Include city + vertical naturally in at least 2 H2s.
      Examples: "Why ${vertical} Owners in ${city} Are Switching Systems" not "The Solution"
    - H3s: inside feature cards and FAQ items
    - FAQ questions: each in an <h3>

SCHEMA MARKUP — include all three in <head>:

1. LocalBusiness:
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "name": "Field-Built Systems",
  "url": "https://field-built.com",
  "telephone": "(817) 518-7791",
  "email": "info@field-built.com",
  "description": "Done-for-you automation systems for ${vertical} companies in ${city}, ${state}",
  "priceRange": "$$",
  "areaServed": {
    "@type": "City",
    "name": "${city}",
    "containedInPlace": { "@type": "State", "name": "${state}" }
  },
  "serviceType": "${page_type}"
}

2. Service:
{
  "@context": "https://schema.org",
  "@type": "Service",
  "name": "${h1}",
  "provider": { "@type": "Organization", "name": "Field-Built Systems", "url": "https://field-built.com" },
  "areaServed": "${city}, ${state}",
  "description": "Done-for-you automation and CRM system for ${vertical} businesses in ${city}. Built on GoHighLevel with AI chat, lead follow-up, and review automation. Live in 10–14 days.",
  "url": "https://seo.field-built.com/${slug}"
}

3. FAQPage (generate from your 4–5 FAQ items):
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    { "@type": "Question", "name": "QUESTION TEXT", "acceptedAnswer": { "@type": "Answer", "text": "ANSWER TEXT" } }
    // ... one object per FAQ item
  ]
}

═══════════════════════════════════════════════════
OUTPUT RULES
═══════════════════════════════════════════════════
- Output ONLY the raw HTML — no markdown fences, no explanation, no preamble
- Start with <!DOCTYPE html> and end with </html>
- The file must be self-contained and render correctly in a browser with no external resources except Google Fonts
`;
}

// ─── API call with retry ────────────────────────────────────────────────────

async function generatePage(client, row) {
  const prompt = buildPrompt(row);
  let attempt = 0;

  while (attempt < CONFIG.rate.maxRetries) {
    try {
      const response = await client.messages.create({
        model:      CONFIG.model,
        max_tokens: CONFIG.maxTokens,
        messages:   [{ role: "user", content: prompt }],
      });

      const raw = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      // Strip accidental markdown fences
      return raw
        .replace(/^```html\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();

    } catch (err) {
      attempt++;
      const isRetryable = err.status === 429 || err.status >= 500;
      if (isRetryable && attempt < CONFIG.rate.maxRetries) {
        log(`  ↻ Retry ${attempt}/${CONFIG.rate.maxRetries} for ${row.slug} (${err.status ?? err.message})`);
        await sleep(CONFIG.rate.retryDelayMs * attempt); // exponential back-off
      } else {
        throw err;
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function outputPath(slug) {
  return path.join(CONFIG.outputDir, `${slug}.html`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  if (!fs.existsSync(CONFIG.csvPath)) {
    console.error(`targets.csv not found at ${CONFIG.csvPath}`);
    process.exit(1);
  }

  ensureDir(CONFIG.outputDir);

  // Always write CNAME — GitHub Pages clears the custom domain if this file is missing on push
  fs.writeFileSync(path.join(CONFIG.outputDir, "CNAME"), CONFIG.cname, "utf8");
  log(`CNAME written: ${CONFIG.cname}`);

  // Parse CSV
  const raw     = fs.readFileSync(CONFIG.csvPath, "utf8");
  let rows      = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  const total   = rows.length;

  // Filter to single slug if requested
  if (TARGET_SLUG) {
    rows = rows.filter((r) => r.slug === TARGET_SLUG);
    if (rows.length === 0) {
      console.error(`No row found with slug: ${TARGET_SLUG}`);
      process.exit(1);
    }
  }

  // Chunk filtering (for parallel CI matrix)
  if (CHUNK_INDEX !== null && CHUNK_TOTAL !== null) {
    rows = rows.filter((_, i) => i % CHUNK_TOTAL === CHUNK_INDEX - 1);
    log(`Chunk ${CHUNK_INDEX}/${CHUNK_TOTAL}: ${rows.length} rows`);
  }

  // Limit
  if (LIMIT) rows = rows.slice(0, LIMIT);

  // Skip existing
  if (SKIP_EXISTING) {
    const before = rows.length;
    rows = rows.filter((r) => !fs.existsSync(outputPath(r.slug)));
    log(`Skip-existing: ${before - rows.length} already done, ${rows.length} remaining`);
  }

  log(`Starting batch: ${rows.length} pages (total in CSV: ${total})`);

  let success = 0;
  let failed  = 0;

  for (let i = 0; i < rows.length; i++) {
    const row  = rows[i];
    const slug = row.slug;
    const out  = outputPath(slug);

    log(`[${i + 1}/${rows.length}] Generating: ${slug}`);

    try {
      const html = await generatePage(client, row);

      if (!html.startsWith("<!DOCTYPE") && !html.startsWith("<html")) {
        throw new Error("Output does not look like valid HTML — skipping write");
      }

      fs.writeFileSync(out, html, "utf8");
      log(`  ✓ Written: ${out}`);
      success++;

    } catch (err) {
      logError(slug, err);
      failed++;
    }

    if (i < rows.length - 1) {
      await sleep(CONFIG.rate.delayBetweenMs);
    }
  }

  log(`\nDone. ✓ ${success} succeeded  ✗ ${failed} failed`);
  if (failed > 0) {
    log(`Check batch-errors.log for details.`);
    process.exit(1); // non-zero exit so CI catches failures
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
