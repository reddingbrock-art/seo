#!/usr/bin/env node

/**
 * Field-Built Systems — SEO Page Generator
 *
 * Usage:
 *   node batch.js                   → process all rows
 *   node batch.js --limit 5         → first N rows only
 *   node batch.js --slug some-slug  → regenerate one page
 *   node batch.js --skip-existing   → skip already-generated pages
 *   node batch.js --chunk 2 --of 5  → parallel CI chunk
 */

import Anthropic from "@anthropic-ai/sdk";
import { parse } from "csv-parse/sync";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  csvPath:   path.join(__dirname, "targets.csv"),
  outputDir: path.join(__dirname, "docs"),
  logFile:   path.join(__dirname, "batch.log"),
  errorFile: path.join(__dirname, "batch-errors.log"),
  model:     "claude-opus-4-6",
  maxTokens: 8000,
  rate: {
    delayMs:      3200,
    retryDelayMs: 15000,
    maxRetries:   3,
  },
};

// ── Args ─────────────────────────────────────────────────────────────────────
const args          = process.argv.slice(2);
const flag          = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i+1] : null; };
const hasFlag       = (f) => args.includes(f);
const LIMIT         = flag("--limit") ? parseInt(flag("--limit")) : null;
const TARGET_SLUG   = flag("--slug") ?? null;
const CHUNK_INDEX   = flag("--chunk") ? parseInt(flag("--chunk")) : null;
const CHUNK_TOTAL   = flag("--of")    ? parseInt(flag("--of"))    : null;
const SKIP_EXISTING = hasFlag("--skip-existing");

// ── Logging ───────────────────────────────────────────────────────────────────
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

// Truncate meta description cleanly at word boundary
function truncateAtWord(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max).replace(/\s+\S*$/, "").replace(/[,.]$/, "") + ".";
}

// ── Design tokens — locked, never drifts ─────────────────────────────────────
const LOGO = "https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png";

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080C14;--bg-card:#0E1420;--bg-alt:#0A0F1A;
  --border:rgba(255,255,255,0.07);
  --text:#F1F5F9;--muted:#8B9AB4;
  --cyan:#1B98E0;--violet:#8B5CF6;
  --green:#22D87A;--red:#EF4444;--amber:#F59E0B;--fbs:#00D4FF;
}
html{scroll-behavior:smooth}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:17px;line-height:1.7;-webkit-font-smoothing:antialiased;}
a{color:inherit;text-decoration:none}
img{display:block}
.grad{background:linear-gradient(90deg,#1B98E0,#8B5CF6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}

/* NAV */
header{position:fixed;top:0;left:0;right:0;z-index:100;height:64px;background:rgba(8,12,20,0.9);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid var(--border);}
.nav-inner{max-width:1200px;margin:0 auto;padding:0 32px;height:64px;display:flex;align-items:center;justify-content:space-between;}
.nav-brand{display:flex;align-items:center;gap:12px}
.nav-brand img{height:40px;width:auto;object-fit:contain}
.nav-brand span{font-size:22px;font-weight:700;color:var(--text)}
.nav-links{display:flex;align-items:center;gap:32px}
.nav-links a{font-size:15px;font-weight:500;color:var(--muted);transition:color .2s}
.nav-links a:hover,.nav-links a.active{color:var(--cyan)}
.nav-cta{background:linear-gradient(90deg,#1B98E0,#8B5CF6);color:#fff;font-size:14px;font-weight:600;padding:10px 24px;border-radius:999px;border:none;cursor:pointer;transition:opacity .2s;}
.nav-cta:hover{opacity:.9}
.hamburger{display:none;flex-direction:column;gap:5px;background:none;border:none;cursor:pointer;padding:4px;}
.hamburger span{display:block;width:24px;height:2px;background:var(--text);border-radius:2px;transition:.3s;}
.mob-menu{display:none;position:fixed;top:64px;left:0;right:0;z-index:99;background:var(--bg-card);border-bottom:1px solid var(--border);padding:20px 32px;flex-direction:column;gap:0;}
.mob-menu.open{display:flex}
.mob-menu a{font-size:16px;font-weight:500;color:var(--muted);padding:14px 0;border-bottom:1px solid var(--border);}
.mob-menu a:last-of-type{border-bottom:none}
.mob-menu a:hover{color:var(--cyan)}
.mob-cta{margin-top:16px;display:block;text-align:center;background:linear-gradient(90deg,#1B98E0,#8B5CF6);color:#fff;font-size:15px;font-weight:600;padding:14px 24px;border-radius:999px;}
@media(max-width:768px){.nav-links,.nav-cta.desk{display:none}.hamburger{display:flex}}

/* HERO */
.hero{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden;background:radial-gradient(ellipse 80% 50% at 50% 0%,rgba(27,152,224,0.13) 0%,var(--bg) 70%);padding-top:64px;}
.hero-grid{position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(to right,rgba(255,255,255,0.03) 1px,transparent 1px),linear-gradient(to bottom,rgba(255,255,255,0.03) 1px,transparent 1px);background-size:40px 40px;}
.hero-orb{position:absolute;border-radius:50%;pointer-events:none;filter:blur(80px)}
.orb1{width:400px;height:400px;background:rgba(27,152,224,0.15);top:-100px;left:-100px}
.orb2{width:300px;height:300px;background:rgba(139,92,246,0.12);bottom:-80px;right:-80px}
.hero-inner{position:relative;z-index:1;max-width:860px;width:100%;padding:60px 24px;}
.hero-badge{display:inline-flex;align-items:center;border:1px solid rgba(27,152,224,0.4);background:rgba(27,152,224,0.08);border-radius:999px;padding:6px 18px;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;margin-bottom:28px;}
.hero h1{font-size:clamp(30px,5vw,58px);font-weight:900;color:var(--text);line-height:1.1;letter-spacing:-.02em;margin-bottom:20px;}
.hero-sub{font-size:18px;color:var(--muted);max-width:520px;margin:0 auto 36px;}
.btn-primary{display:inline-block;background:linear-gradient(90deg,#1B98E0,#8B5CF6);color:#fff;font-size:16px;font-weight:700;padding:16px 36px;border-radius:999px;box-shadow:0 0 32px rgba(27,152,224,0.35);transition:box-shadow .2s,transform .2s;}
.btn-primary:hover{box-shadow:0 0 48px rgba(27,152,224,0.55);transform:translateY(-2px);}

/* SECTIONS */
.section{padding:80px 0}
.section.alt{background:var(--bg-alt)}
.section.card-bg{background:var(--bg-card)}
.container{max-width:1100px;margin:0 auto;padding:0 24px}
.prose-wrap{max-width:720px}
.section-label{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--cyan);margin-bottom:12px;}
.section-title{font-size:clamp(26px,4vw,44px);font-weight:800;color:var(--text);line-height:1.2;margin-bottom:16px;}
.section-sub{font-size:17px;color:var(--muted);max-width:600px;margin-bottom:48px;}
.prose p{color:var(--muted);font-size:17px;line-height:1.75;margin-bottom:18px}
.prose p:last-child{margin-bottom:0}
.prose a{color:var(--cyan);text-decoration:underline;text-underline-offset:3px}

/* CARDS */
.cards-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}
.card{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:28px;transition:border-color .25s,box-shadow .25s;}
.card:hover{border-color:rgba(27,152,224,0.3);box-shadow:0 0 24px rgba(27,152,224,0.08);}
.card-icon{width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#1B98E0,#8B5CF6);display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:18px;}
.card h3{font-size:18px;font-weight:700;color:var(--text);margin-bottom:10px}
.card p{font-size:15px;color:var(--muted);line-height:1.65}

/* TABLE */
.table-scroll{overflow-x:auto;border-radius:12px;border:1px solid var(--border)}
table{width:100%;border-collapse:collapse}
table caption{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;}
thead tr{background:linear-gradient(135deg,rgba(27,152,224,0.15),rgba(139,92,246,0.1))}
th{padding:16px 20px;font-size:14px;font-weight:700;text-align:left;color:var(--text);border-bottom:1px solid var(--border);}
th.fbs{color:var(--fbs)}
td{padding:16px 20px;font-size:15px;color:var(--muted);border-bottom:1px solid var(--border);vertical-align:middle;}
tr:last-child td{border-bottom:none}
tbody tr:nth-child(odd){background:rgba(255,255,255,0.02)}
td:first-child{color:var(--text);font-weight:500}
td.fbs-cell{color:var(--fbs);font-weight:600}
.chk{color:var(--green);font-weight:700;font-size:17px}
.cross{color:var(--red);font-weight:700;font-size:17px}
.manual{color:var(--amber);font-weight:600;font-size:14px}

/* FAQ */
.faq-wrap{max-width:760px}
.faq-item{border-bottom:1px solid var(--border)}
.faq-item:first-child{border-top:1px solid var(--border)}
.faq-btn{width:100%;background:none;border:none;cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:22px 0;text-align:left;gap:16px;}
.faq-btn h3{font-size:17px;font-weight:600;color:var(--text);line-height:1.4}
.faq-icon{flex-shrink:0;width:26px;height:26px;border-radius:50%;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:16px;transition:transform .25s,color .25s,border-color .25s;}
.faq-item.open .faq-icon{transform:rotate(45deg);color:var(--cyan);border-color:var(--cyan)}
.faq-answer{display:none;padding:0 0 20px;font-size:15px;color:var(--muted);line-height:1.75;}
.faq-item.open .faq-answer{display:block}

/* CTA */
.cta-section{background:radial-gradient(ellipse 70% 60% at 50% 50%,rgba(27,152,224,0.08) 0%,var(--bg) 70%);text-align:center;}
.cta-section .section-sub{margin:0 auto 36px}
.cta-note{margin-top:16px;font-size:13px;color:var(--muted);opacity:.8}

/* FOOTER */
footer{background:#080C14;border-top:1px solid var(--border);padding:48px 0 32px;}
.footer-grid{max-width:1100px;margin:0 auto;padding:0 24px;display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:32px;}
.footer-brand{grid-column:span 2}
.footer-logo{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.footer-logo img{height:32px;width:auto;object-fit:contain}
.footer-logo span{font-size:18px;font-weight:700;color:var(--text)}
.footer-desc{font-size:14px;color:var(--muted);max-width:360px;line-height:1.6;margin-bottom:16px}
.footer-contact{display:flex;flex-direction:column;gap:4px}
.footer-contact a{font-size:14px;color:var(--muted);transition:color .2s}
.footer-contact a:hover{color:var(--cyan)}
.footer-col h4{font-size:13px;font-weight:600;color:var(--text);margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em;}
.footer-col nav{display:flex;flex-direction:column;gap:8px}
.footer-col nav a{font-size:14px;color:var(--muted);transition:color .2s}
.footer-col nav a:hover{color:var(--cyan)}
.footer-bottom{max-width:1100px;margin:32px auto 0;padding:24px 24px 0;border-top:1px solid var(--border);text-align:center;font-size:13px;color:var(--muted);}

/* RESPONSIVE */
@media(max-width:768px){
  .section{padding:60px 0}
  .cards-grid{grid-template-columns:1fr}
  .footer-grid{grid-template-columns:1fr}
  .footer-brand{grid-column:span 1}
  .hero h1{font-size:clamp(26px,8vw,40px)}
  .nav-inner{padding:0 20px}
  .table-scroll table{min-width:520px}
}
`;

// ── Static nav — locked ───────────────────────────────────────────────────────
const NAV = `<header>
  <div class="nav-inner">
    <a href="https://field-built.com" class="nav-brand">
      <img src="${LOGO}" alt="Field-Built Systems logo">
      <span>Field-Built Systems</span>
    </a>
    <nav class="nav-links" aria-label="Main navigation">
      <a href="https://field-built.com" class="active">Home</a>
      <a href="https://field-built.com/services">Services</a>
      <a href="https://field-built.com/about">About</a>
      <a href="https://field-built.com/demo">Demo</a>
    </nav>
    <a href="https://field-built.com/book" class="nav-cta desk">Book a Free Call</a>
    <button class="hamburger" id="ham" aria-label="Toggle menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
  </div>
</header>
<div class="mob-menu" id="mob">
  <a href="https://field-built.com">Home</a>
  <a href="https://field-built.com/services">Services</a>
  <a href="https://field-built.com/about">About</a>
  <a href="https://field-built.com/demo">Demo</a>
  <a href="https://field-built.com/book" class="mob-cta">Book a Free Call</a>
</div>`;

// ── Static footer — locked ────────────────────────────────────────────────────
const FOOTER = `<footer>
  <div class="footer-grid">
    <div class="footer-brand">
      <div class="footer-logo">
        <img src="${LOGO}" alt="Field-Built Systems logo" loading="lazy">
        <span>Field-Built Systems</span>
      </div>
      <p class="footer-desc">We install AI-powered automation systems that help service businesses capture, respond to, and convert more leads.</p>
      <div class="footer-contact">
        <a href="tel:8175187791">(817) 518-7791</a>
        <a href="mailto:info@field-built.com">info@field-built.com</a>
      </div>
    </div>
    <div class="footer-col">
      <h4>Company</h4>
      <nav>
        <a href="https://field-built.com/services">Services</a>
        <a href="https://field-built.com/about">About</a>
        <a href="https://field-built.com/contact">Contact</a>
      </nav>
    </div>
    <div class="footer-col">
      <h4>Legal</h4>
      <nav>
        <a href="https://field-built.com/privacy">Privacy Policy</a>
        <a href="https://field-built.com/terms">Terms of Service</a>
        <a href="https://field-built.com/service-agreement">Service Agreement</a>
      </nav>
    </div>
  </div>
  <div class="footer-bottom">© 2026 Field-Built Systems. All rights reserved.</div>
</footer>`;

// ── JS — locked ───────────────────────────────────────────────────────────────
const PAGE_JS = `<script>
(function(){
  var btn=document.getElementById('ham');
  var menu=document.getElementById('mob');
  if(btn&&menu){
    btn.addEventListener('click',function(){
      var open=menu.classList.toggle('open');
      btn.setAttribute('aria-expanded',String(open));
    });
  }
  document.querySelectorAll('.faq-btn').forEach(function(b){
    b.addEventListener('click',function(){
      var item=this.closest('.faq-item');
      var wasOpen=item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach(function(i){
        i.classList.remove('open');
        i.querySelector('.faq-btn').setAttribute('aria-expanded','false');
      });
      if(!wasOpen){
        item.classList.add('open');
        this.setAttribute('aria-expanded','true');
      }
    });
  });
})();
</script>`;

// ── Locked comparison table ───────────────────────────────────────────────────
function buildTable(competitor, vertical) {
  return `<div class="table-scroll">
  <table>
    <caption>Field-Built Systems vs ${competitor} vs DIY — feature and pricing comparison for ${vertical} businesses</caption>
    <thead>
      <tr>
        <th>Feature</th>
        <th class="fbs">Field-Built Systems</th>
        <th>${competitor}</th>
        <th>DIY</th>
      </tr>
    </thead>
    <tbody>
      <tr><td>Done-for-you setup</td><td class="fbs-cell"><span class="chk">✓</span></td><td><span class="cross">✗</span></td><td><span class="cross">✗</span></td></tr>
      <tr><td>AI chat + voice agent</td><td class="fbs-cell"><span class="chk">✓</span></td><td><span class="cross">✗</span></td><td><span class="cross">✗</span></td></tr>
      <tr><td>Automated review requests</td><td class="fbs-cell"><span class="chk">✓</span></td><td><span class="cross">✗</span></td><td><span class="cross">✗</span></td></tr>
      <tr><td>Lead follow-up sequences</td><td class="fbs-cell"><span class="chk">✓</span></td><td><span class="manual">Manual</span></td><td><span class="cross">✗</span></td></tr>
      <tr><td>Launch timeline</td><td class="fbs-cell">10–14 days</td><td>Months</td><td>Never</td></tr>
      <tr><td>Monthly cost</td><td class="fbs-cell">$500/mo all-in</td><td>$300–800+ DIY config</td><td>Your time</td></tr>
    </tbody>
  </table>
</div>`;
}

// ── Page variables from CSV row ───────────────────────────────────────────────
function pageVars(row) {
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

  const competitor =
    angle === "switching-servicetitan" ? "ServiceTitan" :
    angle === "switching-jobber"       ? "Jobber"       : "Generic CRM";

  const serviceDesc = {
    "crm":          `Done-for-you CRM built for ${vertical} businesses in ${city}, ${state}. Configured on GoHighLevel with pipeline, lead follow-up, and AI chat. Live in 10–14 days.`,
    "automation":   `Done-for-you automation system for ${vertical} companies in ${city}, ${state}. AI chat, review requests, and lead follow-up — installed and live in 10–14 days.`,
    "ai-chat":      `AI chat agent for ${vertical} businesses in ${city}, ${state}. Answers leads, books appointments, and follows up automatically. Installed and running in 10–14 days.`,
    "lead-followup":`Done-for-you lead follow-up system for ${vertical} companies in ${city}, ${state}. Automated text and email sequences built on GoHighLevel. Live in 10–14 days.`,
    "reviews":      `Automated Google review system for ${vertical} businesses in ${city}, ${state}. Review requests sent after every completed job. Installed and running in 10–14 days.`,
  }[page_type] ?? `Done-for-you automation system for ${vertical} businesses in ${city}, ${state}. Built on GoHighLevel. Live in 10–14 days.`;

  const ctaH2 = {
    "crm":          `Replace Your CRM With Something <span class="grad">Built for ${vertical}</span> in ${city}`,
    "automation":   `Put Your <span class="grad">${city} ${vertical} Business</span> on Autopilot`,
    "ai-chat":      `Stop Missing Calls From <span class="grad">${city} ${vertical}</span> Customers`,
    "lead-followup":`Stop Losing <span class="grad">${city} ${vertical}</span> Leads to Slow Follow-Up`,
    "reviews":      `Build Your <span class="grad">${vertical} Reputation</span> in ${city} on Autopilot`,
  }[page_type] ?? `See What This Looks Like for <span class="grad">Your ${vertical} Business</span> in ${city}`;

  const metaDescRaw = `Field-Built Systems installs a done-for-you ${page_type} system for ${vertical} companies in ${city}, ${state}. AI chat, automated reviews, and lead follow-up — live in 10–14 days. Book a free call.`;
  const metaDesc = truncateAtWord(metaDescRaw, 155);

  const titleFull = `${h1} | Field-Built Systems`;
  const title = titleFull.length <= 60 ? titleFull
    : `${h1.replace(`, ${state}`, "")} | Field-Built Systems`.slice(0, 57) + "...";

  const faqBank = {
    "crm": [
      "Do I have to migrate all my existing data?",
      "Is this just GoHighLevel with a different name?",
      "What if my techs won't use a new system?",
      "How is this different from buying GoHighLevel directly?",
      "What happens after the system is set up — are you done?",
    ],
    "automation": [
      "What actually gets automated versus what's still manual?",
      "Will this work with the tools I'm already using?",
      "Do I have to learn how to build the automations myself?",
      "What if something breaks while I'm out on a job?",
      "How long before the automations are actually running?",
    ],
    "ai-chat": [
      "What happens when a customer asks something the AI can't handle?",
      "Can I control what the AI says to my customers?",
      "Will customers know they're talking to an AI?",
      "Does it work after hours and on weekends?",
      "What if I already have a chat widget on my site?",
    ],
    "lead-followup": [
      "How fast does the follow-up actually go out after a lead comes in?",
      "What if a lead tells us to stop texting them?",
      "Can I see what messages went out and when?",
      "What if I already have a follow-up sequence in place?",
      "Does this work for leads coming from multiple sources?",
    ],
    "reviews": [
      "What if a customer leaves a bad review?",
      "Can I control which customers get the review request?",
      "How does the system know when a job is complete?",
      "Does this work on Google and other platforms?",
      "What if a customer ignores the first review request?",
    ],
  }[page_type] ?? [
    "Do I have to learn new software?",
    "What if I'm already using GoHighLevel?",
    "How fast will I see results?",
    "What happens after setup?",
    "Is there a contract?",
  ];

  return { h1, competitor, serviceDesc, ctaH2, metaDesc, title, faqBank, ...row };
}

// ── Build Claude prompt ───────────────────────────────────────────────────────
function buildPrompt(v) {
  const faqList = v.faqBank.map((q, i) => `${i+1}. "${q}"`).join("\n");

  return `You are writing content for a production SEO landing page for Field-Built Systems — a done-for-you automation agency for field service businesses.

OUTPUT RULES — critical, no exceptions:
- Output ONLY sections 2, 3, 4, 5, and 7 as specified below
- Do NOT output section 1 (hero), section 6 (table), section 8 (CTA) — those are pre-built
- Do NOT output <!DOCTYPE>, <html>, <head>, <body>, <header>, <footer>, <style>, <script>, or schema
- Do NOT output <main> tags
- Start your output with exactly: <!-- SECTION 2: INTRO -->
- End your output with the closing </section> of section 7

PAGE VARIABLES:
H1 (exact, verbatim): "${v.h1}"
VERTICAL: ${v.vertical}
CITY: ${v.city}
STATE: ${v.state}
PAGE TYPE: ${v.page_type}
ANGLE: ${v.angle}

WRITING RULES — enforce all, no exceptions:
- Practitioner voice: sounds like someone who has run a ${v.vertical} business, not a marketer
- Contractions throughout. Always "you" and "your"
- Mix short punchy sentences with longer explanatory ones
- NEVER say: "game-changer", "seamless", "leverage", "streamline", "supercharge", "unlock your potential", "in today's competitive landscape", "revolutionize"
- Never invent statistics or percentages — use "most", "significantly more", "faster than"
- Never reference existing clients or past results
- City details must be real: actual ${v.city} neighborhoods, real seasonal demand patterns, local competition reality for ${v.vertical}
- The exact keyword "${v.h1}" or a close natural variant MUST appear within the first 100 words of body text

H TAG RULES — strictly enforced:
- Do NOT add any H1 tags — the page already has one
- H2 (.section-title): must be keyword-rich and descriptive. NEVER use "The Solution", "The Problem", "How It Works", "Why Choose Us". At least 2 of your H2s must naturally include both "${v.city}" and "${v.vertical}"
- H3: ONLY inside .card and .faq-item elements — nowhere else
- No H4, H5, H6 anywhere

CSS CLASSES — use only these, exactly as written:
.section / .section.alt / .section.card-bg / .container / .prose-wrap
.prose / .prose p / .prose a / .grad
.section-label / .section-title / .section-sub
.cards-grid / .card / .card-icon / .card h3 / .card p
.faq-wrap / .faq-item / .faq-btn / .faq-btn h3 / .faq-icon / .faq-answer

INTERNAL LINKS — required in section 4:
- Link 1: natural anchor text about what's included → https://field-built.com/services
- Link 2: natural anchor text inviting them to see it live → https://field-built.com/demo

OUTPUT THESE 5 SECTIONS EXACTLY:

<!-- SECTION 2: INTRO -->
<section class="section">
  <div class="container">
    <div class="prose-wrap">
      <p class="section-label">Who This Is For</p>
      <h2 class="section-title">[Keyword-rich. Must include both "${v.city}" and "${v.vertical}". Example: "Why ${v.vertical} Owners in ${v.city} Are Done Managing Leads by Hand"]</h2>
      <div class="prose">
        <p>[Para 1: Who this is for — ${v.vertical} owners in ${v.city} running 1–15 trucks, $300K–$5M revenue. "${v.h1}" or close variant MUST appear in this paragraph.]</p>
        <p>[Para 2: Why ${v.city} specifically — real neighborhoods, real seasonal demand, local market reality. Not just name-dropping.]</p>
        <p>[Para 3: Why now. What's changed. What's at stake if they wait.]</p>
      </div>
    </div>
  </div>
</section>

<!-- SECTION 3: PROBLEM -->
<section class="section alt">
  <div class="container">
    <div class="prose-wrap">
      <p class="section-label">The Real Cost</p>
      <h2 class="section-title">[H2 naming the specific pain — include "${v.vertical}" or "${v.city}" or both]</h2>
      <div class="prose">
        <p>[EXACTLY ONE PARAGRAPH. Real operational pain for ${v.vertical} in ${v.city}. Name real seasonal factors and local competition. Real stakes. Zero solution language.]</p>
      </div>
    </div>
  </div>
</section>

<!-- SECTION 4: SOLUTION -->
<section class="section">
  <div class="container">
    <div class="prose-wrap">
      <p class="section-label">What We Build</p>
      <h2 class="section-title">What <span class="grad">${v.city} ${v.vertical} Companies</span> Get With Field-Built</h2>
      <div class="prose">
        <p>[Para 1: What FBS installs — "we build and install", not "you configure". GoHighLevel + AI. Live in 10–14 days.]</p>
        <p>[Para 2: Specific outcomes. Include: <a href="https://field-built.com/services">[natural anchor text about what's included]</a>]</p>
        <p>[Para 3: What done-for-you means. Include: <a href="https://field-built.com/demo">[natural anchor text to see it live]</a>]</p>
      </div>
    </div>
  </div>
</section>

<!-- SECTION 5: FEATURE CARDS -->
<section class="section card-bg">
  <div class="container">
    <p class="section-label">What's Included</p>
    <h2 class="section-title">Everything <span class="grad">Runs Automatically</span></h2>
    <p class="section-sub">[One line specific to ${v.vertical} — what runs on autopilot.]</p>
    <div class="cards-grid">
      [4 cards — titles must be specific capabilities for ${v.page_type} and ${v.vertical}, not generic labels]
      <div class="card">
        <div class="card-icon">[single emoji]</div>
        <h3>[Specific capability title]</h3>
        <p>[2–3 sentences specific to ${v.vertical} and ${v.page_type}.]</p>
      </div>
      [repeat for all 4 cards]
    </div>
  </div>
</section>

<!-- SECTION 7: FAQ -->
<section class="section alt">
  <div class="container">
    <p class="section-label">Common Questions</p>
    <h2 class="section-title">Real Questions From <span class="grad">${v.vertical} Owners</span> in ${v.city}</h2>
    <div class="faq-wrap">
      [Output exactly 5 FAQ items using these questions in order:
${faqList}

      Structure for each:
      <div class="faq-item">
        <button class="faq-btn" aria-expanded="false">
          <h3>[question text verbatim from list above]</h3>
          <span class="faq-icon" aria-hidden="true">+</span>
        </button>
        <div class="faq-answer">[Direct answer. 2–3 sentences. No restatement. No fluff. Specific to ${v.vertical}.]</div>
      </div>
      ]
    </div>
  </div>
</section>`;
}

// ── Extract FAQ for schema — parse from generated HTML ───────────────────────
function extractFaqSchema(content) {
  const questions = [...content.matchAll(/<h3>([\s\S]*?)<\/h3>/g)].map(m => m[1].trim());
  const answers   = [...content.matchAll(/<div class="faq-answer">([\s\S]*?)<\/div>/g)].map(m => m[1].replace(/<[^>]+>/g, "").trim());
  const count = Math.min(questions.length, answers.length);
  const items = [];
  for (let i = 0; i < count; i++) {
    if (questions[i] && answers[i]) {
      items.push({
        "@type": "Question",
        "name": questions[i],
        "acceptedAnswer": { "@type": "Answer", "text": answers[i] }
      });
    }
  }
  return items;
}

// ── Assemble full HTML page ───────────────────────────────────────────────────
function buildPage(v, content) {
  const faqItems = extractFaqSchema(content);

  const localBiz = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    "@id": "https://field-built.com/#business",
    "name": "Field-Built Systems",
    "url": "https://field-built.com",
    "telephone": "(817) 518-7791",
    "email": "info@field-built.com",
    "description": `Done-for-you automation systems for ${v.vertical} companies in ${v.city}, ${v.state}`,
    "priceRange": "$$",
    "areaServed": {
      "@type": "City",
      "name": v.city,
      "containedInPlace": { "@type": "State", "name": v.state }
    },
    "serviceType": v.page_type
  };

  const service = {
    "@context": "https://schema.org",
    "@type": "Service",
    "name": v.h1,
    "provider": { "@type": "Organization", "name": "Field-Built Systems", "url": "https://field-built.com" },
    "areaServed": `${v.city}, ${v.state}`,
    "description": v.serviceDesc,
    "url": `https://reddingbrock-art.github.io/seo/${v.slug}`
  };

  const faqSchema = faqItems.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqItems
  } : null;

  // Extract a hero subhead from the first prose paragraph
  const firstParaMatch = content.match(/<p>\s*([^<]{30,220})/);
  const heroSub = firstParaMatch
    ? firstParaMatch[1].split(/[.!?]/)[0].trim() + "."
    : `The done-for-you ${v.page_type} system built for ${v.vertical} companies in ${v.city}.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="index, follow">
  <title>${v.title}</title>
  <meta name="description" content="${v.metaDesc}">
  <link rel="canonical" href="https://reddingbrock-art.github.io/seo/${v.slug}">
  <meta property="og:title" content="${v.h1} | Field-Built Systems">
  <meta property="og:description" content="${v.metaDesc}">
  <meta property="og:url" content="https://reddingbrock-art.github.io/seo/${v.slug}">
  <meta property="og:type" content="website">
  <meta property="og:image" content="${LOGO}">
  <meta property="og:site_name" content="Field-Built Systems">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${v.h1} | Field-Built Systems">
  <meta name="twitter:description" content="${v.metaDesc}">
  <meta name="twitter:image" content="${LOGO}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>${CSS}</style>
  <script type="application/ld+json">${JSON.stringify(localBiz)}</script>
  <script type="application/ld+json">${JSON.stringify(service)}</script>
  ${faqSchema ? `<script type="application/ld+json">${JSON.stringify(faqSchema)}</script>` : ""}
</head>
<body>

${NAV}

<main>

<!-- SECTION 1: HERO — locked -->
<section class="hero">
  <div class="hero-grid"></div>
  <div class="hero-orb orb1"></div>
  <div class="hero-orb orb2"></div>
  <div class="hero-inner">
    <div class="hero-badge"><span class="grad">Done-for-you · Live in 10–14 days</span></div>
    <h1>${v.h1}</h1>
    <p class="hero-sub">${heroSub}</p>
    <a href="https://field-built.com/book" class="btn-primary">Book a Free 30-Minute Call</a>
  </div>
</section>

${content}

<!-- SECTION 6: TABLE — locked -->
<section class="section">
  <div class="container">
    <p class="section-label">How We Stack Up</p>
    <h2 class="section-title">Field-Built vs <span class="grad">${v.competitor} vs DIY</span></h2>
    ${buildTable(v.competitor, v.vertical)}
  </div>
</section>

<!-- SECTION 8: CTA — locked -->
<section class="section cta-section">
  <div class="container">
    <h2 class="section-title">${v.ctaH2}</h2>
    <p class="section-sub">30 minutes. No pitch deck. No pressure.</p>
    <a href="https://field-built.com/book" class="btn-primary">Book a Free 30-Minute Call</a>
    <p class="cta-note">Most clients are live within 10–14 days.</p>
  </div>
</section>

</main>

${FOOTER}

${PAGE_JS}

</body>
</html>`;
}

// ── API call with retry ───────────────────────────────────────────────────────
async function generatePage(client, row) {
  const v = pageVars(row);
  const prompt = buildPrompt(v);
  let attempt = 0;

  while (attempt < CONFIG.rate.maxRetries) {
    try {
      const res = await client.messages.create({
        model:      CONFIG.model,
        max_tokens: CONFIG.maxTokens,
        messages:   [{ role: "user", content: prompt }],
      });

      const raw = res.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .replace(/^```html\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();

      if (!raw.includes("<!-- SECTION 2") || !raw.includes("<!-- SECTION 7")) {
        throw new Error("Response missing required sections — likely truncated or malformed");
      }

      return buildPage(v, raw);

    } catch (err) {
      attempt++;
      const retry = err.status === 429 || err.status >= 500;
      if (retry && attempt < CONFIG.rate.maxRetries) {
        log(`  ↻ Retry ${attempt}/${CONFIG.rate.maxRetries} for ${row.slug} (${err.status ?? err.message})`);
        await sleep(CONFIG.rate.retryDelayMs * attempt);
      } else {
        throw err;
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
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
    if (!rows.length) { console.error(`No row with slug: ${TARGET_SLUG}`); process.exit(1); }
  }

  if (CHUNK_INDEX !== null && CHUNK_TOTAL !== null) {
    rows = rows.filter((_, i) => i % CHUNK_TOTAL === CHUNK_INDEX - 1);
    log(`Chunk ${CHUNK_INDEX}/${CHUNK_TOTAL}: ${rows.length} rows`);
  }

  if (LIMIT) rows = rows.slice(0, LIMIT);

  if (SKIP_EXISTING) {
    const before = rows.length;
    rows = rows.filter((r) => !fs.existsSync(path.join(CONFIG.outputDir, `${r.slug}.html`)));
    log(`Skip-existing: ${before - rows.length} skipped, ${rows.length} remaining`);
  }

  log(`Starting: ${rows.length} pages (${total} total in CSV)`);

  let ok = 0, fail = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    log(`[${i+1}/${rows.length}] ${row.slug}`);

    try {
      const html = await generatePage(client, row);
      const outPath = path.join(CONFIG.outputDir, `${row.slug}.html`);

      if (!html.startsWith("<!DOCTYPE")) {
        throw new Error("Assembled HTML does not start with <!DOCTYPE");
      }

      fs.writeFileSync(outPath, html, "utf8");
      log(`  ✓ ${outPath}`);
      ok++;
    } catch (err) {
      logError(row.slug, err);
      fail++;
    }

    if (i < rows.length - 1) await sleep(CONFIG.rate.delayMs);
  }

  log(`\nDone. ✓ ${ok} succeeded  ✗ ${fail} failed`);
  if (fail > 0) { log("Check batch-errors.log"); process.exit(1); }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
