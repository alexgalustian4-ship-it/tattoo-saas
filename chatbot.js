/* ═══════════════════════════════════════════════════════════════
   INK.STUDIO — Concierge IA (widget autonome)
   Bulle flottante → panneau de chat noir & argent → POST /chat.
   Aucune dépendance. S'injecte tout seul (styles compris).
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__inkChatLoaded) return; window.__inkChatLoaded = true;

  /* ── Styles ── */
  var css = `
  #ink-chat-fab {
    position: fixed; right: 20px; bottom: 20px; z-index: 8600;
    width: 54px; height: 54px; border-radius: 50%;
    background: linear-gradient(180deg, #1a1a20, #0e0e12);
    border: 1px solid rgba(207,210,220,0.28); color: #cfd2dc;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; box-shadow: 0 12px 34px rgba(0,0,0,0.55), 0 0 22px rgba(207,210,220,0.06);
    transition: transform 0.3s cubic-bezier(0.34,1.56,0.64,1), border-color 0.25s, box-shadow 0.25s;
  }
  #ink-chat-fab:hover { transform: scale(1.08); border-color: rgba(207,210,220,0.55); }
  #ink-chat-fab svg { width: 22px; height: 22px; }
  #ink-chat-panel {
    position: fixed; right: 20px; bottom: 86px; z-index: 8600;
    width: 360px; max-width: calc(100vw - 32px); height: 480px; max-height: calc(100vh - 120px);
    display: none; flex-direction: column; overflow: hidden;
    background: linear-gradient(180deg, #121216, #0b0b0f);
    border: 1px solid #26262e; border-radius: 20px;
    box-shadow: 0 40px 100px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05);
    opacity: 0; transform: translateY(14px) scale(0.98);
    transition: opacity 0.35s cubic-bezier(0.22,1,0.36,1), transform 0.35s cubic-bezier(0.22,1,0.36,1);
  }
  #ink-chat-panel.open { display: flex; }
  #ink-chat-panel.in { opacity: 1; transform: none; }
  .ink-chat-head {
    padding: 15px 18px; border-bottom: 1px solid #1e1e26;
    display: flex; align-items: center; gap: 10px;
  }
  .ink-chat-head .dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; box-shadow: 0 0 8px rgba(52,211,153,0.6); }
  .ink-chat-head b { font-family: 'Syne', system-ui, sans-serif; font-size: 0.85rem; font-weight: 800; letter-spacing: 0.08em; color: #f6f6f9; }
  .ink-chat-head span { font-size: 0.66rem; color: #6a6e7e; margin-left: auto; }
  #ink-chat-msgs {
    flex: 1; overflow-y: auto; padding: 16px 14px; display: flex; flex-direction: column; gap: 10px;
    font-family: Inter, system-ui, sans-serif;
  }
  .ink-msg { max-width: 84%; padding: 10px 13px; border-radius: 14px; font-size: 0.82rem; line-height: 1.55; white-space: pre-wrap; word-wrap: break-word; animation: inkMsgIn 0.3s cubic-bezier(0.22,1,0.36,1); }
  @keyframes inkMsgIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  .ink-msg.user { align-self: flex-end; background: #f2f3f7; color: #0a0a0e; border-bottom-right-radius: 5px; }
  .ink-msg.bot  { align-self: flex-start; background: #17171d; color: #d5d6de; border: 1px solid #222; border-bottom-left-radius: 5px; }
  .ink-typing { align-self: flex-start; display: inline-flex; gap: 5px; padding: 12px 14px; background: #17171d; border: 1px solid #222; border-radius: 14px; border-bottom-left-radius: 5px; }
  .ink-typing i { width: 5px; height: 5px; border-radius: 50%; background: #cfd2dc; animation: inkDot 1.2s ease-in-out infinite; }
  .ink-typing i:nth-child(2) { animation-delay: 0.15s; } .ink-typing i:nth-child(3) { animation-delay: 0.3s; }
  @keyframes inkDot { 0%,80%,100% { opacity: 0.25; } 40% { opacity: 1; } }
  .ink-chat-inputbar { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #1e1e26; }
  #ink-chat-input {
    flex: 1; background: #0d0d11; border: 1px solid #26262e; border-radius: 12px;
    padding: 11px 13px; color: #f6f6f9; font-size: 0.82rem; outline: none; font-family: Inter, system-ui, sans-serif;
  }
  #ink-chat-input:focus { border-color: rgba(207,210,220,0.4); }
  #ink-chat-send {
    width: 42px; border: none; border-radius: 12px; background: #fff; color: #0a0a0e;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: transform 0.25s cubic-bezier(0.34,1.56,0.64,1), opacity 0.2s;
  }
  #ink-chat-send:hover { transform: scale(1.06); }
  #ink-chat-send:disabled { opacity: 0.4; cursor: default; transform: none; }
  #ink-chat-send svg { width: 16px; height: 16px; }
  @media (max-width: 480px) {
    #ink-chat-panel { right: 8px; left: 8px; width: auto; bottom: 80px; height: 62vh; }
  }`;
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  /* ── DOM ── */
  var fab = document.createElement('button');
  fab.id = 'ink-chat-fab'; fab.type = 'button'; fab.setAttribute('aria-label', 'Chat with INK');
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>';
  var panel = document.createElement('div');
  panel.id = 'ink-chat-panel';
  panel.innerHTML =
    '<div class="ink-chat-head"><span class="dot"></span><b>INK<span style="color:#7a7e8c">.</span>STUDIO</b><span>Studio concierge</span></div>' +
    '<div id="ink-chat-msgs"></div>' +
    '<div class="ink-chat-inputbar">' +
      '<input id="ink-chat-input" type="text" maxlength="500" placeholder="Ask me anything…" autocomplete="off" />' +
      '<button id="ink-chat-send" type="button" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>' +
    '</div>';
  document.body.appendChild(fab); document.body.appendChild(panel);

  var msgsEl = panel.querySelector('#ink-chat-msgs');
  var input  = panel.querySelector('#ink-chat-input');
  var sendBt = panel.querySelector('#ink-chat-send');
  var history = [];
  try { history = JSON.parse(sessionStorage.getItem('ink_chat') || '[]'); } catch (e) {}

  function addMsg(role, text) {
    var d = document.createElement('div');
    d.className = 'ink-msg ' + (role === 'user' ? 'user' : 'bot');
    d.textContent = text;
    msgsEl.appendChild(d);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  function persist() { try { sessionStorage.setItem('ink_chat', JSON.stringify(history.slice(-10))); } catch (e) {} }

  var opened = false;
  function togglePanel() {
    var isOpen = panel.classList.contains('open');
    if (isOpen) {
      panel.classList.remove('in');
      setTimeout(function () { panel.classList.remove('open'); }, 300);
    } else {
      panel.classList.add('open');
      requestAnimationFrame(function () { requestAnimationFrame(function () { panel.classList.add('in'); }); });
      if (!opened) {
        opened = true;
        if (history.length) history.forEach(function (m) { addMsg(m.role, m.content); });
        else addMsg('bot', "Hey! I'm INK, your studio concierge. Ask me about credits, plans, or how any tool works — I'm here to help. ✦");
      }
      setTimeout(function () { input.focus(); }, 250);
    }
  }
  fab.addEventListener('click', togglePanel);

  var busy = false;
  function send() {
    var text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    addMsg('user', text);
    history.push({ role: 'user', content: text }); persist();
    busy = true; sendBt.disabled = true;
    var typing = document.createElement('div');
    typing.className = 'ink-typing'; typing.innerHTML = '<i></i><i></i><i></i>';
    msgsEl.appendChild(typing); msgsEl.scrollTop = msgsEl.scrollHeight;
    fetch('/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history.slice(-10) }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        typing.remove();
        var reply = res.ok && res.d.reply
          ? res.d.reply
          : "I'm having a moment — try again in a bit, or email contact@inkhay.com and a human will help. ✦";
        addMsg('bot', reply);
        history.push({ role: 'assistant', content: reply }); persist();
      })
      .catch(function () {
        typing.remove();
        addMsg('bot', 'Connection hiccup — please try again.');
      })
      .finally(function () { busy = false; sendBt.disabled = false; input.focus(); });
  }
  sendBt.addEventListener('click', send);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
})();
