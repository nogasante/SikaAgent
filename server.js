// Sika Agent v1 — Cloud Run server
// AI sales closer for Ghanaian vendors on WhatsApp.
// Twilio (WhatsApp) -> Gemini (catalog-grounded) -> Paystack (MoMo/card) -> Supabase (state + logs)

import express from "express";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  GEMINI_API_KEY, PAYSTACK_SECRET,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  CRON_SECRET = "change-me",
  PORT = 8080,
} = process.env;

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const app = express();

const log = (vendor_id, conversation_id, action, detail) =>
  db.from("agent_logs").insert({ vendor_id, conversation_id, action, detail }).then(() => {});

// ---------- Twilio outbound ----------
async function sendWhatsApp(from, to, body) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  });
}

// ---------- Gemini ----------
async function gemini(system, history) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: history.map((m) => ({
            role: m.role === "customer" ? "user" : "model",
            parts: [{ text: m.content }],
          })),
          generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
        }),
      },
    );
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    const d = await res.json();
    const text = d?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) return text;
    await new Promise((r) => setTimeout(r, 500));
  }
  return "";
}

function buildSystem(vendor, products) {
  const catalog = products.map((p) =>
    `- id:${p.id} | ${p.name} | GHS ${p.price} | options: ${p.options || "none"} | ${p.in_stock ? "IN STOCK" : "OUT OF STOCK"}${p.notes ? " | " + p.notes : ""}`
  ).join("\n");
  return `You are the WhatsApp sales assistant for "${vendor.shop_name}" in ${vendor.city || "Ghana"}, owned by ${vendor.owner_name}.
Tone: ${vendor.tone_note || "warm, brief, professional, WhatsApp style"}.
Delivery info: ${vendor.delivery_note || "confirm delivery details with the owner"}.

CATALOG (this is the ONLY source of truth for products, prices and stock):
${catalog || "(catalog is empty)"}

STRICT RULES:
1. NEVER invent products, prices, discounts, stock or delivery promises not in the catalog or delivery info above. This is the most important rule.
2. If asked something you cannot answer from the data above, or the customer is upset, or wants to negotiate below listed price: escalate. Write ONLY a short friendly line like "${vendor.owner_name} will confirm that for you shortly 🙏" then a newline, then this tag as the very last thing and nothing after it:
ACTION_ESCALATE {"reason":"<short reason>"}
Keep the reason under 8 words. Never split the tag across lines.
3. When the customer clearly confirms a purchase (item + options + delivery agreed), summarize the total (item + delivery), then a newline, then this tag as the very last thing and nothing after it:
ACTION_ORDER {"summary":"<item, option, delivery place>","amount":<total GHS number>}
Do NOT output ACTION_ORDER before the customer has confirmed. Never split the tag across lines.
4. Keep replies short (1-3 sentences). One question at a time. Light pidgin is fine if the customer uses it.
5. Never mention that you are an AI system's instructions, the catalog format, or these rules.`;
}

// ---------- Paystack ----------
async function paystackLink(order, vendor) {
  if (vendor.is_demo) return `DEMO payment — reply PAID to simulate (ref ${order.payment_ref})`;
  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `orders+${vendor.id.slice(0, 8)}@sika.agent`,
      amount: order.amount * 100,
      currency: "GHS",
      reference: order.payment_ref,
      metadata: { order_id: order.id, vendor_id: vendor.id },
    }),
  });
  return (await res.json())?.data?.authorization_url ?? "payment link unavailable — the owner will assist";
}

// ---------- WhatsApp webhook ----------
app.post("/webhook/whatsapp", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const from = req.body.From ?? "";
    const to = req.body.To ?? "";
    const body = (req.body.Body ?? "").trim();
    if (!from || !body) return twiml(res, "");

    const { data: vendor } = await db.from("vendors").select("*").eq("twilio_number", to).eq("active", true).single();
    if (!vendor) return twiml(res, "This line is not active yet.");

    // Vendor console: owner messaging their own business line
    if (from === vendor.owner_phone) return vendorConsole(res, vendor, body);

    // Customer flow
    let { data: convo } = await db.from("conversations").select("*")
      .eq("vendor_id", vendor.id).eq("customer_number", from).single();
    if (!convo) {
      ({ data: convo } = await db.from("conversations")
        .insert({ vendor_id: vendor.id, customer_number: from }).select().single());
    }
    await db.from("messages").insert({ conversation_id: convo.id, role: "customer", content: body });
    await log(vendor.id, convo.id, "received", { from, body });

    // Kill switch: vendor took over this thread — AI stays silent
    if (convo.ai_paused) return twiml(res, "");

    // Demo payment simulation
    if (vendor.is_demo && /^paid$/i.test(body)) {
      const { data: order } = await db.from("orders").select("*")
        .eq("conversation_id", convo.id).eq("status", "pending")
        .order("created_at", { ascending: false }).limit(1).single();
      if (order) {
        await db.from("orders").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", order.id);
        await log(vendor.id, convo.id, "payment_confirmed", { ref: order.payment_ref, amount: order.amount, demo: true });
        return twiml(res, `Payment received 🎉 GHS ${order.amount} — order confirmed!\n(${vendor.shop_name} demo)`);
      }
    }

    const [{ data: products }, { data: history }] = await Promise.all([
      db.from("products").select("*").eq("vendor_id", vendor.id),
      db.from("messages").select("role, content").eq("conversation_id", convo.id)
        .order("created_at", { ascending: true }).limit(24),
    ]);

    const raw = await gemini(buildSystem(vendor, products ?? []), history ?? []);
    let reply = raw;

    // Tolerant matchers: allow whitespace/fences and grab the JSON object.
    const esc = raw.match(/ACTION_ESCALATE\s*(\{[\s\S]*?\})/);
    const ord = raw.match(/ACTION_ORDER\s*(\{[\s\S]*?\})/);

    if (ord) {
      reply = raw.slice(0, ord.index).trim();
      const a = safeJson(ord[1]);
      if (a?.amount > 0) {
        const payment_ref = `SIKA-${Date.now()}`;
        const { data: order } = await db.from("orders").insert({
          vendor_id: vendor.id, conversation_id: convo.id,
          summary: a.summary, amount: Math.round(a.amount), payment_ref,
        }).select().single();
        await log(vendor.id, convo.id, "created_order", order);
        const link = await paystackLink(order, vendor);
        await log(vendor.id, convo.id, "sent_payment_link", { payment_ref, link });
        reply += `\n\nPay GHS ${order.amount} securely here (MoMo or card):\n${link}`;
      }
    } else if (esc) {
      reply = raw.slice(0, esc.index).trim();
      const reason = safeJson(esc[1])?.reason ?? "needs owner";
      await db.from("escalations").insert({ vendor_id: vendor.id, conversation_id: convo.id, reason });
      await log(vendor.id, convo.id, "escalated", { reason });
      await sendWhatsApp(vendor.twilio_number, vendor.owner_phone,
        `⚠️ ${vendor.shop_name}: customer ${from.replace("whatsapp:", "")} needs you — ${reason}\nReply "PAUSE ${from.replace("whatsapp:", "")}" to take over the thread.`);
    }

    // Safety net: strip ANY leftover ACTION_ remnant (even truncated) so it never reaches the customer.
    reply = reply.replace(/ACTION_[A-Z_]*[\s\S]*$/g, "").trim();
    if (!reply) reply = `Thanks for your message! One moment, we're checking that for you 🙏`;

    await db.from("messages").insert({ conversation_id: convo.id, role: "agent", content: reply });
    await log(vendor.id, convo.id, "replied", { chars: reply.length });
    return twiml(res, reply);
  } catch (e) {
    console.error(e);
    return twiml(res, "One moment please 🙏");
  }
});

// ---------- Vendor console (owner texts their own line) ----------
async function vendorConsole(res, vendor, body) {
  const pause = body.match(/^(pause|resume)\s+(\+?\d{9,15})$/i);
  if (pause) {
    const paused = pause[1].toLowerCase() === "pause";
    const cust = "whatsapp:" + (pause[2].startsWith("+") ? pause[2] : "+" + pause[2]);
    await db.from("conversations").update({ ai_paused: paused })
      .eq("vendor_id", vendor.id).eq("customer_number", cust);
    await log(vendor.id, null, paused ? "paused" : "resumed", { customer: cust });
    return twiml(res, paused
      ? `AI paused for ${pause[2]} — the thread is yours. Send "RESUME ${pause[2]}" when done.`
      : `AI resumed for ${pause[2]} ✅`);
  }
  if (/^report$/i.test(body)) return twiml(res, await buildReport(vendor));
  return twiml(res,
    `${vendor.shop_name} console:\n• PAUSE <customer number> — take over a chat\n• RESUME <customer number>\n• REPORT — today's numbers`);
}

async function buildReport(vendor) {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const [{ count: msgs }, { data: paid }, { count: escs }] = await Promise.all([
    db.from("agent_logs").select("*", { count: "exact", head: true })
      .eq("vendor_id", vendor.id).eq("action", "replied").gte("created_at", since.toISOString()),
    db.from("orders").select("amount").eq("vendor_id", vendor.id).eq("status", "paid").gte("paid_at", since.toISOString()),
    db.from("escalations").select("*", { count: "exact", head: true })
      .eq("vendor_id", vendor.id).gte("created_at", since.toISOString()),
  ]);
  const cedis = (paid ?? []).reduce((s, o) => s + o.amount, 0);
  return `☀️ ${vendor.shop_name} — today\n💰 GHS ${cedis} collected (${(paid ?? []).length} orders)\n💬 ${msgs ?? 0} customer messages handled\n⚠️ ${escs ?? 0} passed to you\n\nYour AI never slept. — Sika Agent`;
}

// ---------- Paystack webhook (payment truth source) ----------
app.post("/webhook/paystack", express.raw({ type: "*/*" }), async (req, res) => {
  const sig = crypto.createHmac("sha512", PAYSTACK_SECRET).update(req.body).digest("hex");
  if (sig !== req.headers["x-paystack-signature"]) return res.sendStatus(401);
  const event = JSON.parse(req.body.toString());
  if (event.event === "charge.success") {
    const ref = event.data.reference;
    const { data: order } = await db.from("orders").select("*, vendors(*), conversations(customer_number)")
      .eq("payment_ref", ref).single();
    if (order && order.status !== "paid") {
      await db.from("orders").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", order.id);
      await log(order.vendor_id, order.conversation_id, "payment_confirmed", { ref, amount: order.amount });
      const v = order.vendors;
      await sendWhatsApp(v.twilio_number, order.conversations.customer_number,
        `Payment received 🎉 GHS ${order.amount} confirmed.\n${order.summary}\n${v.shop_name} thanks you! 💕`);
      await sendWhatsApp(v.twilio_number, v.owner_phone,
        `💰 PAID: GHS ${order.amount} — ${order.summary}\nCustomer: ${order.conversations.customer_number.replace("whatsapp:", "")}`);
    }
  }
  res.sendStatus(200);
});

// ---------- Daily reports (Cloud Scheduler hits this every evening) ----------
app.get("/cron/daily-reports", async (req, res) => {
  if (req.query.key !== CRON_SECRET) return res.sendStatus(401);
  const { data: vendors } = await db.from("vendors").select("*").eq("active", true).eq("is_demo", false);
  for (const v of vendors ?? []) {
    await sendWhatsApp(v.twilio_number, v.owner_phone, await buildReport(v));
    await log(v.id, null, "daily_report", {});
  }
  res.json({ sent: (vendors ?? []).length });
});

app.get("/", (_req, res) => res.send("Sika Agent is running."));

// ---------- Browser test cockpit (no Twilio needed) ----------
app.get("/test", async (_req, res) => {
  const { data: v } = await db.from("vendors").select("shop_name, twilio_number")
    .eq("is_demo", true).limit(1).single();
  if (!v) return res.send("No demo vendor yet — run the seed SQL in DEPLOY.md first.");
  res.type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sika Agent — Test</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#101A2E;color:#E9EEF7;display:flex;flex-direction:column;height:100dvh}
header{background:#0A1220;padding:12px 16px;display:flex;justify-content:space-between;align-items:center}
header b{font-size:.95rem}header small{color:#FFC33D;display:block;font-size:.7rem}
header button{background:none;border:1px solid #3A4B6E;color:#8FA0BC;border-radius:99px;padding:6px 12px;font-size:.75rem}
#chat{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
.m{max-width:84%;padding:9px 12px;border-radius:14px;font-size:.9rem;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.me{background:#1D2C49;align-self:flex-end;border-bottom-right-radius:4px}
.ai{background:#274A2F;align-self:flex-start;border-bottom-left-radius:4px}
.sys{align-self:center;color:#8FA0BC;font-size:.72rem}
form{display:flex;gap:8px;padding:10px;background:#0A1220}
input{flex:1;background:#182640;border:1px solid #2A3A5C;border-radius:99px;color:#E9EEF7;padding:12px 16px;font-size:16px}
button.send{background:#FFC33D;border:none;border-radius:99px;padding:0 20px;font-weight:800;color:#0A1220}
</style></head><body>
<header><div><b>${v.shop_name}</b><small>Sika Agent test mode — you are the customer</small></div>
<button onclick="fresh()">New customer</button></header>
<div id="chat"><div class="m sys">Try: "Is the Ankara two-piece available?" · confirm a size &amp; delivery · ask "can you do GHS 150?" to see escalation</div></div>
<form onsubmit="return send(event)"><input id="box" placeholder="Message the shop…" autocomplete="off"><button class="send">Send</button></form>
<script>
const chat=document.getElementById('chat'),box=document.getElementById('box');
function num(){let n=sessionStorage.n;if(!n){n='whatsapp:+2335'+Math.floor(10000000+Math.random()*89999999);sessionStorage.n=n}return n}
function fresh(){sessionStorage.removeItem('n');chat.innerHTML='<div class="m sys">New customer session started.</div>'}
function add(cls,text){const d=document.createElement('div');d.className='m '+cls;d.textContent=text;chat.appendChild(d);chat.scrollTop=chat.scrollHeight}
async function send(e){e.preventDefault();const t=box.value.trim();if(!t)return false;box.value='';add('me',t);
try{const r=await fetch('/webhook/whatsapp',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
body:new URLSearchParams({From:num(),To:'${v.twilio_number}',Body:t})});
const x=await r.text();const doc=new DOMParser().parseFromString(x,'text/xml');
const m=doc.querySelector('Message');add(m?'ai':'sys',m?m.textContent:'(agent stayed silent — thread may be paused)');}
catch(err){add('sys','Error: '+err.message)}return false}
</script></body></html>`);
});

// ---------- helpers ----------
function twiml(res, text) {
  const safe = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${safe ? `<Message>${safe}</Message>` : ""}</Response>`,
  );
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

app.listen(PORT, () => console.log(`Sika Agent on :${PORT}`));
async function gemini(system, history) {
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: history.map((m) => ({
          role: m.role === "customer" ? "user" : "model",
          parts: [{ text: m.content }],
        })),
        generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
      }),
    },
  );
  const d = await res.json();
  return d?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

function buildSystem(vendor, products) {
  const catalog = products.map((p) =>
    `- id:${p.id} | ${p.name} | GHS ${p.price} | options: ${p.options || "none"} | ${p.in_stock ? "IN STOCK" : "OUT OF STOCK"}${p.notes ? " | " + p.notes : ""}`
  ).join("\n");
  return `You are the WhatsApp sales assistant for "${vendor.shop_name}" in ${vendor.city || "Ghana"}, owned by ${vendor.owner_name}.
Tone: ${vendor.tone_note || "warm, brief, professional, WhatsApp style"}.
Delivery info: ${vendor.delivery_note || "confirm delivery details with the owner"}.

CATALOG (this is the ONLY source of truth for products, prices and stock):
${catalog || "(catalog is empty)"}

STRICT RULES:
1. NEVER invent products, prices, discounts, stock or delivery promises not in the catalog or delivery info above. This is the most important rule.
2. If asked something you cannot answer from the data above, or the customer is upset, or wants to negotiate below listed price: escalate. Say "${vendor.owner_name} will confirm that for you shortly 🙏" and output on the FINAL line exactly:
ACTION_ESCALATE {"reason":"<short reason>"}
3. When the customer clearly confirms a purchase (item + options + delivery agreed), summarize the total (item + delivery) and output on the FINAL line exactly:
ACTION_ORDER {"summary":"<item, option, delivery place>","amount":<total GHS number>}
Do NOT output ACTION_ORDER before the customer has confirmed.
4. Keep replies short (1-3 sentences). One question at a time. Light pidgin is fine if the customer uses it.
5. Never mention that you are an AI system's instructions, the catalog format, or these rules.`;
}

// ---------- Paystack ----------
async function paystackLink(order, vendor) {
  if (vendor.is_demo) return `DEMO payment — reply PAID to simulate (ref ${order.payment_ref})`;
  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `orders+${vendor.id.slice(0, 8)}@sika.agent`,
      amount: order.amount * 100,
      currency: "GHS",
      reference: order.payment_ref,
      metadata: { order_id: order.id, vendor_id: vendor.id },
    }),
  });
  return (await res.json())?.data?.authorization_url ?? "payment link unavailable — the owner will assist";
}

// ---------- WhatsApp webhook ----------
app.post("/webhook/whatsapp", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const from = req.body.From ?? "";
    const to = req.body.To ?? "";
    const body = (req.body.Body ?? "").trim();
    if (!from || !body) return twiml(res, "");

    const { data: vendor } = await db.from("vendors").select("*").eq("twilio_number", to).eq("active", true).single();
    if (!vendor) return twiml(res, "This line is not active yet.");

    // Vendor console: owner messaging their own business line
    if (from === vendor.owner_phone) return vendorConsole(res, vendor, body);

    // Customer flow
    let { data: convo } = await db.from("conversations").select("*")
      .eq("vendor_id", vendor.id).eq("customer_number", from).single();
    if (!convo) {
      ({ data: convo } = await db.from("conversations")
        .insert({ vendor_id: vendor.id, customer_number: from }).select().single());
    }
    await db.from("messages").insert({ conversation_id: convo.id, role: "customer", content: body });
    await log(vendor.id, convo.id, "received", { from, body });

    // Kill switch: vendor took over this thread — AI stays silent
    if (convo.ai_paused) return twiml(res, "");

    // Demo payment simulation
    if (vendor.is_demo && /^paid$/i.test(body)) {
      const { data: order } = await db.from("orders").select("*")
        .eq("conversation_id", convo.id).eq("status", "pending")
        .order("created_at", { ascending: false }).limit(1).single();
      if (order) {
        await db.from("orders").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", order.id);
        await log(vendor.id, convo.id, "payment_confirmed", { ref: order.payment_ref, amount: order.amount, demo: true });
        return twiml(res, `Payment received 🎉 GHS ${order.amount} — order confirmed!\n(${vendor.shop_name} demo)`);
      }
    }

    const [{ data: products }, { data: history }] = await Promise.all([
      db.from("products").select("*").eq("vendor_id", vendor.id),
      db.from("messages").select("role, content").eq("conversation_id", convo.id)
        .order("created_at", { ascending: true }).limit(24),
    ]);

    const raw = await gemini(buildSystem(vendor, products ?? []), history ?? []);
    let reply = raw;

    const esc = raw.match(/ACTION_ESCALATE\s*(\{.*\})/s);
    const ord = raw.match(/ACTION_ORDER\s*(\{.*\})/s);

    if (esc) {
      reply = raw.replace(esc[0], "").trim();
      const reason = safeJson(esc[1])?.reason ?? "needs owner";
      await db.from("escalations").insert({ vendor_id: vendor.id, conversation_id: convo.id, reason });
      await log(vendor.id, convo.id, "escalated", { reason });
      await sendWhatsApp(vendor.twilio_number, vendor.owner_phone,
        `⚠️ ${vendor.shop_name}: customer ${from.replace("whatsapp:", "")} needs you — ${reason}\nReply "PAUSE ${from.replace("whatsapp:", "")}" to take over the thread.`);
    } else if (ord) {
      reply = raw.replace(ord[0], "").trim();
      const a = safeJson(ord[1]);
      if (a?.amount > 0) {
        const payment_ref = `SIKA-${Date.now()}`;
        const { data: order } = await db.from("orders").insert({
          vendor_id: vendor.id, conversation_id: convo.id,
          summary: a.summary, amount: Math.round(a.amount), payment_ref,
        }).select().single();
        await log(vendor.id, convo.id, "created_order", order);
        const link = await paystackLink(order, vendor);
        await log(vendor.id, convo.id, "sent_payment_link", { payment_ref, link });
        reply += `\n\nPay GHS ${order.amount} securely here (MoMo or card):\n${link}`;
      }
    }

    await db.from("messages").insert({ conversation_id: convo.id, role: "agent", content: reply });
    await log(vendor.id, convo.id, "replied", { chars: reply.length });
    return twiml(res, reply);
  } catch (e) {
    console.error(e);
    return twiml(res, "One moment please 🙏");
  }
});

// ---------- Vendor console (owner texts their own line) ----------
async function vendorConsole(res, vendor, body) {
  const pause = body.match(/^(pause|resume)\s+(\+?\d{9,15})$/i);
  if (pause) {
    const paused = pause[1].toLowerCase() === "pause";
    const cust = "whatsapp:" + (pause[2].startsWith("+") ? pause[2] : "+" + pause[2]);
    await db.from("conversations").update({ ai_paused: paused })
      .eq("vendor_id", vendor.id).eq("customer_number", cust);
    await log(vendor.id, null, paused ? "paused" : "resumed", { customer: cust });
    return twiml(res, paused
      ? `AI paused for ${pause[2]} — the thread is yours. Send "RESUME ${pause[2]}" when done.`
      : `AI resumed for ${pause[2]} ✅`);
  }
  if (/^report$/i.test(body)) return twiml(res, await buildReport(vendor));
  return twiml(res,
    `${vendor.shop_name} console:\n• PAUSE <customer number> — take over a chat\n• RESUME <customer number>\n• REPORT — today's numbers`);
}

async function buildReport(vendor) {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const [{ count: msgs }, { data: paid }, { count: escs }] = await Promise.all([
    db.from("agent_logs").select("*", { count: "exact", head: true })
      .eq("vendor_id", vendor.id).eq("action", "replied").gte("created_at", since.toISOString()),
    db.from("orders").select("amount").eq("vendor_id", vendor.id).eq("status", "paid").gte("paid_at", since.toISOString()),
    db.from("escalations").select("*", { count: "exact", head: true })
      .eq("vendor_id", vendor.id).gte("created_at", since.toISOString()),
  ]);
  const cedis = (paid ?? []).reduce((s, o) => s + o.amount, 0);
  return `☀️ ${vendor.shop_name} — today\n💰 GHS ${cedis} collected (${(paid ?? []).length} orders)\n💬 ${msgs ?? 0} customer messages handled\n⚠️ ${escs ?? 0} passed to you\n\nYour AI never slept. — Sika Agent`;
}

// ---------- Paystack webhook (payment truth source) ----------
app.post("/webhook/paystack", express.raw({ type: "*/*" }), async (req, res) => {
  const sig = crypto.createHmac("sha512", PAYSTACK_SECRET).update(req.body).digest("hex");
  if (sig !== req.headers["x-paystack-signature"]) return res.sendStatus(401);
  const event = JSON.parse(req.body.toString());
  if (event.event === "charge.success") {
    const ref = event.data.reference;
    const { data: order } = await db.from("orders").select("*, vendors(*), conversations(customer_number)")
      .eq("payment_ref", ref).single();
    if (order && order.status !== "paid") {
      await db.from("orders").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", order.id);
      await log(order.vendor_id, order.conversation_id, "payment_confirmed", { ref, amount: order.amount });
      const v = order.vendors;
      await sendWhatsApp(v.twilio_number, order.conversations.customer_number,
        `Payment received 🎉 GHS ${order.amount} confirmed.\n${order.summary}\n${v.shop_name} thanks you! 💕`);
      await sendWhatsApp(v.twilio_number, v.owner_phone,
        `💰 PAID: GHS ${order.amount} — ${order.summary}\nCustomer: ${order.conversations.customer_number.replace("whatsapp:", "")}`);
    }
  }
  res.sendStatus(200);
});

// ---------- Daily reports (Cloud Scheduler hits this every evening) ----------
app.get("/cron/daily-reports", async (req, res) => {
  if (req.query.key !== CRON_SECRET) return res.sendStatus(401);
  const { data: vendors } = await db.from("vendors").select("*").eq("active", true).eq("is_demo", false);
  for (const v of vendors ?? []) {
    await sendWhatsApp(v.twilio_number, v.owner_phone, await buildReport(v));
    await log(v.id, null, "daily_report", {});
  }
  res.json({ sent: (vendors ?? []).length });
});

app.get("/", (_req, res) => res.send("Sika Agent is running."));

// ---------- Browser test cockpit (no Twilio needed) ----------
app.get("/test", async (_req, res) => {
  const { data: v } = await db.from("vendors").select("shop_name, twilio_number")
    .eq("is_demo", true).limit(1).single();
  if (!v) return res.send("No demo vendor yet — run the seed SQL in DEPLOY.md first.");
  res.type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sika Agent — Test</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#101A2E;color:#E9EEF7;display:flex;flex-direction:column;height:100dvh}
header{background:#0A1220;padding:12px 16px;display:flex;justify-content:space-between;align-items:center}
header b{font-size:.95rem}header small{color:#FFC33D;display:block;font-size:.7rem}
header button{background:none;border:1px solid #3A4B6E;color:#8FA0BC;border-radius:99px;padding:6px 12px;font-size:.75rem}
#chat{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
.m{max-width:84%;padding:9px 12px;border-radius:14px;font-size:.9rem;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.me{background:#1D2C49;align-self:flex-end;border-bottom-right-radius:4px}
.ai{background:#274A2F;align-self:flex-start;border-bottom-left-radius:4px}
.sys{align-self:center;color:#8FA0BC;font-size:.72rem}
form{display:flex;gap:8px;padding:10px;background:#0A1220}
input{flex:1;background:#182640;border:1px solid #2A3A5C;border-radius:99px;color:#E9EEF7;padding:12px 16px;font-size:16px}
button.send{background:#FFC33D;border:none;border-radius:99px;padding:0 20px;font-weight:800;color:#0A1220}
</style></head><body>
<header><div><b>${v.shop_name}</b><small>Sika Agent test mode — you are the customer</small></div>
<button onclick="fresh()">New customer</button></header>
<div id="chat"><div class="m sys">Try: "Is the Ankara two-piece available?" · confirm a size &amp; delivery · ask "can you do GHS 150?" to see escalation</div></div>
<form onsubmit="return send(event)"><input id="box" placeholder="Message the shop…" autocomplete="off"><button class="send">Send</button></form>
<script>
const chat=document.getElementById('chat'),box=document.getElementById('box');
function num(){let n=sessionStorage.n;if(!n){n='whatsapp:+2335'+Math.floor(10000000+Math.random()*89999999);sessionStorage.n=n}return n}
function fresh(){sessionStorage.removeItem('n');chat.innerHTML='<div class="m sys">New customer session started.</div>'}
function add(cls,text){const d=document.createElement('div');d.className='m '+cls;d.textContent=text;chat.appendChild(d);chat.scrollTop=chat.scrollHeight}
async function send(e){e.preventDefault();const t=box.value.trim();if(!t)return false;box.value='';add('me',t);
try{const r=await fetch('/webhook/whatsapp',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
body:new URLSearchParams({From:num(),To:'${v.twilio_number}',Body:t})});
const x=await r.text();const doc=new DOMParser().parseFromString(x,'text/xml');
const m=doc.querySelector('Message');add(m?'ai':'sys',m?m.textContent:'(agent stayed silent — thread may be paused)');}
catch(err){add('sys','Error: '+err.message)}return false}
</script></body></html>`);
});

// ---------- helpers ----------
function twiml(res, text) {
  const safe = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${safe ? `<Message>${safe}</Message>` : ""}</Response>`,
  );
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

app.listen(PORT, () => console.log(`Sika Agent on :${PORT}`));
