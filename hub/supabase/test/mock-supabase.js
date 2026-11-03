// In-memory stand-in for supabase-js, enough to render every screen in tests.
(function () {
  const uid = () => crypto.randomUUID();
  const now = Date.now();
  const SH = 'b1', PL = 'b2', RF = 'b3';
  const db = {
    businesses: [
      { id: SH, name: 'Shark Pressure Washing', category: 'Pressure washing', artwork_path: 'art.png', active: true },
      { id: PL, name: 'Gulf Coast Plumbing', category: 'Plumbing', artwork_path: null, active: true },
      { id: RF, name: 'Peace River Roofing', category: 'Roofing', artwork_path: 'art.png', active: true }],
    blurbs: [
      { id: 'u1', business_id: SH, body: 'I\'d recommend Shark Pressure Washing. Locally owned, Naples to Sarasota.\n(941) 555-0100 · sharkpw.com', active: true, created_at: 1 },
      { id: 'u2', business_id: SH, body: 'Shark Pressure Washing soft washes roofs so nothing gets damaged.', active: true, created_at: 2 },
      { id: 'u3', business_id: RF, body: 'Peace River Roofing did our roof last year. Great crew.', active: true, created_at: 3 }],
    profiles: [
      { id: 'me', full_name: 'Cy Cox', business_id: SH, is_admin: true, active: true, created_at: new Date(now - 60 * 864e5).toISOString() },
      { id: 'p2', full_name: 'Pat Jones', business_id: PL, is_admin: false, active: true, created_at: new Date(now - 60 * 864e5).toISOString() },
      { id: 'p3', full_name: 'Dana Lee', business_id: RF, is_admin: false, active: true, created_at: new Date(now - 5 * 864e5).toISOString() }],
    referrals: [
      { id: 'r1', created_at: new Date(now - 40 * 6e4).toISOString(), created_by: 'p2', referrer_business_id: PL, referred_business_id: SH, post_url: 'https://www.facebook.com/groups/1/posts/9', note: 'Lanai and driveway in Punta Gorda' },
      { id: 'r2', created_at: new Date(now - 26 * 36e5).toISOString(), created_by: 'p3', referrer_business_id: RF, referred_business_id: PL, post_url: 'https://www.facebook.com/groups/1/posts/8', note: null },
      { id: 'r3', created_at: new Date(now - 3 * 864e5).toISOString(), created_by: 'me', referrer_business_id: SH, referred_business_id: RF, post_url: 'https://www.facebook.com/groups/1/posts/7', note: null }],
    backups: [
      { referral_id: 'r1', user_id: 'p2', business_id: PL, blurb_id: 'u1' },
      { referral_id: 'r2', user_id: 'p3', business_id: RF, blurb_id: null },
      { referral_id: 'r3', user_id: 'me', business_id: SH, blurb_id: 'u3' },
      { referral_id: 'r3', user_id: 'p2', business_id: PL, blurb_id: null }]
  };
  window.__db = db;
  const signedIn = !window.__signedOut;
  function Q(table) {
    let rows = null, filters = [], embed = null, op = 'select', payload = null, single = false, maybe = false, ord = null;
    const api = {
      select(s) { if (op === 'select') op = 'select'; const m = /(\w+)\(([^)]*)\)/.exec(s || ''); if (m) embed = m[1]; return api; },
      order(c, o) { ord = [c, !(o && o.ascending === false)]; return api; },
      gte(c, v) { filters.push((r) => r[c] >= v); return api; },
      eq(c, v) { filters.push((r) => r[c] === v); return api; },
      ilike(c, v) { filters.push((r) => String(r[c]).toLowerCase() === v.toLowerCase()); return api; },
      insert(p) { op = 'insert'; payload = p; return api; },
      update(p) { op = 'update'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      single() { single = true; return api; },
      maybeSingle() { maybe = true; return api; },
      then(ok, bad) { return Promise.resolve(run()).then(ok, bad); }
    };
    function run() {
      const t = db[table];
      if (op === 'insert') {
        const r = Object.assign({ id: uid(), created_at: new Date().toISOString(), active: true }, payload);
        if (table === 'referrals') { r.created_by = 'me'; r.referrer_business_id = SH;
          if (t.some((x) => x.post_url.toLowerCase() === r.post_url.toLowerCase() && x.referred_business_id === r.referred_business_id))
            return { data: null, error: { code: '23505', message: 'duplicate' } };
          db.backups.push({ referral_id: r.id, user_id: 'me', business_id: SH, blurb_id: null }); }
        if (table === 'backups') { r.user_id = 'me'; r.business_id = SH; }
        t.push(r); return { data: single ? r : [r], error: null };
      }
      let out = t.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') { out.forEach((r) => Object.assign(r, payload)); return { data: out, error: null }; }
      if (op === 'delete') { db[table] = t.filter((r) => !out.includes(r)); return { data: out, error: null }; }
      out = out.map((r) => embed ? Object.assign({}, r, { [embed]: db[embed].filter((b) => b.referral_id === r.id) }) : Object.assign({}, r));
      if (ord) out.sort((a, b) => (a[ord[0]] > b[ord[0]] ? 1 : -1) * (ord[1] ? 1 : -1));
      if (single || maybe) return { data: out[0] || null, error: null };
      return { data: out, error: null };
    }
    return api;
  }
  window.supabase = { createClient() {
    return {
      from: Q,
      rpc(name) { const v = { slack_enabled: false, get_settings: { join_code: 'TCSA4821', app_url: '', slack_set: false } }[name];
        return Promise.resolve({ data: v === undefined ? null : v, error: null }); },
      auth: {
        getSession: async () => ({ data: { session: signedIn ? { user: { id: 'me' } } : null } }),
        signInWithPassword: async () => ({ error: { message: 'Invalid login credentials' } }),
        signUp: async () => ({ data: { session: null }, error: null }), signOut: async () => ({}) },
      storage: { from() { return { getPublicUrl: (p) => ({ data: { publicUrl: 'art-sample.png' } }), upload: async () => ({ error: null }) }; } }
    };
  } };
})();
