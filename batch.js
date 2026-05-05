#!/usr/bin/env node

/**
 * Field-Built Systems — Programmatic SEO Page Generator
 * Reads targets.csv → calls Claude API (copy JSON only) → Node assembles HTML → writes to /docs
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
  cname:      "local.field-built.com",
  model:      "claude-haiku-4-5-20251001",  // LOCKED — never change
  maxTokens:  2000,
  rate: {
    delayBetweenMs: 100,  // LOCKED — never change
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

// ─── Row derivation (deterministic — never sent to model) ──────────────────

function deriveRow(row) {
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
    "crm":          `Best CRM for ${angleLabel} in ${city}, ${state}`,
    "automation":   `Automation Software for ${angleLabel} in ${city}, ${state}`,
    "ai-chat":      `AI Chat Agent for ${angleLabel} in ${city}, ${state}`,
    "lead-followup":`Lead Follow-Up System for ${angleLabel} in ${city}, ${state}`,
    "reviews":      `Google Review Automation for ${angleLabel} in ${city}, ${state}`,
  }[page_type] ?? `Automation System for ${angleLabel} in ${city}, ${state}`;

  const midColHeader =
    angle === "switching-servicetitan" ? "ServiceTitan" :
    angle === "switching-jobber"       ? "Jobber"       : "Generic CRM";

  const ctaH2 = `Ready to See What This Looks Like for Your ${vertical} Business?`;

  const serviceDesc = {
    "crm":          `CRM system configured for ${vertical} businesses`,
    "automation":   `Done-for-you automation for ${vertical} companies`,
    "ai-chat":      `AI chat agent for ${vertical} businesses`,
    "lead-followup":`Automated lead follow-up for ${vertical} companies`,
    "reviews":      `Google review automation for ${vertical} businesses`,
  }[page_type] ?? `Automation system for ${vertical} businesses`;

  return { ...row, h1, midColHeader, ctaH2, serviceDesc, angleLabel };
}

// ─── Prompt builder (copy only — no HTML, no CSS) ──────────────────────────

function buildContentPrompt(derived) {
  const { vertical, city, state, page_type, h1 } = derived;

  const faqBank = {
    "crm":          ["Do I have to learn new software?", "What if I'm already using GoHighLevel?", "How is this different from just buying a CRM?", "What happens after setup?", "How fast will I see results?"],
    "automation":   ["What exactly gets automated?", "Do I need technical skills to run this?", "What if my team resists new tools?", "How is this different from buying software myself?", "What happens if something breaks?"],
    "ai-chat":      ["Will the AI actually sound like my business?", "What happens when the AI can't answer?", "Does this replace my receptionist?", "What hours does the AI chat work?", "How long does setup take?"],
    "lead-followup":["How many follow-ups does it send?", "Can I customize what it says?", "What if a lead asks to stop?", "Does this work with my current CRM?", "What's the typical response rate?"],
    "reviews":      ["Will this get me fake reviews?", "What if a customer is unhappy?", "Which platforms does this work on?", "How does the timing work?", "What if I already have a review process?"],
  }[page_type] ?? ["Do I have to learn new software?", "How fast will I see results?", "What if something breaks?", "Is there a contract?"];

  return `You write conversion copy for Field-Built Systems, a done-for-you automation agency for field service businesses.

VERTICAL: ${vertical} | CITY: ${city}, ${state} | PAGE: ${page_type}
H1: "${h1}"

RULES:
- Practitioner voice — sounds like someone who ran a ${vertical} business
- Contractions, "you/your" throughout, varied sentence rhythm
- City context must be specific: real neighborhoods, real seasonal patterns, real market pressure
- Never open with "You're running", "As a ${vertical} owner", or "The ${city} market is"
- Never invent stats — use "most", "significantly more", "faster than"
- Never reference existing clients or imply past results
- Forbidden: "game-changer", "seamless", "leverage", "supercharge", "streamline", "hard-working", "tight-knit"
- Problem paragraph: one paragraph, name the specific operational failure (not the category), end on consequence

Return ONLY valid JSON, no markdown:
{
  "heroSubhead": "one sharp line, specific pain + what FBS delivers",
  "introP1": "paragraph — lead with what's happening in their business right now, weave in 1-15 trucks / $300K-$5M naturally",
  "introP2": "paragraph — why ${city} specifically, a real seasonal or neighborhood observation",
  "problemBody": "one paragraph max — the specific operational failure, local texture, consequence",
  "solutionH2": "keyword-rich H2 including ${vertical} and ${city}",
  "solutionBody": "2-3 sentences — done-for-you framing, GoHighLevel + AI, live in 10-14 days. May include <a href='/services'>our services</a> or <a href='/demo'>see a demo</a>.",
  "cards": [
    { "icon": "emoji", "title": "specific capability title", "body": "2-3 sentences" },
    { "icon": "emoji", "title": "specific capability title", "body": "2-3 sentences" },
    { "icon": "emoji", "title": "specific capability title", "body": "2-3 sentences" },
    { "icon": "emoji", "title": "specific capability title", "body": "2-3 sentences" }
  ],
  "faqH2": "keyword-rich H2 for FAQ section",
  "faqs": [
    { "q": "${faqBank[0]}", "a": "direct answer, no restatement" },
    { "q": "${faqBank[1]}", "a": "direct answer" },
    { "q": "${faqBank[2]}", "a": "direct answer" },
    { "q": "${faqBank[3]}", "a": "direct answer" }
  ]
}`;
}

// ─── Sanitization ──────────────────────────────────────────────────────────

function escHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// solutionBody only — preserves <a href="/services"> and <a href="/demo"> internal links
function sanitizeBody(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/<(?!\/?(a)\b)[^>]+>/gi, "")
    .replace(/(<a\s+href=")(?!\/|https:\/\/field-built\.com)/gi, "$1/");
}

// ─── Static locked blocks (never sent to model) ────────────────────────────

const NAV_HTML = `
<header class="nav">
  <div class="nav-inner">
    <a href="https://field-built.com" class="nav-brand">
      <img src="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png" alt="Field-Built Systems" height="40">
      <span>Field-Built Systems</span>
    </a>
    <nav class="nav-links" aria-label="Main navigation">
      <a href="https://field-built.com">Home</a>
      <a href="/services">Services</a>
      <a href="/about">About</a>
      <a href="/demo">Demo</a>
    </nav>
    <a href="https://field-built.com/book" class="nav-cta">Book a Free Call</a>
    <button class="nav-hamburger" aria-label="Toggle menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
  </div>
  <div class="nav-mobile" id="navMobile">
    <a href="https://field-built.com">Home</a>
    <a href="/services">Services</a>
    <a href="/about">About</a>
    <a href="/demo">Demo</a>
    <a href="https://field-built.com/book" class="nav-cta-mobile">Book a Free Call</a>
  </div>
</header>`;

const FOOTER_HTML = `
<footer class="footer">
  <div class="footer-inner">
    <div class="footer-brand">
      <a href="https://field-built.com" class="nav-brand">
        <img src="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png" alt="Field-Built Systems" height="32" loading="lazy">
        <span>Field-Built Systems</span>
      </a>
      <p class="footer-tagline">Done-for-you automation for field service businesses.</p>
      <div class="footer-contact">
        <a href="tel:8175187791">(817) 518-7791</a>
        <a href="mailto:info@field-built.com">info@field-built.com</a>
      </div>
    </div>
    <div class="footer-col">
      <p class="footer-col-label">Company</p>
      <a href="/services">Services</a>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
    </div>
    <div class="footer-col">
      <p class="footer-col-label">Legal</p>
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms of Service</a>
      <a href="/service-agreement">Service Agreement</a>
    </div>
  </div>
  <div class="footer-bottom">© 2026 Field-Built Systems. All rights reserved.</div>
</footer>`;

const NAV_JS = `
<script>
  const btn = document.querySelector('.nav-hamburger');
  const mob = document.getElementById('navMobile');
  btn.addEventListener('click', () => {
    const open = mob.classList.toggle('open');
    btn.setAttribute('aria-expanded', open);
  });
</script>`;

// ─── HTML assembler (all HTML/CSS — never in the prompt) ───────────────────

function assembleHTML(derived, content) {
  const { vertical, city, state, slug, h1, midColHeader, ctaH2, serviceDesc } = derived;
  const {
    heroSubhead = "", introP1 = "", introP2 = "", problemBody = "",
    solutionH2 = "", solutionBody = "",
    cards = [], faqH2 = "", faqs = [],
  } = content;

  const esc = escHtml;

  const metaDesc = `Done-for-you ${derived.page_type} for ${vertical} companies in ${city}, ${state}. AI chat, automated follow-up, and Google review automation. Live in 10–14 days.`.slice(0, 160);

  const schemaLocal = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    "@id": `https://local.field-built.com/${slug}`,
    "name": "Field-Built Systems",
    "url": "https://field-built.com",
    "telephone": "(817) 518-7791",
    "email": "info@field-built.com",
    "description": `Done-for-you automation systems for ${vertical} companies in ${city}, ${state}`,
    "priceRange": "$$",
    "areaServed": { "@type": "City", "name": city, "containedInPlace": { "@type": "State", "name": state } },
    "serviceType": serviceDesc,
  });

  const schemaService = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Service",
    "name": h1,
    "provider": { "@type": "Organization", "name": "Field-Built Systems", "url": "https://field-built.com" },
    "areaServed": `${city}, ${state}`,
    "description": `Done-for-you ${serviceDesc} in ${city}. Built on GoHighLevel with AI chat, lead follow-up, and review automation. Live in 10–14 days.`,
    "url": `https://local.field-built.com/${slug}`,
  });

  const schemaFaq = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqs.map(f => ({
      "@type": "Question",
      "name": f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a },
    })),
  });

  const cardHTML = cards.map(c => `
    <div class="card">
      <div class="card-icon">${esc(c.icon)}</div>
      <h3>${esc(c.title)}</h3>
      <p>${esc(c.body)}</p>
    </div>`).join("");

  const faqHTML = faqs.map(f => `
    <details class="faq-item">
      <summary><h3>${esc(f.q)}</h3></summary>
      <div class="faq-answer"><p>${esc(f.a)}</p></div>
    </details>`).join("");

  const tableRows = [
    ["Done-for-you setup",        `<span class="chk">✓</span>`, `<span class="x">✗</span>`,          `<span class="x">✗</span>`],
    ["AI chat + voice agent",     `<span class="chk">✓</span>`, `<span class="x">✗</span>`,          `<span class="x">✗</span>`],
    ["Automated review requests", `<span class="chk">✓</span>`, `<span class="x">✗</span>`,          `<span class="x">✗</span>`],
    ["Lead follow-up sequences",  `<span class="chk">✓</span>`, `<span class="manual">Manual</span>`,`<span class="x">✗</span>`],
    ["Launch timeline",           `<span class="fbs-val">10–14 days</span>`, "Months",                "Never"],
    ["Monthly cost",              `<span class="fbs-val">$500/mo all-in</span>`, "$300–800+ DIY config", "Your time"],
  ].map((r, i) => `
    <tr class="${i % 2 === 0 ? "row-odd" : ""}">
      <td class="row-label">${r[0]}</td>
      <td class="fbs-col">${r[1]}</td>
      <td>${r[2]}</td>
      <td>${r[3]}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(h1)} | Field-Built Systems</title>
<meta name="description" content="${esc(metaDesc)}">
<link rel="canonical" href="https://local.field-built.com/${slug}">
<meta name="robots" content="index,follow">
<meta property="og:title" content="${esc(h1)} | Field-Built Systems">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:url" content="https://local.field-built.com/${slug}">
<meta property="og:type" content="website">
<meta name="geo.region" content="US">
<meta name="geo.placename" content="${esc(city)}, ${esc(state)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<script type="application/ld+json">${schemaLocal}</script>
<script type="application/ld+json">${schemaService}</script>
<script type="application/ld+json">${schemaFaq}</script>
<style>
:root{--bg:#080C14;--bg-card:#0E1420;--bg-alt:#0A0F1A;--border:rgba(255,255,255,0.07);--text:#F1F5F9;--muted:#8B9AB4;--cyan:#1B98E0;--violet:#8B5CF6;--green:#22D87A;--red:#EF4444;--amber:#F59E0B;--fbs:#00D4FF}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:18px;line-height:1.75;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
img{display:block}
.nav{position:fixed;top:0;left:0;right:0;z-index:100;background:rgba(8,12,20,0.92);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);height:64px}
.nav-inner{max-width:1140px;margin:0 auto;padding:0 24px;height:64px;display:flex;align-items:center;justify-content:space-between;gap:24px}
.nav-brand{display:flex;align-items:center;gap:12px;font-size:22px;font-weight:700;color:var(--text)}
.nav-links{display:flex;gap:28px}
.nav-links a{font-size:15px;color:var(--muted);transition:color 0.2s}
.nav-links a:hover,.nav-mobile a:hover{color:var(--cyan)}
.nav-cta{background:linear-gradient(135deg,var(--cyan),var(--violet));border-radius:999px;padding:10px 22px;font-size:14px;font-weight:600;color:#fff;white-space:nowrap}
.nav-hamburger{display:none;flex-direction:column;gap:5px;background:none;border:none;cursor:pointer;padding:4px}
.nav-hamburger span{display:block;width:22px;height:2px;background:var(--text);border-radius:2px}
.nav-mobile{display:none;flex-direction:column;padding:16px 24px 20px;gap:16px;background:var(--bg-card);border-top:1px solid var(--border)}
.nav-mobile.open{display:flex}
.nav-mobile a{font-size:16px;color:var(--muted)}
.nav-cta-mobile{background:linear-gradient(135deg,var(--cyan),var(--violet));border-radius:999px;padding:12px 24px;font-weight:600;color:#fff;text-align:center;margin-top:4px}
.hero{position:relative;overflow:hidden;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:120px 24px 80px;background:radial-gradient(ellipse 80% 60% at 50% 40%,rgba(27,152,224,0.12) 0%,var(--bg) 70%)}
.hero::before{content:"";position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.03) 1px,transparent 1px);background-size:40px 40px}
.hero-orb{position:absolute;border-radius:50%;filter:blur(80px);pointer-events:none}
.hero-orb--1{width:400px;height:400px;background:rgba(27,152,224,0.15);top:-80px;left:-80px}
.hero-orb--2{width:300px;height:300px;background:rgba(139,92,246,0.12);bottom:-60px;right:-60px}
.hero-inner{position:relative;z-index:1;max-width:860px;margin:0 auto;display:flex;flex-direction:column;align-items:center;gap:24px}
.hero-badge{display:inline-block;padding:6px 18px;border-radius:999px;border:1px solid rgba(27,152,224,0.4);font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;background:linear-gradient(90deg,#1B98E0,#8B5CF6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero h1{font-size:clamp(36px,5vw,64px);font-weight:900;color:#F1F5F9;line-height:1.1;letter-spacing:-1px}
.hero-sub{color:var(--muted);font-size:18px;line-height:1.6;max-width:520px}
.btn-primary{display:inline-block;padding:16px 36px;border-radius:999px;background:linear-gradient(135deg,#1B98E0,#8B5CF6);color:#fff;font-size:16px;font-weight:700;box-shadow:0 0 32px rgba(27,152,224,0.35);transition:box-shadow 0.2s,transform 0.2s}
.btn-primary:hover{box-shadow:0 0 48px rgba(27,152,224,0.55);transform:translateY(-2px)}
.section{padding:80px 24px}
.section--alt{background:var(--bg-alt)}
.section--intro{background:var(--bg-alt);border-top:1px solid var(--border)}
.container{max-width:1140px;margin:0 auto}
.container--narrow{max-width:720px;margin:0 auto}
.eyebrow{display:block;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--cyan);margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border)}
h2.grad{font-size:clamp(28px,4vw,48px);font-weight:800;line-height:1.15;margin-bottom:20px;background:linear-gradient(90deg,#1B98E0,#8B5CF6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.body-text{font-size:19px;line-height:1.8;color:var(--text);margin-bottom:20px}
.body-text:last-child{margin-bottom:0}
.body-text a{color:var(--cyan);text-decoration:underline}
.cards-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:40px}
.card{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:28px;transition:border-color 0.25s,box-shadow 0.25s}
.card:hover{border-color:rgba(27,152,224,0.3);box-shadow:0 0 20px rgba(27,152,224,0.08)}
.card-icon{width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#1B98E0,#8B5CF6);display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:16px}
.card h3{font-size:18px;font-weight:700;color:var(--text);margin-bottom:10px}
.card p{font-size:16px;color:var(--muted);line-height:1.65}
.table-wrap{border-radius:12px;border:1px solid var(--border);overflow:hidden;overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:520px}
thead th{padding:16px 20px;font-size:14px;font-weight:700;text-align:left;background:linear-gradient(135deg,rgba(27,152,224,0.15),rgba(139,92,246,0.1));border-bottom:1px solid var(--border)}
thead th.fbs-head{color:var(--fbs)}
td{padding:14px 20px;font-size:15px;border-bottom:1px solid rgba(255,255,255,0.06);color:var(--muted);vertical-align:middle}
.row-label{font-weight:500;color:var(--text)}
.fbs-col{background:rgba(27,152,224,0.04)}
.row-odd{background:rgba(255,255,255,0.015)}
.chk{color:#22D87A;font-size:18px;font-weight:700}
.x{color:#EF4444;font-size:18px}
.manual{color:#F59E0B;font-size:14px;font-weight:500}
.fbs-val{color:var(--fbs);font-weight:600}
.faq-item{border-bottom:1px solid var(--border)}
.faq-item summary{padding:20px 0;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:16px}
.faq-item summary h3{font-size:17px;font-weight:600;color:var(--text)}
.faq-item summary::after{content:"+";font-size:20px;color:var(--muted);flex-shrink:0;transition:transform 0.2s}
.faq-item[open] summary::after{content:"×";color:var(--cyan)}
.faq-answer{padding:0 0 20px}
.faq-answer p{font-size:17px;color:var(--muted);line-height:1.75}
.section--cta{text-align:center;background:radial-gradient(ellipse 70% 50% at 50% 50%,rgba(27,152,224,0.08) 0%,var(--bg) 70%)}
.section--cta h2{margin-bottom:16px}
.section--cta .sub{color:var(--muted);font-size:18px;margin-bottom:36px}
.reassurance{font-size:13px;color:var(--muted);margin-top:16px;opacity:0.7}
.footer{background:#080C14;border-top:1px solid var(--border);padding:48px 24px 32px}
.footer-inner{max-width:1140px;margin:0 auto;display:grid;grid-template-columns:2fr 1fr 1fr;gap:40px;margin-bottom:40px}
.footer-tagline{color:var(--muted);font-size:14px;margin:12px 0}
.footer-contact{display:flex;flex-direction:column;gap:6px}
.footer-contact a{color:var(--muted);font-size:14px;transition:color 0.2s}
.footer-contact a:hover{color:var(--cyan)}
.footer-col-label{font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text);margin-bottom:12px}
.footer-col{display:flex;flex-direction:column;gap:10px}
.footer-col a{color:var(--muted);font-size:14px;transition:color 0.2s}
.footer-col a:hover{color:var(--cyan)}
.footer-bottom{max-width:1140px;margin:0 auto;padding-top:24px;border-top:1px solid var(--border);text-align:center;font-size:13px;color:var(--muted)}
@media(max-width:768px){
  .nav-links,.nav-cta{display:none}
  .nav-hamburger{display:flex}
  .hero{padding:100px 20px 60px}
  .section{padding:60px 20px}
  .cards-grid{grid-template-columns:1fr}
  .footer-inner{grid-template-columns:1fr;gap:28px}
}
</style>
</head>
<body>
${NAV_HTML}
<main>

<section class="hero">
  <div class="hero-orb hero-orb--1"></div>
  <div class="hero-orb hero-orb--2"></div>
  <div class="hero-inner">
    <div class="hero-badge">Done-for-you · Live in 10–14 days</div>
    <h1>${esc(h1)}</h1>
    <p class="hero-sub">${esc(heroSubhead)}</p>
    <a href="https://field-built.com/book" class="btn-primary">Book a Free 30-Minute Call</a>
  </div>
</section>

<section class="section section--intro">
  <div class="container--narrow">
    <span class="eyebrow">Who This Is For</span>
    <p class="body-text">${esc(introP1)}</p>
    <p class="body-text">${esc(introP2)}</p>
  </div>
</section>

<section class="section">
  <div class="container--narrow">
    <span class="eyebrow">The Problem</span>
    <h2 class="grad">Why ${esc(vertical)} Owners in ${esc(city)} Stay Stuck</h2>
    <p class="body-text">${esc(problemBody)}</p>
  </div>
</section>

<section class="section section--alt">
  <div class="container--narrow">
    <span class="eyebrow">The Solution</span>
    <h2 class="grad">${esc(solutionH2)}</h2>
    <p class="body-text">${sanitizeBody(solutionBody)}</p>
  </div>
</section>

<section class="section">
  <div class="container">
    <span class="eyebrow">What You Get</span>
    <h2 class="grad">Everything Built, Configured, and Running</h2>
    <div class="cards-grid">${cardHTML}</div>
  </div>
</section>

<section class="section section--alt">
  <div class="container">
    <span class="eyebrow">How We Compare</span>
    <h2 class="grad">Field-Built Systems vs ${esc(midColHeader)} vs DIY</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th></th>
            <th class="fbs-head">Field-Built Systems</th>
            <th>${esc(midColHeader)}</th>
            <th>DIY</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  </div>
</section>

<section class="section">
  <div class="container--narrow">
    <span class="eyebrow">FAQ</span>
    <h2 class="grad">${esc(faqH2)}</h2>
    <div>${faqHTML}</div>
  </div>
</section>

<section class="section section--cta">
  <div class="container--narrow">
    <h2 class="grad">${esc(ctaH2)}</h2>
    <p class="sub">30 minutes. No pitch deck. No pressure.</p>
    <a href="https://field-built.com/book" class="btn-primary">Book a Free 30-Minute Call</a>
    <p class="reassurance">Most clients are live within 10–14 days.</p>
  </div>
</section>

</main>
${FOOTER_HTML}
${NAV_JS}
</body>
</html>`;
}

// ─── API call with retry ────────────────────────────────────────────────────

async function fetchContent(client, derived) {
  const prompt = buildContentPrompt(derived);
  let attempt = 0;

  while (true) {
    try {
      const response = await client.messages.create({
        model:      CONFIG.model,
        max_tokens: CONFIG.maxTokens,
        messages:   [{ role: "user", content: prompt }],
      });

      const raw = response.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("")
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();

      return JSON.parse(raw);

    } catch (err) {
      attempt++;
      const isRetryable = err.status === 429 || err.status >= 500 || err instanceof SyntaxError;
      if (isRetryable && attempt < CONFIG.rate.maxRetries) {
        log(`  ↻ Retry ${attempt}/${CONFIG.rate.maxRetries} for ${derived.slug} (${err.status ?? err.message})`);
        await sleep(CONFIG.rate.retryDelayMs * attempt);
      } else {
        throw err;
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  fs.writeFileSync(path.join(CONFIG.outputDir, "CNAME"), CONFIG.cname, "utf8");
  log(`CNAME written: ${CONFIG.cname}`);

  const raw   = fs.readFileSync(CONFIG.csvPath, "utf8");
  let rows    = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  const total = rows.length;

  if (TARGET_SLUG) {
    rows = rows.filter(r => r.slug === TARGET_SLUG);
    if (rows.length === 0) { console.error(`No row found with slug: ${TARGET_SLUG}`); process.exit(1); }
  }

  if (CHUNK_INDEX !== null && CHUNK_TOTAL !== null) {
    rows = rows.filter((_, i) => i % CHUNK_TOTAL === CHUNK_INDEX - 1);
    log(`Chunk ${CHUNK_INDEX}/${CHUNK_TOTAL}: ${rows.length} rows`);
  }

  if (LIMIT) rows = rows.slice(0, LIMIT);

  if (SKIP_EXISTING) {
    const before = rows.length;
    rows = rows.filter(r => !fs.existsSync(outputPath(r.slug)));
    log(`Skip-existing: ${before - rows.length} already done, ${rows.length} remaining`);
  }

  log(`Starting batch: ${rows.length} pages (total in CSV: ${total})`);

  let success = 0;
  let failed  = 0;

  for (let i = 0; i < rows.length; i++) {
    const derived = deriveRow(rows[i]);
    const out     = outputPath(derived.slug);

    log(`[${i + 1}/${rows.length}] Generating: ${derived.slug}`);

    try {
      const content = await fetchContent(client, derived);
      const html    = assembleHTML(derived, content);
      fs.writeFileSync(out, html, "utf8");
      log(`  ✓ ${derived.slug}`);
      success++;
    } catch (err) {
      logError(derived.slug, err);
      failed++;
    }

    if (i < rows.length - 1) await sleep(CONFIG.rate.delayBetweenMs);
  }

  log(`\nDone. ✓ ${success} succeeded  ✗ ${failed} failed`);
  if (failed > 0) { log(`Check batch-errors.log for details.`); process.exit(1); }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
