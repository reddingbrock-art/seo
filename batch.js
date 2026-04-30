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

// ─── Shared nav + footer HTML (injected verbatim — model must not modify) ──

const NAV_HTML = `<header style="position:fixed;top:0;left:0;right:0;z-index:100;border-bottom:1px solid rgba(255,255,255,0.07);background:rgba(8,12,20,0.90);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);height:64px;">
  <div style="max-width:1140px;margin:0 auto;padding:0 24px;height:64px;display:flex;align-items:center;justify-content:space-between;">

    <!-- Logo + Wordmark -->
    <a href="https://field-built.com" style="display:flex;align-items:center;gap:12px;text-decoration:none;" rel="noopener noreferrer">
      <img src="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png"
           alt="Field-Built Systems logo" width="40" height="40"
           style="height:40px;width:auto;object-fit:contain;display:block;">
      <span style="font-size:22px;font-weight:700;color:#F1F5F9;white-space:nowrap;">Field-Built Systems</span>
    </a>

    <!-- Center nav links (desktop only) -->
    <nav aria-label="Main navigation" style="display:flex;align-items:center;gap:32px;" id="nav-desktop-links">
      <a href="https://field-built.com" style="font-size:15px;font-weight:500;color:#1B98E0;text-decoration:none;" rel="noopener noreferrer">Home</a>
      <a href="https://field-built.com/services" style="font-size:15px;font-weight:500;color:#B0BECE;text-decoration:none;" onmouseover="this.style.color='#1B98E0'" onmouseout="this.style.color='#B0BECE'" rel="noopener noreferrer">Services</a>
      <a href="https://field-built.com/about" style="font-size:15px;font-weight:500;color:#B0BECE;text-decoration:none;" onmouseover="this.style.color='#1B98E0'" onmouseout="this.style.color='#B0BECE'" rel="noopener noreferrer">About</a>
      <a href="https://field-built.com/demo" style="font-size:15px;font-weight:500;color:#B0BECE;text-decoration:none;" onmouseover="this.style.color='#1B98E0'" onmouseout="this.style.color='#B0BECE'" rel="noopener noreferrer">Demo</a>
    </nav>

    <!-- CTA button (desktop) -->
    <a href="https://field-built.com/book" id="nav-desktop-cta"
       style="display:inline-block;background:linear-gradient(90deg,#1B98E0,#8B5CF6);border-radius:999px;padding:10px 22px;font-size:14px;font-weight:600;color:#fff;text-decoration:none;white-space:nowrap;"
       rel="noopener noreferrer">Book a Free Call</a>

    <!-- Hamburger (mobile only) -->
    <button id="nav-toggle" aria-label="Toggle menu" aria-expanded="false"
            style="display:none;background:none;border:none;cursor:pointer;padding:8px;color:#F1F5F9;">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>
  </div>

  <!-- Mobile dropdown -->
  <div id="nav-mobile" hidden
       style="background:#0E1420;border-top:1px solid rgba(255,255,255,0.07);padding:16px 24px;display:flex;flex-direction:column;gap:16px;">
    <a href="https://field-built.com" style="font-size:16px;font-weight:500;color:#1B98E0;text-decoration:none;" rel="noopener noreferrer">Home</a>
    <a href="https://field-built.com/services" style="font-size:16px;font-weight:500;color:#B0BECE;text-decoration:none;" rel="noopener noreferrer">Services</a>
    <a href="https://field-built.com/about" style="font-size:16px;font-weight:500;color:#B0BECE;text-decoration:none;" rel="noopener noreferrer">About</a>
    <a href="https://field-built.com/demo" style="font-size:16px;font-weight:500;color:#B0BECE;text-decoration:none;" rel="noopener noreferrer">Demo</a>
    <a href="https://field-built.com/book"
       style="display:inline-block;background:linear-gradient(90deg,#1B98E0,#8B5CF6);border-radius:999px;padding:12px 24px;font-size:15px;font-weight:600;color:#fff;text-decoration:none;text-align:center;"
       rel="noopener noreferrer">Book a Free Call</a>
  </div>
</header>`;

const FOOTER_HTML = `<footer style="background:#080C14;border-top:1px solid rgba(255,255,255,0.07);padding:48px 24px;">
  <div style="max-width:1140px;margin:0 auto;display:grid;grid-template-columns:2fr 1fr 1fr;gap:32px;">
    <div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <img src="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png"
             alt="Field-Built Systems logo" width="32" height="32"
             style="height:32px;width:auto;object-fit:contain;" loading="lazy">
        <span style="font-size:20px;font-weight:700;color:#F1F5F9;">Field-Built Systems</span>
      </div>
      <p style="font-size:14px;color:#8B9AB4;line-height:1.6;max-width:360px;margin:0 0 16px;">
        We install AI-powered automation systems that help service businesses capture, respond to, and convert more leads.
      </p>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <a href="tel:8175187791" style="font-size:14px;color:#8B9AB4;text-decoration:none;">(817) 518-7791</a>
        <a href="mailto:info@field-built.com" style="font-size:14px;color:#8B9AB4;text-decoration:none;">info@field-built.com</a>
      </div>
    </div>
    <div>
      <h4 style="font-size:13px;font-weight:600;color:#F1F5F9;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em;">Company</h4>
      <nav style="display:flex;flex-direction:column;gap:8px;">
        <a href="https://field-built.com/services" style="font-size:14px;color:#8B9AB4;text-decoration:none;" rel="noopener noreferrer">Services</a>
        <a href="https://field-built.com/about" style="font-size:14px;color:#8B9AB4;text-decoration:none;" rel="noopener noreferrer">About</a>
        <a href="https://field-built.com/contact" style="font-size:14px;color:#8B9AB4;text-decoration:none;" rel="noopener noreferrer">Contact</a>
      </nav>
    </div>
    <div>
      <h4 style="font-size:13px;font-weight:600;color:#F1F5F9;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.05em;">Legal</h4>
      <nav style="display:flex;flex-direction:column;gap:8px;">
        <a href="https://field-built.com/privacy" style="font-size:14px;color:#8B9AB4;text-decoration:none;" rel="noopener noreferrer">Privacy Policy</a>
        <a href="https://field-built.com/terms" style="font-size:14px;color:#8B9AB4;text-decoration:none;" rel="noopener noreferrer">Terms of Service</a>
        <a href="https://field-built.com/service-agreement" style="font-size:14px;color:#8B9AB4;text-decoration:none;" rel="noopener noreferrer">Service Agreement</a>
      </nav>
    </div>
  </div>
  <div style="max-width:1140px;margin:32px auto 0;padding-top:24px;border-top:1px solid rgba(255,255,255,0.07);text-align:center;font-size:13px;color:#8B9AB4;">
    &copy; 2026 Field-Built Systems. All rights reserved.
  </div>
</footer>`;

const NAV_MOBILE_CSS = `
@media (max-width: 767px) {
  #nav-desktop-links { display: none !important; }
  #nav-desktop-cta   { display: none !important; }
  #nav-toggle        { display: block !important; }
}
@media (min-width: 768px) {
  #nav-toggle  { display: none !important; }
  #nav-mobile  { display: none !important; }
}`;

const NAV_JS = `<script>
(function() {
  var toggle = document.getElementById('nav-toggle');
  var mobile = document.getElementById('nav-mobile');
  if (!toggle || !mobile) return;
  toggle.addEventListener('click', function() {
    var open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    mobile.hidden = open;
  });
})();
</script>`;

const FAQ_JS = `<script>
(function() {
  document.querySelectorAll('.faq-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var panelId = btn.getAttribute('aria-controls');
      var panel = document.getElementById(panelId);
      var icon = btn.querySelector('.faq-icon');
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.hidden = open;
      if (icon) icon.textContent = open ? '+' : '\u00d7';
    });
  });
})();
</script>`;

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
    "crm":           `Done-for-you CRM built for ${vertical} businesses in ${city}. Configured on GoHighLevel with pipeline, lead follow-up, appointment reminders, and AI chat. Live in 10-14 days.`,
    "automation":    `Done-for-you automation system for ${vertical} companies in ${city}. AI chat, review requests, appointment confirmations, and lead follow-up — installed and live in 10-14 days.`,
    "ai-chat":       `AI chat agent for ${vertical} businesses in ${city}. Answers leads, books appointments, sends confirmations, and follows up — installed and running in 10-14 days.`,
    "lead-followup": `Done-for-you lead follow-up system for ${vertical} companies in ${city}. Automated sequences via text and email, built on GoHighLevel. Live in 10-14 days.`,
    "reviews":       `Automated Google review system for ${vertical} businesses in ${city}. Satisfaction check after every job — happy customers go to Google, unhappy ones come to you first. Live in 10-14 days.`,
  }[page_type] ?? `Done-for-you automation system for ${vertical} businesses in ${city}. Built on GoHighLevel with AI chat, lead follow-up, and review automation. Live in 10-14 days.`;

  const ctaH2 = {
    "crm":           `Ready to Replace Your CRM With Something Built for ${vertical} in ${city}?`,
    "automation":    `Ready to Put Your ${vertical} Business in ${city} on Autopilot?`,
    "ai-chat":       `Ready to Stop Missing Calls From ${city} ${vertical} Customers?`,
    "lead-followup": `Ready to Stop Losing ${city} ${vertical} Leads to Slow Follow-Up?`,
    "reviews":       `Ready to Build Your ${vertical} Reputation in ${city} on Autopilot?`,
  }[page_type] ?? `Ready to See What This Looks Like for Your ${vertical} Business?`;

  // ── What FBS actually delivers (do not invent or expand this list) ────────
  const offeringsNote = `
WHAT FIELD-BUILT SYSTEMS ACTUALLY DELIVERS — do not claim anything outside this list:
  1. AI chat agent — answers inbound leads via website chat, after hours and weekends
  2. AI voice receptionist — answers calls, captures lead info, books appointments
  3. Automated lead follow-up — text + email sequences triggered by new lead, timed and configured
  4. Appointment confirmations + reminders — confirmation on booking, 24hr reminder, en-route text
  5. Google review automation — two-part: satisfaction check after job close, then Google link (positive) or private form (negative)
  6. CRM pipeline — built and configured on GoHighLevel, includes job tracking and lead visibility
  7. Done-for-you setup — we build and configure everything; client does not need to touch it
  8. Ongoing support — we stay on after launch, handle changes, monitor automations

DO NOT mention or imply:
  - Advertising, paid ads, Google Ads, Facebook Ads, or any paid media
  - Website design or website builds (we do not build websites for clients)
  - Social media management
  - Specific pricing or monthly costs — NEVER mention dollar amounts; route all pricing to a discovery call
  - Guarantees of specific results (e.g. "get 50 more reviews")
  - Any integrations not mentioned above
`;

  // ── Feature card guidance ─────────────────────────────────────────────────

  const featureCardGuidance = page_type === "reviews" ? `
FEATURE CARDS — REVIEWS PAGE
All four cards describe the two-part review mechanism. Do not substitute generic cards.

Card 1 — The Trigger (title should be specific, e.g. "Every Completed Job Triggers a Satisfaction Check"):
  After a job is marked complete in the pipeline, a satisfaction check goes out automatically.
  No action needed from you or your tech. This is always the first step — it always comes before
  any review request goes out.
  RULE: Never describe a review request without first establishing this filter exists.

Card 2 — The Fork (title e.g. "Happy Customers Go to Google. Unhappy Ones Come to You First."):
  Describe BOTH outcomes in the same card — this is a single mechanism, not two separate features:
    Positive response → one-tap link to your Google review page
    Negative response → private feedback form routes directly to the owner before anything goes public
  Frame: every job gets followed up. Good outcomes build your public rating.
  Bad ones come to you privately first — giving you a chance to fix it before it becomes a review.
  RULE: Never describe just the positive path. Never describe just the negative filter.
  Both sides must always appear together.

Card 3 — Consistency (title e.g. "Reviews Build Every Week Without You Thinking About It"):
  Volume comes from every job, not from occasional manual asks.
  No training techs to bring it up. No awkward conversation at the end of the job.
  The system sends it; you see the results.

Card 4 — Timing (title e.g. "Requests Go Out While the Experience Is Still Fresh"):
  The check fires right after job close — not a week later when the customer has moved on,
  not mid-job when the work isn't done yet.
  The timing is why customers actually respond.
` : `
FEATURE CARDS — ${page_type.toUpperCase()} PAGE
Two cards are required. Two are flexible but must stay within what FBS actually delivers.

REQUIRED CARD 1 — Appointment Sequence (outcome-focused title):
  Example: "Confirmations and Reminders Go Out Automatically — No-Shows Go Down"
  Describe the full three-touch sequence as a connected outcome, not a feature list:
    Job booked → confirmation sent (text + email)
    24 hours before → reminder with appointment details
    Day of → en-route text when tech leaves for the job
  Frame: no-shows go down, customers show up prepared, you stop chasing confirmations manually.

REQUIRED CARD 2 — Review Protection (outcome-focused title):
  Example: "Every Job Gets a Satisfaction Check — Bad Reviews Get Caught First"
  Describe both sides of the mechanism together — they are one system, not two:
    After job close → satisfaction check fires automatically, no tech involvement needed
    Positive → Google review link sent
    Negative → private feedback form goes to owner BEFORE anything goes public
  Frame: every job gets followed up. Good outcomes build your rating publicly.
  Bad ones come to you first so you can address them directly.
  RULE: Both the positive and negative paths must be described. Never one without the other.

FLEXIBLE CARDS 3 and 4 — choose from what FBS actually offers for ${page_type} + ${vertical}:
  Options: AI chat agent (after-hours lead capture), AI voice receptionist (answers calls),
  lead follow-up sequences (text + email, timed), pipeline visibility (job tracking),
  done-for-you configuration (nothing for you to build).
  Card titles: specific outcome, not feature category name.
  Bad: "Automation Tools" / "AI Features"
  Good: "AI Chat Answers While You're on the Roof" / "Lead Follow-Up Runs Without You"
`;

  // ── FAQ guidance ──────────────────────────────────────────────────────────

  const faqGuidance = {
    "crm": `
FAQ — CRM PAGE (rewrite naturally, use these topics):
  Q1: Do I have to migrate all my old data?
      Direction: we build fresh — most owners don't have clean data worth migrating anyway.
  Q2: Is this just GoHighLevel with a different name?
      Direction: GoHighLevel is a platform. This is a configured system built for ${vertical}.
      Buying GHL yourself is like buying lumber and calling it a house.
  Q3: What if my techs won't adopt a new system?
      Direction: most of it runs without tech input. What they do touch is simple.
  Q4: What happens after setup — are you done with us?
      Direction: no — we stay on, handle changes, keep automations running.
  Q5 optional: How is this different from hiring someone to set up GoHighLevel for me?`,

    "automation": `
FAQ — AUTOMATION PAGE:
  Q1: What actually gets automated and what still needs a human?
      Direction: be specific — lead response, follow-up, confirmations, review requests are automated.
      Dispatch decisions and job notes still need a person.
  Q2: Will this work with the scheduling or invoicing tools I'm already using?
      Direction: honest answer about what integrates and what doesn't. Don't overpromise.
  Q3: Do I have to learn how to build or maintain the automations?
      Direction: no — that's the entire point of done-for-you.
  Q4: What if something stops working while I'm on a job?
      Direction: we monitor it and fix it. You're not on the hook for troubleshooting.
  Q5 optional: How quickly will I actually notice a difference?`,

    "ai-chat": `
FAQ — AI-CHAT PAGE:
  Q1: What happens when a customer asks something the AI doesn't know how to answer?
      Direction: escalation path — it captures their info and books a callback. Doesn't leave them hanging.
  Q2: Will customers know they're talking to an AI?
      Direction: direct, honest answer. Don't dodge it.
  Q3: Can I control what the AI says about my business, my services, my service area?
      Direction: yes — it's trained specifically on your business before it goes live.
  Q4: Does it actually work after hours and on weekends?
      Direction: yes — that's the entire reason to have it. Not a bonus feature.
  Q5 optional: What if a customer is frustrated or upset when they message in?`,

    "lead-followup": `
FAQ — LEAD-FOLLOWUP PAGE:
  Q1: How fast does the first follow-up actually go out?
      Direction: within minutes — while the lead is still warm and hasn't called someone else.
  Q2: What if a lead tells us to stop texting them?
      Direction: automatic opt-out, handled — compliance isn't on you.
  Q3: Can I see what messages went out and what responses came back?
      Direction: yes — full visibility in the pipeline. You can see every touchpoint.
  Q4: What if I already have a follow-up process I'm doing manually?
      Direction: we replace it with something that runs without you. Bring what you have — we'll improve it.
  Q5 optional: How many follow-up touches go out before the sequence ends?`,

    "reviews": `
FAQ — REVIEWS PAGE:
  Q1: What if a customer leaves a bad review even with the filter in place?
      Direction: the filter catches most negative sentiment before it goes public, but it doesn't
      guarantee zero bad reviews. If one lands on Google, we help you respond to it.
      The point of the filter is to reduce it, not eliminate all risk.
  Q2: Can I control which customers get the satisfaction check?
      Direction: yes — it triggers based on job close status in the pipeline, not a random send.
  Q3: How does the system know when a job is finished?
      Direction: it's connected to your pipeline — when a job is marked complete, the sequence fires.
  Q4: Does this work on Google specifically, or other platforms too?
      Direction: Google is the priority because that's what drives local search ranking.
      The review link goes to your Google profile.
  Q5 optional: What happens after a customer submits negative feedback in the private form?
      Direction: it comes directly to you. You handle it privately. It never becomes a public review.`,
  }[page_type] ?? `
FAQ: 4-5 real objections from ${vertical} owners about done-for-you automation. Direct answers only.`;

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
WHAT FBS OFFERS — STAY STRICTLY WITHIN THIS LIST
=======================================================
${offeringsNote}

=======================================================
WRITING STYLE — NO EXCEPTIONS
=======================================================
- Practitioner voice: sounds like someone who has actually run a ${vertical} business
- Specific to ${city}: real neighborhoods, real seasonal patterns, real local market conditions
- Contractions throughout. "You" and "your" always.
- Short punchy sentences mixed with longer explanatory ones
- NEVER use: "game-changer", "seamless", "leverage", "unlock your potential", "supercharge",
  "streamline", "in today's competitive landscape"
- NEVER invent statistics — directional language only ("most", "significantly more", "faster than")
- NEVER reference existing clients or imply past results
- NEVER mention pricing, dollar amounts, or monthly costs — route all pricing to the discovery call

=======================================================
PAGE STRUCTURE — FOLLOW IN ORDER
=======================================================

1. HERO
   - H1: exactly "${h1}" — verbatim, nothing added or changed
   - One-line subhead: specific pain + what FBS delivers. No fluff.
   - CTA button: "Book a Free 30-Minute Call" → https://field-built.com/book
   - Badge above H1: "Done-for-you · Live in 10–14 days"

2. INTRO (max 3 short paragraphs)
   - Who this is for: ${vertical} owners, 1–15 trucks, $300K–$5M revenue
   - Why now, why ${city}
   - Target keyword or close variant must appear within first 100 words

3. PROBLEM (one paragraph MAX)
   - Pure problem — no solution language
   - Real local stakes: ${city} seasonal demand, neighborhood-level competition, etc.

4. SOLUTION
   - What Field-Built installs — done-for-you framing throughout
   - "We install / we configure / we set up" — never "you'll set up / you'll configure"
   - GoHighLevel + AI stack, live in 10–14 days
   - Include at least one contextual link to https://field-built.com/services with natural anchor text

5. FOUR FEATURE CARDS (2×2 desktop, 1-col mobile)
${featureCardGuidance}

6. COMPARISON TABLE
   Columns: Field-Built Systems | ${midColHeader} | DIY
   Exactly 5 rows in this order (NO pricing row — pricing is never discussed on pages):
   Row 1: Done-for-you setup        | ✓ | ✗ | ✗
   Row 2: AI chat + voice agent     | ✓ | ✗ | ✗
   Row 3: Automated review requests | ✓ | ✗ | ✗
   Row 4: Lead follow-up sequences  | ✓ | Manual | ✗
   Row 5: Launch timeline           | 10–14 days | Months | Never

   Render checkmarks and crosses as colored spans:
   ✓ = <span style="color:#22D87A;font-weight:700;">&#10003;</span>
   ✗ = <span style="color:#EF4444;font-weight:700;">&#10007;</span>
   Manual = <span style="color:#F59E0B;font-weight:600;">Manual</span>
   FBS timeline cell = <span style="color:#00D4FF;font-weight:600;">10–14 days</span>

   Include visually hidden caption:
   <caption style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">
     Field-Built Systems vs ${midColHeader} vs DIY — feature comparison
   </caption>

7. FAQ (4–5 questions)
${faqGuidance}
   - Each question in <h3> inside the accordion trigger button
   - Use aria-expanded + hidden panel JS accordion (not CSS-only)
   - Direct answers only — no restating the question, no filler

8. CTA SECTION
   - H2: "${ctaH2}"
   - Subtext: "30 minutes. No pitch deck. No pressure."
   - CTA button: "Book a Free 30-Minute Call" → https://field-built.com/book
   - Reassurance line: "Most clients are live within 10–14 days."
   - Include contextual link to https://field-built.com/demo with natural anchor text

=======================================================
HTML SHELL
=======================================================

Use exactly this structure:

<!DOCTYPE html>
<html lang="en">
<head>
  [HEAD TAGS]
</head>
<body style="margin:0;padding:0;background:#080C14;color:#F1F5F9;font-family:'Inter',system-ui,sans-serif;">

  [NAV HTML — copy verbatim from the NAV BLOCK below, do not modify]

  <main aria-label="Main content" style="padding-top:64px;">
    [SECTIONS with ids: intro, problem, solution, features, compare, faq, cta]
  </main>

  [FOOTER HTML — copy verbatim from the FOOTER BLOCK below, do not modify]

  [SCRIPTS at bottom of body]
</body>
</html>

=======================================================
NAV BLOCK — COPY VERBATIM, DO NOT MODIFY
=======================================================

${NAV_HTML}

=======================================================
FOOTER BLOCK — COPY VERBATIM, DO NOT MODIFY
=======================================================

${FOOTER_HTML}

=======================================================
CSS — ADD INSIDE YOUR <style> BLOCK
=======================================================

/* Nav responsive behavior */
${NAV_MOBILE_CSS}

/* Design system */
:root {
  --bg: #080C14;
  --bg-card: #0E1420;
  --bg-alt: #0A0F1A;
  --border: rgba(255,255,255,0.07);
  --text: #F1F5F9;
  --text-muted: #8B9AB4;
  --cyan: #1B98E0;
  --violet: #8B5CF6;
  --green: #22D87A;
  --red: #EF4444;
  --amber: #F59E0B;
  --fbs-val: #00D4FF;
}

.grad {
  background: linear-gradient(90deg, #1B98E0, #8B5CF6);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* Typography */
h1 { font-size: clamp(36px,5vw,64px); font-weight:900; color:#F1F5F9; line-height:1.1; margin:0; }
h2 { font-size: clamp(28px,4vw,48px); font-weight:800; color:#F1F5F9; line-height:1.15; }
body { font-size:17px; line-height:1.7; }

/* Sections */
.section { padding: 80px 24px; }
.section-alt { background: var(--bg-alt); }
.section-card { background: var(--bg-card); }
.container { max-width:1100px; margin:0 auto; }
.eyebrow { font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:var(--cyan); display:block; margin-bottom:12px; }

@media (max-width:767px) {
  .section { padding: 60px 20px; }
}

/* Hero */
.hero {
  min-height: calc(100vh - 64px);
  display: flex; align-items: center; justify-content: center;
  text-align: center; position: relative; overflow: hidden;
  background: radial-gradient(ellipse at center, rgba(27,152,224,0.12), #080C14);
}
.hero::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background-image:
    linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px);
  background-size: 40px 40px;
}
.hero-inner { position: relative; z-index:1; max-width:860px; padding:80px 24px; }
.hero-badge {
  display: inline-block; border-radius:999px;
  border: 1px solid rgba(27,152,224,0.4); background: rgba(27,152,224,0.1);
  padding: 6px 16px; font-size:11px; font-weight:700; letter-spacing:0.1em;
  text-transform:uppercase; margin-bottom:24px;
}
.btn-primary {
  display: inline-block;
  background: linear-gradient(90deg,#1B98E0,#8B5CF6);
  border-radius: 999px; padding: 16px 36px;
  font-size:16px; font-weight:700; color:#fff; text-decoration:none;
  box-shadow: 0 0 32px rgba(27,152,224,0.35);
  margin-top: 32px; border: none; cursor: pointer;
}

/* Feature cards */
.card-grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
@media (max-width:767px) { .card-grid { grid-template-columns:1fr; } }
.card {
  background:var(--bg-card); border:1px solid var(--border);
  border-radius:16px; padding:28px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.card:hover { border-color:rgba(27,152,224,0.3); box-shadow:0 0 20px rgba(27,152,224,0.08); }
.card-icon {
  width:48px; height:48px; border-radius:12px;
  background: linear-gradient(135deg,#1B98E0,#8B5CF6);
  display:flex; align-items:center; justify-content:center;
  margin-bottom:16px; font-size:22px;
}

/* Comparison table */
.table-wrap { overflow-x:auto; border-radius:12px; border:1px solid var(--border); }
.compare-table { width:100%; border-collapse:collapse; }
.compare-table thead { background:linear-gradient(135deg,rgba(27,152,224,0.15),rgba(139,92,246,0.1)); }
.compare-table th { padding:16px 20px; font-size:14px; font-weight:700; text-align:left; border-bottom:1px solid var(--border); color:var(--text); }
.compare-table th.fbs-col { color:var(--fbs-val); }
.compare-table td { padding:14px 20px; font-size:15px; border-bottom:1px solid var(--border); color:var(--text-muted); }
.compare-table tr:nth-child(odd) td { background:rgba(255,255,255,0.02); }
.compare-table td:first-child { font-weight:500; color:var(--text); }

/* FAQ */
.faq-item { border-bottom:1px solid var(--border); }
.faq-btn {
  width:100%; background:none; border:none;
  display:flex; justify-content:space-between; align-items:center;
  padding:20px 0; cursor:pointer; text-align:left; gap:16px;
}
.faq-icon { color:var(--text-muted); font-size:20px; flex-shrink:0; }

/* CTA section */
.cta-section {
  background: radial-gradient(ellipse at center, rgba(27,152,224,0.08), #080C14);
  text-align:center; padding:80px 24px;
}

=======================================================
HEAD REQUIREMENTS
=======================================================

<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="max-snippet:-1, max-image-preview:large, max-video-preview:-1">
<title>[Title Case keyword] | Field-Built Systems</title>  ← 55 chars max; abbreviate state if needed
<meta name="description" content="[140–155 chars: keyword + ${city} + specific outcome + soft CTA]">
<link rel="canonical" href="https://local.field-built.com/${slug}">
<link rel="alternate" hreflang="en-us" href="https://local.field-built.com/${slug}">
<meta property="og:title" content="${h1} | Field-Built Systems">
<meta property="og:description" content="[verbatim copy of meta description]">
<meta property="og:url" content="https://local.field-built.com/${slug}">
<meta property="og:type" content="website">
<meta property="og:image" content="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png">
<meta property="og:site_name" content="Field-Built Systems">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${h1} | Field-Built Systems">
<meta name="twitter:description" content="[verbatim copy of meta description]">
<meta name="twitter:image" content="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
[<style> block with all CSS]
[4 JSON-LD schema blocks]

=======================================================
H TAG RULES — NO EXCEPTIONS
=======================================================
ONE H1: exact target keyword verbatim
H2s: keyword-rich and descriptive. NEVER: "The Solution" "How It Works" "Why Choose Us" "Get Started"
     At least 2 H2s include BOTH ${city} AND ${vertical} naturally
H3s: ONLY inside feature cards and FAQ accordion triggers — nowhere else
No H4, H5, H6 anywhere

KEYWORD DENSITY:
  Within first 100 words of body text
  In at least one H2
  2–3 more times naturally in body copy

INTERNAL LINKS (2 minimum, body copy only):
  → https://field-built.com/services (anchor: what the system includes, or similar)
  → https://field-built.com/demo (anchor: see it in action, or similar)
  All outbound links: rel="noopener noreferrer"

=======================================================
SCHEMA — 4 BLOCKS IN HEAD
=======================================================

Block 1 — LocalBusiness:
{"@context":"https://schema.org","@type":"LocalBusiness","@id":"https://field-built.com/#business","name":"Field-Built Systems","url":"https://field-built.com","telephone":"(817) 518-7791","email":"info@field-built.com","description":"Done-for-you automation systems for ${vertical} companies in ${city}, ${state}","priceRange":"$$","areaServed":{"@type":"City","name":"${city}","containedInPlace":{"@type":"State","name":"${state}"}},"serviceType":"${page_type}"}

Block 2 — Service:
{"@context":"https://schema.org","@type":"Service","name":"${h1}","provider":{"@type":"Organization","name":"Field-Built Systems","url":"https://field-built.com"},"areaServed":"${city}, ${state}","description":"${serviceDesc}","url":"https://local.field-built.com/${slug}"}

Block 3 — BreadcrumbList:
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://field-built.com"},{"@type":"ListItem","position":2,"name":"${city} ${vertical}","item":"https://local.field-built.com/${slug}"}]}

Block 4 — FAQPage (real text for every FAQ item — no placeholders):
{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"EXACT Q1","acceptedAnswer":{"@type":"Answer","text":"EXACT A1"}},{"@type":"Question","name":"EXACT Q2","acceptedAnswer":{"@type":"Answer","text":"EXACT A2"}},{"@type":"Question","name":"EXACT Q3","acceptedAnswer":{"@type":"Answer","text":"EXACT A3"}}]}

=======================================================
SCRIPTS — PLACE AT BOTTOM OF BODY, VERBATIM
=======================================================

${NAV_JS}

${FAQ_JS}

=======================================================
OUTPUT RULES
=======================================================
- Raw HTML only. No markdown fences. No explanation. No preamble.
- Start with <!DOCTYPE html>, end with </html>
- Nav and footer copied verbatim from the blocks above — do not modify them
- All script tags at bottom of body
- Self-contained except Google Fonts
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
        throw new Error("Output does not look like valid HTML — skipping write");
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
