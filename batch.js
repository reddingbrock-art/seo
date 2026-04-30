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
    delayBetweenMs: 3200,
    retryDelayMs:   15000,
    maxRetries:     3,
  },
};

// ─── Arg parsing ───────────────────────────────────────────────────────────

const args          = process.argv.slice(2);
const flag          = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasFlag       = (f) => args.includes(f);
const LIMIT         = flag("--limit")  ? parseInt(flag("--limit"))  : null;
const TARGET_SLUG   = flag("--slug")   ?? null;
const CHUNK_INDEX   = flag("--chunk")  ? parseInt(flag("--chunk"))  : null;
const CHUNK_TOTAL   = flag("--of")     ? parseInt(flag("--of"))     : null;
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

  const angleLabel = {
    "general":                `${vertical} companies`,
    "small-business":         `small ${vertical} companies`,
    "owner-operator":         `${vertical} owner-operators`,
    "scaling-up":             `${vertical} companies scaling up`,
    "switching-servicetitan": `${vertical} companies switching from ServiceTitan`,
    "switching-jobber":       `${vertical} companies switching from Jobber`,
    "new-business":           `new ${vertical} companies`,
  }[angle] ?? `${vertical} companies`;

  const h1 = {
    "crm":           `Best CRM for ${angleLabel} in ${city}, ${state}`,
    "automation":    `Automation Software for ${angleLabel} in ${city}, ${state}`,
    "ai-chat":       `AI Chat Agent for ${angleLabel} in ${city}, ${state}`,
    "lead-followup": `Lead Follow-Up System for ${angleLabel} in ${city}, ${state}`,
    "reviews":       `Google Review Automation for ${angleLabel} in ${city}, ${state}`,
  }[page_type] ?? `Automation System for ${angleLabel} in ${city}, ${state}`;

  const midColHeader =
    angle === "switching-servicetitan" ? "ServiceTitan" :
    angle === "switching-jobber"       ? "Jobber"       :
    "Generic CRM";

  const serviceDesc = {
    "crm":
      `Done-for-you CRM built for ${vertical} businesses in ${city}. Configured on GoHighLevel with pipeline, lead follow-up, appointment reminders, and AI chat. Live in 10-14 days.`,
    "automation":
      `Done-for-you automation system for ${vertical} companies in ${city}. AI chat, review requests, appointment confirmations, and lead follow-up -- installed and live in 10-14 days.`,
    "ai-chat":
      `AI chat agent for ${vertical} businesses in ${city}. Answers leads, books appointments, sends confirmations, and follows up -- installed and running in 10-14 days.`,
    "lead-followup":
      `Done-for-you lead follow-up system for ${vertical} companies in ${city}. Automated sequences via text and email, built on GoHighLevel. Live in 10-14 days.`,
    "reviews":
      `Automated Google review system for ${vertical} businesses in ${city}. Satisfaction check after every job -- happy customers go to Google, unhappy ones come to you first. Live in 10-14 days.`,
  }[page_type] ??
    `Done-for-you automation system for ${vertical} businesses in ${city}. Built on GoHighLevel with AI chat, lead follow-up, and review automation. Live in 10-14 days.`;

  const ctaH2 = {
    "crm":           `Ready to Replace Your CRM With Something Built for ${vertical} in ${city}?`,
    "automation":    `Ready to Put Your ${vertical} Business in ${city} on Autopilot?`,
    "ai-chat":       `Ready to Stop Missing Calls From ${city} ${vertical} Customers?`,
    "lead-followup": `Ready to Stop Losing ${city} ${vertical} Leads to Slow Follow-Up?`,
    "reviews":       `Ready to Build Your ${vertical} Reputation in ${city} on Autopilot?`,
  }[page_type] ?? `Ready to See What This Looks Like for Your ${vertical} Business?`;

  // ── Page-type-specific feature card guidance ──────────────────────────────

  const featureCardGuidance = page_type === "reviews" ? `
FEATURE CARDS FOR REVIEWS PAGES -- all four cards must cover the two-part review mechanism.
Do NOT use generic feature cards. Follow this structure exactly:

  Card 1 title: e.g. "Satisfaction Check After Every Job -- Before the Review Goes Out"
    Describe: After job close, a satisfaction check fires automatically. No action needed from
    you or your tech. This always comes before any review request goes out.
    RULE: Never describe requesting a review without first describing this filter step.

  Card 2 title: e.g. "Happy Customers Get a Google Link. Unhappy Ones Come to You First."
    Describe: Positive response triggers a one-tap Google review link. Negative response routes
    a private feedback form directly to the owner before anything goes public.
    Frame it as: every job gets followed up; good outcomes build your rating, bad ones come to you first.
    RULE: Never describe the request without the filter. Never describe the filter without the request.
    These two parts are always described together as a single mechanism.

  Card 3 title: e.g. "Consistent Volume, Every Week, Without Thinking About It"
    Describe: Reviews build in the background on every job -- not in bursts when you remember to ask.
    No training your techs to ask. No awkward end-of-job conversations.

  Card 4 title: e.g. "Timing That Matches How Customers Actually Feel"
    Describe: The request goes out right after the job is marked complete -- while the experience
    is fresh. Not too early (job not done), not too late (customer has moved on).
` : `
FEATURE CARDS FOR ${page_type.toUpperCase()} PAGES -- two required, two flexible.

  REQUIRED CARD 1 -- Appointment Confirmations (title must be outcome-focused, not generic):
    Example title: "No-Show Rates Drop When Every Appointment Is Confirmed Automatically"
    Describe the three-touch sequence as a single connected outcome -- NOT a bullet list:
      Step 1: Job booked -> confirmation fires automatically (text + email)
      Step 2: 24 hours before -> reminder with appointment details goes out
      Step 3: Day of -> tech en-route text fires when they leave for the job
    Frame it as: no-shows go down, you stop chasing confirmations manually.

  REQUIRED CARD 2 -- Reputation Protection (title must be outcome-focused):
    Example title: "Every Job Gets a Satisfaction Check -- Bad Reviews Get Caught First"
    Describe the two-part review mechanism as a single connected system:
      Part 1: After job close, satisfaction check fires automatically -- no tech involvement needed
      Part 2: Happy response -> Google review link. Unhappy response -> private feedback form
               routes to owner BEFORE it goes public.
    Frame it as: every job gets followed up, good outcomes build your rating, bad ones come to you first.
    RULE: Never describe the review request without the filter step.
    RULE: Never describe the filter without the request step. Always both together.

  FLEXIBLE CARDS 3 and 4 -- choose the two most relevant for ${page_type} + ${vertical}:
    Good options: AI chat that captures leads after hours, lead follow-up sequences, pipeline
    visibility without manual updates, done-for-you build and configuration.
    Titles must describe specific outcomes -- not generic feature category names.
    Bad: "AI Features" / "Automation Tools" / "Lead Management"
    Good: "AI Chat Agent -- Answers While You're on the Roof" / "Lead Follow-Up That Runs Without You"
`;

  // ── Page-type-specific FAQ guidance ──────────────────────────────────────

  const faqGuidance = {
    "crm": `
FAQ QUESTIONS FOR CRM PAGES (rewrite naturally -- do not copy verbatim):
  Q1: Do I have to migrate all my old data?
      Answer direction: set up from scratch -- most owners don't have clean data worth migrating.
  Q2: Is this just GoHighLevel with a different name?
      Answer direction: GHL is a platform, this is a configured system built for ${vertical}.
      Use an analogy: buying GHL is like buying lumber and calling it a house.
  Q3: What if my techs won't use a new system?
      Answer direction: most of it runs without tech input. Adoption is less of a barrier than they think.
  Q4: What happens after setup -- are you done?
      Answer direction: no -- we stay on, handle changes, monitor automations.
  Q5 (optional): How is this different from buying GoHighLevel directly?`,

    "automation": `
FAQ QUESTIONS FOR AUTOMATION PAGES (rewrite naturally):
  Q1: What actually gets automated and what's still manual?
      Answer direction: specific about what runs vs. what still needs a human.
  Q2: Will this work with the tools I'm already using?
      Answer direction: address the most common tools for ${vertical} (calendar, QuickBooks, scheduling).
  Q3: Do I have to learn how to build any of this?
      Answer direction: no -- done-for-you means we build it.
  Q4: What if something breaks while I'm on a job?
      Answer direction: we monitor it, we fix it -- not on you.
  Q5 (optional): How long before I actually see it working?`,

    "ai-chat": `
FAQ QUESTIONS FOR AI-CHAT PAGES (rewrite naturally):
  Q1: What happens when a customer asks something the AI can't answer?
      Answer direction: escalation path -- routes to owner, books callback, doesn't leave them hanging.
  Q2: Will customers know they're talking to an AI?
      Answer direction: direct and honest. Don't dodge it.
  Q3: Can I customize what the AI says about my business?
      Answer direction: yes -- trained on your services, service area, and pricing structure.
  Q4: Does it work after hours and on weekends?
      Answer direction: yes -- that's the core value, not a bonus feature.
  Q5 (optional): What if a customer is angry or upset?`,

    "lead-followup": `
FAQ QUESTIONS FOR LEAD-FOLLOWUP PAGES (rewrite naturally):
  Q1: How fast does the follow-up actually go out?
      Answer direction: minutes, not hours -- while the lead is still warm.
  Q2: What if a lead says stop texting me?
      Answer direction: opt-out is automatic -- compliance handled.
  Q3: Can I see what messages went out and what responses came back?
      Answer direction: yes -- full visibility in the pipeline.
  Q4: What if I already have a follow-up sequence?
      Answer direction: we replace or improve it -- bring what you have.
  Q5 (optional): How many touches go out before the sequence stops?`,

    "reviews": `
FAQ QUESTIONS FOR REVIEWS PAGES (rewrite naturally):
  Q1: What if a customer leaves a bad review anyway?
      Answer direction: the filter catches most -- but if one slips through, we show you how to respond.
      The filter prevents, it doesn't guarantee. Be honest.
  Q2: Can I control which customers get the satisfaction check?
      Answer direction: yes -- triggered by job close status in your pipeline, not random sends.
  Q3: How does the system know when a job is done?
      Answer direction: connected to your pipeline -- job marked complete triggers the sequence.
  Q4: Will this work on Google and other platforms?
      Answer direction: Google is the priority -- that's where it moves the needle for local search.
  Q5 (optional): What if a customer gives negative feedback in the private form -- then what?
      Answer direction: it comes to you, you handle it directly, it never becomes a public review.`,
  }[page_type] ?? `
FAQ: write 4-5 real objections from ${vertical} owners about adopting a done-for-you automation system.
Direct answers only. No restating the question. No filler.`;

  // ── Full prompt ────────────────────────────────────────────────────────────

  return `You are writing a single, complete, production-ready HTML page for Field-Built Systems, a done-for-you automation agency serving field service businesses.

TARGET KEYWORD / H1: "${h1}"
VERTICAL: ${vertical}
CITY: ${city}
STATE: ${state}
PAGE TYPE: ${page_type}
ANGLE: ${angle}
SLUG: ${slug}

=======================================================
WRITING STYLE - ENFORCE EVERY RULE, NO EXCEPTIONS
=======================================================
- Practitioner voice: sounds like someone who has actually run a ${vertical} business
- Specific and opinionated -- real local pain, real neighborhoods, real seasonal patterns for ${city}
- Contractions throughout. "You" and "your" always.
- Varied sentence rhythm: short punchy lines mixed with longer explanatory ones
- NEVER use: "in today's competitive landscape", "game-changer", "seamless", "leverage",
  "unlock your potential", "supercharge", "streamline"
- NEVER invent statistics or percentages -- directional language only ("most", "significantly more", "faster than")
- NEVER reference existing clients or imply past results
- City context must be real: actual neighborhoods, seasonal factors, local market conditions

=======================================================
PAGE STRUCTURE - FOLLOW EXACTLY, IN ORDER
=======================================================

1. HERO
   - H1: exactly "${h1}" (verbatim, nothing changed)
   - One-line subhead: specific pain + what FBS delivers. No fluff.
   - Single CTA button: "Book a Free 30-Minute Call" -> https://field-built.com/book
   - Small badge above H1: "Done-for-you · Live in 10-14 days"

2. INTRO PARAGRAPH
   - Who this is for: ${vertical} owners with 1-15 trucks, $300K-$5M revenue
   - Why now / why ${city} specifically
   - Maximum 3 short paragraphs
   - Exact target keyword or close natural variant MUST appear within the first 100 words

3. PROBLEM SECTION (one paragraph MAX)
   - Specific pain, real stakes, make it land fast
   - Pure problem -- zero solution language
   - Name real local factors: seasonal demand, neighborhood competition, etc.

4. SOLUTION SECTION
   - What Field-Built delivers, done-for-you framing throughout
   - "We install" not "you'll configure"
   - Built on GoHighLevel + AI stack, live in 10-14 days

5. FOUR FEATURE CARDS (2x2 grid desktop, 1-col mobile)
${featureCardGuidance}

6. COMPARISON TABLE
   Columns: Field-Built Systems | ${midColHeader} | DIY
   Exactly these 6 rows in this order:
   Row 1: Done-for-you setup        | FBS check | ${midColHeader} x | DIY x
   Row 2: AI chat + voice agent     | FBS check | ${midColHeader} x | DIY x
   Row 3: Automated review requests | FBS check | ${midColHeader} x | DIY x
   Row 4: Lead follow-up sequences  | FBS check | ${midColHeader} Manual | DIY x
   Row 5: Launch timeline           | FBS 10-14 days | ${midColHeader} Months | DIY Never
   Row 6: Monthly cost              | FBS $500/mo all-in | ${midColHeader} $300-800+ DIY config | DIY Your time

   Colors: check marks #22D87A weight 700 | x marks #EF4444 weight 700 |
           Manual #F59E0B weight 600 | FBS data cells (rows 5-6) #00D4FF weight 600

7. FAQ (4-5 questions)
${faqGuidance}
   - Each question wrapped in <h3> inside the accordion trigger button
   - Accordion uses aria-expanded + hidden panel (JS toggle, not CSS-only)
   - Direct answers only. No restating the question. No filler.

8. CTA SECTION
   - H2: "${ctaH2}"
   - Low-commitment framing: "30 minutes. No pitch deck. No pressure."
   - Button: "Book a Free 30-Minute Call" -> https://field-built.com/book
   - Reassurance line: "Most clients are live within 10-14 days."

=======================================================
DESIGN SYSTEM - MATCH THE HOMEPAGE EXACTLY
=======================================================

CSS CUSTOM PROPERTIES (define in :root):
  --bg: #080C14  --bg-card: #0E1420  --bg-alt: #0A0F1A
  --border: rgba(255,255,255,0.07)  --text: #F1F5F9  --text-muted: #8B9AB4
  --cyan: #1B98E0  --violet: #8B5CF6  --green: #22D87A
  --red: #EF4444  --amber: #F59E0B  --fbs-val: #00D4FF

GRADIENT CLASS (.grad):
  background: linear-gradient(90deg, #1B98E0, #8B5CF6);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;

TYPOGRAPHY:
  Inter from Google Fonts (weights 400,500,600,700,800,900)
  H1: clamp(36px,5vw,64px); weight 900; color #F1F5F9; line-height 1.1
  H2: clamp(28px,4vw,48px); weight 800; color #F1F5F9; 2-4 accent words use .grad
  Body: 16-18px; color var(--text); line-height 1.7

NAV:
  <header> wrapping <nav aria-label="Main navigation">
  Fixed top-0, z-index 100, border-bottom 1px solid var(--border),
  background rgba(8,12,20,0.9), backdrop-filter blur(20px), height 64px.
  Inner flex: max-width 1140px, margin auto, padding 0 24px.

  LEFT: logo + wordmark
    <img src="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png"
         alt="Field-Built Systems logo" width="40" height="40"
         style="height:40px;width:auto;object-fit:contain">
    Wordmark: 22px; weight 700; color #F1F5F9; margin-left 12px

  CENTER LINKS (hidden on mobile):
    Home https://field-built.com (rel="noopener noreferrer") color #1B98E0
    Services /services | About /about | Demo /demo -- color #8B9AB4; hover #1B98E0; transition 0.2s

  RIGHT: "Book a Free Call" button
    background linear-gradient(90deg,#1B98E0,#8B5CF6); border-radius 999px;
    padding 10px 22px; font-size 14px; weight 600; color #fff; no border

  MOBILE HAMBURGER:
    <button id="nav-toggle" aria-label="Toggle menu" aria-expanded="false">
    Toggles full-width dropdown: all nav links + CTA, bg var(--bg-card)
    JS sets aria-expanded="true" when open. Script at bottom of body.

HERO:
  min-height 100vh; display flex; align-items center; justify-content center; text-align center
  background: radial-gradient(ellipse at center, rgba(27,152,224,0.12), var(--bg))
  Grid overlay via ::before pseudo-element:
    background-image: linear-gradient(to right,rgba(255,255,255,0.03) 1px,transparent 1px),
                      linear-gradient(to bottom,rgba(255,255,255,0.03) 1px,transparent 1px);
    background-size: 40px 40px; position:absolute; inset:0; pointer-events:none; content:""
  Two orbs (position:absolute; pointer-events:none; aria-hidden="true"):
    Orb 1: 400px circle; rgba(27,152,224,0.15); filter blur(80px); top -100px; left -100px
    Orb 2: 300px circle; rgba(139,92,246,0.12); filter blur(80px); bottom -80px; right -80px
  Badge: rounded-full; border 1px solid rgba(27,152,224,0.4); bg rgba(27,152,224,0.1);
         padding 6px 16px; 11px uppercase letter-spacing 0.1em; .grad text
  CTA button: linear-gradient(90deg,#1B98E0,#8B5CF6); rounded-full; padding 16px 36px;
              16px weight 700; white; box-shadow 0 0 32px rgba(27,152,224,0.35)

SECTIONS:
  padding: 80px 24px desktop; 60px 20px mobile
  Inner container: max-width 1100px; margin auto
  Each section has a unique id: id="intro" id="problem" id="solution"
                                id="features" id="compare" id="faq" id="cta"
  Eyebrow: 11px; uppercase; letter-spacing 0.1em; color var(--cyan); display block; margin-bottom 12px
  Alternate backgrounds: --bg -> --bg-alt -> --bg -> --bg-card

FEATURE CARDS (2x2 desktop, 1-col mobile):
  bg var(--bg-card); border 1px solid var(--border); border-radius 16px; padding 28px
  hover: border-color rgba(27,152,224,0.3); box-shadow 0 0 20px rgba(27,152,224,0.08)
  Icon tile: 48x48; border-radius 12px; gradient bg; aria-hidden="true"
  H3: 18px; weight 700; var(--text)
  Body: 15px; var(--text-muted); line-height 1.65

COMPARISON TABLE:
  Wrap in overflow-x:auto div for mobile
  table: border-collapse separate; border-spacing 0; width 100%; border-radius 12px; overflow hidden
  Visually hidden caption (accessibility + SEO):
    <caption style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">
      Field-Built Systems vs ${midColHeader} vs DIY -- feature and pricing comparison
    </caption>
  Header row: linear-gradient(135deg,rgba(27,152,224,0.15),rgba(139,92,246,0.1))
  FBS th: color var(--fbs-val); weight 800
  Odd rows: rgba(255,255,255,0.02)
  Cell: padding 16px 20px; border-bottom 1px solid var(--border)

FAQ ACCORDION:
  Each item: <div class="faq-item">
  Trigger: <button class="faq-btn" aria-expanded="false" aria-controls="faq-panel-N" style="...">
             <h3 style="font-size:17px;font-weight:600;color:var(--text);margin:0">[question]</h3>
             <span aria-hidden="true" class="faq-icon">+</span>
           </button>
  Panel: <div id="faq-panel-N" hidden style="font-size:15px;color:var(--text-muted);padding:0 0 20px;line-height:1.7">
  JS: on click, toggle aria-expanded and hidden; swap + to x icon

FOOTER (<footer> semantic element):
  bg #080C14; border-top 1px solid var(--border); padding 48px 24px
  3-col grid desktop (2fr 1fr 1fr):
    Brand (col-span 2): logo + wordmark + tagline + phone + email
      <img src="[same URL]" alt="Field-Built Systems logo" width="32" height="32"
           style="height:32px;width:auto" loading="lazy">
    Company: Services /services | About /about | Contact /contact
    Legal: Privacy Policy /privacy | Terms /terms | Service Agreement /service-agreement
  Bottom bar: "2026 Field-Built Systems. All rights reserved." -- center; 13px; var(--text-muted)
  All footer links: var(--text-muted); hover var(--cyan); transition 0.2s
  Mobile: single column

=======================================================
META AND TECHNICAL REQUIREMENTS
=======================================================

HTML SHELL:
  <!DOCTYPE html>
  <html lang="en">
  All content between nav and footer in <main aria-label="Main content">
  Each content block is a <section> with unique id
  All <script> tags at bottom of <body>

HEAD TAGS (in this order):
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="max-snippet:-1, max-image-preview:large, max-video-preview:-1">

  <title>: Title Case. Keyword + "| Field-Built Systems". 55 chars max.
    Abbreviate state (TX not Texas) if needed to stay under 55.

  <meta name="description">: 140-155 chars. Must include: (1) target keyword or close variant,
    (2) city, (3) specific outcome, (4) soft CTA. No filler.
    Example: "Field-Built Systems installs a done-for-you CRM for HVAC companies in Phoenix.
    AI chat, automated reviews, lead follow-up -- live in 10-14 days. Book a free call."

  <link rel="canonical" href="https://local.field-built.com/${slug}">
  <link rel="alternate" hreflang="en-us" href="https://local.field-built.com/${slug}">

  Open Graph (og:description = VERBATIM copy of meta description, not a rewrite):
    <meta property="og:title" content="${h1} | Field-Built Systems">
    <meta property="og:description" content="[VERBATIM META DESCRIPTION]">
    <meta property="og:url" content="https://local.field-built.com/${slug}">
    <meta property="og:type" content="website">
    <meta property="og:image" content="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png">
    <meta property="og:site_name" content="Field-Built Systems">

  Twitter card (twitter:description = VERBATIM copy of meta description):
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${h1} | Field-Built Systems">
    <meta name="twitter:description" content="[VERBATIM META DESCRIPTION]">
    <meta name="twitter:image" content="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png">

  Google Fonts:
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">

  All CSS in one <style> block.
  All four JSON-LD schema blocks.

H TAG STRATEGY -- NO EXCEPTIONS:
  ONE H1: exact target keyword verbatim
  H2s: keyword-rich and descriptive. NEVER generic.
    Bad: "The Solution" / "How It Works" / "Why Choose Us" / "Get Started"
    Good: "Why ${vertical} Owners in ${city} Are Switching Away from Generic CRMs"
    At least 2 H2s must include BOTH city and vertical naturally
  H3s: ONLY inside feature cards and FAQ triggers
  No H4, H5, H6 anywhere

KEYWORD DENSITY:
  Target keyword or close variant within first 100 words
  In at least one H2
  2-3 more times naturally in body copy

INTERNAL LINKS (2 minimum, body copy only):
  Descriptive, naturally varied anchor text (not templated)
  -> https://field-built.com/services (from copy about what the system includes)
  -> https://field-built.com/demo (from copy inviting reader to see it)
  All outbound links including field-built.com: rel="noopener noreferrer"

ALT TEXT:
  Nav logo: alt="Field-Built Systems logo"
  Footer logo: alt="Field-Built Systems logo"
  Decorative orbs: aria-hidden="true"
  Every img has explicit alt

IMAGE DIMENSIONS:
  Nav logo img: width="40" height="40"
  Footer logo img: width="32" height="32"
  (Prevents layout shift / CLS score)

=======================================================
SCHEMA MARKUP -- ALL FOUR BLOCKS IN HEAD
=======================================================

Block 1 -- LocalBusiness:
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

Block 2 -- Service:
{
  "@context": "https://schema.org",
  "@type": "Service",
  "name": "${h1}",
  "provider": {
    "@type": "Organization",
    "name": "Field-Built Systems",
    "url": "https://field-built.com"
  },
  "areaServed": "${city}, ${state}",
  "description": "${serviceDesc}",
  "url": "https://local.field-built.com/${slug}"
}

Block 3 -- BreadcrumbList:
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://field-built.com" },
    { "@type": "ListItem", "position": 2, "name": "${city} ${vertical}", "item": "https://local.field-built.com/${slug}" }
  ]
}

Block 4 -- FAQPage (every FAQ question on the page must appear here, real text, no placeholders):
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    { "@type": "Question", "name": "EXACT FAQ QUESTION 1", "acceptedAnswer": { "@type": "Answer", "text": "EXACT FAQ ANSWER 1" } },
    { "@type": "Question", "name": "EXACT FAQ QUESTION 2", "acceptedAnswer": { "@type": "Answer", "text": "EXACT FAQ ANSWER 2" } },
    { "@type": "Question", "name": "EXACT FAQ QUESTION 3", "acceptedAnswer": { "@type": "Answer", "text": "EXACT FAQ ANSWER 3" } }
  ]
}

=======================================================
OUTPUT RULES
=======================================================
- Output ONLY raw HTML. No markdown fences. No explanation. No preamble.
- Start with <!DOCTYPE html> and end with </html>
- Self-contained: renders correctly with no external resources except Google Fonts
- All script tags at bottom of body
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

      return raw
        .replace(/^```html\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();

    } catch (err) {
      attempt++;
      const isRetryable = err.status === 429 || err.status >= 500;
      if (isRetryable && attempt < CONFIG.rate.maxRetries) {
        log(`  Retry ${attempt}/${CONFIG.rate.maxRetries} for ${row.slug} (${err.status ?? err.message})`);
        await sleep(CONFIG.rate.retryDelayMs * attempt);
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

  const raw   = fs.readFileSync(CONFIG.csvPath, "utf8");
  let rows    = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  const total = rows.length;

  if (TARGET_SLUG) {
    rows = rows.filter((r) => r.slug === TARGET_SLUG);
    if (rows.length === 0) {
      console.error(`No row found with slug: ${TARGET_SLUG}`);
      process.exit(1);
    }
  }

  if (CHUNK_INDEX !== null && CHUNK_TOTAL !== null) {
    rows = rows.filter((_, i) => i % CHUNK_TOTAL === CHUNK_INDEX - 1);
    log(`Chunk ${CHUNK_INDEX}/${CHUNK_TOTAL}: ${rows.length} rows`);
  }

  if (LIMIT) rows = rows.slice(0, LIMIT);

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
        throw new Error("Output does not look like valid HTML -- skipping write");
      }

      fs.writeFileSync(out, html, "utf8");
      log(`  Written: ${out}`);
      success++;

    } catch (err) {
      logError(slug, err);
      failed++;
    }

    if (i < rows.length - 1) {
      await sleep(CONFIG.rate.delayBetweenMs);
    }
  }

  log(`\nDone. ${success} succeeded  ${failed} failed`);
  if (failed > 0) {
    log(`Check batch-errors.log for details.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
