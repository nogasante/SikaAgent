// Admin design system.
//
// Tokens follow the dark-first conventions used by Linear/Vercel-class tools:
// a near-black canvas where surfaces lift by luminance rather than decoration,
// borders expressed as low-alpha white, a 400/510/590 weight band, and ONE
// accent (Sika gold) spent sparingly on actions and the single hero figure.
// Status hues are reserved for state and never reused as accents.
import { esc } from "../lib/util.js";

export const CSS = `
/* Self-hosted so no visitor IP is handed to a third-party font CDN, and so the
   page needs no external request on a cold Render instance. */
@font-face{
  font-family:Inter; font-style:normal; font-weight:100 900; font-display:swap;
  src:url(/fonts/inter.woff2) format("woff2");
}
:root{
  --canvas:#08090a; --panel:#0f1011; --surface:#131416; --raised:#1a1b1e;
  --line:rgba(255,255,255,.07); --line-strong:rgba(255,255,255,.11); --wash:rgba(255,255,255,.03);
  --ink:#f7f8f8; --ink-2:#d0d6e0; --ink-3:#8a8f98; --ink-4:#62666d;
  --gold:#ffc33d; --gold-hi:#ffd268; --gold-dim:rgba(255,195,61,.13);
  --good:#3fb950; --good-dim:rgba(63,185,80,.13);
  --bad:#f85149; --bad-dim:rgba(248,81,73,.13);
  --r-sm:4px; --r:6px; --r-card:8px; --r-panel:12px;
  --ease:cubic-bezier(.25,.46,.45,.94);
  --sidebar:248px;
}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  font-feature-settings:"cv01","ss03";
  background:var(--canvas); color:var(--ink); min-height:100dvh;
  font-size:14px; font-weight:400; line-height:1.5; letter-spacing:-.011em;
  -webkit-font-smoothing:antialiased;
}
a{color:inherit;text-decoration:none}
::selection{background:var(--gold-dim)}

/* ---- shell ---- */
.sidebar{
  position:fixed; inset:0 auto 0 0; width:var(--sidebar); background:var(--panel);
  border-right:1px solid var(--line); display:flex; flex-direction:column; padding:16px 12px; z-index:10;
}
.brand{display:flex;align-items:center;gap:9px;padding:6px 8px 18px;font-weight:590;letter-spacing:-.02em;font-size:15px}
.brand span{color:var(--ink-3);font-weight:400}
.nav{display:flex;flex-direction:column;gap:2px;flex:1}
.nav a{
  display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:var(--r);
  color:var(--ink-3); font-weight:510; font-size:13.5px; transition:color .15s var(--ease),background .15s var(--ease);
}
.nav a:hover{color:var(--ink-2);background:var(--wash)}
.nav a.on{color:var(--ink);background:var(--wash)}
.nav a.on .dot{background:var(--gold)}
.dot{width:5px;height:5px;border-radius:50%;background:var(--ink-4);flex:none;transition:background .15s var(--ease)}
.foot{margin-top:auto;padding-top:12px;border-top:1px solid var(--line);display:flex;align-items:center;gap:7px}
.foot form{margin-left:auto}
.livedot{width:6px;height:6px;border-radius:50%;background:var(--ink-4);flex:none;transition:background .3s}
.livedot[data-on="1"]{background:var(--good);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media(prefers-reduced-motion:reduce){.livedot[data-on="1"]{animation:none}}
main{margin-left:var(--sidebar);padding:28px 32px 72px;max-width:1320px}
@media(max-width:899px){
  /* Wraps rather than overflowing: the bar has to hold the brand, every nav
     item and the logout button on a 360px phone. */
  .sidebar{position:sticky;inset:0 0 auto 0;width:auto;flex-direction:row;align-items:center;gap:6px;
    flex-wrap:wrap;padding:10px 14px;border-right:0;border-bottom:1px solid var(--line);
    background:rgba(15,16,17,.9);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
  .brand{padding:0 8px 0 0;font-size:14px}
  .brand span{display:none} /* "Agent" is implied once you're inside */
  .nav{flex-direction:row;flex:1 1 auto;gap:2px;min-width:0;flex-wrap:wrap}
  .nav a{padding:7px 9px;font-size:13px}
  .foot{margin:0;padding:0;border:0;gap:6px}
  .foot .muted{display:none} /* the dot alone is enough on a phone */
  main{margin-left:0;padding:20px 16px 56px}
}

/* ---- type ---- */
h1{font-size:20px;font-weight:590;letter-spacing:-.022em;line-height:1.2}
h2{font-size:11px;font-weight:590;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);margin:32px 0 12px}
.sub{color:var(--ink-3);font-size:13px;margin-top:3px}
.muted{color:var(--ink-3);font-size:13px}
.dim{color:var(--ink-4)}

/* ---- surfaces ---- */
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);padding:16px}
.card + .card{margin-top:8px}
a.card{display:block;transition:background .15s var(--ease),border-color .15s var(--ease)}
a.card:hover{background:var(--raised);border-color:var(--line-strong)}
.pad{padding:20px}
.stack{display:flex;flex-direction:column;gap:8px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px}
.row.top{align-items:flex-start}
.head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.actions{display:flex;gap:8px;align-items:center}
.grid{display:grid;gap:8px;grid-template-columns:1fr}
@media(min-width:620px){.grid.c2{grid-template-columns:1fr 1fr}.grid.c3{grid-template-columns:repeat(3,1fr)}}

/* ---- KPI strip: one hero figure, the rest secondary ---- */
.kpis{display:grid;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--r-card);
  overflow:hidden;grid-template-columns:repeat(2,1fr);margin-bottom:20px}
@media(min-width:820px){.kpis{grid-template-columns:repeat(4,1fr)}.kpis.k3{grid-template-columns:repeat(3,1fr)}}
.kpi{background:var(--surface);padding:14px 16px 16px}
.kpi .stat-label{font-size:11.5px;color:var(--ink-3);letter-spacing:.03em;margin-bottom:8px}
.kpi .hint{font-size:12px;color:var(--ink-4);margin-top:6px}
/* Exactly one hero figure per view; proportional figures (no tabular-nums). */
.hero{font-size:38px;font-weight:590;letter-spacing:-.03em;line-height:1;color:var(--gold)}
.stat{font-size:24px;font-weight:590;letter-spacing:-.022em;line-height:1.15;color:var(--ink)}
.stat.q{color:var(--ink-3)}
.stat-label{font-size:12px;color:var(--ink-3);font-weight:400;margin-bottom:6px}

/* ---- two-column working layout ---- */
.split{display:grid;gap:20px;grid-template-columns:1fr;align-items:start}
/* Two columns only once the left one can still hold a full table without
   overflowing — below this the page stacks and tables take the full width. */
@media(min-width:1400px){.split{grid-template-columns:minmax(0,1.65fr) minmax(320px,1fr)}
  .split .side{position:sticky;top:24px}
  .split .side .grid.c2{grid-template-columns:1fr} /* too narrow for pairs */}
.split h2:first-child{margin-top:0}

/* ---- controls ---- */
.btn{
  display:inline-flex;align-items:center;gap:6px;background:var(--gold);color:#1c1608;border:1px solid transparent;
  border-radius:var(--r);padding:8px 14px;font:inherit;font-size:13px;font-weight:590;letter-spacing:-.006em;
  cursor:pointer;white-space:nowrap;transition:background .15s var(--ease),border-color .15s var(--ease),color .15s var(--ease);
}
.btn:hover{background:var(--gold-hi)}
.btn.ghost{background:transparent;border-color:var(--line-strong);color:var(--ink-2)}
.btn.ghost:hover{background:var(--wash);color:var(--ink)}
.btn.danger{background:transparent;border-color:var(--line-strong);color:var(--ink-3)}
.btn.danger:hover{background:var(--bad-dim);border-color:var(--bad);color:var(--bad)}
.btn.sm{padding:5px 10px;font-size:12px}
.btn:focus-visible,a:focus-visible{outline:none;box-shadow:0 0 0 2px rgba(255,195,61,.45),0 0 0 4px rgba(255,195,61,.18)}
form.inline{display:inline-flex}

label{display:block;font-size:12px;color:var(--ink-3);margin-bottom:6px;font-weight:400}
input,select,textarea{
  width:100%;background:var(--canvas);border:1px solid var(--line-strong);border-radius:var(--r);
  color:var(--ink);padding:9px 11px;font:inherit;font-size:14px;
  transition:border-color .15s var(--ease),box-shadow .15s var(--ease);
}
input::placeholder,textarea::placeholder{color:var(--ink-4)}
input:focus,select:focus,textarea:focus{
  outline:none;border-color:rgba(255,195,61,.55);
  box-shadow:0 0 0 2px rgba(255,195,61,.35),0 0 0 4px rgba(255,195,61,.12);
}
textarea{resize:vertical;min-height:64px}
.field{margin-bottom:14px}
@media(max-width:620px){input,select,textarea{font-size:16px}} /* stop iOS zoom-on-focus */

/* ---- table ---- */
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:var(--r-card)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:10px 16px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-size:11px;font-weight:510;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3);background:var(--panel)}
tbody tr:last-child td{border-bottom:0}
tbody tr{transition:background .15s var(--ease)}
tbody tr:hover{background:var(--wash)}
td.num{font-variant-numeric:tabular-nums} /* columns align; standalone figures do not */
td.r{text-align:right}
th.r{text-align:right}
td.wrap{white-space:normal;min-width:220px;color:var(--ink-2)}
td.strong{color:var(--ink);font-weight:510}
td.sub{color:var(--ink-3)}
tr.link{cursor:pointer}
tr.link td:first-child{position:relative}
.rowlink{color:inherit;display:block}
.rowlink:hover{color:var(--gold)}
/* ch-based cap, deliberately not widened at large viewports: these tables sit in
   a ~950px column, so a viewport-keyed bump would overflow and clip the last column. */
.trunc{display:block;max-width:30ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Tables carrying an actions column have less room for prose. */
.tablewrap.wide .trunc{max-width:20ch}
.acts{display:flex;gap:6px;justify-content:flex-end}

/* On phones a wide table is unusable, so each row becomes a stacked card and the
   column headers move into per-cell labels (td[data-l]). Cells with no data-l
   (the row's primary identifier) render as the card's heading. */
@media(max-width:760px){
  .tablewrap{border:0;border-radius:0;overflow:visible}
  .tablewrap table,.tablewrap tbody,.tablewrap tr,.tablewrap td{display:block;width:auto}
  .tablewrap thead{display:none}
  .tablewrap tr{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);
    padding:12px 14px;margin-bottom:8px}
  .tablewrap tr:hover{background:var(--surface)}
  .tablewrap td{border:0;padding:4px 0;white-space:normal;text-align:left}
  .tablewrap td[data-l]{display:flex;gap:14px;justify-content:space-between;align-items:center}
  .tablewrap td[data-l]::before{content:attr(data-l);color:var(--ink-3);font-size:12px;flex:none}
  .tablewrap td:not([data-l]){font-size:15px;font-weight:510;color:var(--ink);margin-bottom:4px}
  .tablewrap .trunc{max-width:none;white-space:normal;text-align:right}
  .tablewrap .acts{justify-content:flex-start;margin-top:8px}
  .hero{font-size:30px}
  .kpi{padding:12px 14px 14px}
}

/* ---- status pills: reserved hues, never used as accents ---- */
.pill{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:var(--r-sm);
  font-size:11.5px;font-weight:510;letter-spacing:.005em;background:var(--wash);color:var(--ink-3)}
.pill::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.pill.good{background:var(--good-dim);color:var(--good)}
.pill.bad{background:var(--bad-dim);color:var(--bad)}

/* ---- chat ---- */
.thread{display:flex;flex-direction:column;gap:6px}
.msg{max-width:min(78%,540px);padding:9px 12px;border-radius:var(--r-panel);font-size:13.5px;line-height:1.5;
  white-space:pre-wrap;word-break:break-word}
.msg .at{display:block;font-size:11px;color:var(--ink-4);margin-top:5px;letter-spacing:0}
.msg.customer{background:var(--raised);border:1px solid var(--line);align-self:flex-start;border-bottom-left-radius:var(--r-sm)}
.msg.agent{background:var(--gold-dim);border:1px solid rgba(255,195,61,.2);align-self:flex-end;border-bottom-right-radius:var(--r-sm)}
.msg.vendor{background:var(--wash);border:1px solid var(--line-strong);align-self:flex-end;border-bottom-right-radius:var(--r-sm)}

/* ---- misc ---- */
.empty{border:1px dashed var(--line-strong);border-radius:var(--r-card);padding:40px 20px;text-align:center;color:var(--ink-4);font-size:13px}
.empty b{display:block;color:var(--ink-3);font-weight:510;margin-bottom:4px}
.banner{border:1px solid var(--line-strong);border-radius:var(--r);padding:10px 12px;font-size:13px;color:var(--ink-2);background:var(--wash)}
.banner.bad{background:var(--bad-dim);border-color:rgba(248,81,73,.3);color:var(--bad)}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-thumb{background:var(--line-strong);border-radius:99px}
::-webkit-scrollbar-track{background:transparent}
`;

export const FONT = `<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>`;

// Polls /admin/pulse and reloads when the data behind the page has moved.
// Deliberately conservative: never reloads while a field is focused or a form
// has been typed into, so a refresh can't wipe half-entered work.
const LIVE = `<script>
(() => {
  const dot = document.getElementById('live');
  let last = null, stop = false;
  const typing = () => {
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    return [...document.querySelectorAll('input,textarea')].some(
      (el) => el.type !== 'hidden' && el.value !== el.defaultValue);
  };
  async function tick() {
    if (stop) return;
    try {
      const r = await fetch('/admin/pulse', { cache: 'no-store' });
      if (r.status === 302 || r.redirected) { stop = true; return; } // session gone
      if (!r.ok) return;
      const { v } = await r.json();
      if (dot) dot.dataset.on = '1';
      if (last === null) { last = v; return; }
      if (v !== last && !typing()) location.reload();
    } catch { /* offline — try again next tick */ }
  }
  setInterval(tick, 8000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  tick();
})();
</script>`;

/** Full admin page shell. `active` highlights the current nav item. */
export function page(title, body, { active = "" } = {}) {
  const item = (href, key, label) =>
    `<a href="${href}" class="${active === key ? "on" : ""}"><i class="dot"></i>${label}</a>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)} · Sika Agent</title>${FONT}<style>${CSS}</style></head><body>
<aside class="sidebar">
<div class="brand">💰 Sika <span>Agent</span></div>
<nav class="nav">${item("/admin", "dashboard", "Vendors")}${item("/admin/orders", "orders", "Orders")}${item("/admin/escalations", "escalations", "Escalations")}</nav>
<div class="foot"><span class="livedot" id="live"></span><span class="muted" style="font-size:12px">Live</span>
<form method="post" action="/admin/logout"><button class="btn ghost sm" type="submit">Log out</button></form></div>
</aside>
<main>${body}</main>
${LIVE}
</body></html>`;
}

/** Standalone login screen — no shell, no nav. */
export function loginPage(failed) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Log in · Sika Agent</title>${FONT}<style>${CSS}
body{display:flex;align-items:center;justify-content:center;padding:24px}
.box{width:100%;max-width:320px}
.mark{font-size:26px;margin-bottom:14px}
</style></head><body>
<div class="box">
<div class="mark">💰</div>
<h1>Sika Agent</h1>
<p class="sub" style="margin-bottom:22px">Operator access</p>
${failed ? `<div class="banner bad" style="margin-bottom:12px">That password didn't match.</div>` : ""}
<form method="post" action="/admin/login">
<div class="field"><label for="p">Password</label><input id="p" type="password" name="password" autofocus required></div>
<button class="btn" style="width:100%;justify-content:center" type="submit">Continue</button>
</form>
</div></body></html>`;
}

export const pill = (tone, label) => `<span class="pill ${tone}">${esc(label)}</span>`;
export const empty = (title, hint = "") => `<div class="empty"><b>${esc(title)}</b>${esc(hint)}</div>`;
/** Money without tabular-nums — these are standalone figures, not a column. */
export const ghs = (n) => `GHS ${Number(n || 0).toLocaleString("en-GH")}`;
