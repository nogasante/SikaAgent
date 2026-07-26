# Sika Agent 🇬🇭

**The AI that closes your sales while you sleep.**

Sika Agent is a done-for-you AI sales assistant for Ghanaian small vendors (fashion, beauty, food) who sell through WhatsApp and Instagram. It answers customers 24/7, quotes only from the vendor's real catalog, sends Paystack MoMo/card payment links the moment a customer confirms, verifies payments by webhook, escalates anything it shouldn't decide, and reports recovered revenue to the owner daily.

Built for the **Build with Gemini XPRIZE** — Small Business Services category.

## How AI runs the business
Every customer conversation is handled end-to-end by a Gemini-powered agent that decides, in production and continuously:
- how to answer (grounded strictly in the vendor's catalog — it never invents prices, stock, or discounts)
- when a sale is confirmed → creates the order and issues the payment link
- when NOT to decide → escalates to the owner (negotiations, out-of-catalog questions, upset customers)

Every decision is written to `agent_logs` with a timestamp — a continuous, auditable record of AI operating the business.

Humans (the founder) do: vendor sales/onboarding, catalog entry, quality spot-checks, and escalation handling support.

## Stack
- **Gemini API** (`gemini-flash-latest`) — the decision engine (LLM requirement ✓)
- **Google Cloud Run** — hosting (Google Cloud requirement ✓), plus Cloud Scheduler for daily reports
- **Twilio WhatsApp Business API** — messaging channel
- **Supabase** (Postgres) — vendors, catalogs, conversations, orders, logs
- **Paystack** — GHS payments (mobile money + card), webhook-verified

## Repo contents
- `server.js` — the entire agent: WhatsApp webhook, Gemini brain, vendor console, Paystack webhook, daily reports, and a browser test cockpit at `/test`
- `schema.sql` — database schema + indexes
- `Dockerfile`, `package.json` — Cloud Run deployment
- `DEPLOY.md` — full setup guide including demo-vendor seeding and judge testing instructions

## Try it (judges)
See the testing instructions in `DEPLOY.md`, or open the deployed `/test` URL provided in our Devpost submission — you can chat with the demo shop directly in your browser, watch it quote from a live catalog, place a simulated order, and see it refuse to hallucinate when asked about products it doesn't carry.

---
A Nogadex product · Accra, Ghana
