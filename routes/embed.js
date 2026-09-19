// routes/embed.js
// Returns the embed snippet for a given bot token. This is a faithful copy
// of the WebChat AI dashboard's own chat widget — same bubbles, highlight
// styling, mic input, expand/reset controls, typing dots, suggestion chips,
// and the glowing orb launcher. Notice: contains NO API keys and NO
// knowledge base — just a token and your server's URL. Everything sensitive
// stays server-side in routes/chat.js.

const express = require('express');
const { db } = require('../db');
const router = express.Router();

router.get('/embed/:token.js', async (req, res) => {
  try {
    const { token } = req.params;
    const doc = await db.collection('bots').doc(token).get();
    if (!doc.exists || doc.data().is_active === false) return res.status(404).send('// Bot not found or inactive');
    const bot = doc.data();

  const serverUrl = `${req.protocol}://${req.get('host')}`;

  const cfg = {
    token,
    name: bot.name || 'WebChat AI',
    siteName: bot.site_name || bot.name || 'this site',
    colorGrad: bot.color_grad || 'linear-gradient(135deg,#3d45e0,#818af9)',
    greeting: bot.greeting || "Hi! Ask me anything about this site.",
    iconKey: bot.icon_key || 'bot',
    iconDataUrl: bot.icon_data_url || null,
    orbGlow: bot.orb_glow !== false, // default on unless explicitly disabled
    glowColor: bot.glow_color || '#5b63f5', // customizable; default is the original blue
    apiBase: serverUrl
    // Note: whether AI Pilot is enabled is NOT baked in here — it's fetched
    // lazily by the widget itself (GET /api/pilot/config/:token) the first
    // time it's needed, so toggling Pilot on/off in the dashboard doesn't
    // require regenerating every client's embed snippet.
  };

  // No caching, at all — this file is regenerated fresh on every request
  // from whatever the bot's current name/color/greeting/icon/glow settings
  // are right now. Without this header, browsers (and some CDNs) apply
  // their own heuristic caching to a URL ending in ".js" even with no
  // explicit cache directive, which is exactly why a saved customization
  // change wouldn't show up for a returning visitor until their cache
  // happened to expire — sometimes hours or days later, looking like the
  // change "didn't apply" when it actually had, server-side.
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(EMBED_JS_TEMPLATE(cfg));
  } catch (err) {
    console.error('Embed route error:', err);
    res.status(500).send('// Server error');
  }
});

function EMBED_JS_TEMPLATE(cfg) {
  const cfgJson = JSON.stringify(cfg);
  // Note: this whole thing runs inside the client's page, isolated under
  // #sp-widget-root so its CSS can't clash with their site's styles.
  return `
!function(){
if(window.__webchataiWidgetLoaded)return;window.__webchataiWidgetLoaded=true;
var c=${cfgJson};
var h=[];
var chatOpen=false;
var isLoading=false;
var isRec=false;
var humanMode=false;
var lastQuestion='';

// ── STYLES (scoped under #sp-widget-root) ──
var style=document.createElement('style');
style.textContent=\`
#sp-widget-root{position:fixed;bottom:18px;right:20px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}#sp-widget-root *{box-sizing:border-box}
#sp-window{width:390px;height:600px;max-height:calc(100vh - 100px);background:#0c0d18;border:1px solid rgba(255,255,255,.09);border-radius:20px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 32px 90px rgba(0,0,0,.8),0 0 0 1px rgba(91,99,245,.07);transform-origin:bottom right;transition:transform .22s cubic-bezier(0.34,1.4,0.64,1),opacity .18s ease,width .28s,height .28s;position:relative}
#sp-window.expanded{width:500px;height:min(760px,calc(100vh - 100px))}
#sp-window.hidden{transform:scale(0.88) translateY(14px);opacity:0;pointer-events:none}
.sp-chat-header{padding:11px 12px;border-bottom:1px solid rgba(255,255,255,.05);background:rgba(12,13,24,.8);backdrop-filter:blur(8px);display:flex;align-items:center;gap:9px;flex-shrink:0}
.sp-fav{width:30px;height:30px;border-radius:9px;flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.sp-fav img{width:100%;height:100%;object-fit:cover;display:block}
.sp-fav svg{width:14px;height:14px;fill:#fff}
.sp-pilot-avatar{width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;margin-top:1px}
.sp-pilot-avatar svg{width:15px;height:15px;fill:#fff;flex-shrink:0}
.sp-pilot-avatar img{width:100%;height:100%;object-fit:cover;display:block}
@keyframes sp-pilot-ring{0%{box-shadow:0 0 0 0 rgba(var(--sp-glow-rgb),.55)}100%{box-shadow:0 0 0 14px rgba(var(--sp-glow-rgb),0)}}
#sp-orb-btn.sp-pilot-alert .sp-orb-core{animation:sp-orb-glow 3s ease-in-out infinite,sp-pilot-ring 1.1s ease-out 2}
.sp-hdr-info{flex:1;min-width:0}
.sp-hdr-name{font-size:13px;font-weight:600;color:#f0f0fa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sp-hdr-status{font-size:9.5px;color:#00c98d;display:flex;align-items:center;gap:4px;margin-top:1px}
.sp-status-dot{width:6px;height:6px;border-radius:50%;background:#00c98d;box-shadow:0 0 6px #00c98d}
.sp-hdr-acts{display:flex;gap:4px}
.sp-hdr-btn{width:26px;height:26px;border-radius:7px;background:#171828;border:1px solid rgba(255,255,255,.05);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}
.sp-hdr-btn:hover{border-color:rgba(255,255,255,.09)}
.sp-hdr-btn svg{width:13px;height:13px;fill:#7c7c9e}
#sp-messages{flex:1;overflow-y:auto;padding:11px;display:flex;flex-direction:column;gap:9px;scroll-behavior:smooth;scrollbar-width:thin;scrollbar-color:#1e1f31 transparent}
#sp-messages::-webkit-scrollbar{width:3px}
#sp-messages::-webkit-scrollbar-thumb{background:#1e1f31;border-radius:3px}
.sp-msg-row{display:flex;gap:8px;align-items:flex-start}
.sp-msg-row.user{flex-direction:row-reverse}
.sp-msg-av{width:24px;height:24px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.sp-msg-av svg{width:12px;height:12px;fill:#fff}
.sp-msg-av.user{background:#1e1f31}
.sp-msg-av.user svg{fill:#7c7c9e}
.sp-msg-av img{width:100%;height:100%;object-fit:cover;display:block}
.sp-bubble{max-width:83%;padding:9px 12px;line-height:1.75;font-size:13px;border-radius:14px;word-wrap:break-word;color:#f0f0fa}
.sp-bubble.bot{background:#11121f;border:1px solid rgba(255,255,255,.05);border-top-left-radius:4px}
.sp-bubble.user{background:linear-gradient(135deg,#3d45e0,#5b63f5);color:#fff;border-top-right-radius:4px;box-shadow:0 2px 12px rgba(61,69,224,.3)}
.sp-bubble strong,.sp-bubble b{font-weight:700;color:#f0856e;background:rgba(232,97,75,.1);padding:0 4px;border-radius:4px;border-bottom:1.5px solid rgba(232,97,75,.28);display:inline;margin:0 1px;line-height:1.8}
.sp-bubble code{font-family:'JetBrains Mono',Consolas,monospace;background:rgba(255,255,255,.07);padding:2px 5px;border-radius:4px;font-size:11px}
.sp-bubble a{color:#818af9;text-decoration:underline;text-decoration-color:rgba(129,138,249,.4);word-break:break-all}
.sp-bubble a:hover{color:#b5baff}
.sp-bubble ul{padding-left:1.3em;margin:5px 0}
.sp-bubble li{margin:3px 0}
.sp-typing-bubble{background:#11121f;border:1px solid rgba(255,255,255,.05);border-radius:14px;border-top-left-radius:4px;padding:11px 14px;display:flex;gap:5px;align-items:center}
.sp-typing-dot{width:5px;height:5px;background:#3a3a5c;border-radius:50%;animation:sp-bounce 1.2s infinite}
.sp-typing-dot:nth-child(2){animation-delay:.18s}
.sp-typing-dot:nth-child(3){animation-delay:.36s}
@keyframes sp-bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}
.sp-sug-wrap{padding:0 9px 6px;display:flex;flex-wrap:wrap;gap:5px;flex-shrink:0}
.sp-sug-btn{padding:4px 9px;font-size:11px;color:#7c7c9e;background:transparent;border:1px solid rgba(255,255,255,.09);border-radius:20px;cursor:pointer;font-family:inherit;transition:all .15s}
.sp-sug-btn:hover{border-color:#5b63f5;color:#818af9;background:rgba(91,99,245,.12)}
.sp-input-area{padding:9px;border-top:1px solid rgba(255,255,255,.05);display:flex;gap:6px;align-items:flex-end;background:rgba(12,13,24,.7);flex-shrink:0}
#sp-input{flex:1;background:#171828;border:1.5px solid rgba(255,255,255,.09);border-radius:9px;padding:9px 11px;color:#f0f0fa;font-size:13px;font-family:inherit;outline:none;resize:none;max-height:90px;line-height:1.5;transition:all .2s}
#sp-input:focus{border-color:#5b63f5;box-shadow:0 0 0 3px rgba(91,99,245,.12)}
#sp-input::placeholder{color:#3a3a5c}
#sp-mic-btn{flex-shrink:0;width:32px;height:32px;border-radius:50%;border:1.5px solid rgba(255,255,255,.09);background:#171828;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .18s}
#sp-mic-btn svg{width:14px;height:14px;fill:#7c7c9e}
#sp-mic-btn:hover:not(:disabled){border-color:#5b63f5;background:rgba(91,99,245,.12)}
#sp-mic-btn:disabled{opacity:.3;cursor:not-allowed}
#sp-mic-btn.recording{background:rgba(220,50,50,.15);border-color:#e05555;animation:sp-mic-pulse 1s ease-in-out infinite}
#sp-mic-btn.recording svg{fill:#e05555}
@keyframes sp-mic-pulse{0%,100%{box-shadow:0 0 0 0 rgba(220,50,50,.4)}50%{box-shadow:0 0 0 5px rgba(220,50,50,0)}}
#sp-send-btn{width:34px;height:34px;background:linear-gradient(135deg,#3d45e0,#5b63f5);border:none;border-radius:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s;box-shadow:0 2px 10px rgba(61,69,224,.35)}
#sp-send-btn:hover{transform:translateY(-1px)}
#sp-send-btn:disabled{opacity:.3;cursor:not-allowed;transform:none}
#sp-send-btn svg{width:13px;height:13px;fill:#fff}
.sp-powered{font-size:9px;color:#3a3a5c;text-align:center;padding:5px 0;background:rgba(12,13,24,.7);flex-shrink:0}
#sp-orb-btn{width:66px;height:66px;border-radius:50%;border:none;background:transparent;cursor:pointer;position:relative;flex-shrink:0;transition:transform .2s,opacity .18s;padding:0}
#sp-orb-btn:hover{transform:scale(1.08)}
#sp-orb-btn:active{transform:scale(.94)}
.sp-orb-aura{position:absolute;inset:-14px;border-radius:50%;background:radial-gradient(circle,rgba(var(--sp-glow-rgb),.28) 0%,transparent 68%);animation:sp-breathe 3s ease-in-out infinite;pointer-events:none}
@keyframes sp-breathe{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(1.3);opacity:.35}}
@keyframes sp-nudge-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.sp-orb-core{position:absolute;inset:0;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 0 18px rgba(var(--sp-glow-rgb),.8),0 0 36px rgba(var(--sp-glow-rgb),.4);animation:sp-orb-glow 3s ease-in-out infinite;overflow:hidden}
.sp-orb-core svg{width:27px;height:27px;fill:#fff;flex-shrink:0}
.sp-orb-core img{width:100%;height:100%;object-fit:cover;display:block;flex-shrink:0}
@keyframes sp-orb-glow{0%,100%{box-shadow:0 0 18px rgba(var(--sp-glow-rgb),.8),0 0 36px rgba(var(--sp-glow-rgb),.4)}50%{box-shadow:0 0 28px rgba(var(--sp-glow-rgb),1),0 0 55px rgba(var(--sp-glow-rgb),.6)}}
#sp-orb-btn.sp-no-glow .sp-orb-aura{display:none}
#sp-orb-btn.sp-no-glow .sp-orb-core{animation:none;box-shadow:0 6px 18px rgba(0,0,0,.35)}
#sp-orb-btn.sp-no-glow.sp-pilot-alert .sp-orb-core{animation:sp-pilot-ring 1.1s ease-out 2}
#sp-orb-badge{position:absolute;top:-2px;right:-2px;width:17px;height:17px;background:#e8614b;border-radius:50%;border:2px solid #07080f;font-size:10px;font-weight:700;color:#fff;display:none;align-items:center;justify-content:center}
#sp-orb-badge.show{display:flex}

/* HUMAN HANDOFF — banner shown once connected, row shown reactively after a
   bot reply offering the option, and a confirm modal in between */
.sp-human-banner{display:flex;align-items:center;gap:10px;padding:10px 14px;margin:2px 0;background:linear-gradient(135deg,rgba(0,201,141,.1),rgba(0,201,141,.05));border:1px solid rgba(0,201,141,.25);border-radius:12px;font-size:12px}
.sp-human-banner-icon{width:30px;height:30px;border-radius:8px;background:rgba(0,201,141,.15);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.sp-human-banner-icon svg{width:15px;height:15px;fill:#00c98d}
.sp-human-banner-text strong{display:block;font-size:12.5px;color:#00c98d;font-weight:700;margin-bottom:1px}
.sp-human-banner-text span{font-size:11px;color:rgba(0,201,141,.7);font-weight:400}
.sp-human-row{display:flex;align-items:center;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.05)}
.sp-human-label{font-size:9.5px;font-weight:600;color:#3a3a5c;text-transform:uppercase;letter-spacing:.5px}
.sp-human-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:8px;font-size:11.5px;font-weight:600;cursor:pointer;background:rgba(0,201,141,.08);border:1.5px solid rgba(0,201,141,.22);color:#00c98d;font-family:inherit;transition:all .18s}
.sp-pilot-row{display:flex;align-items:center;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.05)}
.sp-pilot-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;font-size:11.5px;font-weight:700;cursor:pointer;background:rgba(91,99,245,.1);border:1.5px solid rgba(91,99,245,.3);color:#818af9;font-family:inherit;transition:all .18s}
.sp-pilot-btn:hover{background:rgba(91,99,245,.18)}
.sp-pilot-btn:disabled{opacity:.55;cursor:default}
.sp-pilot-btn svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2}
.sp-pilot-stop{font-size:11px;color:#e05555;background:none;border:1px solid rgba(224,85,85,.35);border-radius:20px;padding:3px 10px;cursor:pointer;font-family:inherit}
.sp-human-btn:hover{background:rgba(0,201,141,.15);border-color:#00c98d}
.sp-human-btn svg{width:12px;height:12px;fill:currentColor}
#sp-hm-overlay{display:none;position:absolute;inset:0;z-index:10;background:rgba(7,8,15,.82);backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:16px;border-radius:20px}
#sp-hm-overlay.show{display:flex}
.sp-sent-tick{font-size:9.5px;color:rgba(255,255,255,.55);margin-top:3px;text-align:right}
.sp-hm-card{width:100%;background:#11121f;border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:12px}
.sp-hm-head{display:flex;align-items:flex-start;gap:10px}
.sp-hm-ava{width:34px;height:34px;border-radius:9px;background:rgba(0,201,141,.15);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.sp-hm-ava svg{width:17px;height:17px;fill:#00c98d}
.sp-hm-title{font-size:13.5px;font-weight:700;color:#f0f0fa;margin-bottom:2px}
.sp-hm-sub{font-size:11.5px;color:#7c7c9e;line-height:1.5}
.sp-hm-foot{display:flex;gap:8px}
.sp-hm-cancel{flex:1;background:#171828;border:1px solid rgba(255,255,255,.09);color:#7c7c9e;border-radius:9px;padding:9px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
.sp-hm-switch{flex:1.4;background:linear-gradient(135deg,#009970,#00c98d);border:none;color:#fff;border-radius:9px;padding:9px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:6px}
.sp-hm-switch svg{width:13px;height:13px;fill:#fff}
\`;

// ── SHADOW DOM HOST ──
// Everything below renders inside an isolated Shadow DOM instead of being
// injected directly into the host page. Without this, the widget is at the
// mercy of whatever CSS the host site happens to have — a global button
// or svg rule on their site can silently override our button colors and
// hide our icons (this happened in practice: a law firm's site had global
// button styling that made our header/mic buttons render as blank colored
// shapes with no visible icon). Shadow DOM makes style leakage in either
// direction structurally impossible, regardless of what CSS any given site
// has, so the widget looks identical everywhere. Falls back to a plain
// (unencapsulated) div on the handful of ancient browsers with no
// attachShadow support — same behavior as before this fix, not worse.
var hostEl=document.createElement('div');hostEl.id='sp-widget-host';
document.body.appendChild(hostEl);
var shadow=hostEl.attachShadow?hostEl.attachShadow({mode:'open'}):hostEl;
shadow.appendChild(style);

// ── ICONS ──
var BOT_SVG='<svg viewBox="0 0 24 24"><path d="M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zm-9 5.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>';
var USER_SVG='<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
var ICON_GLYPHS={chat:'\u{1F4AC}',spark:'\u2728',headset:'\u{1F3A7}',star:'\u2B50',"life-ring":'\u{1F6DF}'};
function avatarHTML(){if(c.iconDataUrl)return '<img src="'+c.iconDataUrl+'">';var glyph=ICON_GLYPHS[c.iconKey];if(glyph)return '<span style="font-size:27px;line-height:1">'+glyph+'</span>';return BOT_SVG;}

// ── ROOT (inside the shadow root — see above) ──
var root=document.createElement('div');root.id='sp-widget-root';
shadow.appendChild(root);

// ── ORB LAUNCHER ──
var orbBtn=document.createElement('button');orbBtn.id='sp-orb-btn';orbBtn.title='Open chat';
// Turn the configured glow color (a hex like "#5b63f5") into the "R,G,B"
// triplet the CSS rgba(var(--sp-glow-rgb), alpha) rules above expect. Falls
// back to the original blue if the value isn't a parseable hex, so a
// malformed custom color can never break the widget's appearance.
function glowRgb(hex){
  var m=/^#?([0-9a-f]{6})$/i.exec(String(hex||'').trim());
  if(!m)return '91,99,245';
  var n=parseInt(m[1],16);
  return ((n>>16)&255)+','+((n>>8)&255)+','+(n&255);
}
root.style.setProperty('--sp-glow-rgb',glowRgb(c.glowColor));
if(!c.orbGlow)orbBtn.classList.add('sp-no-glow');
orbBtn.innerHTML='<div class="sp-orb-aura"></div><div class="sp-orb-core" style="background:'+c.colorGrad+'">'+avatarHTML()+'</div><div id="sp-orb-badge">1</div>';

// ── CHAT WINDOW (built once, toggled) ──
var win=document.createElement('div');win.id='sp-window';win.className='hidden';
win.innerHTML=
  '<div class="sp-chat-header">'+
    '<div class="sp-fav" style="background:'+c.colorGrad+'">'+avatarHTML()+'</div>'+
    '<div class="sp-hdr-info"><div class="sp-hdr-name">'+c.name+'</div><div class="sp-hdr-status"><div class="sp-status-dot"></div><span>Online</span></div></div>'+
    '<div class="sp-hdr-acts">'+
      '<button class="sp-hdr-btn" id="sp-expand-btn" title="Expand"><svg viewBox="0 0 24 24"><path d="M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z"/></svg></button>'+
      '<button class="sp-hdr-btn" id="sp-reset-btn" title="Reset chat"><svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg></button>'+
      '<button class="sp-hdr-btn" id="sp-close-btn" title="Close"><svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>'+
    '</div>'+
  '</div>'+
  '<div id="sp-messages"></div>'+
  '<div class="sp-sug-wrap" id="sp-sugs"></div>'+
  '<div class="sp-input-area">'+
    '<textarea id="sp-input" rows="1" placeholder="Ask anything…"></textarea>'+
    '<button id="sp-mic-btn" title="Speak" disabled><svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zm-1 14.93V19H9v2h6v-2h-2v-2.07A7 7 0 0 0 19 11h-2a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93z"/></svg></button>'+
    '<button id="sp-send-btn"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>'+
  '</div>'+
  '<div class="sp-powered">Powered by WebChat AI</div>'+
  '<div id="sp-hm-overlay">'+
    '<div class="sp-hm-card">'+
      '<div class="sp-hm-head">'+
        '<div class="sp-hm-ava">'+USER_SVG+'</div>'+
        '<div><div class="sp-hm-title">Talk to a Human</div><div class="sp-hm-sub">Switch to human mode — an agent will follow up on this conversation directly.</div></div>'+
      '</div>'+
      '<div class="sp-hm-foot">'+
        '<button class="sp-hm-cancel" id="sp-hm-cancel">Cancel</button>'+
        '<button class="sp-hm-switch" id="sp-hm-switch">'+USER_SVG+'Switch to Human</button>'+
      '</div>'+
    '</div>'+
  '</div>';
root.appendChild(win);
root.appendChild(orbBtn);

var msgsEl=win.querySelector('#sp-messages');
var inputEl=win.querySelector('#sp-input');
var sendBtn=win.querySelector('#sp-send-btn');
var micBtn=win.querySelector('#sp-mic-btn');
var sugsEl=win.querySelector('#sp-sugs');

// ── MARKDOWN / HIGHLIGHT RENDERING (same rules as the dashboard, plus link support) ──
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function renderMd(raw){
  // Models commonly put a blank line between each "- " bullet for
  // readability in raw markdown. Left alone, that blank line survives as a
  // literal double newline sitting between list items — the last step below
  // turns every remaining newline into a <br>, so each bullet ended up
  // wrapped in its own separate <ul> with a <br><br> gap between them
  // (compounding with the <ul> block's own CSS margin). Collapsing those
  // in-list blank lines up front, before any HTML is generated, means
  // consecutive bullets end up as one tight <ul>, the way a normal list
  // should read — while blank lines that aren't between two bullets (e.g.
  // a real paragraph break after the list) are left untouched.
  var t=String(raw).replace(/^([-•][^\\n]*)\\n\\s*\\n(?=[-•]\\s)/gm,'$1\\n');
  return esc(t)
    .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g,function(m,code){return '<code>'+code.trim()+'</code>';})
    .replace(/\`([^\`]+)\`/g,function(_,cd){return '<code>'+cd+'</code>';})
    .replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g,'<em>$1</em>')
    .replace(/^[-•]\\s+(.+)/gm,'<li>$1</li>')
    // Group ALL consecutive <li> lines into ONE shared <ul> (the old regex
    // matched non-greedily and wrapped each single <li> in its own <ul>,
    // which is what caused the multiple-margins-stacking half of the gap
    // bug). \\n? (at most one newline) between items, not \\s*, so this
    // can't also swallow a genuine blank-line paragraph break that happens
    // to follow the list.
    .replace(/(?:<li>[\\s\\S]*?<\\/li>\\n?)+/g,function(m){return '<ul>'+m.replace(/\\n/g,'')+'</ul>';})
    .replace(/(https?:\\/\\/[^\\s<]+[^\\s<.,;:!?)\\]'"])/g,function(url){
      return '<a href="'+url+'" target="_blank" rel="noopener noreferrer">'+url+'</a>';
    })
    .replace(/\\n/g,'<br>');
}

// ── MESSAGES ──
function scrollToBottom(){
  // requestAnimationFrame ensures the browser has painted the new content
  // first, so scrollHeight reflects the real new bottom, not a stale one.
  // Falls back to setTimeout in the rare environment without rAF.
  var raf=window.requestAnimationFrame||function(fn){setTimeout(fn,16);};
  raf(function(){msgsEl.scrollTop=msgsEl.scrollHeight;});
}
function addMsg(role,text,typing){
  var row=document.createElement('div');row.className='sp-msg-row '+(role==='bot'?'':'user');
  if(typing)row.id='sp-typing-row';
  var av=document.createElement('div');av.className='sp-msg-av'+(role==='user'?' user':'');
  av.innerHTML=role==='bot'?avatarHTML():USER_SVG;
  if(role==='bot')av.style.background=c.iconDataUrl?'transparent':c.colorGrad;
  var bubble=document.createElement('div');
  if(typing){
    bubble.className='sp-typing-bubble';
    bubble.innerHTML='<div class="sp-typing-dot"></div><div class="sp-typing-dot"></div><div class="sp-typing-dot"></div>';
  }else{
    bubble.className='sp-bubble '+(role==='bot'?'bot':'user');
    bubble.innerHTML=role==='bot'?renderMd(text):esc(text);
  }
  row.appendChild(av);row.appendChild(bubble);
  msgsEl.appendChild(row);scrollToBottom();
  if(!chatOpen&&role==='bot'&&!typing)orbBtn.querySelector('#sp-orb-badge').classList.add('show');
  return bubble;
}
function removeTyping(){var t=win.querySelector('#sp-typing-row');if(t)t.remove();}
// ── VISITOR IDENTITY ──
// A stable random ID persisted in this browser (per site, per bot) so
// multiple messages from the same person group into one conversation on the
// backend, instead of looking like unrelated one-off messages.
var visitorId=(function(){
  var key='sp_visitor_'+c.token;
  try{
    var v=localStorage.getItem(key);
    if(!v){v='v_'+Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem(key,v);}
    return v;
  }catch(e){return 'v_'+Math.random().toString(36).slice(2)+Date.now().toString(36);}
})();

// ── AI PILOT (scroll-triggered contextual questions) ──
// Watches which section of the page is currently in view (client-side, via
// IntersectionObserver — no cursor movement, no clicking, no navigation)
// and, as sections come into and out of view, shows/hides ONE relevant
// question as a popup above the chat launcher — e.g. scrolling onto a
// "Practice Areas" section might prompt "What areas do you practice in?".
// Scroll past it and the popup goes away; scroll back and it reappears.
// Clicking it asks that question in chat, grounded in that section's own
// text so the answer is actually specific, not generic.
var pilotCfg=null;
// Opt-in diagnostics: add ?wcai_debug=1 to any page URL while testing to
// see exactly what AI Pilot is doing (or why it's staying quiet) in the
// browser console — nothing is logged unless this is present.
var PILOT_DEBUG=/[?&]wcai_debug=1\\b/.test(location.search);
function pilotLog(){if(PILOT_DEBUG)console.log.apply(console,['[WebChat AI Pilot]'].concat(Array.prototype.slice.call(arguments)));}
var pilotCfgPromise=fetch(c.apiBase+'/api/page-assistant/config/'+c.token).then(function(r){return r.json();}).then(function(d){
  pilotCfg=d;
  if(!d||!d.enabled)pilotLog('disabled for this bot — turn it on in the dashboard\\'s AI Pilot tab and click Save Settings.');
  else pilotLog('enabled — cooldown '+(typeof d.cooldownSeconds==='number'?d.cooldownSeconds:0)+'s, max '+(typeof d.maxSuggestions==='number'?d.maxSuggestions:0)+' popups/session.');
  return d;
}).catch(function(){pilotCfg={enabled:false};pilotLog('could not load config (network/CORS issue?) — treating as disabled.');return pilotCfg;});

function logPilotEvent(eventType,label){
  fetch(c.apiBase+'/api/page-assistant/event',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:c.token,visitorId:visitorId,eventType:eventType,pageUrl:location.href,label:label||null})
  }).catch(function(){});
}

// Finds candidate "important sections" using headings and semantic
// containers — the same identification signals used elsewhere in
// WebChatAI (semantic HTML, headings, ids), not fragile selectors.
function findPilotSections(){
  var out=[];var seen=[];
  var heads=document.querySelectorAll('h1,h2,h3,section[id],[id][class*="section" i]');
  for(var i=0;i<heads.length&&out.length<20;i++){
    var head=heads[i];
    var container=head.closest('section,article,[id]')||head.parentElement;
    if(!container||seen.indexOf(container)!==-1)continue;
    // Skip anything not actually rendered — sliders/carousels commonly keep
    // every slide's markup in the DOM (including its own <h1>) and just
    // display:none the inactive ones. Those would never be scrolled into
    // view anyway, so including them only crowds out real sections from the
    // one AI Pilot question-writing call's limited response budget.
    if(container.getClientRects().length===0)continue;
    var name=(head.tagName&&head.tagName.charAt(0)==='H'?head.textContent:container.getAttribute('id'))||'';
    name=name.trim().replace(/\\s+/g,' ').slice(0,60);
    if(!name)continue;
    var text=(container.textContent||'').trim().replace(/\\s+/g,' ').slice(0,900);
    if(text.length<20)continue;
    seen.push(container);
    out.push({name:name,el:container,text:text});
  }
  return out;
}

// clickedSections: sections the visitor has actually tapped the popup for —
// permanently silenced. shownSections: sections that have been shown at
// least once — counted toward the session cap exactly once, so scrolling
// back to an already-seen-but-not-clicked section can still pop up again
// without burning through the whole session's budget on one section.
var pilot={sections:[],current:null,questionsBySection:{},lastShownAt:0,shownCount:0,lastDismissed:null,lastDismissedAt:0,shownSections:{},clickedSections:{}};
var pilotObserver=null;
var pilotRatios={};

function startPilotObserving(){
  if(!('IntersectionObserver' in window)){pilotLog('this browser lacks IntersectionObserver — AI Pilot needs it and will stay off here.');return;}
  if(pilotObserver)pilotObserver.disconnect();
  pilot.sections=findPilotSections();
  pilotRatios={};
  if(!pilot.sections.length){
    pilotLog('no sections detected on this page — add at least one <h1>/<h2>/<h3>, or a <section id="…">, with ~20+ characters of nearby text, and AI Pilot will pick it up.');
    return;
  }
  pilotLog('found '+pilot.sections.length+' section(s): '+pilot.sections.map(function(s){return '"'+s.name+'"';}).join(', '));
  // rootMargin shrinks the "viewport" IntersectionObserver checks against to
  // a band roughly a quarter to halfway down the screen — a trigger zone,
  // not a percentage-of-the-whole-section check. The old ratio-based version
  // needed 35% of a section's OWN total area visible before it counted as
  // "current", which for anything taller than the viewport could take
  // forever (or never happen) to reach — that's why popups only fired near
  // the very end of a section's scroll range. A trigger zone fires as soon
  // as a section's content reaches it, regardless of section height. It's
  // widened from the first version (was a much thinner 32%–40% band, easy
  // for a short section to slip through entirely on a fast scroll) to a
  // steadier 24%–50%.
  pilotObserver=new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      var match=pilot.sections.find(function(s){return s.el===entry.target;});
      if(match)pilotRatios[match.name]=entry.isIntersecting;
    });
    updateCurrentPilotSection();
  },{rootMargin:'-24% 0px -50% 0px',threshold:0});
  pilot.sections.forEach(function(s){pilotObserver.observe(s.el);});
}
var pilotPendingTimer=null;
function updateCurrentPilotSection(){
  // Prefer document order (topmost matching section) over object-key order
  // when more than one is momentarily true, and keep the existing current
  // section if it's still valid rather than reshuffling.
  var candidate=null;
  for(var i=0;i<pilot.sections.length;i++){
    if(pilotRatios[pilot.sections[i].name]){candidate=pilot.sections[i].name;break;}
  }
  var target=(pilot.current&&pilotRatios[pilot.current])?pilot.current:candidate;
  if(target===pilot.current)return;
  if(pilotPendingTimer){clearTimeout(pilotPendingTimer);pilotPendingTimer=null;}
  if(!target){commitPilotSection(null);return;}
  // Require the new section to hold the trigger zone for a beat before
  // committing — a fast flick-scroll can graze a short section for a single
  // frame; without this debounce, that instant graze could win "current"
  // and fire a popup for a section the visitor never actually paused on.
  pilotPendingTimer=setTimeout(function(){
    pilotPendingTimer=null;
    if(pilotRatios[target])commitPilotSection(target);
  },180);
}
function commitPilotSection(best){
  if(best===pilot.current)return;
  var leaving=pilot.current;
  pilot.current=best;
  if(leaving&&pilotPopupSection===leaving)hidePilotPopup(leaving);
  if(best){
    if(PILOT_DEBUG){
      if(!pilotCfg||!pilotCfg.enabled)pilotLog('scrolled into "'+best+'" but AI Pilot is disabled — nothing will show.');
      else if(pilot.clickedSections[best])pilotLog('scrolled into "'+best+'" — already clicked earlier, staying quiet.');
      else if(!pilot.shownSections[best]&&pilot.shownCount>=(pilotCfg.maxSuggestions||0))pilotLog('scrolled into "'+best+'" but hit the max-popups-per-session cap ('+(pilotCfg.maxSuggestions||0)+') — raise it in settings to see more.');
      else if(!pilot.questionsBySection[best])pilotLog('scrolled into "'+best+'" — question still generating, will pop up once ready.');
      else pilotLog('scrolled into "'+best+'" — showing: "'+pilot.questionsBySection[best]+'"');
    }
    maybeShowPilotPopup();
  }
}

function maybeShowPilotPopup(){
  if(!pilotCfg||!pilotCfg.enabled||chatOpen||pilotPopupEl)return;
  var name=pilot.current;
  if(!name)return;
  if(pilot.clickedSections[name])return; // they already asked about this one — done, for good
  // Only a section's FIRST-ever impression counts against the session cap —
  // once it's been shown once, scrolling back to it again (without having
  // clicked it) can still pop up, it just doesn't cost more of the budget.
  var firstImpression=!pilot.shownSections[name];
  if(firstImpression&&pilot.shownCount>=(pilotCfg.maxSuggestions||0))return;
  // A brief anti-flicker guard — don't instantly re-show the exact popup
  // that was just hidden a moment ago (e.g. jitter right at the boundary),
  // but DO allow a genuine re-entry after that short window.
  if(pilot.lastDismissed===name&&Date.now()-pilot.lastDismissedAt<2500)return;
  var now=Date.now();
  // cooldownSeconds can legitimately be 0 ("no cooldown"), and 0||4 would
  // silently turn that back into 4 — only fall back when it's genuinely
  // missing (undefined/null), not just falsy.
  var cooldownMs=(typeof pilotCfg.cooldownSeconds==='number'?pilotCfg.cooldownSeconds:0)*1000;
  if(now-pilot.lastShownAt<cooldownMs)return;
  var question=pilot.questionsBySection[name];
  if(!question)return; // not loaded yet — the periodic retry below or the fetch callback will catch it

  pilot.lastShownAt=now;
  if(firstImpression){pilot.shownSections[name]=true;pilot.shownCount++;}
  logPilotEvent('suggestion_shown',name);
  var section=pilot.sections.find(function(s){return s.name===name;});
  showPilotPopup(question,section);
}
// Only for the case where the visitor is already sitting on a section when
// the (slower) question-generation network call finishes — a genuinely
// one-shot situation, not a reason to keep re-checking forever. Gated on
// "never shown yet for this section": once it's been shown once, this stops
// touching it entirely, so sitting still in a section can't cause it to
// pop → hide → pop → hide on a loop. The ONLY thing that should make it
// show again after that is actually leaving and re-entering the section
// (handled separately, in commitPilotSection).
setInterval(function(){
  if(pilot.current&&!pilot.shownSections[pilot.current]&&!pilotPopupEl)maybeShowPilotPopup();
},1500);

var pilotPopupEl=null;
var pilotPopupSection=null;
function hidePilotPopup(sectionName){
  if(!pilotPopupEl)return;
  pilot.lastDismissed=sectionName||pilotPopupSection;
  pilot.lastDismissedAt=Date.now();
  var el=pilotPopupEl;pilotPopupEl=null;pilotPopupSection=null;
  el.style.transition='opacity .25s ease,transform .25s ease';
  el.style.opacity='0';el.style.transform='translateY(8px) scale(.92)';
  setTimeout(function(){el.remove();},260);
}
// A calmer, more professional card — matches the chat window's own dark
// surface (#11121f) instead of a bright full-color balloon, with the bot's
// accent color reduced to a thin left stripe and the avatar chip rather
// than the whole background, and a muted "Suggested question" label instead
// of a cutesy one. Still gets a spring-style entrance, a chime, and a brief
// pulse ring on the orb so it's noticed — just without looking like a promo
// popup.
function showPilotPopup(question,section){
  if(pilotPopupEl)pilotPopupEl.remove();
  pilotPopupSection=section?section.name:null;
  pilotPopupEl=document.createElement('div');
  pilotPopupEl.style.cssText='position:relative;background:#11121f;border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:11px 14px 11px 13px;max-width:254px;box-shadow:0 16px 40px rgba(0,0,0,.55);display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-family:inherit;opacity:0;transform:translateY(14px) scale(.92);overflow:hidden';
  pilotPopupEl.innerHTML=
    '<div style="position:absolute;left:0;top:0;bottom:0;width:3px;background:'+c.colorGrad+'"></div>'+
    '<div class="sp-pilot-avatar" style="background:'+c.colorGrad+'">'+avatarHTML()+'</div>'+
    '<div style="flex:1;min-width:0">'+
      '<div style="font-size:9.5px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:#7c7d94;margin-bottom:3px">Suggested question</div>'+
      '<div style="font-size:13px;font-weight:500;line-height:1.42;color:#eceef7">'+question+'</div>'+
    '</div>'+
    '<button type="button" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);color:#8b8ca6;font-size:11px;cursor:pointer;line-height:1;padding:4px 5px;border-radius:6px;flex-shrink:0;margin-top:1px" title="Dismiss">✕</button>'+
    '<div style="position:absolute;bottom:-6px;right:26px;width:11px;height:11px;background:#11121f;border-right:1px solid rgba(255,255,255,.09);border-bottom:1px solid rgba(255,255,255,.09);transform:rotate(45deg)"></div>';
  root.insertBefore(pilotPopupEl,orbBtn);
  orbBtn.classList.add('sp-pilot-alert');
  setTimeout(function(){orbBtn.classList.remove('sp-pilot-alert');},2400);
  requestAnimationFrame(function(){
    if(!pilotPopupEl)return;
    pilotPopupEl.style.transition='opacity .4s cubic-bezier(.34,1.56,.64,1),transform .4s cubic-bezier(.34,1.56,.64,1)';
    pilotPopupEl.style.opacity='1';
    pilotPopupEl.style.transform='translateY(0) scale(1)';
  });
  pilotPopupEl.onclick=function(){
    logPilotEvent('suggestion_clicked',pilotPopupSection);
    var sectionText=section?section.text:null;
    pilot.clickedSections[pilotPopupSection]=true; // done — this section won't pop up again
    var el=pilotPopupEl; // capture before clearing the shared reference below
    pilotPopupEl=null;pilotPopupSection=null;
    el.remove(); // the actual bug: this was never called, so the bubble stayed
                 // on screen permanently after being clicked — visible under
                 // the now-open chat window, and still there after closing it.
    openChat();
    send(question,sectionText);
  };
  pilotPopupEl.querySelector('button').onclick=function(e){
    e.stopPropagation();
    hidePilotPopup(pilotPopupSection);
  };
  // 20s (up from 10s) gives someone enough time to actually notice and read
  // it, not just a flash — it still disappears immediately on its own if
  // they scroll away from the section before that.
  setTimeout(function(){if(pilotPopupEl)hidePilotPopup(pilotPopupSection);},20000);
}

// Asks the backend for one question per detected section, then (re)checks
// whether the currently-visible section already has its answer ready.
function fetchPilotQuestions(sections){
  if(!sections.length)return;
  fetch(c.apiBase+'/api/page-assistant/section-questions',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:c.token,pageUrl:location.href,sections:sections.map(function(s){return {name:s.name,text:s.text};}),visitorId:visitorId})
  }).then(function(r){return r.json();}).then(function(data){
    (data.questions||[]).forEach(function(q){pilot.questionsBySection[q.section]=q.question;});
    pilotLog('got '+(data.questions||[]).length+'/'+sections.length+' question(s) back from the server.');
    if(pilot.current)maybeShowPilotPopup();
  }).catch(function(){pilotLog('failed to fetch section questions — check that your server URL/token are correct.');});
}

// Some sites reveal real content only after an interaction (an accordion,
// a tab, a "read more"). Rather than trying to guess which control does
// what, this just notices when the page's content has visibly grown and
// re-scans for sections it hasn't seen before — no clicking, no cursor,
// just re-reading the page the same way it did on load.
var pilotLastHeight=0;
var pilotRescanTimer=null;
function schedulePilotRescan(){
  if(pilotRescanTimer)clearTimeout(pilotRescanTimer);
  pilotRescanTimer=setTimeout(function(){
    var h=document.documentElement.scrollHeight;
    if(Math.abs(h-pilotLastHeight)<80)return; // not a meaningful content change
    pilotLastHeight=h;
    var found=findPilotSections();
    var known=pilot.sections.map(function(s){return s.name;});
    var fresh=found.filter(function(s){return known.indexOf(s.name)===-1;});
    if(!fresh.length)return;
    pilot.sections=pilot.sections.concat(fresh);
    fresh.forEach(function(s){if(pilotObserver)pilotObserver.observe(s.el);});
    fetchPilotQuestions(fresh);
  },800);
}

function initPilot(){
  pilotCfgPromise.then(function(cfg){
    if(!cfg||!cfg.enabled)return;
    startPilotObserving();
    pilotLastHeight=document.documentElement.scrollHeight;
    if(!pilot.sections.length)return;
    fetchPilotQuestions(pilot.sections);
    document.addEventListener('click',schedulePilotRescan,{passive:true});
    window.addEventListener('resize',schedulePilotRescan,{passive:true});
  });
}
initPilot();


var WANTS_HUMAN=['talk to a human','talk to human','speak to a human','speak to human','connect me to a human','human support','human agent','real person','speak to a person','talk to a person','talk to someone','speak to someone','live agent','live chat','customer support','talk to representative','speak to representative','need human help','want to talk to a human','i need support','contact support','get support','human please','connect me to support','can i speak to someone','can i talk to someone','i want human','get me a human','transfer me'];
function wantsHuman(t){var lower=t.toLowerCase();return WANTS_HUMAN.some(function(p){return lower.indexOf(p)!==-1;});}

// Appended INSIDE the bot's message bubble it belongs to — not as a
// free-floating row — matching the dashboard's look exactly.
function addHumanRowIn(bubbleEl,label,btnText){
  var row=document.createElement('div');row.className='sp-human-row';
  row.innerHTML='<span class="sp-human-label">'+label+'</span>'+
    '<button class="sp-human-btn">'+USER_SVG+btnText+'</button>';
  row.querySelector('.sp-human-btn').onclick=function(){openHumanModal();};
  bubbleEl.appendChild(row);scrollToBottom();
}
function openHumanModal(){win.querySelector('#sp-hm-overlay').classList.add('show');}
function closeHumanModal(){win.querySelector('#sp-hm-overlay').classList.remove('show');}
win.querySelector('#sp-hm-cancel').onclick=closeHumanModal;
function connectToHuman(){
  humanMode=true;
  win.querySelector('.sp-hdr-status span').textContent='Human agent';
  var banner=document.createElement('div');banner.className='sp-human-banner';
  banner.innerHTML='<div class="sp-human-banner-icon">'+USER_SVG+'</div><div class="sp-human-banner-text"><strong>Connected to a human agent</strong><span>Your messages are now logged for the site owner to follow up on.</span></div>';
  msgsEl.appendChild(banner);scrollToBottom();
  startHumanPolling();
}
win.querySelector('#sp-hm-switch').onclick=function(){
  closeHumanModal();
  connectToHuman();
  sendHumanMessage(lastQuestion);
};
async function sendHumanMessage(text){
  if(!text)return;
  try{
    await fetch(c.apiBase+'/api/human-message',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:c.token,visitorId:visitorId,message:text})
    });
  }catch(e){/* best-effort — the banner already told the visitor they're "connected" either way */}
}
function markMsgSent(bubble){
  if(!bubble)return;
  var tick=document.createElement('div');tick.className='sp-sent-tick';tick.textContent='Sent';
  bubble.appendChild(tick);
}

// ── POLLING FOR AGENT REPLIES ──
// No websockets here — a plain interval checking for new messages every
// few seconds is a fine tradeoff for this: simple, works through any
// firewall/proxy, and "a few seconds of delay" is a non-issue for something
// a human is typing anyway.
var humanPollTimer=null;
var renderedHumanCount=0;
function renderHumanMessages(messages,replayAll){
  for(var i=renderedHumanCount;i<messages.length;i++){
    var m=messages[i];
    // Ongoing polls only need to show the AGENT's side — the visitor's own
    // messages are already echoed locally the moment they're sent. On a
    // fresh page load replaying older history, though, show both sides so
    // the conversation reads as a complete thread, not just agent replies
    // floating with no visible context.
    if(replayAll||m.sender==='agent'){
      addMsg(m.sender==='agent'?'bot':'user',m.message);
    }
  }
  var gotNewAgentMsg=messages.length>renderedHumanCount&&messages[messages.length-1]&&messages[messages.length-1].sender==='agent';
  renderedHumanCount=messages.length;
  if(gotNewAgentMsg&&!chatOpen)orbBtn.querySelector('#sp-orb-badge').classList.add('show');
}
function pollHumanMessages(replayAll){
  return fetch(c.apiBase+'/api/human-messages/'+c.token+'/'+visitorId)
    .then(function(r){return r.json();})
    .then(function(data){if(data&&data.messages)renderHumanMessages(data.messages,replayAll);})
    .catch(function(){});
}
function startHumanPolling(){
  if(humanPollTimer)clearInterval(humanPollTimer);
  humanPollTimer=setInterval(function(){pollHumanMessages(false);},4000);
}
function stopHumanPolling(){
  if(humanPollTimer){clearInterval(humanPollTimer);humanPollTimer=null;}
  renderedHumanCount=0;
}

function showSugs(items){
  sugsEl.innerHTML='';
  items.forEach(function(t){
    var b=document.createElement('button');b.className='sp-sug-btn';b.textContent=t;
    b.onclick=function(){sugsEl.innerHTML='';send(t);};
    sugsEl.appendChild(b);
  });
  scrollToBottom();
}

addMsg('bot',c.greeting);
showSugs(['What is this?','Main features?','How to start?']);

// Returning visitor check — if this browser has talked to a human before
// (same visitorId), pick that conversation back up instead of starting
// fresh and losing any reply that came in since their last visit.
pollHumanMessages(true).then(function(){
  if(renderedHumanCount>0)connectToHuman();
});

// ── SEND ──

// The plain chat call — every message goes through this now that Pilot's
// old cursor/guide branching is gone.
async function sendPlainChat(text,pageContext){
  var r=await fetch(c.apiBase+'/api/chat',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:c.token,message:text,history:h.slice(-4),pageContext:pageContext||null})
  });
  var data=await r.json();
  removeTyping();
  var reply=data.reply||data.error||"Sorry, I couldn't generate a response.";
  var replyBubble=addMsg('bot',reply);
  h.push({role:'assistant',content:reply});
  // Only offer human handoff when the AI genuinely didn't know — a
  // confidently-answered question doesn't need this cluttering every
  // single reply.
  if(data.unsure)addHumanRowIn(replyBubble,"AI couldn't answer",'Talk to a Human');
  if(data.suggestions&&data.suggestions.length)showSugs(data.suggestions);
  return reply;
}

// ── VOICE OUTPUT ──
// Only speaks a reply aloud when the visitor's own message was voice input
// — if they typed, they get text back, same as any normal chat. This makes
// it feel like a real back-and-forth voice conversation when someone talks
// to it, without ever surprising a visitor who just typed a question with
// unexpected audio.
var voiceContributed=false;
inputEl.addEventListener('input',function(){voiceContributed=false;}); // real keystrokes only — recog sets .value directly, which never fires this
var TTS=window.speechSynthesis;
function stripForSpeech(text){
  return String(text)
    .replace(/\`\`\`[\\s\\S]*?\`\`\`/g,'')
    .replace(/\`([^\`]+)\`/g,'$1')
    .replace(/\\*\\*(.+?)\\*\\*/g,'$1')
    .replace(/\\*(.+?)\\*/g,'$1')
    .replace(/^[-•]\\s+/gm,'')
    .replace(/https?:\\/\\/\\S+/g,'')
    .trim();
}
function speak(text){
  if(!TTS||!text)return;
  try{
    TTS.cancel(); // don't let replies overlap/queue up
    var utter=new SpeechSynthesisUtterance(stripForSpeech(text));
    utter.rate=1.02;
    TTS.speak(utter);
  }catch(e){}
}

async function send(presetText,pageContext){
  var text=(presetText||inputEl.value).trim();
  if(!text||isLoading)return;
  var usedVoice=voiceContributed; // capture before it gets reset for the next message
  voiceContributed=false;
  inputEl.value='';inputEl.style.height='auto';
  sugsEl.innerHTML='';
  lastQuestion=text;
  var userBubble=addMsg('user',text);

  // Once switched to human mode, every message just gets logged for the
  // site owner — no more AI calls, and no repeated "thanks, sent along"
  // bubble cluttering the conversation (the banner already said that once).
  if(humanMode){
    isLoading=true;sendBtn.disabled=true;
    await sendHumanMessage(text);
    markMsgSent(userBubble);
    isLoading=false;sendBtn.disabled=false;inputEl.focus();
    return;
  }

  // Explicit "talk to a human" style request — skip the AI entirely and
  // offer the handoff directly, same as the dashboard preview does.
  if(wantsHuman(text)){
    var bridgeBubble=addMsg('bot','Sure, let me connect you with a human agent.');
    addHumanRowIn(bridgeBubble,'Ready to connect','Switch to Human');
    inputEl.focus();
    return;
  }

  h.push({role:'user',content:text});
  addMsg('bot','',true);
  isLoading=true;sendBtn.disabled=true;

  try{
    // pageContext is only ever set when this message came from an AI Pilot
    // popup — it's that section's own extracted text, so the AI actually
    // has something concrete to answer from instead of guessing.
    var plainReply=await sendPlainChat(text,pageContext);
    if(usedVoice)speak(plainReply);
  }catch(e){
    removeTyping();
    addMsg('bot','Connection error. Please try again.');
  }
  isLoading=false;sendBtn.disabled=false;inputEl.focus();
}
sendBtn.onclick=function(){send();};
inputEl.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
inputEl.addEventListener('input',function(){inputEl.style.height='auto';inputEl.style.height=Math.min(inputEl.scrollHeight,90)+'px';});

// ── OPEN / CLOSE / EXPAND / RESET ──
function openChat(){
  chatOpen=true;win.classList.remove('hidden');orbBtn.style.display='none';
  orbBtn.querySelector('#sp-orb-badge').classList.remove('show');
  // Belt-and-suspenders: whatever path opened the chat (a suggestion click,
  // or the visitor just clicking the orb directly while a popup happened to
  // be showing), a leftover AI Pilot popup should never still be sitting on
  // screen once the chat window is open.
  if(pilotPopupEl)hidePilotPopup(pilotPopupSection);
  inputEl.focus();scrollToBottom();
}
function closeChat(){chatOpen=false;win.classList.add('hidden');win.classList.remove('expanded');orbBtn.style.display='';if(TTS)TTS.cancel();}
orbBtn.onclick=function(){chatOpen?closeChat():openChat();};
win.querySelector('#sp-close-btn').onclick=closeChat;
win.querySelector('#sp-expand-btn').onclick=function(){win.classList.toggle('expanded');setTimeout(function(){msgsEl.scrollTop=999999;},300);};
win.querySelector('#sp-reset-btn').onclick=function(){
  h=[];msgsEl.innerHTML='';sugsEl.innerHTML='';
  humanMode=false;lastQuestion='';
  stopHumanPolling();
  var statusEl=win.querySelector('.sp-hdr-status span');if(statusEl)statusEl.textContent='Online';
  addMsg('bot',c.greeting);
  showSugs(['What is this?','Main features?','How to start?']);
};

// ── MIC / SPEECH RECOGNITION ──
var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
if(SR){
  micBtn.disabled=false;
  var recog=new SR();recog.continuous=true;recog.interimResults=true;recog.lang='en-US';
  var finalT='';
  function restoreMic(){isRec=false;micBtn.classList.remove('recording');inputEl.placeholder='Ask anything…';}
  recog.onstart=function(){isRec=true;finalT='';micBtn.classList.add('recording');inputEl.placeholder='Listening… click mic to stop';};
  recog.onresult=function(e){
    voiceContributed=true;
    for(var i=e.resultIndex;i<e.results.length;i++)if(e.results[i].isFinal)finalT+=e.results[i][0].transcript+' ';
    var interim='';for(var j=e.resultIndex;j<e.results.length;j++)if(!e.results[j].isFinal)interim+=e.results[j][0].transcript;
    inputEl.value=(finalT+interim).trim();
    inputEl.style.height='auto';inputEl.style.height=Math.min(inputEl.scrollHeight,90)+'px';
  };
  recog.onend=function(){if(isRec){try{recog.start();}catch(e){restoreMic();}}};
  recog.onerror=function(e){if(e.error==='aborted')return;restoreMic();};
  micBtn.addEventListener('click',function(){
    if(isRec){isRec=false;try{recog.stop();}catch(e){}restoreMic();}
    else{try{recog.start();}catch(e){}}
  });
}else{
  micBtn.style.display='none';
}
}();
`.trim();
}

module.exports = router;