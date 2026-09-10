The backend tests and browser test server always use a temporary SQLite database and a mocked SMS provider. They do not import `api.main`, read production data, or send real SMS.

Backend tests:

```powershell
python -m pip install -r api/requirements.txt httpx
python -m unittest discover -s tests -v
```

For the browser flow, install Playwright into the ignored cache directory:

```powershell
npm install --no-save --prefix .cache/browser playwright
npx --prefix .cache/browser playwright install chromium
python tests/commission_smoke_server.py
```

In another terminal at the repository root:

```powershell
$env:NODE_PATH = (Resolve-Path .cache/browser/node_modules).Path
node tests/commission_browser_test.cjs
```

The browser test uses `http://127.0.0.1:8765`, resets only the test database, checks the admin and operator flows at desktop and mobile sizes, and writes screenshots to `.cache/commission-*.png`. It simulates a lost response after submission and verifies that a retry creates no duplicate SMS history. Stop the test server with Ctrl+C afterward. The test server and its reset endpoint are test tools only; run `api.main:app` for the real application.
