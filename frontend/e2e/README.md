# E2E Tests (Playwright)

Browser automation tests against a running JenEase instance. Uses real Jenkins credentials to verify end-to-end flows.

## Run

```bash
# From repo root
make test-e2e

# Or from frontend/
cd frontend
npx playwright test              # headless
npx playwright test --headed     # watch the browser
npx playwright test --ui         # interactive Playwright UI
```

## Credentials

Tests read from `.env.test` at the repo root (gitignored):

```
JENKINS_TEST_USER=srozen
JENKINS_TEST_TOKEN=<your stage Jenkins API token>
```

The local dev servers must be running (`ainu` or `make test-e2e` starts them automatically via `webServer` in `playwright.config.ts`).

## Test files

### `auth.spec.ts`
- Login with valid credentials → My Clusters nav visible
- Username shown in sidebar after login
- Logout → login page, no infinite reload loop

### `clusters.spec.ts`
- **My Clusters**: page loads, own cluster names start with username
- **All Clusters**: search bar present, OCP/OCS versions visible, platform chip visible, can navigate into cluster detail
- **Non-owner cluster**: workload launcher (right panel) is hidden — only the owner sees it

### `deploy.spec.ts`
- Job list loads with at least one row in list view
- Cluster name fields are visible, editable, accept input
- Search filters the job list
- Modify drawer (⚙) opens and shows param fields
- Trigger a build → UI shows response (✓ or ✕) → abort the build if it fired

## Known limitations

- **Suggest-name pre-fill**: 76+ concurrent Jenkins calls on page load can exceed timeouts. The backend test `test_suggest_name_*` covers this instead.
- **Stage Jenkins POST auth**: `trigger_job` via API token may return 401 on stage Jenkins (SSO-only write restriction). The E2E test accepts both 200 and 502 — the key assertion is that the UI responds correctly either way.
- **Catalog params (modify drawer)**: If the backend was warmed anonymously at startup (empty params), the modify drawer shows no fields. The test detects and logs this but doesn't fail — the backend job catalog test covers it.

## Config (`playwright.config.ts`)

- `workers: 1` — sequential execution, tests share a browser session
- `retries: 1` — one retry on failure
- `timeout: 60_000` — per-test timeout
- `reuseExistingServer: true` — uses already-running `:8099`/`:5199` if available
