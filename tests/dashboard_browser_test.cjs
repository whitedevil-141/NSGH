// Isolated browser regression test: every API and CDN request is intercepted.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer(async (req, res) => {
    const filename = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!filename.startsWith(root + path.sep)) return res.writeHead(403).end();
    try {
      const body = await fs.readFile(filename);
      res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  let checks = 0;
  const scenarios = async (run, { loggedIn = true, role = 'admin' } = {}) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const dialogs = [];
    const errors = [];
    const requests = [];
    let deleteStatus = 200;
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await context.addInitScript(({ loggedIn }) => {
      window.NSGH_API_BASE = 'http://api.test';
      if (loggedIn && !sessionStorage.getItem('initialized')) {
        sessionStorage.setItem('initialized', 'yes');
        sessionStorage.setItem('token', 'initial-token');
        sessionStorage.setItem('token_expiry', Math.floor(Date.now() / 1000) + 3600);
      }
    }, { loggedIn });
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.hostname === 'api.test') {
        requests.push({ path: url.pathname, method: request.method(), headers: request.headers() });
        let status = 200;
        let json = {};
        if (url.pathname === '/auth/login') json = { access_token: 'login-token', expires_in: 3600 };
        else if (url.pathname === '/auth/me') json = { role };
        else if (url.pathname === '/public/doctors/data') json = { doctors: [] };
        else if (url.pathname === '/public/staffs/data') json = { staffs: [] };
        else if (url.pathname === '/doctors/categories') json = [];
        if (request.method() === 'DELETE') {
          status = deleteStatus;
          json = { detail: status === 502 ? 'Image hosting authentication failed. Check the server SFTP credentials.' : 'Access denied' };
        }
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
      }
      if (url.origin !== origin) {
        return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: url.pathname.endsWith('.js')
          ? 'window.bootstrap = { Modal: class { static getInstance() { return { hide() {} }; } show() {} hide() {} } };' : '' });
      }
      return route.continue();
    });
    try {
      await page.goto(`${origin}/dashboard/${loggedIn ? 'dashboard' : 'login'}.html`);
      if (loggedIn) await page.waitForFunction(() => typeof deleteDoctor === 'function');
      await run({ page, dialogs, requests, setStatus: status => { deleteStatus = status; } });
      assert.deepEqual(errors, []);
      checks++;
    } finally { await context.close(); }
  };
  try {
    await scenarios(async ({ page, requests, dialogs }) => {
      await page.evaluate(() => sessionStorage.setItem('token', 'current-token'));
      for (const action of ['deleteDoctor', 'deleteStaff', 'deleteCategory']) {
        await page.evaluate(action => window[action](7), action);
      }
      const mutations = requests.filter(request => request.method === 'DELETE');
      assert.equal(mutations.length, 3);
      assert.ok(mutations.every(request => request.headers.authorization === 'Bearer current-token'));
      assert.equal(dialogs.filter(message => /^(Deleted|Category deleted)$/.test(message)).length, 3);
    });
    await scenarios(async ({ page, dialogs, setStatus }) => {
      setStatus(401);
      await page.evaluate(() => deleteDoctor(7)).catch(() => {});
      await page.waitForURL('**/dashboard/login.html');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('token')), null);
      assert.ok(!dialogs.includes('Deleted'));
    });
    await scenarios(async ({ page, requests }) => {
      await page.evaluate(() => sessionStorage.setItem('token_expiry', '1'));
      await page.evaluate(() => deleteStaff(7)).catch(() => {});
      await page.waitForURL('**/dashboard/login.html');
      assert.equal(requests.filter(request => request.method === 'DELETE').length, 0);
    });
    for (const status of [403, 502]) {
      await scenarios(async ({ page, dialogs, setStatus }) => {
        setStatus(status);
        await page.evaluate(() => deleteDoctor(7));
        assert.ok(page.url().endsWith('/dashboard/dashboard.html'));
        assert.equal(await page.evaluate(() => sessionStorage.getItem('token')), 'initial-token');
        assert.ok(!dialogs.includes('Deleted'));
        assert.ok(dialogs.some(message => status === 502 ? message.includes('SFTP credentials') : message.includes('Access denied')));
      });
    }
    await scenarios(async ({ page, requests }) => {
      await page.fill('[name=username]', 'admin');
      await page.fill('[name=password]', 'secret123');
      await page.click('button[type=submit]');
      await page.waitForURL('**/dashboard/dashboard.html');
      await page.waitForFunction(() => typeof deleteDoctor === 'function');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('token')), 'login-token');
      assert.equal(requests.find(request => request.path === '/auth/me').headers.authorization, 'Bearer login-token');
    }, { loggedIn: false });
    await scenarios(async ({ page, dialogs }) => {
      await page.fill('[name=username]', 'patient');
      await page.fill('[name=password]', 'secret123');
      const rejected = page.waitForEvent('dialog');
      await page.click('button[type=submit]');
      await rejected;
      assert.ok(page.url().endsWith('/dashboard/login.html'));
      assert.equal(await page.evaluate(() => sessionStorage.getItem('token')), null);
      assert.ok(dialogs.some(message => message.includes('admin account is required')));
    }, { loggedIn: false, role: 'user' });
    console.log(`Passed ${checks} dashboard browser scenarios.`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
