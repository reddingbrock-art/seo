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
  model:      "claude-opus-4-6",
  maxTokens:  8000,
  rate: {
    delayBetweenMs: 3200,   // ~18 req/min — safe under tier limits
    retryDelayMs:   15000,  // 15s back-off on 429/500
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
- NEVER use: "in today's competitive landscape", "game-changer", "seamless", "leverage", "unlock your potential", "supercharge", "streamline"
- NEVER invent statistics or percentages — use directional language: "most", "significantly more", "faster than"
- NEVER reference existing clients or imply past results
- City context must be real: actual neighborhoods, seasonal factors, local market conditions — not just name-dropping

═══════════════════════════════════════════════════
PAGE STRUCTURE — FOLLOW EXACTLY, IN ORDER
═══════════════════════════════════════════════════

1. HERO
   - H1: exactly "${h1}"
   - One-line subhead: specific pain + what FBS delivers, no fluff
   - Single CTA button: "Book a Free 30-Minute Call" → https://field-built.com/book
   - Small badge above H1: "Done-for-you · Live in 10–14 days"

2. INTRO PARAGRAPH
   - Who this is for (1–15 trucks, $300K–$5M revenue range)
   - Why now / why this city
   - No more than 3 short paragraphs

3. PROBLEM SECTION (one paragraph MAX)
   - Specific pain, real stakes, make it hurt fast
   - No solution language here — pure problem
   - Name real local factors: seasonal demand spikes, neighborhood competition, etc.

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
  - Body: font-size 16–18px; color: var(--text); line-height: 1.7
  - Muted: color: var(--text-muted)

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

HERO SECTION:
  - min-height: 100vh; display flex align-center justify-center; text-center
  - Background: radial-gradient from rgba(27,152,224,0.12) center, over --bg
  - Animated grid overlay: 40px grid lines at rgba(255,255,255,0.03), use CSS background-image
  - Two decorative blurred orbs (position absolute, pointer-events none, blur 80px):
      Orb 1: 400px circle, rgba(27,152,224,0.15), top-left area
      Orb 2: 300px circle, rgba(139,92,246,0.12), bottom-right area
  - Badge above H1: rounded-full, border 1px solid rgba(27,152,224,0.4),
      background rgba(27,152,224,0.1), gradient text, font-size 11px uppercase tracking-widest
  - H1: white, clamp(36px,5vw,64px), weight 900 — target keyword verbatim
  - Subhead: color var(--text-muted), max-width 520px, margin auto, font-size 18px
  - CTA button: gradient bg, rounded-full, padding 16px 36px, font-size 16px weight 700, color #fff,
      box-shadow: 0 0 32px rgba(27,152,224,0.35)

SECTIONS:
  - padding: 80px 24px (desktop); 60px 20px (mobile)
  - max-width container: 1100px, margin auto
  - Section labels (eyebrow text): font-size 11px, uppercase, letter-spacing 0.1em, color var(--cyan)
  - Alternate section backgrounds: --bg → --bg-alt → --bg → --bg-card etc.

CARDS (feature cards):
  - background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px; padding: 28px
  - On hover: border-color rgba(27,152,224,0.3); box-shadow: 0 0 20px rgba(27,152,224,0.08)
  - Icon tile: 48px square, border-radius 12px, gradient background, icon in white
  - Card title: H3, font-size 18px, font-weight 700, color var(--text)
  - Card body: font-size 15px, color var(--text-muted), line-height 1.65

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
  - Answer: font-size 15px; color var(--text-muted); line-height 1.7; padding-top 12px

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

// ─── Incremental git commit ────────────────────────────────────────────────

async function commitProgress(pageCount) {
  // Only run inside GitHub Actions
  if (!process.env.GITHUB_ACTIONS) return;

  try {
    const { execSync } = await import("child_process");
    const run = (cmd) => execSync(cmd, { stdio: "pipe" }).toString().trim();

    run('git config user.name "github-actions[bot]"');
    run('git config user.email "github-actions[bot]@users.noreply.github.com"');
    run("git add docs/");

    const staged = run("git diff --staged --name-only");
    if (!staged) { log("  ↷ Nothing new to commit"); return; }

    const n = staged.split("\n").filter(Boolean).length;
    run(`git commit -m "chore: add ${n} SEO pages (checkpoint ${pageCount}) [skip ci]"`);
    run("git push");
    log(`  ↷ Committed ${n} files at page ${pageCount}`);
  } catch (err) {
    // Non-fatal — log and keep going
    log(`  ⚠ Commit failed (continuing): ${err.message}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  if (!fs.existsSync(CONFIG.csvPath)) {
    console.error(`targets.csv not found at ${CONFIG.csvPath}`);
    process.exit(1);
  }

  ensureDir(CONFIG.outputDir);

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

    // Rate limit delay (skip after last item)
    if (i < rows.length - 1) {
      await sleep(CONFIG.rate.delayBetweenMs);
    }

    // Commit every 50 pages so progress is never lost if the run dies
    if ((i + 1) % 50 === 0) {
      await commitProgress(i + 1);
    }
  }

  // Final commit for any remainder not caught by the interval
  await commitProgress(success);

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
