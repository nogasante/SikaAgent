import { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } from "./env.js";

const auth = () =>
  "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

/**
 * Whether we can send messages ourselves. TwiML replies are delivered by Twilio
 * and need no credentials, so the app can run without these — but then every
 * REST send 401s. Callers use this to stay on the TwiML path instead of
 * dropping replies on the floor.
 */
export const canSendOutbound = () => Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);

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

// Resolve a template by its friendly_name so buttons work off a fresh deploy
// without anyone pasting SIDs into the environment. Cached after the first hit;
// a null result is cached too so a missing template costs one lookup, not one
// per message.
const sidCache = new Map();

export async function templateSid(friendlyName) {
  if (sidCache.has(friendlyName)) return sidCache.get(friendlyName);
  let sid = null;
  try {
    const res = await fetch("https://content.twilio.com/v1/Content?PageSize=100", {
      headers: { Authorization: auth() },
    });
    if (res.ok) {
      const { contents = [] } = await res.json();
      for (const c of contents) sidCache.set(c.friendly_name, c.sid);
      sid = sidCache.get(friendlyName) ?? null;
    } else {
      console.error("content template lookup failed", res.status);
    }
  } catch (e) {
    console.error("content template lookup error", e.message);
  }
  sidCache.set(friendlyName, sid);
  return sid;
}
