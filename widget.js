/*!
 * AutoAdvisor AI — Embeddable Chat Widget
 * Drop-in <script> integration for any car dealer site.
 *
 * Usage:
 *   <script>
 *     window.AutoAdvisorConfig = { dealerId: "dealer_123", primaryColor: "#e63946" };
 *   </script>
 *   <script src="https://appi.autoadvisoragent.com/widget.js"></script>
 */
(function () {
  if (window.__AutoAdvisorWidgetLoaded) return;
  window.__AutoAdvisorWidgetLoaded = true;

  var cfg = window.AutoAdvisorConfig || {};
  var DEALER_ID = cfg.dealerId || 'default';
  var PRIMARY = sanitizeColor(cfg.primaryColor) || '#e8a020';
  var PRIMARY_DARK = shade(PRIMARY, -14);
  var API_BASE = (cfg.apiBase || 'https://appi.autoadvisoragent.com').replace(/\/+$/, '');
  var GREETING = cfg.greeting || "Hi! I'm AutoAdvisor — I can help you find the right vehicle, answer questions about inventory, or book a test drive. What are you looking for?";
  var TITLE = cfg.title || 'AutoAdvisor AI';
  var SUBTITLE = cfg.subtitle || 'Your honest car buying assistant';
  var STORAGE_KEY = 'aa_widget_' + DEALER_ID;

  var conversationId = null;
  var messages = [];
  var leadCaptured = false;
  var lead = { name: '', phone: '', email: '' };
  var leadShown = false;
  var sending = false;

  restoreState();
  injectStyles();
  var dom = buildDom();
  document.body.appendChild(dom.root);
  bindEvents();
  renderMessages();

  function sanitizeColor(c) {
    if (!c || typeof c !== 'string') return null;
    return /^#[0-9a-fA-F]{3,8}$/.test(c.trim()) ? c.trim() : null;
  }

  function shade(hex, pct) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(hex, 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var f = pct / 100;
    r = Math.max(0, Math.min(255, Math.round(r + (f > 0 ? (255 - r) * f : r * f))));
    g = Math.max(0, Math.min(255, Math.round(g + (f > 0 ? (255 - g) * f : g * f))));
    b = Math.max(0, Math.min(255, Math.round(b + (f > 0 ? (255 - b) * f : b * f))));
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }

  function restoreState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      conversationId = data.conversationId || null;
      messages = Array.isArray(data.messages) ? data.messages : [];
      leadCaptured = !!data.leadCaptured;
      lead = data.lead || { name: '', phone: '', email: '' };
    } catch (e) { /* ignore */ }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        conversationId: conversationId,
        messages: messages.slice(-80),
        leadCaptured: leadCaptured,
        lead: lead
      }));
    } catch (e) { /* ignore */ }
  }

  function injectStyles() {
    if (document.getElementById('aa-widget-styles')) return;
    var s = document.createElement('style');
    s.id = 'aa-widget-styles';
    s.textContent = [
      '#aa-widget-root,#aa-widget-root *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;}',
      '#aa-widget-root{position:fixed;z-index:2147483646;}',
      '.aa-bubble{position:fixed;bottom:20px;right:20px;width:60px;height:60px;border-radius:50%;background:' + PRIMARY + ';border:none;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;color:#fff;font-size:28px;line-height:1;transition:transform .15s,background .15s;z-index:2147483646;padding:0;}',
      '.aa-bubble:hover{background:' + PRIMARY_DARK + ';transform:scale(1.05);}',
      '.aa-bubble svg{width:28px;height:28px;fill:#fff;}',
      '.aa-bubble-dot{position:absolute;top:6px;right:6px;width:11px;height:11px;background:#22c55e;border-radius:50%;border:2px solid #fff;}',
      '.aa-panel{position:fixed;bottom:90px;right:20px;width:380px;height:580px;max-height:calc(100vh - 110px);background:#0f1923;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.4);display:none;flex-direction:column;overflow:hidden;color:#e4e7ee;z-index:2147483646;border:1px solid #1a2535;}',
      '.aa-panel.aa-open{display:flex;}',
      '.aa-header{background:#0a1118;padding:14px 16px;display:flex;align-items:center;gap:11px;border-bottom:1px solid #1a2535;flex-shrink:0;}',
      '.aa-logo{width:36px;height:36px;border-radius:9px;background:' + PRIMARY + ';color:#0f1923;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:16px;flex-shrink:0;}',
      '.aa-h-text{flex:1;min-width:0;}',
      '.aa-h-title{color:#fff;font-size:14px;font-weight:600;line-height:1.2;}',
      '.aa-h-sub{color:#7a8fa6;font-size:11px;margin-top:2px;display:flex;align-items:center;gap:5px;}',
      '.aa-h-dot{width:6px;height:6px;background:#22c55e;border-radius:50%;box-shadow:0 0 0 3px rgba(34,197,94,.2);}',
      '.aa-close{background:none;border:none;color:#7a8fa6;font-size:24px;line-height:1;cursor:pointer;padding:4px 6px;border-radius:6px;}',
      '.aa-close:hover{color:' + PRIMARY + ';background:#1a2535;}',
      '.aa-body{flex:1;overflow-y:auto;padding:14px 14px 6px;display:flex;flex-direction:column;gap:9px;background:#0a1118;}',
      '.aa-msg{max-width:84%;padding:9px 13px;border-radius:14px;font-size:13.5px;line-height:1.45;word-wrap:break-word;white-space:pre-wrap;}',
      '.aa-msg.aa-ai{background:#1a2535;color:#e4e7ee;align-self:flex-start;border-bottom-left-radius:4px;border:1px solid #243450;}',
      '.aa-msg.aa-user{background:' + PRIMARY + ';color:#0f1923;align-self:flex-end;border-bottom-right-radius:4px;font-weight:500;}',
      '.aa-typing{align-self:flex-start;background:#1a2535;border:1px solid #243450;padding:11px 14px;border-radius:14px;border-bottom-left-radius:4px;display:flex;gap:4px;}',
      '.aa-tdot{width:6px;height:6px;background:#7a8fa6;border-radius:50%;animation:aa-bounce 1s infinite;}',
      '.aa-tdot:nth-child(2){animation-delay:.15s;}',
      '.aa-tdot:nth-child(3){animation-delay:.3s;}',
      '@keyframes aa-bounce{0%,60%,100%{transform:translateY(0);opacity:.5;}30%{transform:translateY(-5px);opacity:1;}}',
      '.aa-lead{background:#0f1923;border:1px solid #1a2535;border-radius:12px;padding:13px;margin-top:4px;}',
      '.aa-lead-h{font-size:12px;color:#fff;font-weight:600;margin-bottom:8px;}',
      '.aa-lead-h span{color:' + PRIMARY + ';}',
      '.aa-lead input{width:100%;background:#0a1118;border:1px solid #2a4060;border-radius:8px;padding:8px 11px;font-size:13px;color:#e4e7ee;outline:none;margin-bottom:7px;}',
      '.aa-lead input:focus{border-color:' + PRIMARY + ';}',
      '.aa-lead-btn{width:100%;background:' + PRIMARY + ';color:#0f1923;border:none;border-radius:8px;padding:9px;font-size:13px;font-weight:600;cursor:pointer;}',
      '.aa-lead-btn:hover{background:' + PRIMARY_DARK + ';color:#fff;}',
      '.aa-lead-skip{display:block;width:100%;background:none;border:none;color:#7a8fa6;font-size:11px;margin-top:6px;cursor:pointer;}',
      '.aa-lead-skip:hover{color:' + PRIMARY + ';}',
      '.aa-input-row{padding:10px 11px;border-top:1px solid #1a2535;display:flex;gap:8px;align-items:center;background:#0f1923;flex-shrink:0;}',
      '.aa-input{flex:1;background:#0a1118;border:1px solid #2a4060;border-radius:20px;padding:9px 14px;font-size:13.5px;color:#e4e7ee;outline:none;transition:border-color .15s;}',
      '.aa-input:focus{border-color:' + PRIMARY + ';}',
      '.aa-send{width:38px;height:38px;background:' + PRIMARY + ';border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
      '.aa-send:hover{background:' + PRIMARY_DARK + ';}',
      '.aa-send:disabled{opacity:.5;cursor:not-allowed;}',
      '.aa-send svg{width:15px;height:15px;fill:#0f1923;}',
      '.aa-footer{font-size:10px;color:#7a8fa6;text-align:center;padding:5px 10px 8px;background:#0f1923;}',
      '.aa-footer a{color:' + PRIMARY + ';text-decoration:none;}',
      '@media (max-width:480px){',
      '  .aa-panel{width:100vw;height:100vh;max-height:100vh;bottom:0;right:0;border-radius:0;border:none;}',
      '  .aa-bubble{bottom:14px;right:14px;}',
      '}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function buildDom() {
    var root = el('div', { id: 'aa-widget-root' });

    var bubble = el('button', { class: 'aa-bubble', 'aria-label': 'Open chat' });
    bubble.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-4 9h-3v3h-2v-3H8V9h3V6h2v3h3v2z"/></svg><span class="aa-bubble-dot"></span>';

    var panel = el('div', { class: 'aa-panel', role: 'dialog', 'aria-label': TITLE });
    var initial = (TITLE.charAt(0) || 'A').toUpperCase();
    var header = el('div', { class: 'aa-header' });
    header.innerHTML =
      '<div class="aa-logo">' + escapeHtml(initial) + '</div>' +
      '<div class="aa-h-text">' +
        '<div class="aa-h-title">' + escapeHtml(TITLE) + '</div>' +
        '<div class="aa-h-sub"><span class="aa-h-dot"></span>' + escapeHtml(SUBTITLE) + '</div>' +
      '</div>' +
      '<button class="aa-close" aria-label="Close">×</button>';

    var body = el('div', { class: 'aa-body', id: 'aa-body' });

    var inputRow = el('div', { class: 'aa-input-row' });
    inputRow.innerHTML =
      '<input class="aa-input" id="aa-input" placeholder="Type your message…" autocomplete="off"/>' +
      '<button class="aa-send" id="aa-send" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg></button>';

    var footer = el('div', { class: 'aa-footer', html: 'Powered by <a href="https://autoadvisoragent.com" target="_blank" rel="noopener">AutoAdvisor AI</a>' });

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(inputRow);
    panel.appendChild(footer);

    root.appendChild(bubble);
    root.appendChild(panel);

    return { root: root, bubble: bubble, panel: panel, body: body };
  }

  function bindEvents() {
    dom.bubble.addEventListener('click', toggleOpen);
    dom.panel.querySelector('.aa-close').addEventListener('click', toggleOpen);
    var input = dom.panel.querySelector('#aa-input');
    var send = dom.panel.querySelector('#aa-send');
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendMessage(); });
    send.addEventListener('click', sendMessage);
  }

  function toggleOpen() {
    var isOpen = dom.panel.classList.toggle('aa-open');
    if (isOpen) {
      if (!messages.length) {
        addMessage('ai', GREETING, false);
      }
      setTimeout(function () { dom.panel.querySelector('#aa-input').focus(); }, 50);
      scrollToBottom();
    }
  }

  function addMessage(role, content, persist) {
    messages.push({ role: role, content: content, ts: Date.now() });
    if (persist !== false) saveState();
    renderMessages();
  }

  function renderMessages() {
    var body = dom.body;
    body.innerHTML = '';
    messages.forEach(function (m) {
      var b = el('div', { class: 'aa-msg ' + (m.role === 'customer' ? 'aa-user' : 'aa-ai') });
      b.textContent = m.content;
      body.appendChild(b);
    });
    if (sending) {
      var t = el('div', { class: 'aa-typing', id: 'aa-typing', html: '<span class="aa-tdot"></span><span class="aa-tdot"></span><span class="aa-tdot"></span>' });
      body.appendChild(t);
    }
    if (shouldShowLeadForm() && !leadShown) {
      body.appendChild(buildLeadForm());
      leadShown = true;
    }
    scrollToBottom();
  }

  function shouldShowLeadForm() {
    if (leadCaptured) return false;
    var customerMsgs = messages.filter(function (m) { return m.role === 'customer'; }).length;
    return customerMsgs >= 3;
  }

  function buildLeadForm() {
    var box = el('div', { class: 'aa-lead' });
    box.innerHTML =
      '<div class="aa-lead-h">Want <span>' + escapeHtml(TITLE) + '</span> to follow up with you?</div>' +
      '<input type="text" id="aa-lead-name" placeholder="Your name"/>' +
      '<input type="tel" id="aa-lead-phone" placeholder="Phone number"/>' +
      '<input type="email" id="aa-lead-email" placeholder="Email (optional)"/>' +
      '<button class="aa-lead-btn" id="aa-lead-submit">Send my info</button>' +
      '<button class="aa-lead-skip" id="aa-lead-skip">Maybe later</button>';
    box.querySelector('#aa-lead-submit').addEventListener('click', submitLead);
    box.querySelector('#aa-lead-skip').addEventListener('click', function () {
      leadCaptured = true; saveState(); renderMessages();
    });
    return box;
  }

  function submitLead() {
    var name = dom.panel.querySelector('#aa-lead-name').value.trim();
    var phone = dom.panel.querySelector('#aa-lead-phone').value.trim();
    var email = dom.panel.querySelector('#aa-lead-email').value.trim();
    if (!name || !phone) { alert('Please enter your name and phone number.'); return; }
    lead = { name: name, phone: phone, email: email };
    leadCaptured = true;
    saveState();
    callApi('Customer shared contact info: ' + JSON.stringify(lead), { lead: lead, leadCapture: true }).catch(function () { });
    renderMessages();
    addMessage('ai', "Thanks " + name + "! I'll make sure someone follows up. Anything else I can help with right now?");
  }

  function scrollToBottom() {
    var body = dom.body;
    if (body) body.scrollTop = body.scrollHeight;
  }

  function sendMessage() {
    if (sending) return;
    var input = dom.panel.querySelector('#aa-input');
    var text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    addMessage('customer', text);
    callApi(text, {});
  }

  function callApi(text, extras) {
    sending = true;
    dom.panel.querySelector('#aa-send').disabled = true;
    renderMessages();
    var payload = {
      dealerId: DEALER_ID,
      message: text,
      conversationId: conversationId,
      lead: extras && extras.lead ? extras.lead : (leadCaptured ? lead : null),
      leadCapture: !!(extras && extras.leadCapture),
      pageUrl: location.href,
      pageTitle: document.title
    };
    return fetch(API_BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        sending = false;
        dom.panel.querySelector('#aa-send').disabled = false;
        if (!res.ok) throw new Error((res.data && res.data.error) || 'Chat error');
        if (res.data.conversationId) conversationId = res.data.conversationId;
        if (res.data.reply) addMessage('ai', res.data.reply);
        else renderMessages();
        saveState();
      })
      .catch(function (err) {
        sending = false;
        dom.panel.querySelector('#aa-send').disabled = false;
        addMessage('ai', "Sorry — I'm having trouble reaching the dealership right now. Please try again in a moment.");
        console.error('[AutoAdvisor]', err);
      });
  }

  function escapeHtml(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  window.AutoAdvisor = {
    open: function () { if (!dom.panel.classList.contains('aa-open')) toggleOpen(); },
    close: function () { if (dom.panel.classList.contains('aa-open')) toggleOpen(); },
    reset: function () {
      conversationId = null; messages = []; leadCaptured = false; leadShown = false;
      lead = { name: '', phone: '', email: '' };
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) { }
      renderMessages();
    }
  };
})();
