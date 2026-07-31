// Guided vendor setup.
//
// Onboarding used to be one long form, which is fine for someone who already
// knows what a "tone note" is and wrong for the person actually signing shops up.
// This asks one group of questions at a time, explains what each answer does to
// the agent's behaviour, and lets delivery zones and products be added in place
// so a shop is genuinely ready to sell by the last step.
import express from "express";
import { db } from "../lib/db.js";
import { esc, ar, waFormat, money } from "../lib/util.js";
import { page, empty } from "./theme.js";
import { requireAuth } from "./session.js";

export const setup = express.Router();
// Mounted alongside the admin router but a separate Router, so it needs its own
// guard — otherwise creating vendors would sit wide open on a public URL.
setup.use(requireAuth);

const form = express.urlencoded({ extended: false });

const STEPS = ["The shop", "Delivery", "What you sell"];

function steps(current) {
  return `<ol class="steps">${STEPS.map((label, i) => {
    const state = i < current ? "done" : i === current ? "on" : "";
    return `<li class="${state}">${i + 1}. ${esc(label)}</li>`;
  }).join("")}</ol>`;
}

const q = (label, help, control, required = false) => `
<div class="q">
  <label>${esc(label)}${required ? `<span class="req">*</span>` : ""}</label>
  ${help ? `<div class="help">${esc(help)}</div>` : ""}
  ${control}
</div>`;

// ---------- step 1: the shop ----------
setup.get("/setup", ar(async (_req, res) => {
  const { currencySelect } = await import("./routes.js");
  res.type("html").send(page("Set up a shop", `
<div class="wizard">
  ${steps(0)}
  <h1>Set up a shop</h1>
  <p class="sub">The agent only ever answers from what you enter here, so nothing you skip can be invented later.</p>

  <form method="post" action="/admin/setup">
    <div class="card pad" style="margin-top:20px">
      ${q("Shop name", "How the agent introduces itself to customers.",
          `<input name="shop_name" required autofocus placeholder="e.g. Adjoa's Closet">`, true)}
      ${q("Owner's name", "Used when the agent hands a chat over — “… will reply here shortly”.",
          `<input name="owner_name" required placeholder="e.g. Adjoa">`, true)}
      ${q("Owner's WhatsApp", "Where alerts go when a customer needs a human. Include the country code.",
          `<input name="owner_phone" required placeholder="+233XXXXXXXXX">`, true)}
      ${q("Business line", "The WhatsApp number customers message. This is the Twilio number, not the owner's personal one.",
          `<input name="twilio_number" required placeholder="+1415XXXXXXX">`, true)}
      ${q("City", "Only used to give the agent a sense of place.", `<input name="city" placeholder="e.g. Accra">`)}
      ${q("Currency", "Every price the agent quotes uses this.", currencySelect("GHS"), true)}
      ${q("Payments", "Demo shops simulate payment so you can show the flow without charging anyone.",
          `<select name="is_demo">
             <option value="">Live — real Paystack payments</option>
             <option value="1">Demo — simulated payments</option>
           </select>`)}
      ${q("How should it sound?", "Plain language works: “warm, brief, light pidgin is fine”. Leave blank for a neutral tone.",
          `<textarea name="tone_note" rows="2" placeholder="warm, brief, light pidgin is fine"></textarea>`)}
    </div>
    <div class="nav-row">
      <a class="btn ghost" href="/admin">Cancel</a>
      <button class="btn" type="submit">Continue to delivery</button>
    </div>
  </form>
</div>`, { active: "dashboard" }));
}));

setup.post("/setup", form, ar(async (req, res) => {
  const b = req.body;
  const { cleanCurrency } = await import("./routes.js");
  const { data: vendor } = await db.from("vendors").insert({
    shop_name: b.shop_name, owner_name: b.owner_name,
    owner_phone: waFormat(b.owner_phone), twilio_number: waFormat(b.twilio_number),
    city: b.city || null, tone_note: b.tone_note || null,
    currency: cleanCurrency(b.currency), is_demo: !!b.is_demo,
  }).select().single();
  if (!vendor) return res.redirect("/admin/setup?err=1");
  res.redirect(`/admin/setup/${vendor.id}/delivery`);
}));

// ---------- step 2: delivery ----------
setup.get("/setup/:id/delivery", ar(async (req, res) => {
  const { id } = req.params;
  const [{ data: vendor }, { data: zones }] = await Promise.all([
    db.from("vendors").select("*").eq("id", id).single(),
    db.from("delivery_zones").select("*").eq("vendor_id", id).order("fee", { ascending: true }),
  ]);
  if (!vendor) return res.redirect("/admin");
  const list = zones ?? [];

  res.type("html").send(page("Delivery", `
<div class="wizard">
  ${steps(1)}
  <h1>Where does ${esc(vendor.shop_name)} deliver?</h1>
  <p class="sub">The agent can only quote a fee for a place listed here. Anywhere else, it asks rather than guesses.</p>

  ${list.length ? `<div style="margin:20px 0 8px">${list.map((z) => `
    <div class="added">
      <span><b style="font-weight:510">${esc(z.name)}</b>${z.eta ? ` <span class="muted">· ${esc(z.eta)}</span>` : ""}</span>
      <span>${money(z.fee, vendor.currency)}
        <form class="inline" method="post" action="/admin/setup/${id}/delivery/${z.id}/delete" style="margin-left:8px">
          <button class="btn danger sm" type="submit">Remove</button></form>
      </span>
    </div>`).join("")}</div>`
    : `<div style="margin:20px 0 8px">${empty("No places yet", "Add at least one so the agent can complete an order.")}</div>`}

  <form method="post" action="/admin/setup/${id}/delivery">
    <div class="card pad">
      <div class="grid c3">
        <div class="field"><label>Place</label><input name="name" required placeholder="e.g. Accra" autofocus></div>
        <div class="field"><label>Fee (${esc(vendor.currency)})</label><input name="fee" type="number" min="0" required placeholder="0"></div>
        <div class="field"><label>Arrives</label><input name="eta" placeholder="next day"></div>
      </div>
      <button class="btn ghost" type="submit">Add this place</button>
    </div>
  </form>

  <div class="nav-row">
    <a class="btn ghost" href="/admin/setup">Back</a>
    <a class="btn" href="/admin/setup/${id}/catalog">${list.length ? "Continue to products" : "Skip for now"}</a>
  </div>
</div>`, { active: "dashboard" }));
}));

setup.post("/setup/:id/delivery", form, ar(async (req, res) => {
  const b = req.body;
  if (String(b.name || "").trim()) {
    await db.from("delivery_zones").insert({
      vendor_id: req.params.id,
      name: String(b.name).trim(),
      fee: Math.max(0, Math.round(Number(b.fee) || 0)),
      eta: String(b.eta || "").trim() || null,
    });
  }
  res.redirect(`/admin/setup/${req.params.id}/delivery`);
}));

setup.post("/setup/:id/delivery/:zid/delete", ar(async (req, res) => {
  await db.from("delivery_zones").delete().eq("id", req.params.zid);
  res.redirect(`/admin/setup/${req.params.id}/delivery`);
}));

// ---------- step 3: catalog ----------
setup.get("/setup/:id/catalog", ar(async (req, res) => {
  const { id } = req.params;
  const [{ data: vendor }, { data: products }] = await Promise.all([
    db.from("vendors").select("*").eq("id", id).single(),
    db.from("products").select("*").eq("vendor_id", id).order("created_at", { ascending: true }),
  ]);
  if (!vendor) return res.redirect("/admin");
  const list = products ?? [];

  res.type("html").send(page("What you sell", `
<div class="wizard">
  ${steps(2)}
  <h1>What does ${esc(vendor.shop_name)} sell?</h1>
  <p class="sub">This is the agent's only source of truth. It will refuse to sell anything that isn't here, which is the point.</p>

  ${list.length ? `<div style="margin:20px 0 8px">${list.map((p) => `
    <div class="added">
      <span><b style="font-weight:510">${esc(p.name)}</b>${p.options ? ` <span class="muted">· ${esc(p.options)}</span>` : ""}</span>
      <span>${money(p.price, vendor.currency)}
        <form class="inline" method="post" action="/admin/setup/${id}/catalog/${p.id}/delete" style="margin-left:8px">
          <button class="btn danger sm" type="submit">Remove</button></form>
      </span>
    </div>`).join("")}</div>`
    : `<div style="margin:20px 0 8px">${empty("Nothing listed yet", "Add your first item — the agent cannot sell without one.")}</div>`}

  <form method="post" action="/admin/setup/${id}/catalog">
    <div class="card pad">
      <div class="grid c2">
        <div class="field"><label>Item</label><input name="name" required placeholder="what you are selling" autofocus></div>
        <div class="field"><label>Price (${esc(vendor.currency)})</label><input name="price" type="number" min="0" required placeholder="0"></div>
        <div class="field"><label>Options</label><input name="options" placeholder="sizes, flavours, shades…"></div>
        <div class="field"><label>Anything the agent should know</label><input name="notes" placeholder="e.g. best seller"></div>
      </div>
      <button class="btn ghost" type="submit">Add this item</button>
    </div>
  </form>

  <div class="nav-row">
    <a class="btn ghost" href="/admin/setup/${id}/delivery">Back</a>
    <a class="btn" href="/admin/setup/${id}/done">${list.length ? "Finish" : "Skip for now"}</a>
  </div>
</div>`, { active: "dashboard" }));
}));

setup.post("/setup/:id/catalog", form, ar(async (req, res) => {
  const b = req.body;
  if (String(b.name || "").trim()) {
    await db.from("products").insert({
      vendor_id: req.params.id, name: String(b.name).trim(),
      price: Math.max(0, Math.round(Number(b.price) || 0)),
      options: b.options || null, notes: b.notes || null,
    });
  }
  res.redirect(`/admin/setup/${req.params.id}/catalog`);
}));

setup.post("/setup/:id/catalog/:pid/delete", ar(async (req, res) => {
  await db.from("products").delete().eq("id", req.params.pid);
  res.redirect(`/admin/setup/${req.params.id}/catalog`);
}));

// ---------- done ----------
setup.get("/setup/:id/done", ar(async (req, res) => {
  const { id } = req.params;
  const [{ data: vendor }, { count: products }, { count: zones }] = await Promise.all([
    db.from("vendors").select("*").eq("id", id).single(),
    db.from("products").select("id", { count: "exact", head: true }).eq("vendor_id", id),
    db.from("delivery_zones").select("id", { count: "exact", head: true }).eq("vendor_id", id),
  ]);
  if (!vendor) return res.redirect("/admin");

  // Say plainly what will and won't work rather than declaring success.
  const gaps = [
    !products && "no products, so it cannot sell anything yet",
    !zones && "no delivery zones, so it cannot quote a delivery fee",
  ].filter(Boolean);

  res.type("html").send(page("Ready", `
<div class="wizard">
  ${steps(3)}
  <h1>${esc(vendor.shop_name)} is set up</h1>
  <p class="sub">${products ?? 0} item${products === 1 ? "" : "s"} · ${zones ?? 0} delivery zone${zones === 1 ? "" : "s"} · ${esc(vendor.currency)}${vendor.is_demo ? " · demo payments" : ""}</p>

  ${gaps.length ? `<div class="banner bad" style="margin:20px 0">Still missing: ${gaps.join("; ")}.</div>` : ""}

  <div class="card pad" style="margin-top:20px">
    <h2 style="margin-top:0">Before customers arrive</h2>
    <p class="muted">Point this shop's Twilio number at
      <code>/webhook/whatsapp</code> on this server, then message the line and check the reply.
      ${vendor.is_demo ? "As a demo shop it simulates payment, so you can run the whole journey safely." : "Payments are live, so a real charge will be created."}</p>
  </div>

  <div class="nav-row">
    <a class="btn ghost" href="/admin/setup/${id}/catalog">Back</a>
    <div class="actions">
      ${vendor.is_demo ? `<a class="btn ghost" href="/test">Try it</a>` : ""}
      <a class="btn" href="/admin/vendors/${id}">Open the shop</a>
    </div>
  </div>
</div>`, { active: "dashboard" }));
}));
