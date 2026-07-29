import express from "express";
import { db } from "../lib/db.js";
import { esc, ar, waFormat } from "../lib/util.js";
import { ADMIN_PASSWORD } from "../lib/env.js";
import { requireAuth, setSessionCookie, clearSessionCookie, sessionPayload } from "./session.js";
import { page, loginPage, pill, empty, ghs } from "./theme.js";

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

  const cards = list.map((v, i) => `
<a class="card" href="/admin/vendors/${v.id}">
  <div class="row top">
    <div>
      <div style="font-weight:510">${esc(v.shop_name)}</div>
      <div class="muted" style="margin-top:2px">${esc(v.owner_name)}${v.city ? " · " + esc(v.city) : ""}${v.is_demo ? " · demo" : ""}</div>
    </div>
    ${pill(v.active ? "good" : "", v.active ? "Active" : "Inactive")}
  </div>
  <div class="row" style="margin-top:14px">
    <div><span class="stat">${ghs(stats[i].revenue)}</span> <span class="muted">· ${stats[i].orders} paid</span></div>
    <div class="muted">${stats[i].convos} chat${stats[i].convos === 1 ? "" : "s"}${stats[i].escs ? ` · <span style="color:var(--bad)">${stats[i].escs} escalated</span>` : ""}</div>
  </div>
</a>`).join("");

  res.type("html").send(page("Vendors", `
<div class="head">
  <div><h1>Vendors</h1><p class="sub">${list.length} shop${list.length === 1 ? "" : "s"} running on Sika Agent</p></div>
  <a class="btn" href="/admin/vendors/new">Add vendor</a>
</div>

${list.length ? `
<div class="card pad" style="margin-bottom:8px">
  <div class="stat-label">Revenue collected by the AI</div>
  <div class="hero">${ghs(revenue)}</div>
  <div class="muted" style="margin-top:8px">${orders} paid order${orders === 1 ? "" : "s"} · ${convos} conversation${convos === 1 ? "" : "s"} handled${escs ? ` · ${escs} awaiting an owner` : ""}</div>
</div>
${cards}` : empty("No vendors yet", "Add your first shop to put the agent to work.")}`,
    { active: "dashboard" }));
}));

// ---------- vendor create / edit ----------
function vendorForm(v = {}, action = "/admin/vendors") {
  const val = (k) => esc(v[k] ?? "");
  return `<form method="post" action="${action}">
<div class="card pad">
  <div class="grid c2">
    <div class="field"><label>Shop name</label><input name="shop_name" required value="${val("shop_name")}"></div>
    <div class="field"><label>Owner name</label><input name="owner_name" required value="${val("owner_name")}"></div>
    <div class="field"><label>Owner WhatsApp</label><input name="owner_phone" required placeholder="+233XXXXXXXXX" value="${phone(v.owner_phone)}"></div>
    <div class="field"><label>Business line (Twilio)</label><input name="twilio_number" required placeholder="+1415XXXXXXX" value="${phone(v.twilio_number)}"></div>
    <div class="field"><label>City</label><input name="city" placeholder="Accra" value="${val("city")}"></div>
    <div class="field"><label>Mode</label><select name="is_demo">
      <option value="">Live — real Paystack payments</option>
      <option value="1" ${v.is_demo ? "selected" : ""}>Demo — simulated payments</option>
    </select></div>
  </div>
  <div class="field"><label>Delivery note — the agent quotes this verbatim</label>
    <textarea name="delivery_note" rows="2" placeholder="Accra GHS 20, Madina GHS 25, next-day delivery">${val("delivery_note")}</textarea></div>
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
  const [{ data: vendor }, { data: products }, { data: convos }] = await Promise.all([
    db.from("vendors").select("*").eq("id", id).single(),
    db.from("products").select("*").eq("vendor_id", id).order("created_at", { ascending: true }),
    db.from("conversations").select("*").eq("vendor_id", id).order("created_at", { ascending: false }),
  ]);
  if (!vendor) return res.status(404).type("html").send(page("Not found", `<h1>Vendor not found</h1>`));

  const withLast = await Promise.all((convos ?? []).map(async (c) => {
    const { data: last } = await db.from("messages").select("role, content")
      .eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    return { ...c, last };
  }));

  const productRows = (products ?? []).map((p) => `
<tr>
  <td style="color:var(--ink)">${esc(p.name)}</td>
  <td class="num">GHS ${p.price}</td>
  <td class="muted">${esc(p.options || "—")}</td>
  <td>${pill(p.in_stock ? "good" : "bad", p.in_stock ? "In stock" : "Out of stock")}</td>
  <td style="text-align:right">
    <form class="inline" method="post" action="/admin/vendors/${id}/products/${p.id}/toggle"><button class="btn ghost sm" type="submit">${p.in_stock ? "Mark out" : "Mark in"}</button></form>
    <form class="inline" style="margin-left:6px" method="post" action="/admin/vendors/${id}/products/${p.id}/delete" onsubmit="return confirm('Remove ${esc(p.name).replace(/'/g, "\\'")} from the catalog?')"><button class="btn danger sm" type="submit">Remove</button></form>
  </td>
</tr>`).join("");

  const convoCards = withLast.map((c) => `
<a class="card" href="/admin/vendors/${id}/conversations/${c.id}">
  <div class="row"><span style="font-weight:510">${phone(c.customer_number)}</span>${c.ai_paused ? pill("bad", "AI paused") : ""}</div>
  <div class="muted" style="margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.last ? `<span class="dim">${esc(c.last.role)}:</span> ${esc(c.last.content).slice(0, 110)}` : "No messages yet"}</div>
</a>`).join("");

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

<h2>Catalog</h2>
${(products ?? []).length ? `<div class="tablewrap">
<table><thead><tr><th>Product</th><th>Price</th><th>Options</th><th>Stock</th><th></th></tr></thead>
<tbody>${productRows}</tbody></table></div>` : empty("Catalog is empty", "The agent can only sell what you list here.")}

<div class="card pad" style="margin-top:8px">
<form method="post" action="/admin/vendors/${id}/products">
  <div class="grid c2">
    <div class="field"><label>Product name</label><input name="name" required placeholder="Ankara two-piece set"></div>
    <div class="field"><label>Price (GHS)</label><input name="price" type="number" min="0" required placeholder="250"></div>
    <div class="field"><label>Options</label><input name="options" placeholder="S, M, L"></div>
    <div class="field"><label>Notes for the agent</label><input name="notes" placeholder="best seller"></div>
  </div>
  <button class="btn" type="submit">Add product</button>
</form>
</div>

<h2>Conversations</h2>
${convoCards || empty("No conversations yet", "Customer chats will appear here as they come in.")}

<h2>Shop details</h2>
${vendorForm(vendor, `/admin/vendors/${id}/edit`)}`, { active: "dashboard" }));
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
  const [{ data: vendor }, { data: convo }, { data: messages }] = await Promise.all([
    db.from("vendors").select("shop_name").eq("id", vid).single(),
    db.from("conversations").select("*").eq("id", cid).single(),
    db.from("messages").select("*").eq("conversation_id", cid).order("created_at", { ascending: true }),
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
${bubbles ? `<div class="card pad"><div class="thread">${bubbles}</div></div>` : empty("No messages yet")}`,
    { active: "dashboard" }));
}));

admin.post("/vendors/:vid/conversations/:cid/pause", ar(async (req, res) => {
  const { data: c } = await db.from("conversations").select("ai_paused").eq("id", req.params.cid).single();
  if (c) await db.from("conversations").update({ ai_paused: !c.ai_paused }).eq("id", req.params.cid);
  res.redirect(`/admin/vendors/${req.params.vid}/conversations/${req.params.cid}`);
}));

// ---------- orders ----------
async function fetchOrders(vendorId) {
  let q = db.from("orders").select("*, vendors(shop_name)").order("created_at", { ascending: false });
  if (vendorId) q = q.eq("vendor_id", vendorId);
  const { data } = await q;
  return data ?? [];
}

const TONE = { paid: "good", cancelled: "bad", pending: "" };

admin.get("/orders", ar(async (req, res) => {
  const vendorId = req.query.vendor_id || "";
  const orders = await fetchOrders(vendorId);
  const paid = orders.filter((o) => o.status === "paid");
  const revenue = paid.reduce((s, o) => s + o.amount, 0);
  const scope = vendorId ? (orders[0]?.vendors?.shop_name ?? "this vendor") : "all vendors";

  const rows = orders.map((o) => `
<tr>
  <td class="num muted">${new Date(o.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}</td>
  ${vendorId ? "" : `<td>${esc(o.vendors?.shop_name || "—")}</td>`}
  <td class="wrap">${esc(o.summary || "—")}</td>
  <td class="num" style="color:var(--ink)">GHS ${o.amount}</td>
  <td>${pill(TONE[o.status] ?? "", o.status[0].toUpperCase() + o.status.slice(1))}</td>
  <td class="muted num">${esc(o.payment_ref || "—")}</td>
</tr>`).join("");

  res.type("html").send(page("Orders", `
<div class="head">
  <div><h1>Orders</h1><p class="sub">${esc(scope)}</p></div>
  <div class="actions">
    ${vendorId ? `<a class="btn ghost" href="/admin/orders">All vendors</a>` : ""}
    <a class="btn ghost" href="/admin/orders/export.csv${vendorId ? `?vendor_id=${vendorId}` : ""}">Export CSV</a>
  </div>
</div>

<div class="card pad" style="margin-bottom:8px">
  <div class="stat-label">Paid revenue</div>
  <div class="hero">${ghs(revenue)}</div>
  <div class="muted" style="margin-top:8px">${paid.length} paid of ${orders.length} order${orders.length === 1 ? "" : "s"}</div>
</div>

${orders.length ? `<div class="tablewrap"><table>
<thead><tr><th>Date</th>${vendorId ? "" : "<th>Vendor</th>"}<th>Summary</th><th>Amount</th><th>Status</th><th>Reference</th></tr></thead>
<tbody>${rows}</tbody></table></div>` : empty("No orders yet", "Orders appear the moment the agent closes a sale.")}`,
    { active: "orders" }));
}));

admin.get("/orders/export.csv", ar(async (req, res) => {
  const orders = await fetchOrders(req.query.vendor_id || "");
  const cell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const header = "date,vendor,summary,amount_ghs,status,payment_ref,paid_at\n";
  const rows = orders.map((o) => [
    o.created_at, o.vendors?.shop_name || "", o.summary || "", o.amount, o.status, o.payment_ref || "", o.paid_at || "",
  ].map(cell).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="sika-orders${req.query.vendor_id ? "-" + req.query.vendor_id : ""}.csv"`);
  res.send(header + rows);
}));
