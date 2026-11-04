/* TCSA Referral Hub — single-page app, no build step. */
(function () {
'use strict';

const CFG = window.TCSA_CONFIG || {};
const BRAND = (CFG.supabaseUrl || '') + '/storage/v1/object/public/branding/';
const $ = (s) => document.querySelector(s);
const main = $('#main');

// ---------------------------------------------------------------- helpers
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  if (value !== undefined) el.value = value;
  return el;
}
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
};
function ago(ts) {
  const d = new Date(ts), s = (Date.now() - d) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 7 * 86400) return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function setStatus(el, msg, kind) { el.textContent = msg || ''; el.className = 'status' + (kind ? ' ' + kind : ''); }
function errText(e) {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e);
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Could not reach the server. Check your connection and try again.';
  return m;
}
function hash(str) { let x = 2166136261; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
function isFbUrl(u) { try { const p = new URL(u); return /^https?:$/.test(p.protocol) && /(^|\.)(facebook\.com|fb\.com|fb\.watch)$/i.test(p.hostname); } catch (e) { return false; } }

// ---------------------------------------------------------------- clipboard
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch (e) {
    const ta = h('textarea', { readonly: true, style: 'position:fixed;opacity:0;top:0' }); ta.value = t;
    document.body.append(ta); ta.select(); ta.setSelectionRange(0, t.length);
    let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove(); if (!ok) throw e; return true;
  }
}
async function copyImage(blob) {
  if (!(window.ClipboardItem && navigator.clipboard && navigator.clipboard.write)) throw new Error('This browser cannot copy images.');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': Promise.resolve(blob) })]);
}
async function loadPng(url) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error('Artwork did not load');
  let blob = await res.blob();
  if (blob.type !== 'image/png') blob = await toPng(await blobToImage(blob));
  return blob;
}
function blobToImage(blob) {
  return new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = URL.createObjectURL(blob); });
}
function toPng(img, max) {
  let w = img.naturalWidth, hgt = img.naturalHeight;
  if (max && Math.max(w, hgt) > max) { const r = max / Math.max(w, hgt); w = Math.round(w * r); hgt = Math.round(hgt * r); }
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  c.getContext('2d').drawImage(img, 0, 0, w, hgt);
  return new Promise((ok) => c.toBlob(ok, 'image/png'));
}
async function saveImage(blob, url, name) {
  const file = new File([blob], (name || 'artwork') + '.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return 'shared'; }
  window.open(url, '_blank', 'noopener'); return 'opened';
}

// ---------------------------------------------------------------- data
let sb, session, me, D = { businesses: [], biz: {}, blurbs: [], members: [], mem: {} }, slackOn = false;

async function q(p) { const { data, error } = await p; if (error) throw error; return data; }
function artUrl(b) { return b && b.artwork_path ? sb.storage.from('artwork').getPublicUrl(b.artwork_path).data.publicUrl : null; }
function blurbsFor(bizId, all) { return D.blurbs.filter((x) => x.business_id === bizId && (all || x.active)); }

async function loadAll() {
  const [biz, blurbs, members, slack] = await Promise.all([
    q(sb.from('businesses').select('*').order('name')),
    q(sb.from('blurbs').select('*').order('created_at')),
    q(sb.from('profiles').select('*').order('full_name')),
    q(sb.rpc('slack_enabled'))
  ]);
  D.businesses = biz; D.biz = Object.fromEntries(biz.map((b) => [b.id, b]));
  D.blurbs = blurbs; D.members = members; D.mem = Object.fromEntries(members.map((m) => [m.id, m]));
  slackOn = !!slack;
}

// ---------------------------------------------------------------- phone alerts
const Push = {
  supported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
  isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); },
  standalone() { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; },
  reg: null,
  async registration() {
    if (!this.reg) this.reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    return this.reg;
  },
  async current() {
    if (!this.supported()) return null;
    try { return await (await this.registration()).pushManager.getSubscription(); } catch (e) { return null; }
  },
  key() {
    const b = CFG.vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b + '='.repeat((4 - b.length % 4) % 4));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  },
  async enable() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(perm === 'denied'
      ? 'Alerts are blocked for this app. Turn them on in your phone\'s Settings → Notifications, then try again.'
      : 'Alerts weren\'t allowed. Tap Turn on alerts again and choose Allow.');
    const r = await this.registration();
    let sub = await r.pushManager.getSubscription();
    if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: this.key() });
    const j = sub.toJSON();
    await q(sb.from('push_subscriptions').upsert(
      { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) },
      { onConflict: 'endpoint' }));
  },
  async disable() {
    const sub = await this.current();
    if (!sub) return;
    await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
  },
  async test() {
    const { data, error } = await sb.functions.invoke('send-push', { body: { test: true } });
    if (error) {
      let msg = error.message;
      try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (_) {}
      throw new Error(msg);
    }
    if (!data || !data.sent) throw new Error('The alert didn\'t go through. Turn alerts off and on again, then retry.');
    return data;
  }
};

// The alerts panel. compact=true shows a one-line version once alerts are on.
function alertsPanel(compact) {
  const box = h('div', { class: 'card alerts' }, h('p', { class: 'muted small' }, 'Checking alerts…'));
  const st = h('p', { class: 'status', role: 'status' });
  async function paint() {
    if (!Push.supported()) {
      if (Push.isIOS() && !Push.standalone()) {
        box.replaceChildren(
          h('h2', null, 'Get alerts on your iPhone'),
          h('p', null, 'iPhones only send alerts from the hub when it\'s on your home screen.'),
          h('ol', { class: 'howto' },
            h('li', null, 'Tap the Share button ', h('span', { class: 'kbd', 'aria-label': 'Share icon' }, '⬆'), ' at the bottom of Safari.'),
            h('li', null, 'Scroll down and tap ', h('b', null, 'Add to Home Screen'), ', then ', h('b', null, 'Add'), '.'),
            h('li', null, 'Open the hub from the new icon, sign in, and tap ', h('b', null, 'Turn on alerts'), '.')),
          h('p', { class: 'hint' }, 'Needs iOS 16.4 or newer. You\'ll sign in once more inside the home-screen app.'));
      } else {
        box.replaceChildren(h('h2', null, 'Alerts aren\'t available here'),
          h('p', { class: 'muted' }, 'This browser can\'t show alerts. On Android use Chrome. On iPhone, add the hub to your home screen from Safari.'));
      }
      return;
    }
    if (Notification.permission === 'denied') {
      box.replaceChildren(h('h2', null, 'Alerts are blocked'),
        h('p', { class: 'muted' }, 'Your phone is blocking alerts from the hub. Open your phone\'s Settings, find Notifications for TCSA Hub (or for your browser), and allow them. Then come back here.'));
      return;
    }
    const sub = await Push.current();
    if (sub) {
      const testBtn = h('button', { class: 'btn quiet sm', type: 'button', onclick: async () => {
        testBtn.disabled = true; setStatus(st, 'Sending…');
        try { await Push.test(); setStatus(st, 'Sent. It should appear in a few seconds.', 'ok'); }
        catch (e) { setStatus(st, errText(e), 'err'); }
        testBtn.disabled = false;
      } }, 'Send a test');
      const offBtn = h('button', { class: 'linkbtn', type: 'button', onclick: async () => {
        try { await Push.disable(); toast('Alerts turned off on this device'); paint(); } catch (e) { setStatus(st, errText(e), 'err'); }
      } }, 'Turn off');
      box.replaceChildren(
        h('div', { class: 'row between' }, h('h2', null, compact ? 'Alerts are on' : 'Alerts are on for this device'), h('span', { class: 'pill ok' }, 'On')),
        !compact && h('p', { class: 'muted small' }, 'You\'ll get an alert when someone logs a referral. Tapping it opens the referral card.'),
        h('div', { class: 'row' }, testBtn, offBtn), st);
      return;
    }
    const onBtn = h('button', { class: 'btn block', type: 'button', onclick: async () => {
      onBtn.disabled = true; setStatus(st, 'Turning on…');
      try { await Push.enable(); toast('Alerts are on'); paint(); }
      catch (e) { setStatus(st, errText(e), 'err'); onBtn.disabled = false; }
    } }, 'Turn on alerts');
    box.replaceChildren(h('h2', null, 'Get an alert for every new referral'),
      h('p', { class: 'muted small' }, 'Your phone will buzz when someone logs a referral, and tapping the alert opens it here.'),
      onBtn, st);
  }
  paint().catch(() => box.replaceChildren(h('p', { class: 'muted small' }, 'Couldn\'t check alerts on this device.')));
  box.dataset.compact = compact ? '1' : '';
  return box;
}

// ---------------------------------------------------------------- shell
function chrome(on) {
  $('#topbar').hidden = !on; $('#tabbar').hidden = !on;
  if (on) {
    $('#adminTab').hidden = !me.is_admin;
    $('#whoBtn').textContent = me.full_name;
  }
}
function markTab(tab) {
  document.querySelectorAll('.tabbar a').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
function show(...els) { main.replaceChildren(...els); window.scrollTo(0, 0); }
function errorPanel(e, retry) {
  return h('div', { class: 'card' }, h('h2', null, 'Something went wrong'), h('p', { class: 'err-box' }, errText(e)),
    retry && h('button', { class: 'btn', type: 'button', onclick: retry }, 'Try again'));
}

// ---------------------------------------------------------------- auth & join
function authView(mode) {
  chrome(false);
  const signup = mode === 'signup';
  const st = h('p', { class: 'status', role: 'status' });
  const email = h('input', { id: 'authEmail', type: 'email', autocomplete: 'email', required: true, inputmode: 'email' });
  const pw = h('input', { id: 'authPw', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', required: true, minlength: '8' });
  const btn = h('button', { class: 'btn block', type: 'submit' }, signup ? 'Create account' : 'Sign in');
  const form = h('form', { class: 'card', onsubmit: async (ev) => {
    ev.preventDefault(); btn.disabled = true; setStatus(st, signup ? 'Creating your account…' : 'Signing in…');
    try {
      if (signup) {
        const { data, error } = await sb.auth.signUp({ email: email.value.trim(), password: pw.value });
        if (error) throw error;
        if (!data.session) { setStatus(st, 'Check your email for a confirmation link, then come back and sign in.', 'ok'); btn.disabled = false; return; }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
        if (error) throw error;
      }
      boot();
    } catch (e) {
      const m = errText(e);
      setStatus(st, /Invalid login/i.test(m) ? 'That email and password don\'t match. Check them and try again.' : m, 'err');
      btn.disabled = false;
    }
  } },
    h('div', { class: 'field' }, h('label', { for: 'authEmail' }, 'Email'), email),
    h('div', { class: 'field' }, h('label', { for: 'authPw' }, 'Password'), pw, signup && h('span', { class: 'hint' }, 'At least 8 characters.')),
    btn, st,
    h('p', { class: 'small muted' }, signup ? 'Already have an account? ' : 'New to the hub? ',
      h('button', { class: 'linkbtn', type: 'button', onclick: () => authView(signup ? 'signin' : 'signup') }, signup ? 'Sign in' : 'Create an account')),
    !signup && h('p', { class: 'small muted' }, 'Forgot your password? Ask your ' + (CFG.shortName || 'group') + ' admin to reset it.')
  );
  show(h('div', { class: 'auth-hero' },
    h('img', { class: 'auth-logo', src: BRAND + 'logo-480-v3.jpg', alt: CFG.groupName || 'TCSA', width: '132', height: '126' }),
    h('span', { class: 'eyebrow' }, CFG.groupName || 'Referral group'),
    h('h1', null, h('span', { class: 'grad' }, 'Referral Hub')), h('p', { class: 'muted' }, 'Log referrals and back each other up on Facebook in a few taps.')), form);
}

function joinView() {
  chrome(false);
  const st = h('p', { class: 'status', role: 'status' });
  const name = h('input', { id: 'joinName', type: 'text', autocomplete: 'name', required: true, placeholder: 'First and last name' });
  const biz = h('select', { id: 'joinBiz', required: true },
    h('option', { value: '' }, 'Choose your business'),
    D.businesses.filter((b) => b.active).map((b) => h('option', { value: b.id }, b.name)));
  const code = h('input', { id: 'joinCode', type: 'text', autocomplete: 'off', autocapitalize: 'characters', required: true, placeholder: 'From your group admin' });
  const btn = h('button', { class: 'btn block', type: 'submit' }, 'Join the hub');
  show(
    h('div', { class: 'auth-hero' }, h('span', { class: 'eyebrow' }, 'One more step'), h('h1', null, 'Join your group')),
    h('form', { class: 'card', onsubmit: async (ev) => {
      ev.preventDefault(); btn.disabled = true; setStatus(st, 'Joining…');
      try { await q(sb.rpc('join_group', { p_code: code.value, p_name: name.value, p_business: biz.value })); boot(); }
      catch (e) { setStatus(st, errText(e), 'err'); btn.disabled = false; }
    } },
      h('div', { class: 'field' }, h('label', { for: 'joinName' }, 'Your name'), name),
      h('div', { class: 'field' }, h('label', { for: 'joinBiz' }, 'Your business'), biz,
        !D.businesses.length && h('span', { class: 'hint' }, 'No businesses are set up yet. Ask your admin to add them.')),
      h('div', { class: 'field' }, h('label', { for: 'joinCode' }, 'Group code'), code),
      btn, st,
      h('button', { class: 'linkbtn', type: 'button', onclick: signOut }, 'Use a different account'))
  );
}

async function signOut() { await sb.auth.signOut(); me = null; authView('signin'); }

// ---------------------------------------------------------------- to do
async function todoView() {
  markTab('todo');
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const refs = await q(sb.from('referrals').select('*, backups(user_id)').gte('created_at', since).order('created_at', { ascending: false }));
  const open = refs.filter((r) => !r.backups.some((b) => b.user_id === me.id));
  const done = refs.filter((r) => r.backups.some((b) => b.user_id === me.id));
  const item = (r, isDone) => {
    const b = D.biz[r.referred_business_id] || {}, who = D.mem[r.created_by];
    const url = artUrl(b);
    return h('a', { class: 'item' + (isDone ? ' is-done' : ''), href: '#/r/' + r.id },
      url ? h('img', { class: 'thumb', src: url, alt: '', loading: 'lazy' }) : h('span', { class: 'thumb', 'aria-hidden': 'true' }),
      h('div', { class: 'txt' }, h('h3', null, b.name || 'Business'),
        h('p', { class: 'small muted' }, (who ? who.full_name : 'Someone') + ' · ' + ago(r.created_at))),
      isDone ? h('span', { class: 'pill ok' }, 'Replied') : h('span', { class: 'pill new' }, r.backups.length + ' replied'));
  };
  const sub = await Push.current();
  return [
    !sub && alertsPanel(false),
    h('div', { class: 'row between' }, h('h1', null, open.length ? open.length + ' need your reply' : 'You\'re caught up'),
      h('button', { class: 'btn quiet sm', type: 'button', onclick: route }, 'Refresh')),
    open.length ? h('div', { class: 'list' }, open.map((r) => item(r, false)))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No referrals are waiting on you from the last 14 days. When someone logs one, it shows up here and you get an alert.'),
        h('a', { class: 'btn gold', href: '#/log' }, 'Log a referral')),
    done.length && h('h2', null, 'Done'),
    done.length && h('div', { class: 'list' }, done.slice(0, 15).map((r) => item(r, true)))
  ];
}

// ---------------------------------------------------------------- shared: blurb + artwork blocks
function blurbBlock(bizId, startIdx, onChange) {
  const list = blurbsFor(bizId);
  let i = startIdx || 0;
  const box = h('div', { class: 'blurb' });
  const st = h('p', { class: 'status', role: 'status' });
  const other = h('button', { class: 'btn quiet sm', type: 'button', onclick: () => { i++; paint(); setStatus(st, ''); } }, 'Different blurb');
  function cur() { return list.length ? list[((i % list.length) + list.length) % list.length] : null; }
  function paint() {
    const c = cur();
    box.textContent = c ? c.body : 'No blurb has been written for this business yet. Ask your admin to add one.';
    other.hidden = list.length < 2;
    if (onChange) onChange(c);
  }
  const copy = h('button', { class: 'btn grow', type: 'button', onclick: async () => {
    const c = cur(); if (!c) return;
    try { await copyText(c.body); setStatus(st, 'Text copied. Paste it into your Facebook reply.', 'ok'); }
    catch (e) { setStatus(st, 'Copy was blocked. Press and hold the text to copy it.', 'err'); }
  } }, 'Copy text');
  paint();
  return { el: h('div', { class: 'stack' }, box, h('div', { class: 'row' }, copy, other), st), current: cur };
}

function artBlock(biz) {
  const url = artUrl(biz);
  const st = h('p', { class: 'status', role: 'status' });
  if (!url) return h('div', { class: 'stack' }, h('p', { class: 'err-box' }, 'No artwork has been uploaded for this business yet.'));
  let blob = null;
  const img = h('img', { class: 'art', src: url, alt: biz.name + ' artwork' });
  loadPng(url).then((b) => { blob = b; }).catch(() => setStatus(st, 'The artwork is slow to load. Wait a moment, or press and hold the picture to copy it.', 'err'));
  const copy = h('button', { class: 'btn grow', type: 'button', onclick: async () => {
    if (!blob) { setStatus(st, 'Still loading the image. Try again in a second.', 'err'); return; }
    try { await copyImage(blob); setStatus(st, 'Image copied. Paste it into the same reply.', 'ok'); }
    catch (e) { setStatus(st, 'This phone blocked the copy. Tap Save image, or press and hold the picture.', 'err'); }
  } }, 'Copy image');
  const save = h('button', { class: 'btn ghost grow', type: 'button', onclick: async () => {
    if (!blob) return;
    try { const r = await saveImage(blob, url, biz.name.replace(/\W+/g, '-'));
      setStatus(st, r === 'shared' ? 'Choose Save Image, then attach it with the photo button on your reply.' : 'Press and hold the image to save it.', 'ok'); }
    catch (e) { if (e && e.name !== 'AbortError') setStatus(st, 'Press and hold the picture and choose Save.', 'err'); }
  } }, 'Save image');
  return h('div', { class: 'stack' }, img, h('div', { class: 'row' }, copy, save), st);
}

// ---------------------------------------------------------------- log a referral
function logView() {
  markTab('log');
  const others = D.businesses.filter((b) => b.active);
  const pick = h('select', { id: 'logBiz', required: true },
    h('option', { value: '' }, 'Choose a business'), others.map((b) => h('option', { value: b.id }, b.name + (b.category ? ' — ' + b.category : ''))));
  const kit = h('div', { class: 'stack' });
  let blurb = null;
  pick.addEventListener('change', () => {
    const b = D.biz[pick.value];
    if (!b) { kit.replaceChildren(); return; }
    const bb = blurbBlock(b.id, Math.floor(Math.random() * 10));
    blurb = bb;
    kit.replaceChildren(
      b.id === me.business_id && h('p', { class: 'err-box small' }, 'This is your own business. You can log it, but it doesn\'t earn race points.'),
      h('ol', { class: 'steps' },
        h('li', null, h('div', null, h('h3', null, 'Copy the text and reply on the post'), bb.el)),
        h('li', null, h('div', null, h('h3', null, 'Copy the artwork into the same reply'), artBlock(b))),
        h('li', null, h('div', null, h('h3', null, 'Post your reply, then copy the post link'),
          h('p', { class: 'hint' }, 'On the Facebook post, tap Share, then Copy link.')))));
  });

  const link = h('input', { id: 'logLink', type: 'url', required: true, inputmode: 'url', placeholder: 'https://www.facebook.com/groups/…' });
  const pasteBtn = h('button', { class: 'btn quiet sm', type: 'button', onclick: async () => {
    try { const t = (await navigator.clipboard.readText()).trim(); if (t) link.value = t; else link.focus(); }
    catch (e) { link.focus(); toast('Press and hold in the box and choose Paste'); }
  } }, 'Paste link');
  const note = h('input', { id: 'logNote', type: 'text', placeholder: 'Optional, e.g. "needs a roof cleaned in Punta Gorda"' });
  const st = h('p', { class: 'status', role: 'status' });
  const btn = h('button', { class: 'btn block', type: 'submit' }, 'Log referral');

  const form = h('form', { class: 'card', onsubmit: async (ev) => {
    ev.preventDefault();
    const url = link.value.trim();
    if (!pick.value) { setStatus(st, 'Choose the business you recommended.', 'err'); return; }
    if (!isFbUrl(url)) { setStatus(st, 'That doesn\'t look like a Facebook link. On the post, tap Share, then Copy link, and paste it here.', 'err'); return; }
    btn.disabled = true; setStatus(st, 'Logging…');
    try {
      const r = await q(sb.from('referrals').insert({ referred_business_id: pick.value, post_url: url, note: note.value.trim() || null }).select().single());
      const c = blurb && blurb.current();
      if (c) await sb.from('backups').update({ blurb_id: c.id }).eq('referral_id', r.id).eq('user_id', me.id);
      loggedView(r);
    } catch (e) {
      btn.disabled = false;
      if (e && e.code === '23505') {
        const ex = await sb.from('referrals').select('id').ilike('post_url', url).eq('referred_business_id', pick.value).maybeSingle();
        setStatus(st, 'This post is already logged for ' + D.biz[pick.value].name + '.', 'err');
        if (ex.data) st.append(' ', h('a', { href: '#/r/' + ex.data.id }, 'Open it'));
      } else setStatus(st, errText(e), 'err');
    }
  } },
    h('div', { class: 'field' }, h('label', { for: 'logBiz' }, 'Who did you recommend?'), pick),
    kit,
    h('div', { class: 'field' }, h('div', { class: 'row between' }, h('label', { for: 'logLink' }, 'Facebook post link'), pasteBtn), link),
    h('div', { class: 'field' }, h('label', { for: 'logNote' }, 'Note for the group'), note),
    btn, st);
  return [h('h1', null, 'Log a referral'), form];
}

function loggedView(r) {
  const b = D.biz[r.referred_business_id];
  const cardUrl = location.origin + location.pathname + '?r=' + r.id;
  const slackMsg = 'New referral: ' + b.name + '\nReferred by ' + me.full_name + ' (' + (D.biz[me.business_id] || {}).name + ')\nReferral card: ' + cardUrl + '\nFacebook post: ' + r.post_url;
  const st = h('p', { class: 'status', role: 'status' });
  show(h('div', { class: 'card' },
    h('span', { class: 'eyebrow' }, 'Logged'),
    h('h1', null, b.name + ' referral logged'),
    r.referred_business_id !== me.business_id && h('p', { class: 'pts-earned' }, '+10 race points for ' + ((D.biz[me.business_id] || {}).name || 'your business')),
    h('p', null, 'Everyone with alerts turned on has been notified' + (slackOn ? ', and a notice was posted in Slack.' : '.') + ' It\'s also on their To do list.'),
    !slackOn && h('details', { class: 'more' }, h('summary', null, 'Also post it in Slack?'),
      h('div', { class: 'stack' }, h('div', { class: 'blurb' }, slackMsg),
        h('button', { class: 'btn quiet', type: 'button', onclick: async () => {
          try { await copyText(slackMsg); setStatus(st, 'Copied. Paste it in Slack.', 'ok'); } catch (e) { setStatus(st, 'Press and hold the message to copy it.', 'err'); }
        } }, 'Copy Slack message'), st)),
    h('div', { class: 'row' }, h('a', { class: 'btn ghost grow', href: '#/r/' + r.id }, 'View referral card'), h('a', { class: 'btn quiet grow', href: '#/' }, 'Done'))));
}

// ---------------------------------------------------------------- referral card
async function cardView(id) {
  markTab('todo');
  const r = await q(sb.from('referrals').select('*, backups(user_id, blurb_id, done_at)').eq('id', id).maybeSingle());
  if (!r) return h('div', { class: 'card' }, h('h2', null, 'Referral not found'), h('p', { class: 'muted' }, 'It may have been removed.'), h('a', { class: 'btn', href: '#/' }, 'Back to to do'));
  const b = D.biz[r.referred_business_id] || { name: 'Business' };
  const who = D.mem[r.created_by], whoBiz = D.biz[r.referrer_business_id];
  const mine = r.backups.find((x) => x.user_id === me.id);

  // Pick a blurb no one has used on this post yet, varied per person.
  const list = blurbsFor(b.id);
  const used = new Set(r.backups.map((x) => x.blurb_id).filter(Boolean));
  let start = 0;
  if (mine && mine.blurb_id) start = Math.max(0, list.findIndex((x) => x.id === mine.blurb_id));
  else if (list.length) {
    const fresh = list.map((x, i) => i).filter((i) => !used.has(list[i].id));
    const pool = fresh.length ? fresh : list.map((x, i) => i);
    start = pool[hash(me.id + r.id) % pool.length];
  }
  const bb = blurbBlock(b.id, start);

  const doneSt = h('p', { class: 'status', role: 'status' });
  const doneBtn = h('button', { class: 'btn block' + (mine ? ' done' : ''), type: 'button' }, mine ? '✓ You replied · Undo' : 'Mark done');
  doneBtn.addEventListener('click', async () => {
    doneBtn.disabled = true;
    try {
      if (mine) { await q(sb.from('backups').delete().eq('referral_id', r.id).eq('user_id', me.id)); toast('Marked not done'); }
      else { const c = bb.current(); await q(sb.from('backups').insert({ referral_id: r.id, blurb_id: c ? c.id : null })); const pts = racePoints(r, Date.now() - new Date(r.created_at) <= 15 * 60000); toast(pts ? 'Marked done · +' + pts + ' race points' : 'Marked done'); }
      route();
    } catch (e) { setStatus(doneSt, errText(e), 'err'); doneBtn.disabled = false; }
  });

  const repliedNames = r.backups.map((x) => (D.mem[x.user_id] || {}).full_name).filter(Boolean);
  const canDelete = r.created_by === me.id || me.is_admin;
  const delWrap = h('div');
  const delBtn = canDelete && h('button', { class: 'linkbtn', type: 'button', onclick: () => {
    delWrap.replaceChildren(h('div', { class: 'confirm' }, h('p', null, 'Remove this referral for everyone? This can\'t be undone.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn danger sm', type: 'button', onclick: async () => {
          try { await q(sb.from('referrals').delete().eq('id', r.id)); toast('Referral removed'); location.hash = '#/'; }
          catch (e) { toast(errText(e)); }
        } }, 'Remove'),
        h('button', { class: 'btn quiet sm', type: 'button', onclick: () => delWrap.replaceChildren(delBtn) }, 'Keep it'))));
  } }, 'Remove referral');
  if (delBtn) delWrap.append(delBtn);

  return [
    h('div', { class: 'stack' },
      h('span', { class: 'eyebrow' }, 'Referral card'),
      h('h1', null, b.name),
      h('p', { class: 'muted small' }, 'Referred by ' + (who ? who.full_name : 'someone') + (whoBiz ? ' (' + whoBiz.name + ')' : '') + ' · ' + ago(r.created_at)),
      r.note && h('p', { class: 'err-box' }, r.note)),
    h('div', { class: 'card' },
      h('ol', { class: 'steps' },
        h('li', null, h('div', null, h('h3', null, 'Copy the text'), bb.el)),
        h('li', null, h('div', null, h('h3', null, 'Open the post and paste it in a reply'),
          h('a', { class: 'btn ghost block', href: r.post_url, target: '_blank', rel: 'noopener' }, 'Open Facebook post'))),
        h('li', null, h('div', null, h('h3', null, 'Copy the artwork and paste it in the same reply'), artBlock(b))),
        h('li', null, h('div', null, h('h3', null, 'Post it, then mark it done'), doneBtn, doneSt)))),
    h('div', { class: 'card' },
      h('h2', null, repliedNames.length + (repliedNames.length === 1 ? ' person has' : ' people have') + ' replied'),
      h('p', { class: 'muted small' }, repliedNames.join(', ') || 'No one yet.'),
      delWrap)
  ];
}

// ---------------------------------------------------------------- stats
let statRange = 30;
async function statsView() {
  markTab('stats');
  const since = statRange ? new Date(Date.now() - statRange * 86400000).toISOString() : '2000-01-01';
  const refs = await q(sb.from('referrals').select('id, created_at, created_by, referrer_business_id, referred_business_id, backups(user_id)').gte('created_at', since));
  const replies = refs.reduce((n, r) => n + r.backups.length, 0);

  const bizRows = D.businesses.map((b) => ({
    b, given: refs.filter((r) => r.referrer_business_id === b.id).length, got: refs.filter((r) => r.referred_business_id === b.id).length
  })).sort((a, c) => c.got - a.got || c.given - a.given);

  const memRows = D.members.filter((m) => m.active).map((m) => {
    const eligible = refs.filter((r) => new Date(r.created_at) >= new Date(m.created_at));
    const replied = eligible.filter((r) => r.backups.some((x) => x.user_id === m.id)).length;
    return { m, logged: refs.filter((r) => r.created_by === m.id).length, replied, eligible: eligible.length,
      rate: eligible.length ? replied / eligible.length : null };
  }).sort((a, c) => (c.rate ?? -1) - (a.rate ?? -1) || c.replied - a.replied);

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Date range' },
    [[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All time']].map(([d, l]) =>
      h('button', { type: 'button', 'aria-pressed': String(statRange === d), onclick: () => { statRange = d; route(); } }, l)));

  return [
    h('h1', null, 'Group stats'), seg,
    h('div', { class: 'kpis' },
      h('div', { class: 'kpi' }, h('b', null, refs.length), h('span', null, 'Referrals')),
      h('div', { class: 'kpi' }, h('b', null, replies), h('span', null, 'Replies on posts')),
      h('div', { class: 'kpi' }, h('b', null, refs.length ? (replies / refs.length).toFixed(1) : '0'), h('span', null, 'Replies per referral'))),
    h('div', { class: 'card' }, h('h2', null, 'By business'),
      h('div', { class: 'tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Business'), h('th', { class: 'num' }, 'Given'), h('th', { class: 'num' }, 'Received'))),
        h('tbody', null, bizRows.map((x) => h('tr', null, h('td', null, x.b.name), h('td', { class: 'num' }, x.given), h('td', { class: 'num' }, x.got))))))),
    h('div', { class: 'card' }, h('h2', null, 'By member'),
      h('p', { class: 'hint' }, 'Reply rate counts referrals logged since the person joined.'),
      h('div', { class: 'tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Member'), h('th', { class: 'num' }, 'Logged'), h('th', { class: 'num' }, 'Replied'), h('th', { class: 'num' }, 'Rate'), h('th', null, ''))),
        h('tbody', null, memRows.map((x) => h('tr', null,
          h('td', null, x.m.full_name, h('div', { class: 'small muted' }, (D.biz[x.m.business_id] || {}).name || '')),
          h('td', { class: 'num' }, x.logged), h('td', { class: 'num' }, x.replied + ' / ' + x.eligible),
          h('td', { class: 'num' }, x.rate == null ? '–' : Math.round(x.rate * 100) + '%'),
          h('td', null, h('div', { class: 'bar' }, h('span', { style: 'width:' + Math.round((x.rate || 0) * 100) + '%' })))))))))
  ];
}

// ---------------------------------------------------------------- admin
function adminTabs(cur) {
  return h('nav', { class: 'tabs', 'aria-label': 'Admin' },
    [['biz', '#/admin', 'Businesses'], ['members', '#/admin/members', 'Members'], ['settings', '#/admin/settings', 'Settings']].map(([k, href, l]) =>
      h('a', { href, 'aria-current': cur === k ? 'page' : null }, l)));
}

function adminBizList() {
  const name = h('input', { id: 'newBizName', type: 'text', required: true, placeholder: 'Business name' });
  const cat = h('input', { id: 'newBizCat', type: 'text', placeholder: 'Trade, e.g. Plumbing' });
  const st = h('p', { class: 'status', role: 'status' });
  return [
    h('h1', null, 'Admin'), adminTabs('biz'),
    h('div', { class: 'list' }, D.businesses.map((b) => {
      const n = blurbsFor(b.id).length, url = artUrl(b);
      return h('a', { class: 'item', href: '#/admin/b/' + b.id },
        url ? h('img', { class: 'thumb', src: url, alt: '' }) : h('span', { class: 'thumb' }),
        h('div', { class: 'txt' }, h('h3', null, b.name), h('p', { class: 'small muted' }, (b.category || 'No trade set') + ' · ' + n + (n === 1 ? ' blurb' : ' blurbs'))),
        !b.active ? h('span', { class: 'pill off' }, 'Hidden') : (!url || !n) ? h('span', { class: 'pill new' }, 'Needs setup') : h('span', { class: 'pill ok' }, 'Ready'));
    })),
    h('form', { class: 'card', onsubmit: async (ev) => {
      ev.preventDefault();
      try { const b = await q(sb.from('businesses').insert({ name: name.value.trim(), category: cat.value.trim() || null }).select().single());
        await loadAll(); location.hash = '#/admin/b/' + b.id; }
      catch (e) { setStatus(st, e.code === '23505' ? 'A business with that name already exists.' : errText(e), 'err'); }
    } }, h('h2', null, 'Add a business'),
      h('div', { class: 'field' }, h('label', { for: 'newBizName' }, 'Name'), name),
      h('div', { class: 'field' }, h('label', { for: 'newBizCat' }, 'Trade'), cat),
      h('button', { class: 'btn', type: 'submit' }, 'Add business'), st)
  ];
}

function adminBiz(id) {
  const b = D.biz[id];
  if (!b) return [adminTabs('biz'), h('p', null, 'Business not found.')];
  const name = h('input', { id: 'bizName', type: 'text', value: b.name });
  const cat = h('input', { id: 'bizCat', type: 'text', value: b.category || '' });
  const active = h('input', { id: 'bizActive', type: 'checkbox', checked: b.active });
  const st = h('p', { class: 'status', role: 'status' });

  const artSt = h('p', { class: 'status', role: 'status' });
  const file = h('input', { id: 'bizArt', type: 'file', accept: 'image/*' });
  file.addEventListener('change', async () => {
    const f = file.files[0]; if (!f) return;
    setStatus(artSt, 'Uploading…');
    try {
      const png = await toPng(await blobToImage(f), 1600);
      const path = b.id + '/' + Date.now() + '.png';
      const up = await sb.storage.from('artwork').upload(path, png, { contentType: 'image/png', cacheControl: '31536000' });
      if (up.error) throw up.error;
      await q(sb.from('businesses').update({ artwork_path: path }).eq('id', b.id));
      await loadAll(); toast('Artwork updated'); route();
    } catch (e) { setStatus(artSt, errText(e), 'err'); }
  });

  const blurbList = blurbsFor(b.id, true).map((x) => {
    const ta = h('textarea', { id: 'blurb-' + x.id, value: x.body, 'aria-label': 'Blurb text' });
    const s = h('p', { class: 'status', role: 'status' });
    return h('div', { class: 'stack' }, ta,
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', type: 'button', onclick: async () => {
          try { await q(sb.from('blurbs').update({ body: ta.value.trim() }).eq('id', x.id)); await loadAll(); setStatus(s, 'Saved.', 'ok'); } catch (e) { setStatus(s, errText(e), 'err'); }
        } }, 'Save'),
        h('button', { class: 'btn quiet sm', type: 'button', onclick: async () => {
          try { await q(sb.from('blurbs').update({ active: !x.active }).eq('id', x.id)); await loadAll(); route(); } catch (e) { setStatus(s, errText(e), 'err'); }
        } }, x.active ? 'Hide' : 'Show again'),
        !x.active && h('span', { class: 'pill off' }, 'Hidden'),
        h('button', { class: 'linkbtn', type: 'button', style: 'color:var(--bad)', onclick: async () => {
          try { await q(sb.from('blurbs').delete().eq('id', x.id)); await loadAll(); route(); } catch (e) { setStatus(s, errText(e), 'err'); }
        } }, 'Delete')), s);
  });
  const newBlurb = h('textarea', { id: 'newBlurb', placeholder: 'Write a new blurb. Include the phone number and website.' });
  const nbSt = h('p', { class: 'status', role: 'status' });
  const url = artUrl(b);

  return [
    h('a', { href: '#/admin', class: 'small' }, '← All businesses'),
    h('h1', null, b.name),
    h('form', { class: 'card', onsubmit: async (ev) => {
      ev.preventDefault();
      try { await q(sb.from('businesses').update({ name: name.value.trim(), category: cat.value.trim() || null, active: active.checked }).eq('id', b.id));
        await loadAll(); setStatus(st, 'Saved.', 'ok'); } catch (e) { setStatus(st, errText(e), 'err'); }
    } }, h('h2', null, 'Details'),
      h('div', { class: 'field' }, h('label', { for: 'bizName' }, 'Name'), name),
      h('div', { class: 'field' }, h('label', { for: 'bizCat' }, 'Trade'), cat),
      h('label', { class: 'check', for: 'bizActive' }, active, 'Show in the hub'),
      h('button', { class: 'btn', type: 'submit' }, 'Save details'), st),
    h('div', { class: 'card' }, h('h2', null, 'Artwork'),
      url ? h('img', { class: 'art', src: url, alt: b.name + ' artwork' }) : h('p', { class: 'muted' }, 'No artwork yet.'),
      h('div', { class: 'field' }, h('label', { for: 'bizArt' }, url ? 'Replace artwork' : 'Upload artwork'), file,
        h('span', { class: 'hint' }, 'Any image works. It\'s saved as a PNG so it copies cleanly on phones.')), artSt),
    h('div', { class: 'card' }, h('h2', null, 'Blurbs'),
      h('p', { class: 'hint' }, 'Write several. Each member gets a different one on the same post, so replies don\'t look copy-pasted.'),
      blurbList.length ? blurbList : h('p', { class: 'muted' }, 'No blurbs yet.'),
      h('div', { class: 'stack' }, h('label', { for: 'newBlurb' }, 'New blurb'), newBlurb,
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          if (!newBlurb.value.trim()) return;
          try { await q(sb.from('blurbs').insert({ business_id: b.id, body: newBlurb.value.trim() })); await loadAll(); toast('Blurb added'); route(); }
          catch (e) { setStatus(nbSt, errText(e), 'err'); }
        } }, 'Add blurb'), nbSt))
  ];
}

async function adminMembers() {
  const subs = await q(sb.from('push_subscriptions').select('user_id'));
  const subCount = {}; subs.forEach((x) => { subCount[x.user_id] = (subCount[x.user_id] || 0) + 1; });
  const withAlerts = D.members.filter((m) => m.active && subCount[m.id]).length;
  return [
    h('h1', null, 'Admin'), adminTabs('members'),
    h('p', { class: 'hint' }, 'New people join with the group code from Settings. Turn off "Active" to remove someone\'s access.'),
    h('p', null, h('b', null, withAlerts + ' of ' + D.members.filter((m) => m.active).length), ' active members have alerts turned on.'),
    h('div', { class: 'list' }, D.members.map((m) => {
      const s = h('span', { class: 'status small', role: 'status' });
      const save = async (patch) => { try { await q(sb.from('profiles').update(patch).eq('id', m.id)); await loadAll(); setStatus(s, 'Saved', 'ok'); } catch (e) { setStatus(s, errText(e), 'err'); } };
      const biz = h('select', { 'aria-label': 'Business for ' + m.full_name, onchange: (e) => save({ business_id: e.target.value }) },
        D.businesses.map((b) => h('option', { value: b.id, selected: b.id === m.business_id }, b.name)));
      const self = m.id === me.id;
      return h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h3', null, m.full_name),
          h('div', { class: 'row' }, self && h('span', { class: 'pill' }, 'You'),
            subCount[m.id] ? h('span', { class: 'pill ok' }, 'Alerts on') : h('span', { class: 'pill new' }, 'No alerts'))),
        biz,
        h('div', { class: 'row' },
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: m.is_admin, disabled: self, onchange: (e) => save({ is_admin: e.target.checked }) }), 'Admin'),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: m.active, disabled: self, onchange: (e) => save({ active: e.target.checked }) }), 'Active'),
          s));
    }))
  ];
}

async function adminSettings() {
  const s = await q(sb.rpc('get_settings'));
  const field = (id, label, val, hint, type) => {
    const inp = h('input', { id, type: type || 'text', value: val || '' });
    const st = h('p', { class: 'status', role: 'status' });
    return { inp, el: h('div', { class: 'field' }, h('label', { for: id }, label), inp, hint && h('span', { class: 'hint' }, hint), st), st };
  };
  const appDefault = location.origin + location.pathname;
  const code = field('setCode', 'Group code', s.join_code, 'Share this with members so they can join. Change it to stop new sign-ups.');
  const goal = field('setGoal', 'Monthly group goal', s.season_goal || '150', 'Total referrals the whole group aims for each month. Shown on the race board.', 'text');
  goal.inp.inputMode = 'numeric';
  const app = field('setApp', 'App address', s.app_url || appDefault, 'Used for the link in alerts and Slack notices.', 'url');
  const hook = field('setHook', 'Slack webhook URL', '', s.slack_set ? 'A webhook is set. Paste a new one to replace it.' : 'Not set. Slack notices are off.', 'url');
  hook.inp.placeholder = 'https://hooks.slack.com/services/…';
  const saveOne = async (key, f, val) => {
    try { await q(sb.rpc('set_setting', { p_key: key, p_value: val })); setStatus(f.st, 'Saved.', 'ok'); slackOn = (await q(sb.rpc('slack_enabled'))); }
    catch (e) { setStatus(f.st, errText(e), 'err'); }
  };
  return [
    h('h1', null, 'Admin'), adminTabs('settings'),
    h('div', { class: 'card' }, code.el, h('button', { class: 'btn', type: 'button', onclick: () => saveOne('join_code', code, code.inp.value.trim()) }, 'Save group code')),
    h('div', { class: 'card' }, goal.el, h('button', { class: 'btn', type: 'button', onclick: () => saveOne('season_goal', goal, goal.inp.value.trim()) }, 'Save goal')),
    h('div', { class: 'card' }, app.el, h('button', { class: 'btn', type: 'button', onclick: () => saveOne('app_url', app, app.inp.value.trim()) }, 'Save app address')),
    h('div', { class: 'card' }, h('h2', null, 'Slack notices (optional)'), h('p', { class: 'hint' }, 'Phone alerts work without Slack. Add a webhook only if the group also wants notices in a Slack channel.'), hook.el,
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => saveOne('slack_webhook_url', hook, hook.inp.value.trim()) }, 'Save webhook'),
        s.slack_set && h('button', { class: 'btn quiet', type: 'button', onclick: async () => { await saveOne('slack_webhook_url', hook, ''); route(); } }, 'Turn off notices')))
  ];
}

function meView() {
  markTab('');
  return [
    h('h1', null, 'My settings'),
    h('div', { class: 'card' }, h('h2', null, me.full_name), h('p', { class: 'muted' }, (D.biz[me.business_id] || {}).name || ''),
      h('p', { class: 'hint' }, 'To change your name or business, ask your admin.')),
    alertsPanel(false),
    h('button', { class: 'btn quiet block', type: 'button', onclick: signOut }, 'Sign out')
  ];
}

// ---------------------------------------------------------------- participation race
const RACE = { root: null, lanes: new Map(), data: null, timer: null, channel: null, pending: null };
const PLACE = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
const LANE_H = () => (document.body.classList.contains('tv') ? 92 : 64);

function racePoints(r, isFast) {
  // Mirrors the database scoring, for instant feedback only.
  if (r.referred_business_id === me.business_id) return 0;
  return isFast ? 5 : 3;
}

function boatEl(b) {
  const url = artUrl(b);
  const face = url ? h('img', { src: url, alt: '', loading: 'lazy' }) : h('span', { class: 'initials' }, b.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 60 16'); svg.setAttribute('class', 'hull'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="M2 3h56l-7 11H9z" fill="var(--bar)"/><path d="M2 3h56" stroke="var(--gold)" stroke-width="2"/>';
  return h('div', { class: 'boat' }, h('div', { class: 'face' }, face), svg);
}

function paintRace(data, flash) {
  const list = data.businesses;
  const lead = Math.max(1, ...list.map((b) => b.points));
  const H = LANE_H();
  const track = RACE.root.querySelector('.track');
  track.style.height = (list.length * H) + 'px';
  const seen = new Set();
  list.forEach((b, i) => {
    seen.add(b.id);
    let lane = RACE.lanes.get(b.id);
    const prev = lane ? Number(lane.dataset.place) : null;
    if (!lane) {
      lane = h('div', { class: 'lane' + (b.id === me.business_id ? ' mine' : '') },
        h('span', { class: 'place' }), h('div', { class: 'water' }, boatEl(D.biz[b.id] || b)),
        h('div', { class: 'tag' }, h('b', { class: 'pts' }), h('span', { class: 'nm' })));
      lane.style.top = (i * H) + 'px';
      track.append(lane); RACE.lanes.set(b.id, lane);
    }
    lane.dataset.place = b.place;
    lane.style.top = (i * H) + 'px';
    const pl = lane.querySelector('.place');
    pl.textContent = b.points > 0 ? PLACE(b.place) : '–';
    pl.className = 'place' + (b.points > 0 && b.place <= 3 ? ' p' + b.place : '');
    lane.querySelector('.pts').textContent = b.points + ' pts';
    lane.querySelector('.nm').textContent = b.name;
    lane.querySelector('.boat').style.left = 'calc((100% - var(--boat-w)) * ' + (b.points / lead).toFixed(3) + ')';
    lane.title = b.name + ': ' + b.logged + ' referrals logged, ' + b.backed + ' backups (' + b.fast + ' fast)';
    if (flash && prev && prev > b.place && b.points > 0) {
      lane.classList.remove('flash'); void lane.offsetWidth; lane.classList.add('flash');
      if (b.id === me.business_id) toast((D.biz[b.id] || b).name + ' moved up to ' + PLACE(b.place) + '!');
    }
  });
  for (const [id, lane] of RACE.lanes) if (!seen.has(id)) { lane.remove(); RACE.lanes.delete(id); }

  const leader = list[0];
  const daysLeft = Math.max(0, Math.ceil((new Date(data.season_end) - Date.now()) / 86400000));
  RACE.root.querySelector('.r-title').textContent = leader && leader.points > 0
    ? (list.filter((b) => b.place === 1).length > 1 ? 'Tied for the lead' : leader.name + ' leads')
    : 'The race is on';
  RACE.root.querySelector('.r-sub').textContent = data.label + ' race · ' + (daysLeft === 1 ? '1 day left' : daysLeft + ' days left');
  const pct = Math.min(100, Math.round((data.total_referrals / data.goal) * 100));
  RACE.root.querySelector('.goal-fill').style.width = pct + '%';
  RACE.root.querySelector('.goal-num').textContent = data.total_referrals + ' of ' + data.goal + ' referrals';
  RACE.root.querySelector('.goal-pct').textContent = pct >= 100 ? 'Goal reached!' : pct + '%';
  const mvp = RACE.root.querySelector('.mvp');
  mvp.textContent = data.mvp ? data.mvp.name + ' (' + ((D.biz[data.mvp.business_id] || {}).name || '') + ') · ' + data.mvp.points + ' pts' : 'No points scored yet this month';
}

async function refreshRace(flash) {
  if (!RACE.root || !RACE.root.isConnected) return;
  try { RACE.data = await q(sb.rpc('leaderboard', { p_offset: 0 })); paintRace(RACE.data, flash); } catch (e) { /* keep the last board */ }
}

function listenForRace() {
  if (RACE.channel) return;
  const kick = () => { clearTimeout(RACE.pending); RACE.pending = setTimeout(() => refreshRace(true), 700); };
  RACE.channel = sb.channel('race-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'referrals' }, kick)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'backups' }, kick)
    .subscribe();
}

async function raceView(tv) {
  markTab('race');
  const [now, last] = await Promise.all([q(sb.rpc('leaderboard', { p_offset: 0 })), q(sb.rpc('leaderboard', { p_offset: -1 }))]);
  RACE.lanes = new Map(); RACE.data = now;
  const lastWin = last.businesses[0] && last.businesses[0].points > 0 ? last.businesses[0] : null;
  RACE.root = h('section', { class: 'race' + (tv ? ' is-tv' : '') },
    h('div', { class: 'row between' },
      h('div', { class: 'stack', style: 'gap:2px' }, h('span', { class: 'eyebrow r-sub' }), h('h1', { class: 'r-title' })),
      tv ? h('a', { class: 'btn quiet sm', href: '#/race' }, 'Exit TV mode') : h('a', { class: 'btn quiet sm', href: '#/race/tv' }, 'TV mode')),
    h('div', { class: 'card goal' },
      h('div', { class: 'row between' }, h('h2', null, 'Group goal'), h('span', { class: 'goal-pct pill ok' })),
      h('div', { class: 'goal-bar', role: 'img', 'aria-label': 'Group goal progress' }, h('span', { class: 'goal-fill' })),
      h('p', { class: 'small muted goal-num' })),
    h('div', { class: 'card sea' }, h('div', { class: 'finish', 'aria-hidden': 'true' }), h('div', { class: 'track' })),
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', null, 'MVP of the month'), h('span', { class: 'pill' }, 'Top individual')),
      h('p', { class: 'mvp' }),
      lastWin && h('p', { class: 'small muted' }, last.label + ' winner: ', h('b', null, lastWin.name), ' with ' + lastWin.points + ' pts')),
    !tv && h('details', { class: 'card more' }, h('summary', null, 'How points work'),
      h('div', { class: 'tablewrap' }, h('table', null,
        h('tbody', null,
          h('tr', null, h('td', null, 'Log a referral for another business'), h('td', { class: 'num' }, '10')),
          h('tr', null, h('td', null, 'Back up someone else\'s referral'), h('td', { class: 'num' }, '3')),
          h('tr', null, h('td', null, 'Back up within 15 minutes'), h('td', { class: 'num' }, '+2')),
          h('tr', null, h('td', null, 'Referrals or backups for your own business'), h('td', { class: 'num' }, '0'))))),
      h('p', { class: 'hint' }, 'Points go to your business. One scoring referral per Facebook post per person. The race resets on the 1st of every month.')));
  requestAnimationFrame(() => paintRace(now, false));
  listenForRace();
  clearInterval(RACE.timer); RACE.timer = setInterval(() => refreshRace(true), 60000);
  return RACE.root;
}

// ---------------------------------------------------------------- router
async function route() {
  if (!me) return;
  const p = (location.hash || '#/').slice(1).split('/').filter(Boolean);
  document.body.classList.toggle('tv', p[0] === 'race' && p[1] === 'tv');
  if (p[0] !== 'race') clearInterval(RACE.timer);
  try {
    let v;
    if (p[0] === 'log') v = logView();
    else if (p[0] === 'race') v = await raceView(p[1] === 'tv');
    else if (p[0] === 'me') v = meView();
    else if (p[0] === 'r' && p[1]) v = await cardView(p[1]);
    else if (p[0] === 'stats') v = await statsView();
    else if (p[0] === 'admin' && me.is_admin) {
      markTab('admin');
      if (p[1] === 'members') v = await adminMembers();
      else if (p[1] === 'settings') v = await adminSettings();
      else if (p[1] === 'b' && p[2]) v = adminBiz(p[2]);
      else v = adminBizList();
    } else v = await todoView();
    show(...[].concat(v).filter(Boolean));
  } catch (e) { show(errorPanel(e, route)); }
}

async function boot() {
  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || !window.supabase) {
    show(h('div', { class: 'card' }, h('h1', null, 'Setup needed'), h('p', { class: 'muted' }, 'This hub isn\'t connected to its database yet. Fill in config.js.')));
    return;
  }
  sb = sb || window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  try {
    session = (await sb.auth.getSession()).data.session;
    if (!session) { authView('signin'); return; }
    me = await q(sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle());
    if (!me) {
      const biz = await q(sb.from('businesses').select('*').order('name'));
      D.businesses = biz; joinView(); return;
    }
    if (!me.active) { chrome(false); show(h('div', { class: 'card' }, h('h1', null, 'Access paused'), h('p', { class: 'muted' }, 'Your hub access is turned off. Contact your group admin.'), h('button', { class: 'btn quiet', type: 'button', onclick: signOut }, 'Sign out'))); return; }
    await loadAll();
    chrome(true);
    const after = store.get('tcsa_after'); if (after) { store.del('tcsa_after'); location.hash = after; }
    route();
  } catch (e) { show(errorPanel(e, boot)); }
}

// Slack links arrive as ?r=<id>; turn them into an in-app route.
(function () {
  const r = new URLSearchParams(location.search).get('r');
  if (r) { history.replaceState(null, '', location.pathname + '#/r/' + encodeURIComponent(r)); store.set('tcsa_after', '#/r/' + r); }
  else if (location.hash && location.hash !== '#/') store.set('tcsa_after', location.hash);
})();

$('#whoBtn').addEventListener('click', () => { location.hash = '#/me'; });
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && me && /^#\/?$/.test(location.hash || '#/')) route();
});
boot();
})();
