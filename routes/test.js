import express from "express";
import { db } from "../lib/db.js";

export const testCockpit = express.Router();

// Browser test cockpit — lets judges chat with the demo shop without Twilio.
testCockpit.get("/test", async (_req, res) => {
  const { data: v } = await db.from("vendors").select("shop_name, twilio_number")
    .eq("is_demo", true).limit(1).single();
  if (!v) return res.send("No demo vendor yet — run the seed SQL in DEPLOY.md first.");
  res.type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sika Agent — Test</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#101A2E;color:#E9EEF7;display:flex;flex-direction:column;height:100dvh}
header{background:#0A1220;padding:12px 16px;display:flex;justify-content:space-between;align-items:center}
header b{font-size:.95rem}header small{color:#FFC33D;display:block;font-size:.7rem}
header button{background:none;border:1px solid #3A4B6E;color:#8FA0BC;border-radius:99px;padding:6px 12px;font-size:.75rem}
#chat{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
.m{max-width:84%;padding:9px 12px;border-radius:14px;font-size:.9rem;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.me{background:#1D2C49;align-self:flex-end;border-bottom-right-radius:4px}
.ai{background:#274A2F;align-self:flex-start;border-bottom-left-radius:4px}
.sys{align-self:center;color:#8FA0BC;font-size:.72rem}
form{display:flex;gap:8px;padding:10px;background:#0A1220}
input{flex:1;background:#182640;border:1px solid #2A3A5C;border-radius:99px;color:#E9EEF7;padding:12px 16px;font-size:16px}
button.send{background:#FFC33D;border:none;border-radius:99px;padding:0 20px;font-weight:800;color:#0A1220}
</style></head><body>
<header><div><b>${v.shop_name}</b><small>Sika Agent test mode — you are the customer</small></div>
<button onclick="fresh()">New customer</button></header>
<div id="chat"><div class="m sys">Try: "Is the Ankara two-piece available?" · confirm a size &amp; delivery · ask "can you do GHS 150?" to see escalation</div></div>
<form onsubmit="return send(event)"><input id="box" placeholder="Message the shop…" autocomplete="off"><button class="send">Send</button></form>
<script>
const chat=document.getElementById('chat'),box=document.getElementById('box');
function num(){let n=sessionStorage.n;if(!n){n='whatsapp:+2335'+Math.floor(10000000+Math.random()*89999999);sessionStorage.n=n}return n}
function fresh(){sessionStorage.removeItem('n');chat.innerHTML='<div class="m sys">New customer session started.</div>'}
function add(cls,text){const d=document.createElement('div');d.className='m '+cls;d.textContent=text;chat.appendChild(d);chat.scrollTop=chat.scrollHeight}
async function send(e){e.preventDefault();const t=box.value.trim();if(!t)return false;box.value='';add('me',t);
try{const r=await fetch('/webhook/whatsapp',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
body:new URLSearchParams({From:num(),To:'${v.twilio_number}',Body:t,Channel:'web'})});
const x=await r.text();const doc=new DOMParser().parseFromString(x,'text/xml');
const m=doc.querySelector('Message');add(m?'ai':'sys',m?m.textContent:'(agent stayed silent — thread may be paused)');}
catch(err){add('sys','Error: '+err.message)}return false}
</script></body></html>`);
});
