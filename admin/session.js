// Operator session: HMAC-signed cookie, no dependencies, no server-side store.
// Per-vendor logins later = add a `vendorId` claim here and scope queries by it.
import crypto from "node:crypto";
import { SESSION_SECRET } from "../lib/env.js";

const COOKIE = "sika_admin";
const MAX_AGE_S = 7 * 24 * 60 * 60;

export function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

export function parseCookies(req) {
  const h = req.headers.cookie;
  if (!h) return {};
  return Object.fromEntries(h.split(";").map((c) => {
    const i = c.indexOf("=");
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
}

export function setSessionCookie(req, res, payload) {
  const token = signSession(payload);
  res.setHeader("Set-Cookie",
    `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${MAX_AGE_S}; SameSite=Lax${req.secure ? "; Secure" : ""}`);
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

export function requireAuth(req, res, next) {
  const session = verifySession(parseCookies(req)[COOKIE]);
  if (!session) return res.redirect("/admin/login");
  req.session = session;
  next();
}

export const sessionPayload = () => ({ role: "operator", exp: Date.now() + MAX_AGE_S * 1000 });
