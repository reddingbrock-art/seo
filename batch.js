#!/usr/bin/env node

/**
 * Field-Built Systems — Programmatic SEO Page Generator
 *
 * node batch.js                    → all rows
 * node batch.js --slug some-slug   → one page
 * node batch.js --limit 10         → first N rows
 * node batch.js --chunk 2 --of 5   → CI parallel chunk (1-based)
 * node batch.js --skip-existing    → skip already-built slugs
 *
 * Setup: npm install @anthropic-ai/sdk csv-parse dotenv
 */

import Anthropic from "@anthropic-ai/sdk";
import { parse }  from "csv-parse/sync";
import fs         from "fs";
import path       from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  csvPath:   path.join(__dirname, "targets.csv"),
  outputDir: path.join(__dirname, "docs"),
  logFile:   path.join(__dirname, "batch.log"),
  errorFile: path.join(__dirname, "batch-errors.log"),
  model:     "claude-opus-4-6",
  maxTokens: 4000,
  rate: { delayBetweenMs: 3200, retryDelayMs: 15000, maxRetries: 3 },
};

const args          = process.argv.slice(2);
const flag          = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasFlag       = (f) => args.includes(f);
const LIMIT         = flag("--limit") ? parseInt(flag("--limit")) : null;
const TARGET_SLUG   = flag("--slug")  ?? null;
const CHUNK_INDEX   = flag("--chunk") ? parseInt(flag("--chunk")) : null;
const CHUNK_TOTAL   = flag("--of")    ? parseInt(flag("--of"))    : null;
const SKIP_EXISTING = hasFlag("--skip-existing");

const sleep     = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (d)  => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };
const outPath   = (s)  => path.join(CONFIG.outputDir, `${s}.html`);

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

// ─── Derived page values ───────────────────────────────────────────────────

function derivePageValues(row) {
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

  const midCol =
    angle === "switching-servicetitan" ? "ServiceTitan" :
    angle === "switching-jobber"       ? "Jobber"       : "Generic CRM";

  const ctaH2 = {
    "crm":           `Ready to Replace Your CRM With Something Built for ${vertical} in ${city}?`,
    "automation":    `Ready to Put Your ${vertical} Business in ${city} on Autopilot?`,
    "ai-chat":       `Ready to Stop Missing Calls From ${city} ${vertical} Customers?`,
    "lead-followup": `Ready to Stop Losing ${city} ${vertical} Leads to Slow Follow-Up?`,
    "reviews":       `Ready to Build Your ${vertical} Reputation in ${city} on Autopilot?`,
  }[page_type] ?? `Ready to See What This Looks Like for Your ${vertical} Business?`;

  const serviceDesc = {
    "crm":           `Done-for-you CRM for ${vertical} businesses in ${city}. Built on GoHighLevel with pipeline, lead follow-up, appointment reminders, and AI chat. Live in 10-14 days.`,
    "automation":    `Done-for-you automation for ${vertical} companies in ${city}. AI chat, review requests, appointment confirmations, and lead follow-up. Live in 10-14 days.`,
    "ai-chat":       `AI chat agent for ${vertical} businesses in ${city}. Answers leads, books appointments, sends confirmations. Live in 10-14 days.`,
    "lead-followup": `Done-for-you lead follow-up for ${vertical} companies in ${city}. Automated text and email sequences on GoHighLevel. Live in 10-14 days.`,
    "reviews":       `Google review automation for ${vertical} businesses in ${city}. Satisfaction check after every job — happy customers go to Google, unhappy ones come to you first. Live in 10-14 days.`,
  }[page_type] ?? `Done-for-you automation for ${vertical} businesses in ${city}. Live in 10-14 days.`;

  return { h1, midCol, ctaH2, serviceDesc, slug, vertical, city, state, page_type, angle };
}

// ─── Prompt — asks only for content, returns JSON ─────────────────────────

function buildPrompt(row) {
  const { vertical, city, state, page_type, angle } = row;
  const { h1, midCol } = derivePageValues(row);

  const cardRules = page_type === "reviews" ? `
All 4 cards cover the two-part review mechanism:
- Card 1: satisfaction check fires after job close automatically — always before any review request goes out
- Card 2: positive response sends Google review link; negative sends private form to owner before anything is public. ALWAYS describe both sides together — they are one mechanism.
- Card 3: reviews build from every job without manual effort or awkward end-of-job conversations
- Card 4: request fires right after job close while the experience is still fresh` : `
- Card 1 (required): appointment sequence — booked→confirmation, 24hr→reminder, day-of→en-route text. Frame as no-shows going down, not a feature list.
- Card 2 (required): review protection — satisfaction check after job close; positive→Google link; negative→private form to owner before it goes public. Always describe both sides together.
- Cards 3-4: pick from AI chat (after-hours leads), AI voice receptionist, lead follow-up sequences, pipeline visibility. Outcome-focused titles only.`;

  const faqTopics = {
    "crm":           `Q1: Do I have to migrate my old data? Q2: Is this just GoHighLevel? (GHL is lumber, this is the house) Q3: What if my techs won't use it? Q4: Are you done after setup? (no — we stay on) Q5: How is this different from hiring a GHL consultant?`,
    "automation":    `Q1: What's automated vs still manual? Q2: Will it work with my existing tools? Q3: Do I have to learn to build automations? (no) Q4: What if something breaks on a job? (we fix it) Q5: How fast will I notice a difference?`,
    "ai-chat":       `Q1: What if a customer asks something the AI can't answer? (captures info, books callback) Q2: Will customers know it's AI? (honest answer) Q3: Can I control what it says? (yes — trained on your business) Q4: Does it work after hours? (yes — that's the point) Q5: What if a customer is angry?`,
    "lead-followup": `Q1: How fast does the first message go out? (minutes) Q2: What if someone says stop texting? (auto opt-out) Q3: Can I see what went out? (yes) Q4: What if I already have a manual process? (we replace it) Q5: How many touches before it stops?`,
    "reviews":       `Q1: What if a bad review slips through anyway? (filter reduces it, doesn't guarantee zero) Q2: Can I control who gets the check? (yes — job close trigger) Q3: How does it know when a job is done? (pipeline status) Q4: Is this Google only? (Google is the priority) Q5: What happens after negative private feedback? (comes to you, never goes public)`,
  }[page_type] ?? `Q1-Q5: real objections from ${vertical} owners about done-for-you automation`;

  return `Write content for a Field-Built Systems SEO landing page. Return ONLY a valid JSON object — no markdown, no explanation.

PAGE: "${h1}"
VERTICAL: ${vertical} | CITY: ${city}, ${state} | TYPE: ${page_type} | ANGLE: ${angle}
COMPETITOR COLUMN: ${midCol}

WRITING RULES:
- Practitioner voice — sounds like someone who ran a ${vertical} business in ${city}
- Real local context: actual ${city} neighborhoods, seasonal patterns, local competition
- Contractions and "you/your" throughout. Varied sentence rhythm.
- Never: "game-changer", "seamless", "leverage", "supercharge", "streamline", dollar amounts, pricing
- Never invent stats — use "most", "faster than", "significantly more"
- Never claim: website builds, paid ads, social media
- FBS offers: AI chat, AI voice receptionist, lead follow-up (text+email), appointment confirmations+reminders, Google review automation (two-part), CRM on GoHighLevel, done-for-you setup+support
- At least 2 H2s must include both "${city}" and "${vertical}"
- Include a natural link to field-built.com/services in intro_body and field-built.com/demo in solution_body using <a href="..." class="bl" rel="noopener noreferrer">anchor text</a>

CARD RULES:
${cardRules}

FAQ TOPICS:
${faqTopics}

Return this exact JSON structure (all fields required):
{
  "meta_title": "Title Case keyword under 55 chars",
  "meta_description": "140-155 chars: keyword + ${city} + outcome + soft CTA",
  "hero_subhead": "one line: specific ${vertical} pain + what FBS delivers",
  "intro_h2": "keyword-rich H2 including ${city} and ${vertical}",
  "intro_body": "2-3 short paragraphs as HTML <p> tags. Keyword within first 100 words. Link to services.",
  "problem_h2": "H2 about the problem including ${city} or ${vertical}",
  "problem_body": "one paragraph as <p> tag. Pure problem, no solution language. Real local factors.",
  "solution_h2": "H2 including ${city} and ${vertical}",
  "solution_body": "2-3 paragraphs as HTML <p> tags. We install/configure framing. Link to demo.",
  "features_h2": "H2 about capabilities including ${vertical} or ${city}",
  "cards": [
    { "title": "Card 1 title", "body": "2-3 sentences" },
    { "title": "Card 2 title", "body": "2-3 sentences" },
    { "title": "Card 3 title", "body": "2-3 sentences" },
    { "title": "Card 4 title", "body": "2-3 sentences" }
  ],
  "compare_h2": "H2 comparing FBS to alternatives including ${vertical} or ${city}",
  "faq_h2": "H2 like Questions From ${city} ${vertical} Owners",
  "faqs": [
    { "q": "question text", "a": "answer text" },
    { "q": "question text", "a": "answer text" },
    { "q": "question text", "a": "answer text" },
    { "q": "question text", "a": "answer text" },
    { "q": "question text", "a": "answer text" }
  ],
  "faq_schema": [
    { "q": "exact question text", "a": "exact answer text" },
    { "q": "exact question text", "a": "exact answer text" },
    { "q": "exact question text", "a": "exact answer text" },
    { "q": "exact question text", "a": "exact answer text" },
    { "q": "exact question text", "a": "exact answer text" }
  ]
}`;
}

// ─── HTML assembler — Node builds the page, model never sees this ──────────

function assembleHTML(content, row) {
  const { h1, midCol, ctaH2, serviceDesc, slug, vertical, city, state, page_type } = derivePageValues(row);

  const faqItems = content.faqs.map((f, i) => `
    <div class="faq-item">
      <button class="faq-btn" aria-expanded="false" aria-controls="f${i+1}">
        <h3>${escHtml(f.q)}</h3>
        <span class="faq-icon" aria-hidden="true">+</span>
      </button>
      <div id="f${i+1}" class="faq-body" hidden><p>${escHtml(f.a)}</p></div>
    </div>`).join("");

  const faqSchema = JSON.stringify(content.faq_schema.map(f => ({
    "@type": "Question",
    "name": f.q,
    "acceptedAnswer": { "@type": "Answer", "text": f.a }
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="max-snippet:-1, max-image-preview:large, max-video-preview:-1">
  <title>${escHtml(content.meta_title)} | Field-Built Systems</title>
  <meta name="description" content="${escAttr(content.meta_description)}">
  <link rel="canonical" href="https://local.field-built.com/${slug}">
  <link rel="alternate" hreflang="en-us" href="https://local.field-built.com/${slug}">
  <meta property="og:title" content="${escAttr(h1)} | Field-Built Systems">
  <meta property="og:description" content="${escAttr(content.meta_description)}">
  <meta property="og:url" content="https://local.field-built.com/${slug}">
  <meta property="og:type" content="website">
  <meta property="og:image" content="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png">
  <meta property="og:site_name" content="Field-Built Systems">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escAttr(h1)} | Field-Built Systems">
  <meta name="twitter:description" content="${escAttr(content.meta_description)}">
  <meta name="twitter:image" content="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root{--bg:#080C14;--bg-card:#0E1420;--bg-alt:#0A0F1A;--border:rgba(255,255,255,0.07);--text:#F1F5F9;--muted:#8B9AB4;--cyan:#1B98E0;--violet:#8B5CF6;--green:#22D87A;--red:#EF4444;--amber:#F59E0B;--fbs:#00D4FF;}
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:17px;line-height:1.7;-webkit-font-smoothing:antialiased;}
    a{color:inherit;text-decoration:none;}
    h1{font-size:clamp(36px,5vw,64px);font-weight:900;line-height:1.1;color:#F1F5F9;}
    h2{font-size:clamp(28px,4vw,48px);font-weight:800;line-height:1.15;color:#F1F5F9;margin-bottom:20px;}
    h3{font-size:18px;font-weight:700;color:#F1F5F9;line-height:1.3;}
    p{color:var(--muted);line-height:1.7;margin-bottom:16px;}
    p:last-child{margin-bottom:0;}
    .grad{background:linear-gradient(90deg,#1B98E0,#8B5CF6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
    .eyebrow{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--fbs);display:block;margin-bottom:12px;}
    .sec{padding:80px 24px;}
    .sec-alt{background:var(--bg-alt);}
    .sec-card{background:var(--bg-card);}
    .wrap{max-width:1100px;margin:0 auto;}
    .wrap-sm{max-width:780px;margin:0 auto;}
    .hero{min-height:calc(100vh - 64px);display:flex;align-items:center;justify-content:center;text-align:center;position:relative;overflow:hidden;background:radial-gradient(ellipse at center,rgba(27,152,224,.12),var(--bg));}
    .hero::before{content:"";position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(to right,rgba(255,255,255,.03) 1px,transparent 1px),linear-gradient(to bottom,rgba(255,255,255,.03) 1px,transparent 1px);background-size:40px 40px;}
    .hero-inner{position:relative;z-index:1;max-width:860px;padding:80px 24px;}
    .orb{position:absolute;border-radius:50%;pointer-events:none;filter:blur(80px);}
    .orb-1{width:400px;height:400px;background:rgba(27,152,224,.15);top:-100px;left:-100px;}
    .orb-2{width:300px;height:300px;background:rgba(139,92,246,.12);bottom:-80px;right:-80px;}
    .badge{display:inline-block;border-radius:999px;border:1px solid rgba(0,212,255,.4);background:rgba(0,212,255,.1);padding:6px 16px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--fbs);margin-bottom:24px;}
    .btn{display:inline-block;background:#00D4FF;border-radius:999px;padding:14px 32px;font-size:15px;font-weight:700;color:#080C14 !important;margin-top:28px;transition:opacity .2s;border:none;cursor:pointer;}
    .btn:hover{opacity:.88;}
    .btn-lg{padding:16px 40px;font-size:16px;}
    .card-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:40px;}
    .card{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:28px;transition:border-color .2s,box-shadow .2s;}
    .card:hover{border-color:rgba(27,152,224,.3);box-shadow:0 0 20px rgba(27,152,224,.08);}
    .card-icon{width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#1B98E0,#8B5CF6);display:flex;align-items:center;justify-content:center;margin-bottom:16px;font-size:22px;}
    .card h3{margin-bottom:8px;}
    .card p{font-size:15px;line-height:1.65;}
    .table-wrap{overflow-x:auto;border-radius:12px;border:1px solid var(--border);margin-top:32px;}
    .cmp{width:100%;border-collapse:collapse;}
    .cmp thead{background:linear-gradient(135deg,rgba(27,152,224,.15),rgba(139,92,246,.1));}
    .cmp th{padding:16px 20px;font-size:14px;font-weight:700;text-align:left;border-bottom:1px solid var(--border);color:var(--text);}
    .cmp th.fbs{color:var(--fbs);}
    .cmp td{padding:14px 20px;font-size:15px;border-bottom:1px solid var(--border);color:var(--muted);}
    .cmp tr:nth-child(odd) td{background:rgba(255,255,255,.02);}
    .cmp td:first-child{font-weight:500;color:var(--text);}
    .ck{color:#22D87A;font-weight:700;}
    .xx{color:#EF4444;font-weight:700;}
    .mn{color:#F59E0B;font-weight:600;}
    .fv{color:#00D4FF;font-weight:600;}
    .faq-item{border-bottom:1px solid var(--border);}
    .faq-btn{width:100%;background:none;border:none;display:flex;justify-content:space-between;align-items:center;padding:20px 0;cursor:pointer;text-align:left;gap:16px;}
    .faq-btn h3{font-size:17px;margin:0;color:#F1F5F9;}
    .faq-icon{color:var(--muted);font-size:20px;flex-shrink:0;}
    .faq-body{font-size:15px;color:var(--muted);line-height:1.7;padding:0 0 20px;}
    .cta-sec{background:radial-gradient(ellipse at center,rgba(27,152,224,.08),var(--bg));text-align:center;padding:80px 24px;}
    .bl{color:var(--fbs);text-decoration:underline;text-decoration-color:rgba(0,212,255,.3);}
    .bl:hover{text-decoration-color:var(--fbs);}
    @media(max-width:767px){
      #ndl,#ndc{display:none!important;}
      #nt{display:block!important;}
      .card-grid{grid-template-columns:1fr;}
      .sec,.cta-sec{padding:60px 20px;}
      .hero-inner{padding:60px 20px;}
    }
    @media(min-width:768px){#nt,#nm{display:none!important;}}
  </style>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","@id":"https://field-built.com/#business","name":"Field-Built Systems","url":"https://field-built.com","telephone":"(817) 518-7791","email":"info@field-built.com","description":"Done-for-you automation for ${vertical} companies in ${city}, ${state}","priceRange":"$$","areaServed":{"@type":"City","name":"${city}","containedInPlace":{"@type":"State","name":"${state}"}},"serviceType":"${page_type}"}</script>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Service","name":"${escAttr(h1)}","provider":{"@type":"Organization","name":"Field-Built Systems","url":"https://field-built.com"},"areaServed":"${city}, ${state}","description":"${escAttr(serviceDesc)}","url":"https://local.field-built.com/${slug}"}</script>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://field-built.com"},{"@type":"ListItem","position":2,"name":"${city} ${vertical}","item":"https://local.field-built.com/${slug}"}]}</script>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":${faqSchema}}</script>
</head>
<body>

<header style="position:fixed;top:0;left:0;right:0;z-index:100;border-bottom:1px solid rgba(255,255,255,0.07);background:rgba(8,12,20,0.92);backdrop-filter:blur(20px);height:64px;">
  <div style="max-width:1140px;margin:0 auto;padding:0 24px;height:64px;display:flex;align-items:center;justify-content:space-between;">
    <a href="https://field-built.com" style="display:flex;align-items:center;gap:12px;" rel="noopener noreferrer">
      <img src="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png" alt="Field-Built Systems logo" width="40" height="40" style="height:40px;width:auto;object-fit:contain;display:block;">
      <span style="font-size:22px;font-weight:700;color:#F1F5F9;white-space:nowrap;">Field-Built Systems</span>
    </a>
    <nav id="ndl" aria-label="Main navigation" style="display:flex;align-items:center;gap:32px;">
      <a href="https://field-built.com" style="font-size:15px;font-weight:500;color:#00D4FF;" rel="noopener noreferrer">Home</a>
      <a href="https://field-built.com/services" style="font-size:15px;font-weight:500;color:#B0BECE;" onmouseover="this.style.color='#00D4FF'" onmouseout="this.style.color='#B0BECE'" rel="noopener noreferrer">Services</a>
      <a href="https://field-built.com/about" style="font-size:15px;font-weight:500;color:#B0BECE;" onmouseover="this.style.color='#00D4FF'" onmouseout="this.style.color='#B0BECE'" rel="noopener noreferrer">About</a>
      <a href="https://field-built.com/demo" style="font-size:15px;font-weight:500;color:#B0BECE;" onmouseover="this.style.color='#00D4FF'" onmouseout="this.style.color='#B0BECE'" rel="noopener noreferrer">Demo</a>
    </nav>
    <a id="ndc" href="https://field-built.com/book" style="display:inline-block;background:#00D4FF;border-radius:999px;padding:10px 22px;font-size:14px;font-weight:700;color:#080C14;" rel="noopener noreferrer">Book a Free Call</a>
    <button id="nt" aria-label="Toggle menu" aria-expanded="false" style="display:none;background:none;border:none;cursor:pointer;padding:8px;color:#F1F5F9;">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
  </div>
  <div id="nm" hidden style="background:#0E1420;border-top:1px solid rgba(255,255,255,0.07);padding:16px 24px;display:flex;flex-direction:column;gap:16px;">
    <a href="https://field-built.com" style="font-size:16px;font-weight:500;color:#00D4FF;" rel="noopener noreferrer">Home</a>
    <a href="https://field-built.com/services" style="font-size:16px;font-weight:500;color:#B0BECE;" rel="noopener noreferrer">Services</a>
    <a href="https://field-built.com/about" style="font-size:16px;font-weight:500;color:#B0BECE;" rel="noopener noreferrer">About</a>
    <a href="https://field-built.com/demo" style="font-size:16px;font-weight:500;color:#B0BECE;" rel="noopener noreferrer">Demo</a>
    <a href="https://field-built.com/book" style="display:inline-block;background:#00D4FF;border-radius:999px;padding:12px 24px;font-size:15px;font-weight:700;color:#080C14;text-align:center;" rel="noopener noreferrer">Book a Free Call</a>
  </div>
</header>

<main aria-label="Main content" style="padding-top:64px;">

  <section class="hero" id="intro">
    <div class="orb orb-1" aria-hidden="true"></div>
    <div class="orb orb-2" aria-hidden="true"></div>
    <div class="hero-inner">
      <span class="badge">Done-for-you &middot; Live in 10&ndash;14 days</span>
      <h1>${escHtml(h1)}</h1>
      <p style="font-size:18px;max-width:520px;margin:20px auto 0;color:#8B9AB4;">${escHtml(content.hero_subhead)}</p>
      <a href="https://field-built.com/book" class="btn" rel="noopener noreferrer">Book a Free 30-Minute Call</a>
    </div>
  </section>

  <section class="sec" id="about">
    <div class="wrap wrap-sm">
      <span class="eyebrow">Who This Is For</span>
      <h2>${escHtml(content.intro_h2)}</h2>
      ${content.intro_body}
    </div>
  </section>

  <section class="sec sec-alt" id="problem">
    <div class="wrap wrap-sm">
      <span class="eyebrow">The Real Cost</span>
      <h2>${escHtml(content.problem_h2)}</h2>
      ${content.problem_body}
    </div>
  </section>

  <section class="sec" id="solution">
    <div class="wrap wrap-sm">
      <span class="eyebrow">What We Install</span>
      <h2>${escHtml(content.solution_h2)}</h2>
      ${content.solution_body}
    </div>
  </section>

  <section class="sec sec-card" id="features">
    <div class="wrap">
      <span class="eyebrow">What's Included</span>
      <h2>${escHtml(content.features_h2)}</h2>
      <div class="card-grid">
        ${content.cards.map(c => `
        <div class="card">
          <div class="card-icon" aria-hidden="true">&#9654;</div>
          <h3>${escHtml(c.title)}</h3>
          <p>${escHtml(c.body)}</p>
        </div>`).join("")}
      </div>
    </div>
  </section>

  <section class="sec sec-alt" id="compare">
    <div class="wrap">
      <span class="eyebrow">How It Stacks Up</span>
      <h2>${escHtml(content.compare_h2)}</h2>
      <div class="table-wrap">
        <table class="cmp">
          <caption style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Field-Built Systems vs ${escHtml(midCol)} vs DIY — feature comparison</caption>
          <thead>
            <tr><th>Feature</th><th class="fbs">Field-Built Systems</th><th>${escHtml(midCol)}</th><th>DIY</th></tr>
          </thead>
          <tbody>
            <tr><td>Done-for-you setup</td><td><span class="ck">&#10003;</span></td><td><span class="xx">&#10007;</span></td><td><span class="xx">&#10007;</span></td></tr>
            <tr><td>AI chat + voice agent</td><td><span class="ck">&#10003;</span></td><td><span class="xx">&#10007;</span></td><td><span class="xx">&#10007;</span></td></tr>
            <tr><td>Automated review requests</td><td><span class="ck">&#10003;</span></td><td><span class="xx">&#10007;</span></td><td><span class="xx">&#10007;</span></td></tr>
            <tr><td>Lead follow-up sequences</td><td><span class="ck">&#10003;</span></td><td><span class="mn">Manual</span></td><td><span class="xx">&#10007;</span></td></tr>
            <tr><td>Launch timeline</td><td><span class="fv">10&ndash;14 days</span></td><td><span class="mn">Months</span></td><td><span class="xx">Never</span></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <section class="sec" id="faq">
    <div class="wrap wrap-sm">
      <span class="eyebrow">FAQ</span>
      <h2>${escHtml(content.faq_h2)}</h2>
      <div style="margin-top:32px;">
        ${faqItems}
      </div>
    </div>
  </section>

  <section class="cta-sec" id="cta">
    <div class="wrap">
      <h2>${escHtml(ctaH2)}</h2>
      <p style="font-size:18px;max-width:480px;margin:16px auto 0;">30 minutes. No pitch deck. No pressure.</p>
      <a href="https://field-built.com/book" class="btn btn-lg" rel="noopener noreferrer">Book a Free 30-Minute Call</a>
      <p style="font-size:14px;margin-top:20px;opacity:.7;">Most clients are live within 10&ndash;14 days.</p>
    </div>
  </section>

</main>

<footer style="background:#080C14;border-top:1px solid rgba(255,255,255,0.07);padding:48px 24px;">
  <div style="max-width:1140px;margin:0 auto;display:grid;grid-template-columns:2fr 1fr 1fr;gap:32px;">
    <div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <img src="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png" alt="Field-Built Systems logo" width="32" height="32" style="height:32px;width:auto;" loading="lazy">
        <span style="font-size:20px;font-weight:700;color:#F1F5F9;">Field-Built Systems</span>
      </div>
      <p style="font-size:14px;color:#8B9AB4;line-height:1.6;max-width:360px;margin:0 0 16px;">We install AI-powered automation systems that help service businesses capture, respond to, and convert more leads.</p>
      <a href="tel:8175187791" style="font-size:14px;color:#8B9AB4;display:block;margin-bottom:4px;">(817) 518-7791</a>
      <a href="mailto:info@field-built.com" style="font-size:14px;color:#8B9AB4;">info@field-built.com</a>
    </div>
    <div>
      <p style="font-size:13px;font-weight:600;color:#F1F5F9;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em;">Company</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <a href="https://field-built.com/services" style="font-size:14px;color:#8B9AB4;" rel="noopener noreferrer">Services</a>
        <a href="https://field-built.com/about" style="font-size:14px;color:#8B9AB4;" rel="noopener noreferrer">About</a>
        <a href="https://field-built.com/contact" style="font-size:14px;color:#8B9AB4;" rel="noopener noreferrer">Contact</a>
      </div>
    </div>
    <div>
      <p style="font-size:13px;font-weight:600;color:#F1F5F9;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em;">Legal</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <a href="https://field-built.com/privacy" style="font-size:14px;color:#8B9AB4;" rel="noopener noreferrer">Privacy Policy</a>
        <a href="https://field-built.com/terms" style="font-size:14px;color:#8B9AB4;" rel="noopener noreferrer">Terms of Service</a>
        <a href="https://field-built.com/service-agreement" style="font-size:14px;color:#8B9AB4;" rel="noopener noreferrer">Service Agreement</a>
      </div>
    </div>
  </div>
  <div style="max-width:1140px;margin:32px auto 0;padding-top:24px;border-top:1px solid rgba(255,255,255,0.07);text-align:center;font-size:13px;color:#8B9AB4;">&copy; 2026 Field-Built Systems. All rights reserved.</div>
</footer>

<script>
(function(){
  var t=document.getElementById('nt'),m=document.getElementById('nm');
  if(t&&m)t.addEventListener('click',function(){
    var o=t.getAttribute('aria-expanded')==='true';
    t.setAttribute('aria-expanded',o?'false':'true');
    m.hidden=o;
  });
  document.querySelectorAll('.faq-btn').forEach(function(b){
    b.addEventListener('click',function(){
      var p=document.getElementById(b.getAttribute('aria-controls'));
      var i=b.querySelector('.faq-icon');
      var o=b.getAttribute('aria-expanded')==='true';
      b.setAttribute('aria-expanded',o?'false':'true');
      p.hidden=o;
      if(i)i.textContent=o?'+':'\u00d7';
    });
  });
})();
</script>

</body>
</html>`;
}

// ─── HTML escape helpers ───────────────────────────────────────────────────

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escAttr(s) {
  return String(s).replace(/"/g, "&quot;").replace(/&/g, "&amp;");
}

// ─── API call ──────────────────────────────────────────────────────────────

async function generateContent(client, row) {
  const prompt = buildPrompt(row);
  let attempt  = 0;

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
        .join("")
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();

      return JSON.parse(raw);

    } catch (err) {
      attempt++;
      const retry = err.status === 429 || err.status >= 500;
      if (retry && attempt < CONFIG.rate.maxRetries) {
        log(`  Retry ${attempt}/${CONFIG.rate.maxRetries} for ${row.slug} (${err.status ?? err.message})`);
        await sleep(CONFIG.rate.retryDelayMs * attempt);
      } else {
        throw err;
      }
    }
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

  const raw   = fs.readFileSync(CONFIG.csvPath, "utf8");
  let rows    = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  const total = rows.length;

  if (TARGET_SLUG) {
    rows = rows.filter((r) => r.slug === TARGET_SLUG);
    if (!rows.length) { console.error(`No row found: ${TARGET_SLUG}`); process.exit(1); }
  }

  if (CHUNK_INDEX !== null && CHUNK_TOTAL !== null) {
    rows = rows.filter((_, i) => i % CHUNK_TOTAL === CHUNK_INDEX - 1);
    log(`Chunk ${CHUNK_INDEX}/${CHUNK_TOTAL}: ${rows.length} rows`);
  }

  if (LIMIT) rows = rows.slice(0, LIMIT);

  if (SKIP_EXISTING) {
    const before = rows.length;
    rows = rows.filter((r) => !fs.existsSync(outPath(r.slug)));
    log(`Skip-existing: ${before - rows.length} done, ${rows.length} remaining`);
  }

  log(`Starting: ${rows.length} pages (${total} in CSV)`);

  let success = 0, failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row  = rows[i];
    const slug = row.slug;

    log(`[${i + 1}/${rows.length}] ${slug}`);

    try {
      const content = await generateContent(client, row);
      const html    = assembleHTML(content, row);

      fs.writeFileSync(outPath(slug), html, "utf8");
      log(`  ✓ ${slug}`);
      success++;
    } catch (err) {
      logError(slug, err);
      failed++;
    }

    if (i < rows.length - 1) await sleep(CONFIG.rate.delayBetweenMs);
  }

  log(`Done. ✓ ${success}  ✗ ${failed}`);
  if (failed > 0) { log(`Check batch-errors.log`); process.exit(1); }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
