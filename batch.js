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

const args         = process.argv.slice(2);
const flag         = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasFlag      = (f) => args.includes(f);
const LIMIT        = flag("--limit")  ? parseInt(flag("--limit"))  : null;
const TARGET_SLUG  = flag("--slug")   ?? null;
const CHUNK_INDEX  = flag("--chunk")  ? parseInt(flag("--chunk"))  : null;
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

// ─── Locked HTML blocks ────────────────────────────────────────────────────
// These are injected verbatim into the prompt. The model is instructed to
// paste them as-is. Do NOT describe nav/footer/CTA in prose elsewhere — that
// gives the model permission to "improve" them.

const LOGO_URL = "https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png";

const NAV_HTML = `<header class="fbs-header">
  <nav class="fbs-nav" aria-label="Main navigation">
    <a href="https://field-built.com" class="fbs-brand">
      <img src="${LOGO_URL}" alt="Field-Built Systems logo" class="fbs-logo">
      <span class="fbs-wordmark">Field-Built Systems</span>
    </a>
    <ul class="fbs-nav-links">
      <li><a href="https://field-built.com">Home</a></li>
      <li><a href="https://field-built.com/services">Services</a></li>
      <li><a href="https://field-built.com/about">About</a></li>
      <li><a href="https://field-built.com/demo">Demo</a></li>
    </ul>
    <a href="https://field-built.com/book" class="fbs-nav-cta">Book a Free Call</a>
    <button class="fbs-hamburger" aria-label="Toggle menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
  </nav>
  <div class="fbs-mobile-menu" hidden>
    <a href="https://field-built.com">Home</a>
    <a href="https://field-built.com/services">Services</a>
    <a href="https://field-built.com/about">About</a>
    <a href="https://field-built.com/demo">Demo</a>
    <a href="https://field-built.com/book" class="fbs-mobile-cta">Book a Free Call</a>
  </div>
</header>`;

const NAV_CSS = `/* Header / Nav — DO NOT MODIFY */
.fbs-header { position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  background: rgba(8,12,20,0.9); backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border); height: 64px; }
.fbs-nav { max-width: 1140px; margin: 0 auto; padding: 0 24px; height: 100%;
  display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.fbs-brand { display: flex; align-items: center; gap: 12px; text-decoration: none; }
.fbs-logo { height: 40px; width: auto; object-fit: contain; display: block; }
.fbs-wordmark { font-size: 22px; font-weight: 700; color: #F1F5F9; }
.fbs-nav-links { display: flex; gap: 28px; list-style: none; margin: 0; padding: 0; }
.fbs-nav-links a { color: #8B9AB4; text-decoration: none; font-size: 15px; font-weight: 500;
  transition: color 0.2s; }
.fbs-nav-links a:hover { color: #1B98E0; }
.fbs-nav-cta { background: linear-gradient(90deg, #1B98E0, #8B5CF6); color: #fff;
  padding: 10px 22px; border-radius: 999px; font-size: 14px; font-weight: 600;
  text-decoration: none; border: none; cursor: pointer; white-space: nowrap; }
.fbs-hamburger { display: none; background: none; border: none; cursor: pointer;
  flex-direction: column; gap: 5px; padding: 8px; }
.fbs-hamburger span { display: block; width: 24px; height: 2px; background: #F1F5F9;
  border-radius: 2px; }
.fbs-mobile-menu { position: fixed; top: 64px; left: 0; right: 0;
  background: var(--bg-card); border-bottom: 1px solid var(--border);
  padding: 20px 24px; flex-direction: column; gap: 16px; }
.fbs-mobile-menu a { color: #8B9AB4; text-decoration: none; font-size: 16px;
  font-weight: 500; padding: 8px 0; }
.fbs-mobile-cta { background: linear-gradient(90deg, #1B98E0, #8B5CF6) !important;
  color: #fff !important; padding: 12px 22px !important; border-radius: 999px;
  text-align: center; font-weight: 600 !important; }
@media (max-width: 768px) {
  .fbs-nav-links, .fbs-nav-cta { display: none; }
  .fbs-hamburger { display: flex; }
  .fbs-mobile-menu[data-open="true"] { display: flex; }
  .fbs-wordmark { font-size: 18px; }
}`;

const NAV_JS = `<script>
(function() {
  var btn = document.querySelector('.fbs-hamburger');
  var menu = document.querySelector('.fbs-mobile-menu');
  if (!btn || !menu) return;
  btn.addEventListener('click', function() {
    var open = menu.getAttribute('data-open') === 'true';
    menu.setAttribute('data-open', open ? 'false' : 'true');
    btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    if (open) { menu.setAttribute('hidden', ''); } else { menu.removeAttribute('hidden'); }
  });
})();
</script>`;

const CTA_BUTTON_HTML = `<a href="https://field-built.com/book" class="fbs-cta-primary">Book a Free 30-Minute Call</a>`;

const CTA_BUTTON_CSS = `/* Primary CTA Button — DO NOT MODIFY */
.fbs-cta-primary { display: inline-block; background: linear-gradient(90deg, #1B98E0, #8B5CF6);
  color: #fff !important; text-decoration: none; padding: 18px 44px;
  border-radius: 999px; font-size: 17px; font-weight: 700; border: none; cursor: pointer;
  box-shadow: 0 0 32px rgba(27,152,224,0.35); transition: transform 0.2s, box-shadow 0.2s; }
.fbs-cta-primary:hover { transform: translateY(-1px);
  box-shadow: 0 0 40px rgba(27,152,224,0.5); }
.fbs-cta-primary--hero { padding: 16px 36px; font-size: 16px; }`;

const FOOTER_HTML = `<footer class="fbs-footer">
  <div class="fbs-footer-inner">
    <div class="fbs-footer-grid">
      <div class="fbs-footer-brand">
        <div class="fbs-footer-brand-row">
          <img src="${LOGO_URL}" alt="Field-Built Systems logo" class="fbs-footer-logo" loading="lazy">
          <span class="fbs-footer-wordmark">Field-Built Systems</span>
        </div>
        <p class="fbs-footer-tagline">We install AI-powered automation systems that help service businesses capture, respond to, and convert more leads.</p>
        <div class="fbs-footer-contact">
          <a href="tel:8175187791">(817) 518-7791</a>
          <a href="mailto:info@field-built.com">info@field-built.com</a>
        </div>
      </div>
      <div class="fbs-footer-col">
        <h4>Company</h4>
        <a href="https://field-built.com/services">Services</a>
        <a href="https://field-built.com/about">About</a>
        <a href="https://field-built.com/contact">Contact</a>
      </div>
      <div class="fbs-footer-col">
        <h4>Legal</h4>
        <a href="https://field-built.com/privacy">Privacy Policy</a>
        <a href="https://field-built.com/terms">Terms of Service</a>
        <a href="https://field-built.com/service-agreement">Service Agreement</a>
      </div>
    </div>
    <div class="fbs-footer-bottom">© 2026 Field-Built Systems. All rights reserved.</div>
  </div>
</footer>`;

const FOOTER_CSS = `/* Footer — DO NOT MODIFY */
.fbs-footer { background: #080C14; border-top: 1px solid var(--border); padding: 48px 24px; }
.fbs-footer-inner { max-width: 1140px; margin: 0 auto; }
.fbs-footer-grid { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 32px; }
.fbs-footer-brand-row { display: flex; align-items: center; gap: 12px; }
.fbs-footer-logo { height: 32px; width: auto; object-fit: contain; }
.fbs-footer-wordmark { font-size: 20px; font-weight: 700; color: #F1F5F9; }
.fbs-footer-tagline { color: var(--text-muted); font-size: 14px; line-height: 1.6;
  margin: 12px 0 16px; max-width: 420px; }
.fbs-footer-contact { display: flex; flex-direction: column; gap: 4px; }
.fbs-footer-contact a { color: var(--text-muted); text-decoration: none; font-size: 14px; }
.fbs-footer-contact a:hover { color: var(--cyan); }
.fbs-footer-col h4 { color: #F1F5F9; font-size: 14px; font-weight: 600; margin: 0 0 12px; }
.fbs-footer-col a { display: block; color: var(--text-muted); text-decoration: none;
  font-size: 14px; padding: 4px 0; }
.fbs-footer-col a:hover { color: var(--cyan); }
.fbs-footer-bottom { text-align: center; color: var(--text-muted); font-size: 13px;
  margin-top: 40px; padding-top: 24px; border-top: 1px solid var(--border); }
@media (max-width: 768px) {
  .fbs-footer-grid { grid-template-columns: 1fr; gap: 32px; }
}`;

// ─── Prompt builder ────────────────────────────────────────────────────────

function buildPrompt(row) {
  const { vertical, city, state, page_type, angle, slug } = row;

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
    "reviews":      `Reputation Management for ${angleLabel} in ${city}, ${state}`,
  }[page_type] ?? `Automation System for ${angleLabel} in ${city}, ${state}`;

  const h1 = pageLabel;

  const midColHeader =
    angle === "switching-servicetitan" ? "ServiceTitan" :
    angle === "switching-jobber"       ? "Jobber"       :
    "Generic CRM";

  const serviceDesc = {
    "crm":          `Done-for-you CRM built for ${vertical} businesses in ${city}. Configured on GoHighLevel with pipeline, lead follow-up, and AI chat. Live in 10–14 days.`,
    "automation":   `Done-for-you automation system for ${vertical} companies in ${city}. AI chat, review requests, and lead follow-up — installed and live in 10–14 days.`,
    "ai-chat":      `AI chat agent for ${vertical} businesses in ${city}. Answers leads, books appointments, and follows up — installed and running in 10–14 days.`,
    "lead-followup":`Done-for-you lead follow-up system for ${vertical} companies in ${city}. Automated sequences via text and email, built on GoHighLevel. Live in 10–14 days.`,
    "reviews":      `Done-for-you reputation management for ${vertical} businesses in ${city}. Automated review requests, multi-platform monitoring, and AI-drafted owner replies. Live in 10–14 days.`,
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
LOCKED HTML BLOCKS — PASTE VERBATIM, DO NOT MODIFY
═══════════════════════════════════════════════════

The blocks below are NOT to be rewritten, restyled, restructured, or "improved." Paste them
exactly as written. Do not change class names, hrefs, text, or attributes. Do not invent
alternative versions. If you change anything inside these blocks, the page is wrong.

──── BLOCK 1: NAVIGATION HTML — place immediately after opening <body> ────
${NAV_HTML}

──── BLOCK 2: NAV + CTA + FOOTER CSS — paste verbatim inside your single <style> block ────
Place these AFTER your :root design tokens. Do not change selectors, values, or breakpoints.

${NAV_CSS}

${CTA_BUTTON_CSS}

${FOOTER_CSS}

──── BLOCK 3: PRIMARY CTA BUTTON ────
Every primary "Book a Free 30-Minute Call" button on the page must be exactly this HTML:
${CTA_BUTTON_HTML}

For the hero CTA only, add the modifier class:
<a href="https://field-built.com/book" class="fbs-cta-primary fbs-cta-primary--hero">Book a Free 30-Minute Call</a>

Do NOT invent your own button styling. Do NOT change the href. Do NOT change the button text.
Do NOT add secondary CTAs, "Try the demo first" links, or any other buttons in the hero or
bottom CTA. The only primary CTA on the page links to https://field-built.com/book.

──── BLOCK 4: FOOTER HTML — place immediately before the nav <script> ────
${FOOTER_HTML}

──── BLOCK 5: NAV JS — place immediately before </body> ────
${NAV_JS}

═══════════════════════════════════════════════════
REPUTATION POSITIONING — REQUIRED FRAMING
═══════════════════════════════════════════════════

Field-Built Systems sells REPUTATION MANAGEMENT, not just review automation. Every page must
position the offer this way when reviews come up. The reputation stack has three parts and
all three must be referenced on pages where reputation is the primary topic, and at least
two should be referenced briefly on pages where reputation is one of several capabilities:

1. AUTOMATED REVIEW REQUESTS
   - Goes out to every customer after a completed job
   - Same ask, every time, no manual chasing
   - Timing is automated and tied to job-close in the CRM
   - The link points to the business's Google profile (and other platforms when relevant)

2. MULTI-PLATFORM REPUTATION MONITORING
   - Tracks new reviews and mentions across Google, Yelp, and Facebook in one place
   - Owner gets notified when a new review lands so nothing sits unanswered for days
   - One inbox view — you don't have to log into three platforms to see what people are saying

3. AI-DRAFTED OWNER REPLIES
   - When a review lands (positive OR negative), the system drafts a response in the owner's voice
   - Owner reviews, edits if they want, and approves with one tap — reply posts to the platform
   - Replying to every review (not just bad ones) signals an active business to Google's algorithm
   - Bad reviews get a calm, professional response drafted in seconds instead of a panicked
     midnight reply or — worse — silence

WHEN WRITING ABOUT REVIEWS, USE THIS LANGUAGE:
- "Every customer gets the ask" / "every job triggers a review request"
- "Reply to every review without staring at a 1-star at 9pm"
- "AI drafts the response in your voice — you tap approve"
- "One inbox for Google, Yelp, and Facebook reviews"
- "Reputation built on volume and responsiveness, not luck"

DO NOT mention or imply any of the following — these concepts are off the table entirely
and must not appear in copy, FAQ answers, feature cards, or anywhere else:
- Filtering, screening, or pre-qualifying customers before the review request
- Sending different links based on customer sentiment
- Routing unhappy customers to a private form before they can review publicly
- "Capturing negative feedback before it goes public"
- "Only happy customers get the Google link"
- Any framing that suggests the system controls WHICH customers can leave a public review

The differentiator is responsiveness and volume — every customer gets asked, every review
gets answered. That is the entire story.

═══════════════════════════════════════════════════
PRICING — DO NOT DISCUSS
═══════════════════════════════════════════════════
- Never mention "$1,200 setup", "$500/month", retainer, fees, or any specific dollar amounts
  in body copy, intro, problem, solution, feature cards, or FAQ.
- The ONLY place pricing appears is comparison table row 6, exactly as specified below.
- Route all pricing questions to the discovery call.

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
- City context must be real: actual neighborhoods, seasonal factors, local market conditions

═══════════════════════════════════════════════════
PAGE STRUCTURE — FOLLOW EXACTLY, IN ORDER
═══════════════════════════════════════════════════

1. HERO
   - H1: exactly "${h1}"
   - One-line subhead: specific pain + what FBS delivers, no fluff
   - Single CTA: use the locked CTA HTML with --hero modifier (see Block 3)
   - Small badge above H1: "Done-for-you · Live in 10–14 days"
   - DO NOT add a secondary "demo" link or any other button

2. INTRO PARAGRAPH
   - Who this is for (1–15 trucks, $300K–$5M revenue range)
   - Why now / why this city
   - No more than 3 short paragraphs

3. PROBLEM SECTION (one paragraph MAX)
   - Specific pain, real stakes, make it hurt fast
   - No solution language here — pure problem
   - Name real local factors

4. SOLUTION SECTION
   - What Field-Built delivers
   - Done-for-you framing — "we install" not "you'll configure"
   - Built on GoHighLevel + AI stack, live in 10–14 days

5. FOUR FEATURE CARDS (2×2 grid desktop, 1-col mobile)
   For pages where reputation is the primary topic (page_type "reviews"), the four cards
   must collectively cover the full reputation stack:
   - "Review Requests After Every Job" (the ask, automated)
   - "One Inbox for Google, Yelp, and Facebook" (multi-platform monitoring)
   - "AI-Drafted Replies in Your Voice" (response automation)
   - "Reputation That Compounds Without You Touching It" (the system view)

   For other page_types, include ONE card about reputation that frames it as the full stack
   (asks + monitoring + AI replies), not just review automation. The other three cards cover
   the page_type's primary capability.

6. COMPARISON TABLE
   Columns: Field-Built Systems | ${midColHeader} | DIY
   Exactly these 6 rows, in this order:
   Row 1: Done-for-you setup            | ✓ | ✗ | ✗
   Row 2: AI chat + voice agent         | ✓ | ✗ | ✗
   Row 3: Reputation management stack   | ✓ | ✗ | ✗
   Row 4: Lead follow-up sequences      | ✓ | Manual | ✗
   Row 5: Launch timeline               | 10–14 days | Months | Never
   Row 6: Monthly cost                  | $500/mo all-in | $300–800+ DIY config | Your time
   ✓ = #22D87A  |  ✗ = #EF4444  |  Manual = #F59E0B  |  FBS values = #00D4FF
   Include a visually-hidden <caption> describing the comparison.

7. FAQ (4–5 questions)
   Questions must be specific to BOTH the vertical AND the page_type. Direct answers, no
   restating the question. By page_type, choose from these:
     crm:          "Do I have to migrate all my old data?", "Is this just GoHighLevel rebranded?",
                   "What if my techs won't use a new system?", "How is this different from buying GHL directly?"
     automation:   "What gets automated and what's still manual?", "Will this work with the tools I already use?",
                   "Do I have to learn how to build automations?", "What if something breaks while I'm on a job?"
     ai-chat:      "What happens when a customer asks something the AI can't answer?", "Can I customize what the AI says?",
                   "Will customers know they're talking to an AI?", "Does it work after hours and on weekends?"
     lead-followup:"How fast does the follow-up actually go out?", "What if a lead replies STOP?",
                   "Can I see what messages went out?", "What if I already have a follow-up sequence?"
     reviews:      "What if a customer leaves a bad review?", "Does the AI reply post automatically or do I approve it first?",
                   "Which platforms does it monitor?", "How does it know when a job is done?",
                   "What if I don't like the reply the AI drafts?"
   Each FAQ question wrapped in <h3>.

   For the "what if a customer leaves a bad review" question, the answer must reflect the
   real positioning: the system flags it immediately, drafts a calm professional response in
   your voice for you to review and approve, and posts the reply once you tap approve. No
   filtering, no hiding — just fast, considered responses to every review.

8. CTA SECTION
   - H2 specific to the page type:
       crm:          "Ready to Replace Your CRM With Something Built for ${vertical} in ${city}?"
       automation:   "Ready to Put Your ${vertical} Business in ${city} on Autopilot?"
       ai-chat:      "Ready to Stop Missing Calls From ${city} ${vertical} Customers?"
       lead-followup:"Ready to Stop Losing ${city} ${vertical} Leads to Slow Follow-Up?"
       reviews:      "Ready to Build Your ${vertical} Reputation in ${city} on Autopilot?"
   - Subhead: "30 minutes. No pitch deck. No pressure."
   - Button: locked CTA from Block 3
   - Reassurance line below: "Most clients are live within 10–14 days."

═══════════════════════════════════════════════════
DESIGN SYSTEM
═══════════════════════════════════════════════════

Use these CSS custom properties at the top of your <style> block, inside :root:
  --bg:        #080C14
  --bg-card:   #0E1420
  --bg-alt:    #0A0F1A
  --border:    rgba(255,255,255,0.07)
  --text:      #F1F5F9
  --text-muted:#8B9AB4
  --cyan:      #1B98E0
  --violet:    #8B5CF6
  --green:     #22D87A
  --red:       #EF4444
  --amber:     #F59E0B
  --fbs-val:   #00D4FF

GRADIENT for H2 accent words and hero badge text:
  background: linear-gradient(90deg, #1B98E0, #8B5CF6);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;

TYPOGRAPHY:
  - Font: Inter from Google Fonts (weights 400, 500, 600, 700, 800, 900)
  - H1: clamp(36px, 5vw, 64px); font-weight 900; color #F1F5F9; line-height 1.1
  - H2: clamp(28px, 4vw, 48px); font-weight 800; color #F1F5F9
        2–4 words per H2 should use the gradient span class
  - Body: 16–18px; color var(--text); line-height 1.7

HERO SECTION:
  - min-height: 100vh; flex center; text-center
  - Background: radial-gradient from rgba(27,152,224,0.12) center over --bg
  - Animated grid overlay: 40px grid lines at rgba(255,255,255,0.03) via background-image
  - Two decorative blurred orbs (position absolute, pointer-events none, blur 80px):
      Orb 1: 400px circle, rgba(27,152,224,0.15), top-left
      Orb 2: 300px circle, rgba(139,92,246,0.12), bottom-right
  - Badge above H1: rounded-full, border 1px solid rgba(27,152,224,0.4),
      background rgba(27,152,224,0.1), gradient text, font-size 11px uppercase tracking-widest

SECTIONS:
  - padding: 80px 24px desktop; 60px 20px mobile
  - max-width container: 1100px; margin auto
  - Section labels (eyebrow): 11px uppercase letter-spacing 0.1em color var(--cyan)
  - Alternate backgrounds: --bg → --bg-alt → --bg → --bg-card

FEATURE CARDS:
  - background var(--bg-card); border 1px solid var(--border); border-radius 16px; padding 28px
  - Hover: border-color rgba(27,152,224,0.3); box-shadow 0 0 20px rgba(27,152,224,0.08)
  - Icon tile: 48px square, border-radius 12px, gradient background, icon white
  - Card title H3: 18px, font-weight 700, color var(--text)
  - Card body: 15px, color var(--text-muted), line-height 1.65

COMPARISON TABLE:
  - border-collapse separate; border-spacing 0; width 100%; border-radius 12px; overflow hidden
  - Header row: linear-gradient(135deg, rgba(27,152,224,0.15), rgba(139,92,246,0.1))
  - FBS column header: color var(--fbs-val); font-weight 800
  - Odd rows: rgba(255,255,255,0.02); even: transparent
  - Cell padding 16px 20px; border-bottom 1px solid var(--border)
  - ✓ color var(--green); ✗ color var(--red); Manual color var(--amber); FBS values var(--fbs-val)
  - Wrap in horizontally scrollable div on mobile

FAQ:
  - Accordion (pure CSS or minimal JS)
  - Each item: border-bottom 1px solid var(--border); padding 20px 0
  - Question H3: 17px, font-weight 600, color var(--text), cursor pointer
  - Answer: 15px, color var(--text-muted), line-height 1.7, padding-top 12px

CTA SECTION:
  - Background: radial-gradient from rgba(27,152,224,0.08) center over --bg
  - H2: white with gradient accent words
  - Button: locked CTA (Block 3) — do NOT restyle

═══════════════════════════════════════════════════
META / TECHNICAL REQUIREMENTS
═══════════════════════════════════════════════════
- Complete standalone HTML file: <!DOCTYPE html> through </html>
- Opening tag: <html lang="en">
- <head> includes:
    - charset UTF-8, viewport meta
    - <meta name="robots" content="index, follow">
    - <title>: Title Case. Exact target keyword + " | Field-Built Systems". Target ≤55 chars.
      Abbreviate state if needed (AZ not Arizona).
    - <meta name="description">: 140–155 chars. Include (1) target keyword or close variant,
      (2) city name, (3) specific outcome/differentiator, (4) soft CTA.
    - <link rel="canonical" href="https://local.field-built.com/${slug}">
    - Open Graph + Twitter card tags (og:title, og:description verbatim from meta description,
      og:url, og:type=website, og:image=${LOGO_URL}, og:site_name, twitter:card=summary_large_image,
      twitter:title, twitter:description verbatim, twitter:image)
    - Google Fonts with preconnect:
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    - All CSS in one <style> block — no external stylesheets
    - Three JSON-LD <script type="application/ld+json"> blocks (see schema below)
- No external JS libraries
- Mobile responsive with inline media queries
- Wrap all page content (between nav and footer) in a <main> element
- Use <section> elements for each major content block inside <main>

KEYWORD DENSITY:
- Exact target keyword or close variant in first 100 words of body
- In at least one H2 heading
- Naturally 2–3 more times in body — never forced

INTERNAL LINKS:
- At least 2 contextual text links inside body copy (not nav/footer):
    https://field-built.com/services — link from copy about what is included
    https://field-built.com/demo    — link from copy inviting reader to see it in action
- Anchor text natural to surrounding sentence, varied phrasing

ALT TEXT:
- Nav and footer logos: alt="Field-Built Systems logo" (footer also loading="lazy")
- Decorative elements: alt=""

H TAG STRATEGY — STRICT:
- ONE H1 — exact target keyword verbatim
- H2s: keyword-rich, descriptive. NEVER "The Solution" / "How It Works" / "Why Choose Us"
  At least 2 H2s must include both city name and vertical.
- H3s: ONLY inside feature cards and FAQ items
- No H4/H5/H6 anywhere

SCHEMA MARKUP — three JSON-LD blocks in <head>:

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

3. FAQPage — populate mainEntity with ALL FAQ items from the page. Every question must
   appear here. Valid JSON, no comments, no placeholders:
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    { "@type": "Question", "name": "EXACT QUESTION 1", "acceptedAnswer": { "@type": "Answer", "text": "EXACT ANSWER 1" } }
  ]
}

═══════════════════════════════════════════════════
OUTPUT RULES
═══════════════════════════════════════════════════
- Output ONLY raw HTML — no markdown fences, no explanation, no preamble
- Start with <!DOCTYPE html> and end with </html>
- Self-contained except for Google Fonts
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
        log(`  ↻ Retry ${attempt}/${CONFIG.rate.maxRetries} for ${row.slug} (${err.status ?? err.message})`);
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

  const raw     = fs.readFileSync(CONFIG.csvPath, "utf8");
  let rows      = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  const total   = rows.length;

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
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

