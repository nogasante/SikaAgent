import express from "express";
import { db } from "../lib/db.js";
import { esc, ar, waFormat } from "../lib/util.js";
import { ADMIN_PASSWORD } from "../lib/env.js";
import { requireAuth, setSessionCookie, clearSessionCookie, sessionPayload } from "./session.js";
import { page, loginPage, pill, empty, money } from "./theme.js";

export const adminAuth = express.Router();   // unauthenticated: login/logout
export const admin = express.Router();       // everything behind requireAuth

const form = express.urlencoded({ extended: false });
const phone = (n) => esc(String(n ?? "").replace("whatsapp:", ""));

// ---------- auth ----------
adminAuth.get("/admin/login", (req, res) => res.type("html").send(loginPage(!!req.query.err)));

adminAuth.post("/admin/login", form, (req, res) => {
  if (!ADMIN_PASSWORD || req.body.password !== ADMIN_PASSWORD) return res.redirect("/admin/login?err=1");
  setSessionCookie(req, res, sessionPayload());
  res.redirect("/admin");
});

adminAuth.post("/admin/logout", (_req, res) => {
  clearSessionCookie(res);
  res.redirect("/admin/login");
});

admin.use(requireAuth);

// ---------- live updates ----------
// The panel is server-rendered, so pages would otherwise stay frozen until a
// manual reload. Clients poll this for a cheap change signature and refresh only
// when something actually moved. Polling rather than Supabase Realtime keeps the
// service-role key server-side and needs no client library.
admin.get("/pulse", ar(async (_req, res) => {
  const newest = (table) =>
    db.from(table).select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle();

  const [msg, ord, esc, paid, open] = await Promise.all([
    newest("messages"), newest("orders"), newest("escalations"),
    // Status flips (pending -> paid) don't touch created_at, so count them too.
    db.from("orders").select("id", { count: "exact", head: true }).eq("status", "paid"),
    db.from("escalations").select("id", { count: "exact", head: true }).eq("resolved", false),
  ]);

  res.set("Cache-Control", "no-store").json({
    v: [
      msg.data?.created_at ?? "", ord.data?.created_at ?? "", esc.data?.created_at ?? "",
      paid.count ?? 0, open.count ?? 0,
    ].join("|"),
  });
}));

// ---------- dashboard ----------
admin.get("/", ar(async (_req, res) => {
  const { data: vendors } = await db.from("vendors").select("*").order("created_at", { ascending: false });
  const list = vendors ?? [];

  const stats = await Promise.all(list.map(async (v) => {
    const [{ data: paid }, { count: convos }, { count: escs }] = await Promise.all([
      db.from("orders").select("amount").eq("vendor_id", v.id).eq("status", "paid"),
      db.from("conversations").select("id", { count: "exact", head: true }).eq("vendor_id", v.id),
      db.from("escalations").select("id", { count: "exact", head: true }).eq("vendor_id", v.id).eq("resolved", false),
    ]);
    return {
      revenue: (paid ?? []).reduce((s, o) => s + o.amount, 0),
      orders: (paid ?? []).length,
      convos: convos ?? 0,
      escs: escs ?? 0,
    };
  }));

  const revenue = stats.reduce((s, x) => s + x.revenue, 0);
  const orders = stats.reduce((s, x) => s + x.orders, 0);
  const convos = stats.reduce((s, x) => s + x.convos, 0);
  const escs = stats.reduce((s, x) => s + x.escs, 0);

  // Adding figures across currencies would produce a number that means nothing,
  // so a combined total is only shown when every shop shares one.
  const currencies = new Set(list.map((v) => v.currency || "GHS"));
  const one = currencies.size <= 1 ? ([...currencies][0] || "GHS") : null;
  const totalRevenue = one ? money(revenue, one) : "—";
  const revenueHint = one ? "by the agent, all time" : `across ${currencies.size} currencies — see each shop`;
  const avgOrder = one && orders ? `avg ${money(Math.round(revenue / orders), one)}` : orders ? `${orders} paid` : "none yet";

  const rows = list.map((v, i) => `
<tr class="link" onclick="location='/admin/vendors/${v.id}'">
  <td class="strong"><a class="rowlink" href="/admin/vendors/${v.id}">${esc(v.shop_name)}</a></td>
  <td class="sub" data-l="Owner">${esc(v.owner_name)}</td>
  <td class="sub" data-l="City">${esc(v.city || "—")}</td>
  <td class="num r strong" data-l="Revenue">${money(stats[i].revenue, v.currency)}</td>
  <td class="num r sub" data-l="Paid orders">${stats[i].orders}</td>
  <td class="num r sub" data-l="Chats">${stats[i].convos}</td>
  <td class="num r" data-l="Escalations">${stats[i].escs ? `<span style="color:var(--bad)">${stats[i].escs}</span>` : `<span class="dim">0</span>`}</td>
  <td class="r" data-l="Status">${pill(v.active ? "good" : "", v.active ? "Active" : "Inactive")}</td>
</tr>`).join("");

  res.type("html").send(page("Vendors", `
<div class="head">
  <div><h1>Vendors</h1><p class="sub">${list.length} shop${list.length === 1 ? "" : "s"} running on Sika Agent</p></div>
  <a class="btn" href="/admin/vendors/new">Add vendor</a>
</div>

<div class="kpis">
  <div class="kpi"><div class="stat-label">Revenue collected</div><div class="hero">${totalRevenue}</div><div class="hint">${revenueHint}</div></div>
  <div class="kpi"><div class="stat-label">Paid orders</div><div class="stat">${orders}</div><div class="hint">${avgOrder}</div></div>
  <div class="kpi"><div class="stat-label">Conversations</div><div class="stat">${convos}</div><div class="hint">handled end to end</div></div>
  <div class="kpi"><div class="stat-label">Escalations</div><div class="stat${escs ? "" : " q"}" ${escs ? 'style="color:var(--bad)"' : ""}>${escs}</div><div class="hint">${escs ? "waiting on an owner" : "nothing waiting"}</div></div>
</div>

${list.length ? `<div class="tablewrap"><table>
<thead><tr><th>Shop</th><th>Owner</th><th>City</th><th class="r">Revenue</th><th class="r">Paid</th><th class="r">Chats</th><th class="r">Esc.</th><th class="r">Status</th></tr></thead>
<tbody>${rows}</tbody></table></div>`
    : empty("No vendors yet", "Add your first shop to put the agent to work.")}`,
    { active: "dashboard" }));
}));

// ---------- vendor create / edit ----------
// ISO 4217 straight from the platform — no dependency, no list to go stale.
// The shops we serve are clustered in a few markets, so those lead.
const COMMON_CURRENCIES = ["GHS", "NGN", "XOF", "KES", "ZAR", "USD", "EUR", "GBP"];

const CURRENCY_OPTIONS = (() => {
  const names = new Intl.DisplayNames(["en"], { type: "currency" });
  const all = typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("currency")
    : COMMON_CURRENCIES;
  const label = (c) => {
    const n = names.of(c);
    return esc(n && n !== c ? `${c} — ${n}` : c);
  };
  const common = COMMON_CURRENCIES.filter((c) => all.includes(c));
  const rest = all.filter((c) => !common.includes(c));
  return { common: common.map((c) => [c, label(c)]), rest: rest.map((c) => [c, label(c)]) };
})();

const VALID_CURRENCIES = new Set([...CURRENCY_OPTIONS.common, ...CURRENCY_OPTIONS.rest].map(([c]) => c));

function currencySelect(selected = "GHS") {
  const opt = ([code, label]) =>
    `<option value="${code}"${code === selected ? " selected" : ""}>${label}</option>`;
  return `<select name="currency">
    <optgroup label="Common">${CURRENCY_OPTIONS.common.map(opt).join("")}</optgroup>
    <optgroup label="All currencies">${CURRENCY_OPTIONS.rest.map(opt).join("")}</optgroup>
  </select>`;
}

/** Reject anything not a real ISO code so a typo can't become a price prefix. */
const cleanCurrency = (v) => {
  const c = String(v || "").trim().toUpperCase();
  return VALID_CURRENCIES.has(c) ? c : "GHS";
};

function vendorForm(v = {}, action = "/admin/vendors") {
  const val = (k) => esc(v[k] ?? "");
  return `<form method="post" action="${action}">
<div class="card pad">
  <div class="grid c2">
    <div class="field"><label>Shop name</label><input name="shop_name" required value="${val("shop_name")}"></div>
    <div class="field"><label>Owner name</label><input name="owner_name" required value="${val("owner_name")}"></div>
    <div class="field"><label>Owner WhatsApp</label><input name="owner_phone" required placeholder="+233XXXXXXXXX" value="${phone(v.owner_phone)}"></div>
    <div class="field"><label>Business line (Twilio)</label><input name="twilio_number" required placeholder="+1415XXXXXXX" value="${phone(v.twilio_number)}"></div>
    <div class="field"><label>City</label><input name="city" placeholder="e.g. Accra" value="${val("city")}"></div>
    <div class="field"><label>Currency</label>${currencySelect(v.currency || "GHS")}</div>
    <div class="field"><label>Mode</label><select name="is_demo">
      <option value="">Live — real Paystack payments</option>
      <option value="1" ${v.is_demo ? "selected" : ""}>Demo — simulated payments</option>
    </select></div>
  </div>
  <div class="field"><label>Delivery note — the agent quotes this verbatim</label>
    <textarea name="delivery_note" rows="2" placeholder="e.g. in-town 20, nearby suburb 25, next-day delivery">${val("delivery_note")}</textarea></div>
  <div class="field"><label>Tone note — how the agent should sound</label>
    <textarea name="tone_note" rows="2" placeholder="warm, uses emojis, light pidgin ok">${val("tone_note")}</textarea></div>
  ${v.id ? `<div class="field"><label>Status</label><select name="active">
    <option value="1" ${v.active ? "selected" : ""}>Active — agent answers customers</option>
    <option value="" ${!v.active ? "selected" : ""}>Inactive — line is off</option></select></div>` : ""}
  <button class="btn" type="submit">${v.id ? "Save changes" : "Create vendor"}</button>
</div></form>`;
}

admin.get("/vendors/new", ar(async (_req, res) => {
  res.type("html").send(page("Add vendor", `
<div class="head"><div><h1>Add vendor</h1><p class="sub">The agent answers only from what you enter here.</p></div>
<a class="btn ghost" href="/admin">Cancel</a></div>
${vendorForm()}`, { active: "dashboard" }));
}));

admin.post("/vendors", form, ar(async (req, res) => {
  const b = req.body;
  await db.from("vendors").insert({
    shop_name: b.shop_name, owner_name: b.owner_name,
    owner_phone: waFormat(b.owner_phone), twilio_number: waFormat(b.twilio_number),
    city: b.city || null, delivery_note: b.delivery_note || null, tone_note: b.tone_note || null,
    is_demo: !!b.is_demo,
  });
  res.redirect("/admin");
}));

admin.post("/vendors/:id/edit", form, ar(async (req, res) => {
  const b = req.body;
  await db.from("vendors").update({
    shop_name: b.shop_name, owner_name: b.owner_name,
    owner_phone: waFormat(b.owner_phone), twilio_number: waFormat(b.twilio_number),
    city: b.city || null, delivery_note: b.delivery_note || null, tone_note: b.tone_note || null,
    is_demo: !!b.is_demo, active: !!b.active,
  }).eq("id", req.params.id);
  res.redirect(`/admin/vendors/${req.params.id}`);
}));

// orders/escalations carry no ON DELETE CASCADE, so clear them before the vendor row
admin.post("/vendors/:id/delete", ar(async (req, res) => {
  const { id } = req.params;
  await db.from("agent_logs").delete().eq("vendor_id", id);
  await db.from("escalations").delete().eq("vendor_id", id);
  await db.from("orders").delete().eq("vendor_id", id);
  await db.from("vendors").delete().eq("id", id); // products/conversations/messages cascade
  res.redirect("/admin");
}));

// ---------- vendor detail ----------
admin.get("/vendors/:id", ar(async (req, res) => {
  const { id } = req.params;
  const [{ data: vendor }, { data: products }, { data: convos }, { data: zones }] = await Promise.all([
    db.from("vendors").select("*").eq("id", id).single(),
    db.from("products").select("*").eq("vendor_id", id).order("created_at", { ascending: true }),
    db.from("conversations").select("*").eq("vendor_id", id).order("created_at", { ascending: false }),
    db.from("delivery_zones").select("*").eq("vendor_id", id).order("fee", { ascending: true }),
  ]);
  if (!vendor) return res.status(404).type("html").send(page("Not found", `<h1>Vendor not found</h1>`));

  const withLast = await Promise.all((convos ?? []).map(async (c) => {
    const [{ data: last }, { count: msgs }] = await Promise.all([
      db.from("messages").select("role, content, created_at")
        .eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      db.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", c.id),
    ]);
    return { ...c, last, msgs: msgs ?? 0 };
  }));

  const productRows = (products ?? []).map((p) => `
<tr>
  <td class="strong">${esc(p.name)}</td>
  <td class="num r" data-l="Price">${money(p.price, vendor.currency)}</td>
  <td class="sub" data-l="Options">${esc(p.options || "—")}</td>
  <td data-l="Stock">${pill(p.in_stock ? "good" : "bad", p.in_stock ? "In stock" : "Out of stock")}</td>
  <td class="r"><div class="acts">
    <form class="inline" method="post" action="/admin/vendors/${id}/products/${p.id}/toggle"><button class="btn ghost sm" type="submit">${p.in_stock ? "Mark out" : "Mark in"}</button></form>
    <form class="inline" method="post" action="/admin/vendors/${id}/products/${p.id}/delete" onsubmit="return confirm('Remove ${esc(p.name).replace(/'/g, "\\'")} from the catalog?')"><button class="btn danger sm" type="submit">Remove</button></form>
  </div></td>
</tr>`).join("");

  const when = (d) => {
    if (!d) return "—";
    const mins = Math.floor((Date.now() - new Date(d)) / 60000);
    if (mins < 60) return `${Math.max(mins, 0)}m`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h`;
    return `${Math.floor(mins / 1440)}d`;
  };

  const convoRows = withLast.map((c) => `
<tr class="link" onclick="location='/admin/vendors/${id}/conversations/${c.id}'">
  <td class="strong"><a class="rowlink" href="/admin/vendors/${id}/conversations/${c.id}">${phone(c.customer_number)}</a></td>
  <td class="sub" data-l="Last"><span class="trunc">${c.last?.content?.trim()
    ? `<span class="dim">${esc(c.last.role)}:</span> ${esc(c.last.content)}`
    : `<span class="dim">${c.msgs ? "blank reply recorded" : "no messages"}</span>`}</span></td>
  <td class="num r sub" data-l="Messages">${c.msgs}</td>
  <td class="num r sub" data-l="Age">${when(c.last?.created_at ?? c.created_at)}</td>
  <td class="r" data-l="AI">${c.ai_paused ? pill("bad", "Paused") : pill("good", "Live")}</td>
</tr>`).join("");

  const paused = withLast.filter((c) => c.ai_paused).length;
  const inStock = (products ?? []).filter((p) => p.in_stock).length;

  res.type("html").send(page(vendor.shop_name, `
<div class="head">
  <div>
    <h1>${esc(vendor.shop_name)}</h1>
    <p class="sub">${esc(vendor.owner_name)} · ${phone(vendor.owner_phone)} · line ${phone(vendor.twilio_number)}</p>
  </div>
  <div class="actions">
    <a class="btn ghost" href="/admin/orders?vendor_id=${id}">Orders</a>
    <form class="inline" method="post" action="/admin/vendors/${id}/delete" onsubmit="return confirm('Delete ${esc(vendor.shop_name).replace(/'/g, "\\'")} along with its products, conversations and orders? This cannot be undone.')"><button class="btn danger" type="submit">Delete</button></form>
  </div>
</div>

<div class="kpis k3">
  <div class="kpi"><div class="stat-label">Catalog</div><div class="stat">${(products ?? []).length}</div><div class="hint">${inStock} in stock</div></div>
  <div class="kpi"><div class="stat-label">Conversations</div><div class="stat">${withLast.length}</div><div class="hint">${paused ? `${paused} paused` : "all AI-handled"}</div></div>
  <div class="kpi"><div class="stat-label">Mode</div><div class="stat">${vendor.is_demo ? "Demo" : "Live"}</div><div class="hint">${vendor.is_demo ? "simulated payments" : "real Paystack payments"}</div></div>
</div>

<div class="split">
<div>
  <h2>Catalog</h2>
  ${(products ?? []).length ? `<div class="tablewrap">
  <table><thead><tr><th>Product</th><th class="r">Price</th><th>Options</th><th>Stock</th><th></th></tr></thead>
  <tbody>${productRows}</tbody></table></div>` : empty("Catalog is empty", "The agent can only sell what you list here.")}

  <div class="card pad" style="margin-top:8px">
  <form method="post" action="/admin/vendors/${id}/products">
    <div class="grid c2">
      <div class="field"><label>Product name</label><input name="name" required placeholder="what you are selling"></div>
      <div class="field"><label>Price (${esc(vendor.currency || "GHS")})</label><input name="price" type="number" min="0" required placeholder="0"></div>
      <div class="field"><label>Options</label><input name="options" placeholder="sizes, flavours, shades…"></div>
      <div class="field"><label>Notes for the agent</label><input name="notes" placeholder="best seller"></div>
    </div>
    <button class="btn" type="submit">Add product</button>
  </form>
  </div>

  <h2>Delivery zones</h2>
  ${(zones ?? []).length ? `<div class="tablewrap wide">
  <table><thead><tr><th>Place</th><th class="r">Fee</th><th>Arrives</th><th>Status</th><th></th></tr></thead>
  <tbody>${(zones ?? []).map((z) => `
  <tr>
    <td class="strong">${esc(z.name)}</td>
    <td class="num r" data-l="Fee">${money(z.fee, vendor.currency)}</td>
    <td class="sub" data-l="Arrives">${esc(z.eta || "—")}</td>
    <td data-l="Status">${pill(z.active ? "good" : "", z.active ? "Offered" : "Off")}</td>
    <td class="r"><div class="acts">
      <form class="inline" method="post" action="/admin/vendors/${id}/zones/${z.id}/toggle"><button class="btn ghost sm" type="submit">${z.active ? "Turn off" : "Turn on"}</button></form>
      <form class="inline" method="post" action="/admin/vendors/${id}/zones/${z.id}/delete" onsubmit="return confirm('Remove ${esc(z.name).replace(/'/g, "\\'")}?')"><button class="btn danger sm" type="submit">Remove</button></form>
    </div></td>
  </tr>`).join("")}</tbody></table></div>`
    : empty("No delivery zones", "Add them and the agent quotes exact fees instead of reading your note.")}

  <div class="card pad" style="margin-top:8px">
  <form method="post" action="/admin/vendors/${id}/zones">
    <div class="grid c3">
      <div class="field"><label>Place</label><input name="name" required placeholder="e.g. Accra"></div>
      <div class="field"><label>Fee (${esc(vendor.currency || "GHS")})</label><input name="fee" type="number" min="0" required placeholder="0"></div>
      <div class="field"><label>Arrives</label><input name="eta" placeholder="next day"></div>
    </div>
    <button class="btn" type="submit">Add zone</button>
  </form>
  </div>

  <h2>Conversations</h2>
  ${convoRows ? `<div class="tablewrap">
  <table><thead><tr><th>Customer</th><th>Last message</th><th class="r">Msgs</th><th class="r">Age</th><th class="r">AI</th></tr></thead>
  <tbody>${convoRows}</tbody></table></div>` : empty("No conversations yet", "Customer chats appear here as they come in.")}
</div>

<div class="side">
  <h2>Shop details</h2>
  ${vendorForm(vendor, `/admin/vendors/${id}/edit`)}
</div>
</div>`, { active: "dashboard" }));
}));

// ---------- delivery zones ----------
admin.post("/vendors/:id/zones", form, ar(async (req, res) => {
  const b = req.body;
  if (String(b.name || "").trim()) {
    await db.from("delivery_zones").insert({
      vendor_id: req.params.id,
      name: String(b.name).trim(),
      fee: Math.max(0, Math.round(Number(b.fee) || 0)),
      eta: String(b.eta || "").trim() || null,
    });
  }
  res.redirect(`/admin/vendors/${req.params.id}`);
}));

admin.post("/vendors/:vid/zones/:zid/toggle", ar(async (req, res) => {
  const { data: z } = await db.from("delivery_zones").select("active").eq("id", req.params.zid).maybeSingle();
  if (z) await db.from("delivery_zones").update({ active: !z.active }).eq("id", req.params.zid);
  res.redirect(`/admin/vendors/${req.params.vid}`);
}));

admin.post("/vendors/:vid/zones/:zid/delete", ar(async (req, res) => {
  await db.from("delivery_zones").delete().eq("id", req.params.zid);
  res.redirect(`/admin/vendors/${req.params.vid}`);
}));

// ---------- catalog mutations ----------
admin.post("/vendors/:id/products", form, ar(async (req, res) => {
  const b = req.body;
  await db.from("products").insert({
    vendor_id: req.params.id, name: b.name, price: Math.round(Number(b.price) || 0),
    options: b.options || null, notes: b.notes || null,
  });
  res.redirect(`/admin/vendors/${req.params.id}`);
}));

admin.post("/vendors/:vid/products/:pid/toggle", ar(async (req, res) => {
  const { data: p } = await db.from("products").select("in_stock").eq("id", req.params.pid).single();
  if (p) await db.from("products").update({ in_stock: !p.in_stock }).eq("id", req.params.pid);
  res.redirect(`/admin/vendors/${req.params.vid}`);
}));

admin.post("/vendors/:vid/products/:pid/delete", ar(async (req, res) => {
  await db.from("products").delete().eq("id", req.params.pid);
  res.redirect(`/admin/vendors/${req.params.vid}`);
}));

// ---------- conversation thread ----------
admin.get("/vendors/:vid/conversations/:cid", ar(async (req, res) => {
  const { vid, cid } = req.params;
  const [{ data: vendor }, { data: convo }, { data: messages }, { count: undelivered }] = await Promise.all([
    db.from("vendors").select("shop_name").eq("id", vid).single(),
    db.from("conversations").select("*").eq("id", cid).single(),
    db.from("messages").select("*").eq("conversation_id", cid).order("created_at", { ascending: true }),
    // Replies Twilio refused. Without this the thread reads as if the customer
    // was answered when nothing actually reached their phone.
    db.from("agent_logs").select("id", { count: "exact", head: true })
      .eq("conversation_id", cid).eq("action", "send_failed"),
  ]);
  if (!convo) return res.status(404).type("html").send(page("Not found", `<h1>Conversation not found</h1>`));

  const bubbles = (messages ?? []).map((m) =>
    `<div class="msg ${esc(m.role)}">${esc(m.content)}<span class="at">${new Date(m.created_at).toLocaleString()}</span></div>`
  ).join("");

  res.type("html").send(page("Conversation", `
<div class="head">
  <div>
    <h1>${phone(convo.customer_number)}</h1>
    <p class="sub">${esc(vendor?.shop_name ?? "")} · ${(messages ?? []).length} message${(messages ?? []).length === 1 ? "" : "s"}</p>
  </div>
  <div class="actions">
    <a class="btn ghost" href="/admin/vendors/${vid}">Back</a>
    <form class="inline" method="post" action="/admin/vendors/${vid}/conversations/${cid}/pause">
      <button class="btn ${convo.ai_paused ? "" : "ghost"}" type="submit">${convo.ai_paused ? "Resume AI" : "Pause AI"}</button>
    </form>
  </div>
</div>
${convo.ai_paused ? `<div class="banner bad" style="margin-bottom:12px">AI is paused — this thread is yours until you resume it.</div>` : ""}
${undelivered ? `<div class="banner bad" style="margin-bottom:12px">${undelivered} repl${undelivered === 1 ? "y" : "ies"} below never reached the customer — Twilio rejected the send. Check the Twilio console for the reason (a trial account caps at 50 messages a day).</div>` : ""}
${bubbles ? `<div class="card pad"><div class="thread">${bubbles}</div></div>` : empty("No messages yet")}`,
    { active: "dashboard" }));
}));

admin.post("/vendors/:vid/conversations/:cid/pause", ar(async (req, res) => {
  const { cid, vid } = req.params;
  const { data: c } = await db.from("conversations").select("ai_paused").eq("id", cid).single();
  if (c) {
    const resuming = c.ai_paused;
    // Resuming means the operator handled whatever was escalated, so clear it
    // and start the AI's history window here — otherwise the exchange the
    // operator just settled keeps steering the agent's replies.
    await db.from("conversations")
      .update(resuming ? { ai_paused: false, ai_resumed_at: new Date().toISOString() } : { ai_paused: true })
      .eq("id", cid);
    if (resuming) {
      await db.from("escalations").update({ resolved: true }).eq("conversation_id", cid).eq("resolved", false);
    }
  }
  res.redirect(`/admin/vendors/${vid}/conversations/${cid}`);
}));

// ---------- escalations ----------
admin.get("/escalations", ar(async (req, res) => {
  const showAll = req.query.all === "1";
  let q = db.from("escalations")
    .select("*, vendors(shop_name), conversations(id, customer_number, ai_paused)")
    .order("created_at", { ascending: false }).limit(200);
  if (!showAll) q = q.eq("resolved", false);
  const { data } = await q;
  const list = data ?? [];

  const rows = list.map((e) => `
<tr>
  <td class="strong">${esc(e.reason || "needs owner")}</td>
  <td class="sub" data-l="Customer">${e.conversations
    ? `<a class="rowlink" href="/admin/vendors/${e.vendor_id}/conversations/${e.conversations.id}">${phone(e.conversations.customer_number)}</a>`
    : "—"}</td>
  <td class="sub" data-l="Shop">${esc(e.vendors?.shop_name || "—")}</td>
  <td class="num sub" data-l="Raised">${new Date(e.created_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
  <td data-l="AI">${e.conversations?.ai_paused ? pill("bad", "Paused") : pill("good", "Answering")}</td>
  <td class="r" data-l="">${e.resolved
    ? pill("good", "Resolved")
    : `<form class="inline" method="post" action="/admin/escalations/${e.id}/resolve"><button class="btn ghost sm" type="submit">Mark resolved</button></form>`}</td>
</tr>`).join("");

  res.type("html").send(page("Escalations", `
<div class="head">
  <div><h1>Escalations</h1><p class="sub">${showAll ? "every escalation ever raised" : "waiting on a human"}</p></div>
  <div class="actions">
    <a class="btn ghost" href="/admin/escalations${showAll ? "" : "?all=1"}">${showAll ? "Open only" : "Show resolved too"}</a>
    ${list.some((e) => !e.resolved)
      ? `<form class="inline" method="post" action="/admin/escalations/resolve-all" onsubmit="return confirm('Mark every open escalation as resolved?')"><button class="btn ghost" type="submit">Resolve all</button></form>`
      : ""}
  </div>
</div>
${list.length ? `<div class="tablewrap"><table>
<thead><tr><th>Reason</th><th>Customer</th><th>Shop</th><th>Raised</th><th>AI</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>`
  : empty("Nothing waiting", "The agent escalates when it needs a human — none open right now.")}`,
    { active: "escalations" }));
}));

admin.post("/escalations/:id/resolve", ar(async (req, res) => {
  await db.from("escalations").update({ resolved: true }).eq("id", req.params.id);
  res.redirect("/admin/escalations");
}));

admin.post("/escalations/resolve-all", ar(async (_req, res) => {
  await db.from("escalations").update({ resolved: true }).eq("resolved", false);
  res.redirect("/admin/escalations");
}));

// ---------- orders ----------
async function fetchOrders(vendorId) {
  let q = db.from("orders").select("*, vendors(shop_name, currency)").order("created_at", { ascending: false });
  if (vendorId) q = q.eq("vendor_id", vendorId);
  const { data } = await q;
  return data ?? [];
}

const TONE = { paid: "good", cancelled: "bad", pending: "" };

// Payment status belongs to the Paystack webhook — "paid" is never set by hand.
// The operator only owns cancelling and reopening.
const OPERATOR_STATUSES = new Set(["cancelled", "pending"]);

const backTo = (req) => {
  const v = String(req.body.back || "");
  return `/admin/orders${v ? `?vendor_id=${encodeURIComponent(v)}` : ""}`;
};

admin.post("/orders/:id/status", form, ar(async (req, res) => {
  const next = String(req.body.status || "");
  if (OPERATOR_STATUSES.has(next)) {
    await db.from("orders").update({ status: next }).eq("id", req.params.id);
  }
  res.redirect(backTo(req));
}));

// Fulfilment, tracked apart from payment so revenue totals stay intact.
admin.post("/orders/:id/delivered", form, ar(async (req, res) => {
  const { data: o } = await db.from("orders").select("delivered_at").eq("id", req.params.id).maybeSingle();
  if (o) {
    await db.from("orders")
      .update({ delivered_at: o.delivered_at ? null : new Date().toISOString() })
      .eq("id", req.params.id);
  }
  res.redirect(backTo(req));
}));

admin.get("/orders", ar(async (req, res) => {
  const vendorId = req.query.vendor_id || "";
  const orders = await fetchOrders(vendorId);
  const paid = orders.filter((o) => o.status === "paid");
  const revenue = paid.reduce((s, o) => s + o.amount, 0);
  const scope = vendorId ? (orders[0]?.vendors?.shop_name ?? "this vendor") : "all vendors";

  // Payment status is owned by the Paystack webhook, so the only transitions
  // offered here are the ones a human genuinely decides.
  const post = (id, path, fields, label, cls = "ghost") =>
    `<form class="inline" method="post" action="/admin/orders/${id}/${path}">${fields}<input type="hidden" name="back" value="${esc(vendorId)}"><button class="btn ${cls} sm" type="submit">${label}</button></form>`;
  const setStatus = (id, to, label, cls) => post(id, "status", `<input type="hidden" name="status" value="${to}">`, label, cls);

  const rows = orders.map((o) => `
<tr>
  <td><span class="trunc">${esc(o.summary || "—")}</span></td>
  <td class="num sub" data-l="Date">${new Date(o.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}</td>
  ${vendorId ? "" : `<td class="sub" data-l="Vendor">${esc(o.vendors?.shop_name || "—")}</td>`}
  <td class="num r strong" data-l="Amount">${money(o.amount, o.vendors?.currency)}</td>
  <td data-l="Status">${pill(TONE[o.status] ?? "", o.status[0].toUpperCase() + o.status.slice(1))}${
      o.delivered_at ? ` ${pill("good", "Delivered")}` : ""}</td>
  <td class="sub num" data-l="Reference" style="font-size:12px">${esc(o.payment_ref || "—")}</td>
  <td class="r" data-l=""><div class="acts">
    ${o.status === "paid" ? post(o.id, "delivered", "", o.delivered_at ? "Undo delivered" : "Mark delivered") : ""}
    ${o.status === "pending" ? setStatus(o.id, "cancelled", "Cancel", "danger") : ""}
    ${o.status === "cancelled" ? setStatus(o.id, "pending", "Reopen") : ""}
  </div></td>
</tr>`).join("");

  const pending = orders.filter((o) => o.status === "pending");
  const avg = paid.length ? Math.round(revenue / paid.length) : 0;
  // Same rule as the dashboard: never add amounts that aren't the same money.
  const cur = new Set(orders.map((o) => o.vendors?.currency || "GHS"));
  const one = cur.size <= 1 ? ([...cur][0] || "GHS") : null;

  res.type("html").send(page("Orders", `
<div class="head">
  <div><h1>Orders</h1><p class="sub">${esc(scope)}</p></div>
  <div class="actions">
    ${vendorId ? `<a class="btn ghost" href="/admin/orders">All vendors</a>` : ""}
    <a class="btn ghost" href="/admin/orders/export.csv${vendorId ? `?vendor_id=${vendorId}` : ""}">Export CSV</a>
  </div>
</div>

<div class="kpis">
  <div class="kpi"><div class="stat-label">Paid revenue</div><div class="hero">${one ? money(revenue, one) : "—"}</div><div class="hint">${one ? `${paid.length} paid order${paid.length === 1 ? "" : "s"}` : `${paid.length} paid across ${cur.size} currencies`}</div></div>
  <div class="kpi"><div class="stat-label">Average order</div><div class="stat">${one && paid.length ? money(avg, one) : "—"}</div><div class="hint">per paid sale</div></div>
  <div class="kpi"><div class="stat-label">Awaiting payment</div><div class="stat${pending.length ? "" : " q"}">${pending.length}</div><div class="hint">${pending.length && one ? money(pending.reduce((s, o) => s + o.amount, 0), one) + " outstanding" : pending.length ? "outstanding" : "nothing pending"}</div></div>
  <div class="kpi"><div class="stat-label">Conversion</div><div class="stat">${orders.length ? Math.round((paid.length / orders.length) * 100) + "%" : "—"}</div><div class="hint">of ${orders.length} order${orders.length === 1 ? "" : "s"} created</div></div>
</div>

${orders.length ? `<div class="tablewrap wide"><table>
<thead><tr><th>Summary</th><th>Date</th>${vendorId ? "" : "<th>Vendor</th>"}<th class="r">Amount</th><th>Status</th><th>Reference</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>` : empty("No orders yet", "Orders appear the moment the agent closes a sale.")}`,
    { active: "orders" }));
}));

admin.get("/orders/export.csv", ar(async (req, res) => {
  const orders = await fetchOrders(req.query.vendor_id || "");
  const cell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const header = "date,vendor,summary,amount_ghs,status,payment_ref,paid_at,delivered_at\n";
  const rows = orders.map((o) => [
    o.created_at, o.vendors?.shop_name || "", o.summary || "", o.amount, o.status,
    o.payment_ref || "", o.paid_at || "", o.delivered_at || "",
  ].map(cell).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="sika-orders${req.query.vendor_id ? "-" + req.query.vendor_id : ""}.csv"`);
  res.send(header + rows);
}));
