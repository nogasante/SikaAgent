import { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } from "./env.js";

const auth = () =>
  "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

async function postMessage(params) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) console.error("twilio send failed", res.status, await res.text().catch(() => ""));
  return res.ok;
}

export const sendWhatsApp = (from, to, body) => postMessage({ From: from, To: to, Body: body });

/**
 * Send a Content template (buttons). TwiML cannot carry buttons, so anything
 * interactive has to go out over the REST API instead of the webhook response.
 * `variables` is a { "1": "…" } map matching the template's placeholders.
 */
export const sendTemplate = (from, to, contentSid, variables) =>
  postMessage({
    From: from, To: to,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify(variables),
  });
