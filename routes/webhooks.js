import express from "express";
import crypto from "node:crypto";
import { db, log } from "../lib/db.js";
import { sendWhatsApp } from "../lib/whatsapp.js";
import { gemini, buildSystem } from "../lib/gemini.js";
import { paystackLink } from "../lib/paystack.js";
import { PAYSTACK_SECRET, CRON_SECRET } from "../lib/env.js";
import { twiml, safeJson } from "../lib/util.js";

export const webhooks = express.Router();

// ---------- WhatsApp webhook ----------
webhooks.post("/webhook/whatsapp", express.urlencoded({ extended: false }), async (req, res) => {
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

    const [{ data: products }, { data: history }, { data: pastOrders }] = await Promise.all([
      db.from("products").select("*").eq("vendor_id", vendor.id),
      db.from("messages").select("role, content").eq("conversation_id", convo.id)
        .order("created_at", { ascending: true }).limit(24),
      db.from("orders").select("summary, amount, status, paid_at, payment_ref")
        .eq("conversation_id", convo.id).order("created_at", { ascending: false }).limit(5),
    ]);

    const raw = await gemini(buildSystem(vendor, products ?? [], pastOrders ?? []), history ?? []);

    // Model unreachable (quota/outage) — say something neutral and keep the
    // thread live so the next message retries. Do NOT claim we misunderstood
    // them, and do NOT pause: a transient blip shouldn't freeze the chat.
    if (raw === null) {
      const holding = "One moment please 🙏";
      await db.from("messages").insert({ conversation_id: convo.id, role: "agent", content: holding });
      await log(vendor.id, convo.id, "model_unavailable", { from });
      return twiml(res, holding);
    }

    let reply = raw;

    // Tolerant matchers: allow whitespace/fences and grab the JSON object.
    const escalate = raw.match(/ACTION_ESCALATE\s*(\{[\s\S]*?\})/);
    const ord = raw.match(/ACTION_ORDER\s*(\{[\s\S]*?\})/);

    if (ord) {
      reply = raw.slice(0, ord.index).trim();
      const a = safeJson(ord[1]);
      if (a?.amount > 0) {
        const amount = Math.round(a.amount);

        // The model often re-emits ACTION_ORDER while the customer is still
        // confirming ("yes", "ok"). Reuse the open order for the same amount
        // instead of billing this conversation twice.
        const { data: open } = await db.from("orders").select("*")
          .eq("conversation_id", convo.id).eq("status", "pending").eq("amount", amount)
          .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())
          .order("created_at", { ascending: false }).limit(1).maybeSingle();

        let order = open;
        if (order) {
          await log(vendor.id, convo.id, "reused_order", { payment_ref: order.payment_ref, amount });
        } else {
          const payment_ref = `SIKA-${Date.now()}`;
          ({ data: order } = await db.from("orders").insert({
            vendor_id: vendor.id, conversation_id: convo.id,
            summary: a.summary, amount, payment_ref,
          }).select().single());
          await log(vendor.id, convo.id, "created_order", order);
        }
        const link = await paystackLink(order, vendor);
        await log(vendor.id, convo.id, "sent_payment_link", { payment_ref: order.payment_ref, link });
        reply += `\n\nPay GHS ${order.amount} securely here (MoMo or card):\n${link}`;
      }
    } else if (escalate) {
      reply = raw.slice(0, escalate.index).trim();
      const reason = safeJson(escalate[1])?.reason ?? "needs owner";
      const cust = from.replace("whatsapp:", "");

      // Was this thread already handed over? Used only to avoid re-alerting the
      // owner; the pause below is what actually stops the loop.
      const { data: prior } = await db.from("escalations").select("created_at")
        .eq("conversation_id", convo.id).eq("resolved", false)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const alertedRecently = prior && Date.now() - new Date(prior.created_at).getTime() < 30 * 60 * 1000;

      await db.from("escalations").insert({ vendor_id: vendor.id, conversation_id: convo.id, reason });
      await log(vendor.id, convo.id, "escalated", { reason });

      // Escalating means a human is required, so hand the thread over and go
      // quiet. Without this the agent keeps repeating its holding line to a
      // customer who is already angry, and re-alerts the owner every message.
      await db.from("conversations").update({ ai_paused: true }).eq("id", convo.id);
      await log(vendor.id, convo.id, "paused", { auto: true, reason });

      if (!alertedRecently) {
        await sendWhatsApp(vendor.twilio_number, vendor.owner_phone,
          `⚠️ ${vendor.shop_name}: ${cust} needs you — ${reason}\nThe AI has stopped replying on this chat, so please answer them directly.\nSend "RESUME ${cust}" to hand it back to the AI.`);
      }
    }

    // Safety net: strip ANY leftover ACTION_ remnant (even truncated) so it never reaches the customer.
    reply = reply.replace(/ACTION_[A-Z_]*[\s\S]*$/g, "").trim();
    reply = stripScaffolding(reply);
    // Deliberately makes no promise to "check and update" — nothing here sends a
    // follow-up, so promising one is how the agent ends up stalling a customer.
    if (!reply) reply = `Sorry, I didn't quite get that — could you put it another way? 🙏`;

    await db.from("messages").insert({ conversation_id: convo.id, role: "agent", content: reply });
    await log(vendor.id, convo.id, "replied", { chars: reply.length });
    return twiml(res, reply);
  } catch (e) {
    console.error(e);
    return twiml(res, "One moment please 🙏");
  }
});

// Last line of defence against model scratchpad reaching a customer. The prompt
// forbids it and thinkingBudget is 0, but a leak here is seen by a real buyer.
function stripScaffolding(text) {
  let t = text;
  // Drop leading meta lines: "Drafting Response:", "**Analysis**", "Plan:" etc.
  t = t.replace(/^\s*(?:[*_#>\s-]*)(?:drafting|draft|response|reply|thinking|thought|analysis|plan|reasoning|answer)\b[^\n:]*:\s*/i, "");
  // A leaked draft is often wrapped in quotes and bullets — unwrap a single one.
  t = t.replace(/^\s*[*\-•]\s*/, "");
  t = t.replace(/^\s*["“](.+)["”]\s*$/s, "$1");
  return t.trim();
}

// ---------- Vendor console (owner texts their own line) ----------
async function vendorConsole(res, vendor, body) {
  const pause = body.match(/^(pause|resume)\s+(\+?\d{9,15})$/i);
  if (pause) {
    const paused = pause[1].toLowerCase() === "pause";
    const cust = "whatsapp:" + (pause[2].startsWith("+") ? pause[2] : "+" + pause[2]);
    const { data: convo } = await db.from("conversations")
      .update({ ai_paused: paused })
      .eq("vendor_id", vendor.id).eq("customer_number", cust).select("id").maybeSingle();
    // Handing the thread back means the owner dealt with it.
    if (!paused && convo) {
      await db.from("escalations").update({ resolved: true })
        .eq("conversation_id", convo.id).eq("resolved", false);
    }
    await log(vendor.id, null, paused ? "paused" : "resumed", { customer: cust });
    return twiml(res, paused
      ? `AI paused for ${pause[2]} — the thread is yours. Send "RESUME ${pause[2]}" when done.`
      : `AI resumed for ${pause[2]} ✅`);
  }
  if (/^report$/i.test(body)) return twiml(res, await buildReport(vendor));
  return twiml(res,
    `${vendor.shop_name} console:\n• PAUSE <customer number> — take over a chat\n• RESUME <customer number>\n• REPORT — today's numbers`);
}

export async function buildReport(vendor) {
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
webhooks.post("/webhook/paystack", express.raw({ type: "*/*" }), async (req, res) => {
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

// ---------- Daily reports (scheduler hits this every evening) ----------
webhooks.get("/cron/daily-reports", async (req, res) => {
  if (req.query.key !== CRON_SECRET) return res.sendStatus(401);
  const { data: vendors } = await db.from("vendors").select("*").eq("active", true).eq("is_demo", false);
  for (const v of vendors ?? []) {
    await sendWhatsApp(v.twilio_number, v.owner_phone, await buildReport(v));
    await log(v.id, null, "daily_report", {});
  }
  res.json({ sent: (vendors ?? []).length });
});
