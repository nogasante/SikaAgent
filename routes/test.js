import express from "express";
import { db } from "../lib/db.js";
import { esc } from "../lib/util.js";
import { CSS, FONT } from "../admin/theme.js";

export const testCockpit = express.Router();

// Only ever exposes a demo shop, and only for the throwaway number the browser
// invented for itself — no real customer's thread is reachable here.
async function demoVendor() {
  const { data } = await db.from("vendors")
    .select("id, shop_name, owner_name, city, delivery_note, twilio_number")
    .eq("is_demo", true).eq("active", true).limit(1).maybeSingle();
  return data;
}

// What the agent did behind the reply: orders raised, whether it handed over.
// This is the "AI is really running the business" evidence, made visible.
testCockpit.get("/test/state", async (req, res) => {
  const vendor = await demoVendor();
  const number = String(req.query.n ?? "");
  if (!vendor || !/^whatsapp:\+\d{6,20}$/.test(number)) return res.json({ orders: [], paused: false, escalations: 0 });

  const { data: convo } = await db.from("conversations").select("id, ai_paused")
    .eq("vendor_id", vendor.id).eq("customer_number", number).maybeSingle();
  if (!convo) return res.json({ orders: [], paused: false, escalations: 0 });

  const [{ data: orders }, { count: escalations }] = await Promise.all([
    db.from("orders").select("summary, amount, status")
      .eq("conversation_id", convo.id).order("created_at", { ascending: false }).limit(5),
    db.from("escalations").select("id", { count: "exact", head: true })
      .eq("conversation_id", convo.id).eq("resolved", false),
  ]);

  res.set("Cache-Control", "no-store")
    .json({ orders: orders ?? [], paused: !!convo.ai_paused, escalations: escalations ?? 0 });
});

testCockpit.get("/test", async (_req, res) => {
  const vendor = await demoVendor();
  if (!vendor) return res.send("No demo vendor yet — run the seed SQL in DEPLOY.md first.");

  const { data: products } = await db.from("products").select("name, price, options, in_stock")
    .eq("vendor_id", vendor.id).order("price", { ascending: true });
  const items = products ?? [];

  // Suggestions come from this shop's real catalog: hardcoding examples would be
  // wrong for every vendor except the one they were copied from.
  const inStock = items.filter((p) => p.in_stock);
  const out = items.find((p) => !p.in_stock);
  const first = inStock[0];
  const chips = [
    first && `Do you have the ${first.name}?`,
    first && "What do you sell?",
    out && `Is the ${out.name} available?`,
    first && `Can you do GHS ${Math.max(1, Math.round(first.price * 0.6))} for the ${first.name}?`,
  ].filter(Boolean);

  // A table is too wide for a 340px rail, so the catalog reads as a list.
  const catalogRows = items.map((p) => `
<div class="item">
  <div>
    <div class="strong">${esc(p.name)}</div>
    <div class="muted dim" style="font-size:12px">${esc(p.options || "one option")}</div>
  </div>
  <div style="text-align:right;flex:none">
    <div class="strong">GHS ${p.price}</div>
    <span class="pill ${p.in_stock ? "good" : "bad"}" style="margin-top:3px">${p.in_stock ? "In stock" : "Out"}</span>
  </div>
</div>`).join("");

  res.type("html").send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(vendor.shop_name)} — Sika Agent live demo</title>${FONT}<style>${CSS}
body{display:flex;flex-direction:column;height:100dvh;overflow:hidden}
.bar{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--line);
  background:var(--panel);flex:none;flex-wrap:wrap}
.bar .who{font-weight:590;letter-spacing:-.02em}
.bar .who span{color:var(--ink-3);font-weight:400}
.bar .spacer{flex:1}
.wrap{flex:1;display:grid;grid-template-columns:1fr;min-height:0}
@media(min-width:1000px){.wrap{grid-template-columns:minmax(0,1fr) 340px}}
.chatcol{display:flex;flex-direction:column;min-height:0}
#chat{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:2px}
.side{border-left:1px solid var(--line);background:var(--panel);overflow-y:auto;padding:18px;display:none}
@media(min-width:1000px){.side{display:block}}
.side h2{margin-top:0}
.side h2:not(:first-child){margin-top:26px}
.composer{flex:none;display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--line);background:var(--panel)}
.composer input{flex:1}
.chips{display:flex;gap:6px;flex-wrap:wrap;padding:0 16px 12px;background:var(--panel)}
.chip{background:var(--wash);border:1px solid var(--line-strong);color:var(--ink-3);border-radius:99px;
  padding:6px 12px;font-size:12.5px;cursor:pointer;font:inherit;font-size:12.5px}
.chip:hover{color:var(--ink);border-color:var(--gold)}
.note{align-self:center;color:var(--ink-4);font-size:12px;text-align:center;max-width:44ch;margin:6px 0 14px;line-height:1.5}
.event{align-self:center;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:510;
  padding:4px 11px;border-radius:99px;margin:8px 0}
.event.order{background:var(--gold-dim);color:var(--gold)}
.event.hand{background:var(--bad-dim);color:var(--bad)}
.typing{align-self:flex-start;color:var(--ink-4);font-size:12.5px;padding:6px 2px}
.item{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;
  padding:10px 0;border-bottom:1px solid var(--line)}
.item:last-child{border-bottom:0}
/* In the cockpit the reader IS the customer, so their own words sit on the
   right and the shop answers on the left — the opposite of the operator's view
   in /admin, where the shop is the one being represented. */
#chat .msg.customer{align-self:flex-end;background:var(--raised);
  border-bottom-right-radius:var(--r-sm);border-bottom-left-radius:var(--r-panel)}
#chat .msg.agent{align-self:flex-start;
  border-bottom-left-radius:var(--r-sm);border-bottom-right-radius:var(--r-panel)}
#chat .msg strong{font-weight:590}
</style></head><body>

<div class="bar">
  <div class="who">💰 ${esc(vendor.shop_name)} <span>· Sika Agent live demo</span></div>
  <div class="spacer"></div>
  <span class="pill" id="statePill" hidden></span>
  <button class="btn ghost sm" onclick="fresh()">New customer</button>
</div>

<div class="wrap">
  <div class="chatcol">
    <div id="chat">
      <div class="note">You are a customer messaging this shop on WhatsApp. The agent answers only from the
      catalog on the right — ask for something it doesn't stock and watch it refuse rather than invent.</div>
    </div>
    <div class="chips">${chips.map((c) => `<button class="chip" onclick="ask(this)">${esc(c)}</button>`).join("")}</div>
    <form class="composer" onsubmit="return send(event)">
      <input id="box" placeholder="Message the shop…" autocomplete="off" autofocus>
      <button class="btn" type="submit">Send</button>
    </form>
  </div>

  <aside class="side">
    <h2>Catalog — the agent's only source of truth</h2>
    ${catalogRows || `<p class="muted dim">No products yet.</p>`}
    <h2>Delivery</h2>
    <p class="muted">${esc(vendor.delivery_note || "Not set for this shop.")}</p>
    <h2>This conversation</h2>
    <div id="live"><p class="muted dim">Nothing yet — say hello.</p></div>
  </aside>
</div>

<script>
const chat = document.getElementById('chat'), box = document.getElementById('box');
const pill = document.getElementById('statePill'), live = document.getElementById('live');
const TO = ${JSON.stringify(vendor.twilio_number)};

function num() {
  let n = sessionStorage.n;
  if (!n) { n = 'whatsapp:+2335' + Math.floor(10000000 + Math.random() * 89999999); sessionStorage.n = n; }
  return n;
}
function fresh() {
  sessionStorage.removeItem('n');
  chat.innerHTML = '<div class="note">New customer — the agent has never met this number before.</div>';
  live.innerHTML = '<p class="muted dim">Nothing yet — say hello.</p>';
  pill.hidden = true;
  box.focus();
}
// WhatsApp renders *bold*/_italic_/~strike~; a browser shows the raw asterisks,
// so apply the same formatting here. Escaped first — this text comes from a
// model and must never be trusted as markup.
function fmt(t) {
  const e = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return e
    .replace(/(^|[\\s(])\\*([^*\\n]+)\\*(?=[\\s.,!?)]|$)/g, '$1<strong>$2</strong>')
    .replace(/(^|[\\s(])_([^_\\n]+)_(?=[\\s.,!?)]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\\s(])~([^~\\n]+)~(?=[\\s.,!?)]|$)/g, '$1<s>$2</s>');
}
function add(cls, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.innerHTML = fmt(text);
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}
function event(kind, text) {
  const d = document.createElement('div');
  d.className = 'event ' + kind;
  d.textContent = text;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
}
function ask(btn) { box.value = btn.textContent; send(new Event('x')); }

let seenOrders = 0, seenPaused = false;
async function refresh() {
  try {
    const r = await fetch('/test/state?n=' + encodeURIComponent(num()), { cache: 'no-store' });
    const s = await r.json();

    if (s.orders.length > seenOrders) {
      const o = s.orders[0];
      event('order', 'Order created — GHS ' + o.amount);
      seenOrders = s.orders.length;
    }
    if (s.paused && !seenPaused) event('hand', 'Handed to the owner — the agent has stopped replying');
    seenPaused = s.paused;

    pill.hidden = false;
    pill.className = 'pill ' + (s.paused ? 'bad' : 'good');
    pill.textContent = s.paused ? 'AI paused' : 'AI answering';

    live.innerHTML = s.orders.length
      ? s.orders.map((o) =>
          '<div class="card" style="padding:11px;margin-bottom:6px"><div class="row"><b style="font-weight:510">GHS ' + o.amount +
          '</b><span class="pill ' + (o.status === 'paid' ? 'good' : '') + '">' + o.status + '</span></div>' +
          '<div class="muted" style="margin-top:3px">' + (o.summary || '') + '</div></div>').join('')
      : '<p class="muted dim">No order yet.</p>';
  } catch { /* ignore — the chat still works */ }
}

async function send(e) {
  if (e.preventDefault) e.preventDefault();
  const t = box.value.trim();
  if (!t) return false;
  box.value = '';
  add('customer', t);
  const wait = document.createElement('div');
  wait.className = 'typing';
  wait.textContent = 'the agent is thinking…';
  chat.appendChild(wait);
  chat.scrollTop = chat.scrollHeight;

  try {
    const r = await fetch('/webhook/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: num(), To: TO, Body: t, Channel: 'web' }),
    });
    const xml = await r.text();
    const msg = new DOMParser().parseFromString(xml, 'text/xml').querySelector('Message');
    wait.remove();
    if (msg && msg.textContent.trim()) add('agent', msg.textContent);
    else add('customer', '(the agent stayed silent — this thread belongs to the owner)').className = 'note';
  } catch (err) {
    wait.remove();
    add('customer', 'Network error: ' + err.message).className = 'note';
  }
  refresh();
  return false;
}
refresh();
</script>
</body></html>`);
});
