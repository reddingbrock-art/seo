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

  const serviceDesc = {
    "crm":          `Done-for-you CRM built for ${vertical} businesses in ${city}. Configured on GoHighLevel with pipeline, lead follow-up, and AI chat. Live in 10–14 days.`,
    "automation":   `Done-for-you automation system for ${vertical} companies in ${city}. AI chat, review requests, and lead follow-up — installed and live in 10–14 days.`,
    "ai-chat":      `AI chat agent for ${vertical} businesses in ${city}. Answers leads, books appointments, and follows up — installed and running in 10–14 days.`,
    "lead-followup":`Done-for-you lead follow-up system for ${vertical} companies in ${city}. Automated sequences via text and email, built on GoHighLevel. Live in 10–14 days.`,
    "reviews":      `Automated Google review system for ${vertical} businesses in ${city}. Review requests go out after every job — installed and running in 10–14 days.`,
  }[page_type] ?? `Done-for-you automation system for ${vertical} businesses in ${city}. Built on GoHighLevel with AI chat, lead follow-up, and review automation. Live in 10–14 days.`;

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
   - Questions must be specific to BOTH the vertical AND the page_type — not generic software questions
   - Direct answers only. No restating the question. No fluff.
   - Do NOT reuse the same questions across page types. Choose from these by page_type:
       crm:          "Do I have to migrate all my old data?", "Is this just GoHighLevel with a different name?",
                     "What if my techs won't use a new system?", "How is this different from buying GHL directly?"
       automation:   "What gets automated and what's still manual?", "Will this work with the tools I already use?",
                     "Do I have to learn how to build automations?", "What if something breaks while I'm on a job?"
       ai-chat:      "What happens when a customer asks something the AI can't answer?", "Can I customize what the AI says?",
                     "Will customers know they're talking to an AI?", "Does it work after hours and on weekends?"
       lead-followup:"How fast does the follow-up actually go out?", "What if a lead says stop texting me?",
                     "Can I see what messages went out?", "What if I already have a follow-up sequence?"
       reviews:      "What if a customer leaves a bad review?", "Can I control which customers get the review request?",
                     "How does it know when a job is done?", "Will this work on Google and other platforms?"
   - Each FAQ question: wrap in <h3>

8. CTA SECTION
   - H2 must be specific to the page type — pick the matching one:
       crm:          "Ready to Replace Your CRM With Something Built for ${vertical} in ${city}?"
       automation:   "Ready to Put Your ${vertical} Business in ${city} on Autopilot?"
       ai-chat:      "Ready to Stop Missing Calls From ${city} ${vertical} Customers?"
       lead-followup:"Ready to Stop Losing ${city} ${vertical} Leads to Slow Follow-Up?"
       reviews:      "Ready to Build Your ${vertical} Reputation in ${city} on Autopilot?"
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
  Use a <header> element wrapping a <nav aria-label="Main navigation"> inside it.
  <header> fixed top-0, z-index 100, border-bottom: 1px solid var(--border),
  background: rgba(8,12,20,0.9), backdrop-filter: blur(20px), height: 64px.

  LEFT: Logo img + "Field-Built Systems" wordmark
    Logo: <img src="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png"
               alt="Field-Built Systems logo" style="height:40px;width:auto;object-fit:contain">
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
  Use a semantic <footer> element (not a div).
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
- Opening tag must be: <html lang="en">
- <head> includes:
    - charset UTF-8, viewport meta
    - <meta name="robots" content="index, follow">
    - <title> tag: Title Case. Must include the exact target keyword + "Field-Built Systems".
      Target 55 characters or fewer (Google measures in pixels; stay conservative).
      Example: "Best CRM for HVAC Companies in Phoenix | Field-Built Systems"
      If over 55 chars, abbreviate the state (AZ not Arizona) or drop the angle modifier.
    - <meta name="description">: 140–155 chars. Must include: (1) exact target keyword or close
      variant, (2) city name, (3) a specific outcome or differentiator, (4) a soft CTA. No filler.
      Example: "Field-Built Systems installs a done-for-you CRM for HVAC companies in Phoenix. AI chat, automated reviews, lead follow-up — live in 10–14 days. Book a free call."
    - <link rel="canonical" href="https://local.field-built.com/${slug}">
    - Open Graph tags:
        <meta property="og:title" content="${h1} | Field-Built Systems">
        <meta property="og:description" content="COPY THE META DESCRIPTION VERBATIM HERE — same exact text, not a rewrite">
        <meta property="og:url" content="https://local.field-built.com/${slug}">
        <meta property="og:type" content="website">
        <meta property="og:image" content="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png">
        <meta property="og:site_name" content="Field-Built Systems">
    - Twitter card tags:
        <meta name="twitter:card" content="summary_large_image">
        <meta name="twitter:title" content="${h1} | Field-Built Systems">
        <meta name="twitter:description" content="COPY THE META DESCRIPTION VERBATIM HERE">
        <meta name="twitter:image" content="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png">
    - Google Fonts — use preconnect to reduce render-blocking, then the stylesheet:
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    - All CSS in one <style> block — no external stylesheets
    - Three JSON-LD <script type="application/ld+json"> blocks (see schema below)
- No external JS libraries
- Mobile responsive with inline media queries
- Hamburger nav JS in a <script> block at bottom of <body>
- Wrap all page content (everything between nav and footer) in a <main> element
- Use <section> elements (not divs) for each major content block inside <main>
- KEYWORD DENSITY: the exact target keyword or a natural close variant must appear:
    - Within the first 100 words of body text (intro paragraph)
    - In at least one H2 heading
    - Naturally 2–3 more times in body copy — never forced, always reads naturally
- INTERNAL LINKS: within the body copy (not nav, not footer), include at least 2 contextual
  text links back to field-built.com pages. Anchor text must be natural to the surrounding
  sentence — not templated. Vary the phrasing. Target pages:
    https://field-built.com/services — link from copy about what the system includes
    https://field-built.com/demo    — link from copy inviting the reader to see it in action
- ALT TEXT: every <img> tag must have a descriptive alt attribute.
    Nav logo: alt="Field-Built Systems logo"
    Footer logo: alt="Field-Built Systems logo" loading="lazy"
    Any purely decorative elements: alt=""
- COMPARISON TABLE: include a visually hidden <caption> describing the table:
  <caption style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">
    Field-Built Systems vs ${midColHeader} vs DIY — feature and pricing comparison
  </caption>
- H TAG STRATEGY — ENFORCE STRICTLY, NO EXCEPTIONS:
    - ONE H1 per page — the exact target keyword verbatim, nothing else
    - H2s: every section heading must be keyword-rich and descriptive. NEVER use generic labels like
      "The Solution", "The Problem", "Why Choose Us", "How It Works", or "Get Started".
      At least 2 H2s must naturally include both the city name and the vertical. Examples:
        Good: "Why ${vertical} Owners in ${city} Are Switching Away from Generic CRMs"
        Good: "What ${city} ${vertical} Companies Get With Field-Built Systems"
        Bad:  "The Solution" / "How It Works" / "Why Choose Us"
    - H3s: ONLY inside feature cards and FAQ items — nowhere else on the page
    - FAQ questions: every question must be wrapped in <h3> — no exceptions
    - No H4, H5, or H6 tags anywhere on the page

SCHEMA MARKUP — include all three in <head>:

1. LocalBusiness:
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "@id": "https://field-built.com/#business",
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
  "description": "${serviceDesc}",
  "url": "https://local.field-built.com/${slug}"
}

3. FAQPage — populate mainEntity with ALL 4–5 FAQ items from the page. Every question on the page
   must appear here. The JSON must be valid — no comments, no placeholders:
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "EXACT TEXT OF FAQ QUESTION 1",
      "acceptedAnswer": { "@type": "Answer", "text": "EXACT TEXT OF FAQ ANSWER 1" }
    },
    {
      "@type": "Question",
      "name": "EXACT TEXT OF FAQ QUESTION 2",
      "acceptedAnswer": { "@type": "Answer", "text": "EXACT TEXT OF FAQ ANSWER 2" }
    },
    {
      "@type": "Question",
      "name": "EXACT TEXT OF FAQ QUESTION 3",
      "acceptedAnswer": { "@type": "Answer", "text": "EXACT TEXT OF FAQ ANSWER 3" }
    }
  ]
}
Every FAQ question on the page must have a matching entry here. Do not leave placeholders — write the real question and answer text.

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
