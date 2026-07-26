# Sika Agent — Deploy Guide

Stack: **Cloud Run** (Google Cloud ✓) + **Gemini API** (LLM requirement ✓) + Twilio WhatsApp + Supabase + Paystack.

## 1. Supabase (10 min)
New project → SQL Editor → run `schema.sql`.

## 2. Seed your demo vendor (for you + the judges)
```sql
insert into vendors (shop_name, owner_name, owner_phone, twilio_number, city, delivery_note, tone_note, is_demo)
values ('Adjoa''s Closet (Demo)', 'Adjoa', 'whatsapp:+233YOURNUMBER', 'whatsapp:+14155238886', 'Accra',
        'Accra GHS 20, Madina GHS 25, next-day delivery', 'warm, light pidgin ok, uses emojis', true);

insert into products (vendor_id, name, price, options, notes)
select id, 'Ankara two-piece set', 250, 'S, M, L', 'best seller' from vendors where is_demo limit 1;
insert into products (vendor_id, name, price, options)
select id, 'Corset top', 120, 'S, M' from vendors where is_demo limit 1;
insert into products (vendor_id, name, price, options, in_stock)
select id, 'Denim maxi skirt', 180, '30-36', false from vendors where is_demo limit 1;
```
(The out-of-stock skirt and off-catalog questions are there to demo escalation.)

## 3. Google Cloud (20 min)
```bash
gcloud auth login
gcloud config set project <your-project>
gcloud run deploy sika-agent --source . --region europe-west1 --allow-unauthenticated \
  --set-env-vars SUPABASE_URL=...,SUPABASE_SERVICE_ROLE_KEY=...,GEMINI_API_KEY=...,PAYSTACK_SECRET=...,TWILIO_ACCOUNT_SID=...,TWILIO_AUTH_TOKEN=...,CRON_SECRET=<random>
```
Gemini key: aistudio.google.com. Copy the Cloud Run URL.

Daily reports: Cloud Scheduler → HTTP job, every day 19:00 →
`https://<cloud-run-url>/cron/daily-reports?key=<CRON_SECRET>`

## 4. Twilio (15 min + sender approval days)
- Sandbox now: "When a message comes in" → `https://<url>/webhook/whatsapp` (POST).
- Production: apply for WhatsApp senders (one number per vendor). Start today — approval takes days.

## 5. Paystack
Dashboard → Settings → Webhooks → `https://<url>/webhook/paystack`.
Payments are confirmed ONLY by this webhook — never by the customer saying "paid" (except demo vendors).

## Onboarding a real vendor (same-day, done-for-you)
1. Buy/assign a Twilio WhatsApp number for them.
2. `insert into vendors (...)` with their shop details, `is_demo=false`.
3. Insert their catalog into `products` (you type it in — that IS the service).
4. Vendor puts "📲 Order line: 0XX XXX XXXX" in their Instagram bio + WhatsApp status.
5. Vendor console (they text their own line): `PAUSE <number>`, `RESUME <number>`, `REPORT`.

## Judge testing instructions (paste into your Devpost submission)
> Message our demo shop on WhatsApp: +XXXXXXXX (join sandbox with "join <code>" if applicable).
> Try: "Is the Ankara two-piece available?" → agent quotes from live catalog.
> Confirm a size and delivery to Madina → agent creates an order and sends a payment link (demo mode: reply PAID to simulate; live vendors use real Paystack MoMo).
> Ask "can you do GHS 150?" or ask about the denim skirt → watch the agent escalate to the owner instead of inventing an answer.
> All agent decisions are logged continuously in our agent_logs table (export provided as evidence).

## What's deliberately NOT in v1
Month-end payment chaser (v1.1 cron), vendor self-serve dashboard (you are the dashboard), multi-language beyond English/pidgin.
