import express from "express";
import crypto from "node:crypto";
import { db, log } from "../lib/db.js";
import { sendWhatsApp, sendTemplate, templateSid, canSendOutbound } from "../lib/whatsapp.js";
import { gemini, buildSystem } from "../lib/gemini.js";
import { paystackLink } from "../lib/paystack.js";
import { PAYSTACK_SECRET, CRON_SECRET, CONTENT_SID_PAY_NOW, CONTENT_SID_DEMO_PAY,
         CONTENT_SID_CHOOSE_2, CONTENT_SID_CHOOSE_3 } from "../lib/env.js";
import { twiml, safeJson, money } from "../lib/util.js";

export const webhooks = express.Router();

// ---------- WhatsApp webhook ----------
// Twilio abandons a webhook after roughly 15s (error 11200) and a thinking model
// can spend longer than that on its own, before the Twilio calls a button needs.
// So WhatsApp traffic is acknowledged immediately and answered over the REST API
// once there's something to say. The /test cockpit still runs inline, because the
// browser is waiting on the reply and is happy to.
// One chain per (line, customer) so a customer sending three messages in a row
// is answered in order. Without it, concurrent runs read the same history and can
// duplicate an order or an escalation.
const chains = new Map();

function serialize(key, fn) {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  const settled = run.catch(() => {});
  chains.set(key, settled);
  settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
  return run;
}

webhooks.post("/webhook/whatsapp", express.urlencoded({ extended: false }), (req, res) => {
  const payload = { ...req.body };
  const key = `${payload.To ?? ""}|${payload.From ?? ""}`;

  // Without Twilio credentials every REST send 401s, so answering out of band
  // would drop the reply entirely. Fall back to replying in the webhook body,
  // which Twilio delivers for us — slower, but the customer hears back.
  const inline = payload.Channel === "web" || !canSendOutbound();
  if (!canSendOutbound()) {
    console.warn("TWILIO_ACCOUNT_SID/AUTH_TOKEN not set — replying via TwiML; buttons and owner alerts are unavailable");
  }

  if (inline) {
    const parts = [];
    serialize(key, () => handleInbound(payload, { web: true, collect: (t) => parts.push(t) }))
      .then(() => twiml(res, parts.join("\n\n")))
      .catch((e) => { console.error("inbound (inline) failed", e); twiml(res, "One moment please 🙏"); });
    return;
  }

  twiml(res, ""); // ack first: never let Twilio time out on us
  serialize(key, () => handleInbound(payload, { web: false }))
    .catch((e) => console.error("inbound failed", e));
});

async function handleInbound(payload, opts) {
  const from = payload.From ?? "";
  const to = payload.To ?? "";
  const body = (payload.Body ?? "").trim();
  // Set by a tapped quick-reply button; more reliable than matching the label.
  const buttonId = payload.ButtonPayload ?? "";
  const isWeb = !!opts.web;
  if (!from || !body) return;

  const { data: vendor } = await db.from("vendors").select("*").eq("twilio_number", to).eq("active", true).single();

  // Deliver a line to the customer: buffered for the cockpit, sent over REST on
  // WhatsApp (where the webhook response has already gone out).
  let convoId = null;
  const say = async (text) => {
    if (!text) return;
    if (isWeb) return void opts.collect(text);
    const ok = await sendWhatsApp(vendor?.twilio_number ?? to, from, text);
    // A rejected send is invisible to the customer AND to us unless we record
    // it — that is how a spent Twilio quota looked exactly like a broken agent.
    if (!ok && vendor) await log(vendor.id, convoId, "send_failed", { to: from, chars: text.length });
  };

  try {
    if (!vendor) return await say("This line is not active yet.");

    // Vendor console: owner messaging their own business line
    if (from === vendor.owner_phone) return await vendorConsole(say, vendor, body);

    // Upsert rather than select-then-insert: a customer firing off several
    // messages at once would otherwise have every request but the first lose the
    // race against the (vendor_id, customer_number) unique constraint.
    const { data: convo } = await db.from("conversations")
      .upsert({ vendor_id: vendor.id, customer_number: from },
              { onConflict: "vendor_id,customer_number" })
      .select().single();
    if (!convo) return;
    convoId = convo.id;
    await db.from("messages").insert({ conversation_id: convo.id, role: "customer", content: body });
    await log(vendor.id, convo.id, "received", { from, body });

    // Kill switch: vendor took over this thread — AI stays silent
    if (convo.ai_paused) return; // thread is the owner's — stay silent

    // Demo payment simulation — typed "PAID", or the Pay button tapped.
    if (vendor.is_demo && (/^paid$/i.test(body) || buttonId === "pay_now" || /^pay ghs/i.test(body))) {
      const { data: order } = await db.from("orders").select("*")
        .eq("conversation_id", convo.id).eq("status", "pending")
        .order("created_at", { ascending: false }).limit(1).single();
      if (order) {
        await db.from("orders").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", order.id);
        await log(vendor.id, convo.id, "payment_confirmed", { ref: order.payment_ref, amount: order.amount, demo: true });
        return await say(`Payment received 🎉 ${money(order.amount, vendor.currency)} — order confirmed!\n(${vendor.shop_name} demo)`);
      }
    }

    // Only read history since the owner last handed the thread back. Without
    // this, a resolved dispute keeps steering every later reply: the model sees
    // its own past escalation lines and escalates again, even for "hi".
    let historyQuery = db.from("messages").select("role, content").eq("conversation_id", convo.id);
    if (convo.ai_resumed_at) historyQuery = historyQuery.gte("created_at", convo.ai_resumed_at);

    const [{ data: products }, { data: history }, { data: pastOrders }] = await Promise.all([
      db.from("products").select("*").eq("vendor_id", vendor.id),
      historyQuery.order("created_at", { ascending: true }).limit(24),
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
      return await say(holding);
    }

    let reply = raw;
    let payNow = null; // deferred so the button lands after the prose

    // Tolerant matchers: allow whitespace/fences and grab the JSON object.
    const escalate = raw.match(/ACTION_ESCALATE\s*(\{[\s\S]*?\})/);
    const ord = raw.match(/ACTION_ORDER\s*(\{[\s\S]*?\})/);
    const choose = raw.match(/ACTION_CHOICES\s*(\{[\s\S]*?\})/);
    const menu = raw.match(/ACTION_MENU\s*(\{[\s\S]*?\})?/);

    // The catalog as a WhatsApp list message: one "View items" button that opens
    // a scrollable menu. Rows are fixed per template, so there is one template
    // per catalog size and we pick the matching one.
    let inStock = null;
    if (menu && !ord && !escalate && !choose) {
      inStock = (products ?? []).filter((p) => p.in_stock).slice(0, 10);
      if (inStock.length >= 2) reply = raw.slice(0, menu.index).trim();
      else inStock = null; // one item is not a menu
    }

    // A pick-one question becomes tappable buttons. Three is WhatsApp's limit for
    // an in-session template, and a label must stand alone because tapping sends
    // exactly that text back as the customer's next message.
    let choices = null;
    if (choose && !ord && !escalate) {
      const parsed = safeJson(choose[1])?.options;
      if (Array.isArray(parsed)) {
        const clean = parsed
          .map((o) => String(o ?? "").trim().slice(0, 20))
          .filter(Boolean)
          .slice(0, 3);
        if (clean.length >= 2) {
          reply = raw.slice(0, choose.index).trim();
          choices = clean;
        }
      }
    }

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

        // Buttons need the REST API (TwiML can't carry them), so on WhatsApp we
        // send the prose first, then the tappable prompt as its own message.
        // Env var wins if set; otherwise look the template up by name on Twilio.
        const contentSid = vendor.is_demo
          ? (CONTENT_SID_DEMO_PAY || await templateSid("sika_demo_pay"))
          : (CONTENT_SID_PAY_NOW || await templateSid("sika_pay_now"));
        const vars = vendor.is_demo
          ? { 1: String(order.amount), 2: order.summary || "your order" }
          : { 1: String(order.amount), 2: order.summary || "your order", 3: link };

        // The model re-emits ACTION_ORDER while the customer confirms, so don't
        // present the same order twice in a row. Time-boxed on purpose: a
        // customer who comes back later asking for the link should get it again,
        // not be told it can't be found.
        const { count: prompted } = await db.from("agent_logs")
          .select("id", { count: "exact", head: true })
          .eq("conversation_id", convo.id)
          .in("action", ["sent_pay_buttons", "sent_pay_text"])
          .eq("detail->>payment_ref", order.payment_ref)
          .gte("created_at", new Date(Date.now() - 3 * 60 * 1000).toISOString());

        if (prompted) {
          // Just sent it, so don't repeat the whole prompt — but always point at
          // it, since this branch also catches "where is my payment link?".
          await log(vendor.id, convo.id, "pay_prompt_skipped", { payment_ref: order.payment_ref });
          reply = `${reply ? reply + "\n\n" : ""}The payment link for ${money(order.amount, vendor.currency)} is just above ☝️`;
        } else if (isWeb || !contentSid) {
          // Cockpit (or no template available): the link goes inline as text.
          reply += `\n\nPay ${money(order.amount, vendor.currency)} securely here (MoMo or card):\n${link}`;
          await log(vendor.id, convo.id, "sent_pay_text", { payment_ref: order.payment_ref });
        } else {
          // Buttons need their own REST message, sent after the prose. If the
          // template is rejected, fall back to the link so the customer can
          // still pay.
          payNow = async () => {
            const sent = await sendTemplate(vendor.twilio_number, from, contentSid, vars);
            await log(vendor.id, convo.id, sent ? "sent_pay_buttons" : "sent_pay_text", { payment_ref: order.payment_ref });
            const record = sent
              ? `[Pay ${money(order.amount, vendor.currency)} button] ${order.summary || ""}`.trim()
              : `Pay ${money(order.amount, vendor.currency)} securely here (MoMo or card):\n${link}`;
            if (!sent) await say(record);
            await db.from("messages").insert({ conversation_id: convo.id, role: "agent", content: record });
          };
        }
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

    // Offer the choices as buttons where we can; everywhere else (the cockpit, or
    // no Twilio credentials) they become a numbered list so the question still
    // makes sense and the customer can just type the answer.
    // Separate templates per count: padding a two-option question into the
    // three-button template would show the same answer twice.
    let choiceSid = null;
    if (choices && !isWeb) {
      choiceSid = choices.length >= 3
        ? (CONTENT_SID_CHOOSE_3 || await templateSid("sika_choose_3"))
        : (CONTENT_SID_CHOOSE_2 || await templateSid("sika_choose_2"));
    }
    if (choices && !choiceSid) {
      reply += `\n\n${choices.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
    }

    const menuSid = inStock && !isWeb ? await templateSid(`sika_menu_${inStock.length}`) : null;
    if (inStock && !menuSid) {
      // No list message available — write the catalog out instead, so asking
      // "what do you sell?" is never answered with nothing.
      reply += `\n\n${inStock.map((p) => `*${p.name}* — ${money(p.price, vendor.currency)}`).join("\n")}`;
    }

    await db.from("messages").insert({ conversation_id: convo.id, role: "agent", content: reply });
    await log(vendor.id, convo.id, "replied", { chars: reply.length });

    if (menuSid) {
      // Rows are {{2}}/{{3}}, {{4}}/{{5}}, … — title then description per item.
      const vars = { 1: reply || "Here is what we have today" };
      inStock.forEach((p, i) => {
        vars[2 + i * 2] = p.name.slice(0, 24);
        vars[3 + i * 2] = `${money(p.price, vendor.currency)}${p.options ? ` · ${p.options}` : ""}`.slice(0, 72);
      });
      const sent = await sendTemplate(vendor.twilio_number, from, menuSid, vars);
      await log(vendor.id, convo.id, sent ? "sent_menu" : "menu_failed", { items: inStock.length });
      if (!sent) {
        await say(`${reply}\n\n${inStock.map((p) => `*${p.name}* — ${money(p.price, vendor.currency)}`).join("\n")}`);
      }
    } else if (choiceSid) {
      // The template carries the question itself, so it replaces the text reply
      // rather than following it — two copies of the same question reads badly.
      const vars = choices.length >= 3
        ? { 1: reply || "Please choose:", 2: choices[0], 3: choices[1], 4: choices[2] }
        : { 1: reply || "Please choose:", 2: choices[0], 3: choices[1] };
      const sent = await sendTemplate(vendor.twilio_number, from, choiceSid, vars);
      await log(vendor.id, convo.id, sent ? "sent_choices" : "choices_failed", { options: choices });
      if (!sent) await say(`${reply}\n\n${choices.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
    } else {
      await say(reply);
    }

    // The tappable prompt follows the prose so the conversation reads in order.
    if (payNow) await payNow();
  } catch (e) {
    console.error(e);
    await say("One moment please 🙏").catch(() => {});
  }
}

// Last line of defence against model scratchpad reaching a customer. The prompt
// forbids it, but this endpoint rejects thinkingConfig so it can happen, and a
// leak here is read by a real buyer.
function stripScaffolding(text) {
  let t = text;
  // Drop leading meta lines: "Drafting Response:", "**Analysis**", "Plan:" etc.
  t = t.replace(/^\s*(?:[*_#>\s-]*)(?:drafting|draft|response|reply|thinking|thought|analysis|plan|reasoning|answer)\b[^\n:]*:\s*/i, "");
  // A leaked draft is often wrapped in quotes or a bullet — unwrap a single one.
  // The trailing space matters: "* item" is a bullet, but "*item*" is WhatsApp
  // bold, and stripping that asterisk would break the formatting.
  t = t.replace(/^\s*[*\-•][ \t]+/, "");
  t = t.replace(/^\s*["“](.+)["”]\s*$/s, "$1");
  return t.trim();
}

// ---------- Vendor console (owner texts their own line) ----------
async function vendorConsole(say, vendor, body) {
  const pause = body.match(/^(pause|resume)\s+(\+?\d{9,15})$/i);
  if (pause) {
    const paused = pause[1].toLowerCase() === "pause";
    const cust = "whatsapp:" + (pause[2].startsWith("+") ? pause[2] : "+" + pause[2]);
    // Handing the thread back means the owner dealt with it: clear the
    // escalations and move the AI's history window past the resolved exchange.
    const { data: convo } = await db.from("conversations")
      .update(paused ? { ai_paused: true } : { ai_paused: false, ai_resumed_at: new Date().toISOString() })
      .eq("vendor_id", vendor.id).eq("customer_number", cust).select("id").maybeSingle();
    if (!paused && convo) {
      await db.from("escalations").update({ resolved: true })
        .eq("conversation_id", convo.id).eq("resolved", false);
    }
    await log(vendor.id, convo?.id ?? null, paused ? "paused" : "resumed", { customer: cust });
    return await say(paused
      ? `AI paused for ${pause[2]} — the thread is yours. Send "RESUME ${pause[2]}" when done.`
      : `AI resumed for ${pause[2]} ✅`);
  }
  if (/^report$/i.test(body)) return await say(await buildReport(vendor));
  return await say(
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
  return `☀️ ${vendor.shop_name} — today\n💰 ${money(cedis, vendor.currency)} collected (${(paid ?? []).length} orders)\n💬 ${msgs ?? 0} customer messages handled\n⚠️ ${escs ?? 0} passed to you\n\nYour AI never slept. — Sika Agent`;
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
        `Payment received 🎉 ${money(order.amount, v.currency)} confirmed.\n${order.summary}\n${v.shop_name} thanks you! 💕`);
      await sendWhatsApp(v.twilio_number, v.owner_phone,
        `💰 PAID: ${money(order.amount, v.currency)} — ${order.summary}\nCustomer: ${order.conversations.customer_number.replace("whatsapp:", "")}`);
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
