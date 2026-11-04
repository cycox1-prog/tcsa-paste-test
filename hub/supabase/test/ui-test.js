// Renders every screen against the mock at phone width and reports errors.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '../..');
const out = process.argv[2];
(async () => {
  const b = await chromium.launch();
  const errors = [];
  async function page(opts) {
    const ctx = await b.newContext({ viewport: { width: opts.vw || 390, height: opts.vw ? 720 : 844 }, colorScheme: opts.dark ? 'dark' : 'light', userAgent: opts.ua });
    if (opts.noPush) await ctx.addInitScript(() => { delete window.PushManager; });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(opts.name + ': ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g|net::ERR/.test(m.text())) errors.push(opts.name + ' console: ' + m.text()); });
    await p.route('**/*', async (route) => {
      const u = route.request().url();
      if (u.includes('supabase-js')) return route.fulfill({ contentType: 'text/javascript',
        body: (opts.signedOut ? 'window.__signedOut=true;' : '') + fs.readFileSync(path.join(__dirname, 'mock-supabase.js'), 'utf8') });
      if (u.endsWith('config.js')) return route.fulfill({ contentType: 'text/javascript', body: 'window.TCSA_CONFIG={supabaseUrl:"x",supabaseAnonKey:"y",groupName:"Trusted Community Service Affiliates",shortName:"TCSA"}' });
      if (u.includes('art-sample.png')) return route.fulfill({ contentType: 'image/png', body: fs.readFileSync(path.join(root, 'icon-180.png')) });
      if (u.startsWith('file://')) return route.continue();
      return route.abort();
    });
    await p.goto('file://' + root + '/index.html' + (opts.q || '') + (opts.hash || ''));
    await p.waitForTimeout(400);
    return p;
  }
  const shots = [
    { name: 'signin', signedOut: true },
    { name: 'todo' }, { name: 'todo-dark', dark: true },
    { name: 'card', q: '?r=r1' },
    { name: 'log', hash: '#/log', act: async (p) => { await p.selectOption('#logBiz', 'b1'); await p.waitForTimeout(200); } },
    { name: 'stats', hash: '#/stats' }, { name: 'race', hash: '#/race' }, { name: 'race-dark', hash: '#/race', dark: true }, { name: 'race-tv', hash: '#/race/tv', vw: 1280 },
    { name: 'admin', hash: '#/admin' }, { name: 'admin-biz', hash: '#/admin/b/b1' },
    { name: 'admin-members', hash: '#/admin/members' }, { name: 'me', hash: '#/me' }, { name: 'iphone-todo', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', noPush: true }, { name: 'admin-settings', hash: '#/admin/settings' }
  ];
  for (const s of shots) {
    const p = await page(s);
    if (s.act) await s.act(p);
    const w = await p.evaluate(() => document.documentElement.scrollWidth);
    if (w > (s.vw || 390)) errors.push(s.name + ': page is ' + w + 'px wide');
    const text = await p.evaluate(() => document.querySelector('#main').innerText.slice(0, 120).replace(/\n/g, ' | '));
    console.log(s.name.padEnd(15), text);
    if (out) await p.screenshot({ path: path.join(out, s.name + '.png'), fullPage: true });
    // Flow checks
    if (s.name === 'card') {
      await p.click('text=Mark done'); await p.waitForTimeout(300);
      console.log('  after mark done:', await p.textContent('.btn.done').catch(() => 'NOT DONE'));
    }
    if (s.name === 'log') {
      await p.fill('#logLink', 'https://www.facebook.com/groups/1/posts/9'); await p.click('button[type=submit]'); await p.waitForTimeout(300);
      console.log('  duplicate:', await p.textContent('form .status:last-of-type'));
      await p.fill('#logLink', 'https://www.facebook.com/groups/1/posts/55'); await p.click('button[type=submit]'); await p.waitForTimeout(300);
      console.log('  logged:', (await p.textContent('#main')).slice(0, 90));
      if (out) await p.screenshot({ path: path.join(out, 'logged.png'), fullPage: true });
    }
    await p.context().close();
  }
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No errors');
  await b.close();
})();
