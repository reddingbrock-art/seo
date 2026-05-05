#!/usr/bin/env node

/**
 * Field-Built Systems — SEO Page Generator
 * Haiku generates copy JSON → Node assembles HTML
 *
 * node batch.js                    → all rows
 * node batch.js --limit 10         → first N rows
 * node batch.js --slug some-slug   → one page
 * node batch.js --chunk 2 --of 5   → parallel CI chunk
 * node batch.js --skip-existing    → skip already-built pages
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
  model:     "claude-haiku-4-5-20251001",
  maxTokens: 2500,
  rate: { delayBetweenMs: 200, retryDelayMs: 8000, maxRetries: 3 },
};

const args          = process.argv.slice(2);
const flag          = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasFlag       = (f) => args.includes(f);
const LIMIT         = flag("--limit") ? parseInt(flag("--limit")) : null;
const TARGET_SLUG   = flag("--slug")  ?? null;
const CHUNK_INDEX   = flag("--chunk") ? parseInt(flag("--chunk")) : null;
const CHUNK_TOTAL   = flag("--of")    ? parseInt(flag("--of"))    : null;
const SKIP_EXISTING = hasFlag("--skip-existing");

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
function outputPath(slug) { return path.join(CONFIG.outputDir, `${slug}.html`); }

// State abbreviation map for geo.region meta tag
const STATE_ABBR = {
  "Alabama":"AL","Alaska":"AK","Arizona":"AZ","Arkansas":"AR","California":"CA","Colorado":"CO",
  "Connecticut":"CT","Delaware":"DE","Florida":"FL","Georgia":"GA","Hawaii":"HI","Idaho":"ID",
  "Illinois":"IL","Indiana":"IN","Iowa":"IA","Kansas":"KS","Kentucky":"KY","Louisiana":"LA",
  "Maine":"ME","Maryland":"MD","Massachusetts":"MA","Michigan":"MI","Minnesota":"MN","Mississippi":"MS",
  "Missouri":"MO","Montana":"MT","Nebraska":"NE","Nevada":"NV","New Hampshire":"NH","New Jersey":"NJ",
  "New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND","Ohio":"OH","Oklahoma":"OK",
  "Oregon":"OR","Pennsylvania":"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD",
  "Tennessee":"TN","Texas":"TX","Utah":"UT","Vermont":"VT","Virginia":"VA","Washington":"WA",
  "West Virginia":"WV","Wisconsin":"WI","Wyoming":"WY",
};

// ─── Derived values (deterministic — no model needed) ─────────────────────

function deriveRow(row) {
  const { vertical, city, state, page_type, angle, slug } = row;

  const aLabel = {
    "general":                `${vertical} companies`,
    "small-business":         `small ${vertical} companies`,
    "owner-operator":         `${vertical} owner-operators`,
    "scaling-up":             `${vertical} companies scaling up`,
    "switching-servicetitan": `${vertical} companies switching from ServiceTitan`,
    "switching-jobber":       `${vertical} companies switching from Jobber`,
    "new-business":           `new ${vertical} companies`,
  }[angle] ?? `${vertical} companies`;

  const h1 = {
    "crm":           `Best CRM for ${aLabel} in ${city}, ${state}`,
    "automation":    `Automation Software for ${aLabel} in ${city}, ${state}`,
    "ai-chat":       `AI Chat Agent for ${aLabel} in ${city}, ${state}`,
    "lead-followup": `Lead Follow-Up System for ${aLabel} in ${city}, ${state}`,
    "reviews":       `Reputation Management for ${aLabel} in ${city}, ${state}`,
  }[page_type] ?? `Automation System for ${aLabel} in ${city}, ${state}`;

  const midColHeader =
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
    "crm":           `Done-for-you CRM for ${vertical} businesses in ${city}. GoHighLevel with pipeline, lead follow-up, and AI chat. Live in 10–14 days.`,
    "automation":    `Done-for-you automation for ${vertical} companies in ${city}. AI chat, review requests, lead follow-up — live in 10–14 days.`,
    "ai-chat":       `AI chat agent for ${vertical} businesses in ${city}. Answers leads, books appointments, follows up. Live in 10–14 days.`,
    "lead-followup": `Lead follow-up system for ${vertical} companies in ${city}. Automated text/email sequences on GoHighLevel. Live in 10–14 days.`,
    "reviews":       `Reputation management for ${vertical} businesses in ${city}. Automated review requests, multi-platform monitoring, AI-drafted replies. Live in 10–14 days.`,
  }[page_type] ?? `Done-for-you automation for ${vertical} businesses in ${city}. GoHighLevel with AI chat, lead follow-up, and review automation. Live in 10–14 days.`;

  const geoRegion = `US-${STATE_ABBR[state] ?? state}`;

  return { ...row, h1, midColHeader, ctaH2, serviceDesc, geoRegion };
}

// ─── Content prompt (copy only — no HTML, CSS, or schema) ─────────────────

function buildContentPrompt({ vertical, city, state, page_type, h1 }) {
  const faqBank = {
    "crm":           `"Do I have to migrate all my old data?", "Is this just GoHighLevel rebranded?", "What if my techs won't use a new system?", "How is this different from buying GHL directly?"`,
    "automation":    `"What gets automated and what's still manual?", "Will this work with the tools I already use?", "Do I have to learn how to build automations?", "What if something breaks while I'm on a job?"`,
    "ai-chat":       `"What happens when a customer asks something the AI can't answer?", "Can I customize what the AI says?", "Will customers know they're talking to an AI?", "Does it work after hours and on weekends?"`,
    "lead-followup": `"How fast does the follow-up actually go out?", "What if a lead replies STOP?", "Can I see what messages went out?", "What if I already have a follow-up sequence?"`,
    "reviews":       `"What if a customer leaves a bad review?", "Does the AI reply post automatically or do I approve it first?", "Which platforms does it monitor?", "How does it know when a job is done?"`,
  }[page_type] ?? `"Do I have to learn new software?", "What if I'm already using GoHighLevel?", "How is this different from buying a CRM?", "What happens after setup?"`;

  const schema = {
    metaTitle:         "<=55 chars Title Case. Keyword + | Field-Built Systems",
    metaDesc:          "140-155 chars. Keyword, city, outcome, soft CTA",
    heroSubhead:       "One line. Pain + delivery. <=20 words",
    introParagraphs:   ["p1: who this is for, 1-15 trucks, $300K-$5M revenue", "p2: why now, why this city"],
    problemHeading:    "H2. Keyword-rich. Include city and vertical",
    problemParagraphs: [
      `60-80 words. Specific operational pain for ${vertical} in ${city}. Real stakes. No solution language.`,
      `60-80 words. What staying stuck costs — lost jobs, competitors pulling ahead. Name real ${city} market dynamics.`
    ],
    solutionHeading:   "H2. Keyword-rich. Include city and vertical",
    solutionBody:      "2-3 paragraphs separated by \n\n. Done-for-you. GoHighLevel + AI. 10-14 days. Use keyword naturally.",
    cityContext:       `80-100 words. Why ${city} ${vertical} businesses need this now. Seasonal demand, local competition density, neighborhood-level conditions. Local knowledge tone.`,
    featuresHeading:   "H2. Keyword-rich. Include city and vertical",
    cards: [
      { title: `Specific capability for ${page_type} / ${vertical}`, body: "2-3 sentences. Concrete outcome." },
      { title: "...", body: "..." },
      { title: "...", body: "..." },
      { title: "...", body: "..." }
    ],
    tableHeading:      "H2. Comparison angle. Keyword-rich",
    whyFBSHeading:     `H2. Why Field-Built for ${vertical} in ${city}`,
    whyFBSBody:        "2 paragraphs separated by \n\n. Done-for-you vs buying software, GoHighLevel expertise, field service specialization, post-launch support. 100-120 words total.",
    faqHeading:        "H2. Include city and vertical",
    faqs: [
      { q: `Pick from: ${faqBank}`, a: "Complete answer, 50-70 words. No restatement." },
      { q: "...", a: "..." },
      { q: "...", a: "..." },
      { q: "...", a: "..." },
      { q: "...", a: "..." }
    ]
  };

  return `Write copy for a Field-Built Systems landing page. Return only valid JSON, no markdown.

VERTICAL: ${vertical} | CITY: ${city}, ${state} | PAGE TYPE: ${page_type}
H1: "${h1}"

RULES:
- Practitioner voice — sounds like someone who ran a ${vertical} business
- Contractions always. "You" and "your" throughout.
- Real ${city} context: actual neighborhoods, seasonal patterns, local competition
- Never invent stats. Use "most", "faster than", "significantly more"
- Never: "game-changer", "seamless", "leverage", "supercharge", "streamline"
- problemParagraphs: pure pain only, zero solution language
- Solution: done-for-you framing — "we install" not "you'll configure"
- Reviews content: every customer gets asked, every review gets answered. AI drafts reply, owner approves. Never imply filtering.

${JSON.stringify(schema, null, 0)}`;
}

// ─── API call ──────────────────────────────────────────────────────────────

async function fetchContent(client, row) {
  let attempt = 0;
  while (attempt < CONFIG.rate.maxRetries) {
    try {
      const res = await client.messages.create({
        model: CONFIG.model, max_tokens: CONFIG.maxTokens,
        messages: [{ role: "user", content: buildContentPrompt(row) }],
      });
      const raw = res.content.filter(b => b.type === "text").map(b => b.text).join("")
        .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```\s*$/i, "").trim();
      return JSON.parse(raw);
    } catch (err) {
      attempt++;
      if (attempt < CONFIG.rate.maxRetries) {
        log(`  Retry ${attempt} for ${row.slug}: ${err.message}`);
        await sleep(CONFIG.rate.retryDelayMs * attempt);
      } else { throw err; }
    }
  }
}

// ─── HTML assembly ────────────────────────────────────────────────────────

const LOGO = "https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png";
const esc  = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const CARD_ICONS = ["💬","📨","⭐","📋"];
const TITLE_MAX  = 55;

function assembleHTML(r, c) {
  const { vertical, city, state, page_type, slug, h1, midColHeader, ctaH2, serviceDesc, geoRegion } = r;

  // Hard-enforce title length — never let a model overrun truncate silently in SERPs
  const safeTitle = c.metaTitle.length > TITLE_MAX
    ? c.metaTitle.slice(0, TITLE_MAX - 1).trim() + "…"
    : c.metaTitle;

  const faqSchema = c.faqs.map(f =>
    `{"@type":"Question","name":${JSON.stringify(f.q)},"acceptedAnswer":{"@type":"Answer","text":${JSON.stringify(f.a)}}}`
  ).join(",");

  // FAQ: button inside h3 for correct semantics (heading + interactive element)
  const faqHTML = c.faqs.map(f => `
      <div class="faq-item">
        <h3><button class="faq-q" aria-expanded="false">${esc(f.q)}<span class="faq-icon" aria-hidden="true">+</span></button></h3>
        <div class="faq-a" hidden><p>${esc(f.a)}</p></div>
      </div>`).join("");

  const cardsHTML = c.cards.map((card, i) => `
        <div class="card">
          <div class="card-icon" aria-hidden="true">${CARD_ICONS[i]}</div>
          <h3>${esc(card.title)}</h3>
          <p>${esc(card.body)}</p>
        </div>`).join("");

  // Internal links injected by Node — never costs prompt tokens
  const solutionParas = c.solutionBody.split(/\n\n+/);
  const solutionHTML = solutionParas.map((p, i) => {
    let text = esc(p);
    // Inject one internal link each into first two paragraphs
    if (i === 0) text = text.replace(/done-for-you/i, `<a href="https://field-built.com/services" style="color:var(--cyan)">done-for-you</a>`);
    if (i === 1) text = text.replace(/see (it|how it works)/i, (m) => `<a href="https://field-built.com/demo" style="color:var(--cyan)">${m}</a>`);
    return `<p>${text}</p>`;
  }).join("\n          ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="index,follow">
<meta name="geo.region" content="${geoRegion}">
<meta name="geo.placename" content="${esc(city)}, ${esc(state)}">
<title>${esc(safeTitle)}</title>
<meta name="description" content="${esc(c.metaDesc)}">
<link rel="canonical" href="https://local.field-built.com/${slug}">
<meta property="og:title" content="${esc(safeTitle)}">
<meta property="og:description" content="${esc(c.metaDesc)}">
<meta property="og:url" content="https://local.field-built.com/${slug}">
<meta property="og:type" content="website">
<meta property="og:image" content="${LOGO}">
<meta property="og:site_name" content="Field-Built Systems">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(safeTitle)}">
<meta name="twitter:description" content="${esc(c.metaDesc)}">
<meta name="twitter:image" content="${LOGO}">
<link rel="icon" type="image/png" href="https://assets.cdn.filesafe.space/8rt3tZ6TYwlA5NWwwHXp/media/69efea020d66f2a665bccba8.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","@id":"https://field-built.com/#business","name":"Field-Built Systems","url":"https://field-built.com","telephone":"(817) 518-7791","email":"info@field-built.com","description":"Done-for-you automation for ${esc(vertical)} companies in ${esc(city)}, ${esc(state)}","priceRange":"$$","address":{"@type":"PostalAddress","addressLocality":"${esc(city)}","addressRegion":"${STATE_ABBR[state] ?? esc(state)}","addressCountry":"US"},"areaServed":{"@type":"City","name":"${esc(city)}","containedInPlace":{"@type":"State","name":"${esc(state)}"}},"serviceType":"${esc(page_type)}"}<\/script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Service","name":${JSON.stringify(h1)},"provider":{"@type":"Organization","name":"Field-Built Systems","url":"https://field-built.com"},"areaServed":"${esc(city)}, ${esc(state)}","description":${JSON.stringify(serviceDesc)},"url":"https://local.field-built.com/${slug}"}<\/script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[${faqSchema}]}<\/script>
<style>
:root{--bg:#080C14;--bg-card:#0E1420;--bg-alt:#0A0F1A;--border:rgba(255,255,255,0.07);--text:#F1F5F9;--muted:#8B9AB4;--cyan:#1B98E0;--violet:#8B5CF6;--green:#22D87A;--red:#EF4444;--amber:#F59E0B;--fbs:#00D4FF}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:17px;line-height:1.7;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}img{display:block}
.skip-nav{position:absolute;left:-9999px;top:0;z-index:200;padding:8px 16px;background:var(--cyan);color:#080C14;font-weight:700;border-radius:0 0 8px 0}
.skip-nav:focus{left:0}
header{position:fixed;top:0;left:0;right:0;z-index:100;height:64px;display:flex;align-items:center;background:rgba(8,12,20,0.92);backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}
.nav{width:100%;max-width:1140px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;gap:24px}
.brand{display:flex;align-items:center;gap:12px}
.wordmark{font-size:22px;font-weight:700;color:#F1F5F9}
.nav-links{display:flex;gap:28px;list-style:none}
.nav-links a{color:var(--muted);font-size:15px;font-weight:500;transition:color .2s}
.nav-links a:hover{color:var(--cyan)}
.nav-cta{background:#00D4FF;color:#080C14;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:600;white-space:nowrap}
.hamburger{display:none;background:none;border:none;cursor:pointer;flex-direction:column;gap:5px;padding:8px}
.hamburger span{display:block;width:24px;height:2px;background:#F1F5F9;border-radius:2px}
.mobile-menu{display:none;position:fixed;top:64px;left:0;right:0;background:var(--bg-card);border-bottom:1px solid var(--border);padding:20px 24px;flex-direction:column;gap:16px}
.mobile-menu a{color:var(--muted);font-size:16px;font-weight:500;padding:8px 0}
.mobile-menu[data-open=true]{display:flex}
.mob-cta{background:#00D4FF!important;color:#080C14!important;padding:12px 22px!important;border-radius:999px;text-align:center;font-weight:600!important}
.container{max-width:1100px;margin:0 auto;padding:0 24px}
.narrow{max-width:780px;margin:0 auto;padding:0 24px}
main>section{padding:88px 0}
main>section:nth-child(even){background:var(--bg-alt)}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--cyan);margin-bottom:14px}
h1{font-size:clamp(36px,5vw,64px);font-weight:900;line-height:1.1;color:#F1F5F9}
h2{font-size:clamp(28px,4vw,48px);font-weight:800;line-height:1.15;color:#F1F5F9;margin-bottom:16px}
h3{font-size:18px;font-weight:700;color:var(--text);margin-bottom:10px}
p{color:var(--muted);line-height:1.75;margin-bottom:16px}
p:last-child{margin-bottom:0}
.grad{background:linear-gradient(90deg,var(--cyan),var(--violet));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero{min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;position:relative;overflow:hidden;background:radial-gradient(ellipse 80% 60% at 50% 30%,rgba(27,152,224,.12) 0%,var(--bg) 70%);padding:100px 24px 80px}
.hero::before{content:'';position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px);background-size:40px 40px}
.orb{position:absolute;pointer-events:none;border-radius:50%;filter:blur(80px)}
.orb-1{width:400px;height:400px;background:rgba(27,152,224,.15);top:-100px;left:-100px}
.orb-2{width:300px;height:300px;background:rgba(139,92,246,.12);bottom:-80px;right:-80px}
.hero-inner{position:relative;z-index:1;max-width:860px;width:100%}
.badge{display:inline-block;margin-bottom:28px;border:1px solid rgba(27,152,224,.4);border-radius:999px;background:rgba(27,152,224,.1);padding:6px 18px;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.hero h1{margin-bottom:24px}
.hero p{font-size:18px;max-width:520px;margin:0 auto 36px}
.btn{display:inline-block;background:#00D4FF;color:#080C14;border-radius:999px;font-weight:700;border:none;cursor:pointer;transition:transform .2s,box-shadow .2s}
.btn:hover{transform:translateY(-1px);box-shadow:0 0 40px rgba(27,152,224,.5)}
.btn-hero{padding:16px 36px;font-size:16px;box-shadow:0 0 32px rgba(27,152,224,.35)}
.btn-cta{padding:18px 44px;font-size:17px;box-shadow:0 0 32px rgba(27,152,224,.35)}
.card-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:40px}
.card{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:28px;transition:border-color .25s,box-shadow .25s}
.card:hover{border-color:rgba(27,152,224,.3);box-shadow:0 0 20px rgba(27,152,224,.08)}
.card-icon{width:48px;height:48px;border-radius:12px;margin-bottom:16px;background:linear-gradient(135deg,var(--cyan),var(--violet));display:flex;align-items:center;justify-content:center;font-size:22px}
.card h3{font-size:18px}
.card p{font-size:15px;line-height:1.65}
.table-wrap{overflow-x:auto;border-radius:12px;border:1px solid var(--border);margin-top:40px}
table{width:100%;border-collapse:collapse;min-width:540px}
caption{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
thead tr{background:linear-gradient(135deg,rgba(27,152,224,.15),rgba(139,92,246,.1))}
th{padding:16px 20px;font-size:14px;font-weight:700;text-align:left;border-bottom:1px solid var(--border);color:var(--muted)}
th.fbs{color:var(--fbs);font-weight:800}
td{padding:16px 20px;font-size:15px;border-bottom:1px solid var(--border);color:var(--muted);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:nth-child(odd) td{background:rgba(255,255,255,.02)}
td:first-child{font-weight:500;color:var(--text)}
.chk{color:var(--green);font-weight:700;font-size:18px}
.x{color:var(--red);font-weight:700;font-size:18px}
.man{color:var(--amber);font-weight:600;font-size:14px}
.fv{color:var(--fbs);font-weight:600}
.faq-list{margin-top:40px}
.faq-item{border-bottom:1px solid var(--border)}
.faq-item:last-child{border-bottom:none}
.faq-q{display:flex;justify-content:space-between;align-items:center;width:100%;padding:20px 0;font-size:17px;font-weight:600;color:var(--text);cursor:pointer;gap:12px;background:none;border:none;text-align:left}
.faq-icon{font-size:20px;color:var(--muted);flex-shrink:0;transition:transform .2s}
.faq-a{padding-bottom:20px}
.faq-a[hidden]{display:none}
.faq-item.open .faq-icon{transform:rotate(45deg);color:var(--cyan)}
.faq-a p{font-size:15px}
.faq-q:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.cta-sec{text-align:center;background:radial-gradient(ellipse 80% 60% at 50% 50%,rgba(27,152,224,.08) 0%,var(--bg) 70%)}
.cta-sec h2{margin-bottom:12px}
.cta-sec>div>p{max-width:520px;margin:0 auto 36px;font-size:18px}
.reassure{font-size:13px;margin-top:16px;opacity:.7}
footer{background:#080C14;border-top:1px solid var(--border);padding:48px 24px}
.footer-grid{max-width:1140px;margin:0 auto;display:grid;grid-template-columns:2fr 1fr 1fr;gap:32px}
.footer-brand-row{display:flex;align-items:center;gap:12px}
.footer-wordmark{font-size:20px;font-weight:700;color:#F1F5F9}
.footer-tagline{color:var(--muted);font-size:14px;line-height:1.6;margin:12px 0 16px;max-width:420px}
.footer-contact a{display:block;color:var(--muted);font-size:14px;padding:2px 0;transition:color .2s}
.footer-contact a:hover{color:var(--cyan)}
.footer-col h4{color:#F1F5F9;font-size:14px;font-weight:600;margin:0 0 12px}
.footer-col a{display:block;color:var(--muted);font-size:14px;padding:4px 0;transition:color .2s}
.footer-col a:hover{color:var(--cyan)}
.footer-bottom{text-align:center;color:var(--muted);font-size:13px;margin-top:40px;padding-top:24px;border-top:1px solid var(--border)}
@media(max-width:768px){.nav-links,.nav-cta{display:none}.hamburger{display:flex}main>section{padding:64px 0}.card-grid{grid-template-columns:1fr}.footer-grid{grid-template-columns:1fr;gap:32px}.orb-1,.orb-2{display:none}.wordmark{font-size:18px}}
</style>
</head>
<body>

<a href="#main-content" class="skip-nav">Skip to main content</a>

<header>
  <nav class="nav" aria-label="Main navigation">
    <a href="https://field-built.com" class="brand">
      <img src="${LOGO}" alt="Field-Built Systems logo" style="height:40px;width:auto;object-fit:contain">
      <span class="wordmark">Field-Built Systems</span>
    </a>
    <ul class="nav-links">
      <li><a href="https://field-built.com">Home</a></li>
      <li><a href="https://field-built.com/services">Services</a></li>
      <li><a href="https://field-built.com/about">About</a></li>
      <li><a href="https://field-built.com/demo">Demo</a></li>
    </ul>
    <a href="https://field-built.com/book" class="nav-cta">Book a Free Call</a>
    <button class="hamburger" aria-label="Toggle menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
  </nav>
  <div class="mobile-menu">
    <a href="https://field-built.com">Home</a>
    <a href="https://field-built.com/services">Services</a>
    <a href="https://field-built.com/about">About</a>
    <a href="https://field-built.com/demo">Demo</a>
    <a href="https://field-built.com/book" class="mob-cta">Book a Free Call</a>
  </div>
</header>

<main id="main-content">

<section class="hero">
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>
  <div class="hero-inner">
    <div class="badge"><span class="grad">Done-for-you · Live in 10–14 days</span></div>
    <h1>${esc(h1)}</h1>
    <p>${esc(c.heroSubhead)}</p>
    <a href="https://field-built.com/book" class="btn btn-hero">Book a Free 30-Minute Call</a>
  </div>
</section>

<section>
  <div class="narrow">
    <p class="eyebrow">Who This Is For</p>
    ${c.introParagraphs.map(p => `<p>${esc(p)}</p>`).join("\n    ")}
  </div>
</section>

<section>
  <div class="narrow">
    <p class="eyebrow">The Problem</p>
    <h2>${esc(c.problemHeading)}</h2>
    ${(c.problemParagraphs || [c.problemBody]).map(p => `<p>${esc(p)}</p>`).join("\n    ")}
  </div>
</section>

<section>
  <div class="narrow">
    <p class="eyebrow">The Fix</p>
    <h2>${esc(c.solutionHeading)}</h2>
    ${solutionHTML}
  </div>
</section>

<section>
  <div class="narrow">
    <p class="eyebrow">Local Market</p>
    <h2><span class="grad">${esc(city)}</span> Context</h2>
    <p>${esc(c.cityContext)}</p>
  </div>
</section>

<section>
  <div class="container">
    <p class="eyebrow">What You Get</p>
    <h2>${esc(c.featuresHeading)}</h2>
    <div class="card-grid">${cardsHTML}</div>
  </div>
</section>

<section>
  <div class="container">
    <p class="eyebrow">How We Compare</p>
    <h2>${esc(c.tableHeading)}</h2>
    <div class="table-wrap">
      <table>
        <caption>Field-Built Systems vs ${esc(midColHeader)} vs DIY — feature and pricing comparison</caption>
        <thead><tr><th>Feature</th><th class="fbs">Field-Built Systems</th><th>${esc(midColHeader)}</th><th>DIY</th></tr></thead>
        <tbody>
          <tr><td>Done-for-you setup</td><td class="fv"><span class="chk">✓</span></td><td><span class="x">✗</span></td><td><span class="x">✗</span></td></tr>
          <tr><td>AI chat + voice agent</td><td class="fv"><span class="chk">✓</span></td><td><span class="x">✗</span></td><td><span class="x">✗</span></td></tr>
          <tr><td>Reputation management stack</td><td class="fv"><span class="chk">✓</span></td><td><span class="x">✗</span></td><td><span class="x">✗</span></td></tr>
          <tr><td>Lead follow-up sequences</td><td class="fv"><span class="chk">✓</span></td><td><span class="man">Manual</span></td><td><span class="x">✗</span></td></tr>
          <tr><td>Launch timeline</td><td class="fv">10–14 days</td><td>Months</td><td>Never</td></tr>
          <tr><td>Monthly cost</td><td class="fv">$500/mo all-in</td><td>$300–800+ DIY config</td><td>Your time</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</section>

<section>
  <div class="narrow">
    <p class="eyebrow">Why Field-Built</p>
    <h2>${esc(c.whyFBSHeading)}</h2>
    ${(c.whyFBSBody || "").split(/\n\n+/).map(p => `<p>${esc(p)}</p>`).join("\n    ")}
  </div>
</section>

<section>
  <div class="narrow">
    <p class="eyebrow">Common Questions</p>
    <h2>${esc(c.faqHeading)}</h2>
    <div class="faq-list">${faqHTML}</div>
  </div>
</section>

<section class="cta-sec">
  <div class="narrow">
    <h2>${esc(ctaH2)}</h2>
    <p>30 minutes. No pitch deck. No pressure.</p>
    <a href="https://field-built.com/book" class="btn btn-cta">Book a Free 30-Minute Call</a>
    <p class="reassure">Most clients are live within 10–14 days.</p>
  </div>
</section>

</main>

<footer>
  <div class="footer-grid">
    <div>
      <div class="footer-brand-row">
        <img src="${LOGO}" alt="Field-Built Systems logo" loading="lazy" style="height:32px;width:auto;object-fit:contain">
        <span class="footer-wordmark">Field-Built Systems</span>
      </div>
      <p class="footer-tagline">We install AI-powered automation systems that help service businesses capture, respond to, and convert more leads.</p>
      <div class="footer-contact">
        <a href="tel:8175187791">(817) 518-7791</a>
        <a href="mailto:info@field-built.com">info@field-built.com</a>
      </div>
    </div>
    <div class="footer-col">
      <h4>Company</h4>
      <a href="https://field-built.com/services">Services</a>
      <a href="https://field-built.com/about">About</a>
      <a href="https://field-built.com/contact">Contact</a>
    </div>
    <div class="footer-col">
      <h4>Legal</h4>
      <a href="https://field-built.com/privacy">Privacy Policy</a>
      <a href="https://field-built.com/terms">Terms of Service</a>
      <a href="https://field-built.com/service-agreement">Service Agreement</a>
    </div>
  </div>
  <div class="footer-bottom">© 2026 Field-Built Systems. All rights reserved.</div>
</footer>

<script>
(function(){
  var btn=document.querySelector('.hamburger'),menu=document.querySelector('.mobile-menu');
  if(btn&&menu){
    btn.addEventListener('click',function(){
      var open=menu.getAttribute('data-open')==='true';
      menu.setAttribute('data-open',open?'false':'true');
      btn.setAttribute('aria-expanded',open?'false':'true');
    });
  }
  document.querySelectorAll('.faq-q').forEach(function(q){
    q.addEventListener('click',function(){
      var item=q.closest('.faq-item'),isOpen=item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach(function(i){
        i.classList.remove('open');
        i.querySelector('.faq-a').hidden=true;
        i.querySelector('.faq-q').setAttribute('aria-expanded','false');
        i.querySelector('.faq-icon').textContent='+';
      });
      if(!isOpen){
        item.classList.add('open');
        item.querySelector('.faq-a').hidden=false;
        q.setAttribute('aria-expanded','true');
        item.querySelector('.faq-icon').textContent='×';
      }
    });
  });
})();
</script>

</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  if (!fs.existsSync(CONFIG.csvPath)) { console.error(`targets.csv not found`); process.exit(1); }
  ensureDir(CONFIG.outputDir);

  const raw   = fs.readFileSync(CONFIG.csvPath, "utf8");
  let rows    = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  const total = rows.length;

  if (TARGET_SLUG) {
    rows = rows.filter(r => r.slug === TARGET_SLUG);
    if (!rows.length) { console.error(`No row: ${TARGET_SLUG}`); process.exit(1); }
  }
  if (CHUNK_INDEX !== null && CHUNK_TOTAL !== null) {
    rows = rows.filter((_, i) => i % CHUNK_TOTAL === CHUNK_INDEX - 1);
    log(`Chunk ${CHUNK_INDEX}/${CHUNK_TOTAL}: ${rows.length} rows`);
  }
  if (LIMIT) rows = rows.slice(0, LIMIT);
  if (SKIP_EXISTING) {
    const before = rows.length;
    rows = rows.filter(r => !fs.existsSync(outputPath(r.slug)));
    log(`Skip-existing: ${before - rows.length} done, ${rows.length} remaining`);
  }

  log(`Starting: ${rows.length} pages (CSV total: ${total}) — est. $${(rows.length * 0.012).toFixed(2)}`);

  let success = 0, failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row  = deriveRow(rows[i]);
    const out  = outputPath(row.slug);
    log(`[${i+1}/${rows.length}] ${row.slug}`);
    try {
      const content = await fetchContent(client, row);
      const html    = assembleHTML(row, content);
      if (!html.startsWith("<!DOCTYPE")) throw new Error("Assembly failed");
      fs.writeFileSync(out, html, "utf8");
      log(`  ✓ ${out}`);
      success++;
      if (success % 10 === 0) log(`  ↳ ${success} pages written`);
    } catch (err) {
      logError(row.slug, err);
      failed++;
    }
    if (i < rows.length - 1) await sleep(CONFIG.rate.delayBetweenMs);
  }

  log(`Done. ✓ ${success}  ✗ ${failed}`);
  if (failed > 0) { log("Check batch-errors.log"); process.exit(1); }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
