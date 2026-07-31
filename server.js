// Sika Agent — AI sales closer for Ghanaian vendors on WhatsApp.
// Twilio (WhatsApp) -> Gemini (catalog-grounded) -> Paystack (MoMo/card) -> Supabase (state + logs)
//
//   lib/      supabase client, external service clients, shared helpers
//   routes/   WhatsApp + Paystack webhooks, cron, browser test cockpit
//   admin/    operator panel: session, design system, routes
import express from "express";
import { PORT } from "./lib/env.js";
import { webhooks } from "./routes/webhooks.js";
import { testCockpit } from "./routes/test.js";
import { adminAuth, admin } from "./admin/routes.js";
import { setup } from "./admin/setup.js";

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy — needed for req.secure on the session cookie
app.use(express.static("public", { maxAge: "1y", immutable: true }));

app.get("/", (_req, res) => res.send("Sika Agent is running."));

app.use(webhooks);
app.use(testCockpit);
app.use(adminAuth);
app.use("/admin", admin);
app.use("/admin", setup);

app.listen(PORT, () => console.log(`Sika Agent on :${PORT}`));
