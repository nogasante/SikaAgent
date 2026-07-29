import { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } from "./env.js";

export async function sendWhatsApp(from, to, body) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  });
}
