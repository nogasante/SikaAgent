// Escape for HTML attribute/text interpolation.
export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function twiml(res, text) {
  const safe = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${safe ? `<Message>${safe}</Message>` : ""}</Response>`,
  );
}

export function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// Normalise a phone number into Twilio's whatsapp:+E164 form.
export function waFormat(n) {
  n = String(n ?? "").trim();
  if (!n) return n;
  if (!n.startsWith("whatsapp:")) n = "whatsapp:" + (n.startsWith("+") ? n : "+" + n);
  return n;
}

// Wrap an async route so rejections reach Express' error handler.
export function ar(fn) { return (req, res, next) => fn(req, res, next).catch(next); }
