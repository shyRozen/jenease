# E2E Tests (Playwright)

Full browser automation tests against a running JenEase instance using real Jenkins credentials. Tests open a real Chromium browser, log in, and interact with the UI end-to-end.

## Run

```bash
# From repo root
make test-e2e

# From frontend/
npx playwright test              # headless, all specs
npx playwright test --headed     # watch the browser
npx playwright test --ui         # interactive Playwright UI with time-travel
npx playwright test e2e/auth.spec.ts  # single spec
```

## Credentials

Tests read from `.env.test` at the repo root (gitignored, already created):

```
JENKINS_TEST_USER=srozen
JENKINS_TEST_TOKEN=<stage Jenkins API token>
```

The local dev servers auto-start via `webServer` in `playwright.config.ts` if they aren't already running.

## Config (`playwright.config.ts`)

- **`workers: 1`** — sequential, all tests share the same browser session
- **`retries: 1`** — one automatic retry on failure
- **`timeout: 60 000ms`** per test
- **`reuseExistingServer: true`** — uses already-running `:8099`/`:5199` if available
- **Credentials** loaded from `../.env.test` via dotenv

---

## `auth.spec.ts` — Authentication flows

Tests login, session display, and logout behaviour.

| Test | What it checks |
|---|---|
| `login with valid credentials shows My Clusters nav` | After filling username + token and submitting, the nav sidebar shows `My Clusters` and `Deploy` links — confirms the full login → session → page render path works |
| `shows signed-in username in sidebar` | After login, the username (`srozen`) is visible in the sidebar — confirms the session is correctly read by `/auth/me` and rendered |
| `logout returns to login page without reload loop` | Clicking `sign out` redirects to the login form; after 2 seconds the page stays stable on the login form — **regression guard** for the infinite reload loop bug where a 401 from `/auth/me` triggered `window.location.href='/'` indefinitely |

---

## `clusters.spec.ts` — My Clusters and All Clusters views

Tests cluster listing, navigation, and access control.

### My Clusters

| Test | What it checks |
|---|---|
| `My Clusters page loads and shows at least a heading` | Navigating to `/clusters` renders either the page heading or the `No active clusters` empty state — confirms the route resolves and the cluster list API call completes |
| `own clusters start with username` | Any clusters visible under My Clusters have links containing the test username — confirms the active cluster detection and owner filtering work correctly |

### All Clusters

| Test | What it checks |
|---|---|
| `All Clusters page loads with search bar` | The search input is visible after navigating to `/all-clusters` |
| `clusters show OCP and OCS versions` | At least one cluster row shows text matching `OCP 4.x` — **regression guard** for the bug where `ocp_version` was blank because `get_build()` had no SSO fallback |
| `clusters show platform chip` | At least one platform chip (`vSphere`, `AWS`, `IBM Cloud`, etc.) is visible — confirms the `detectPlatform()` logic and chip rendering work |
| `can navigate into a cluster detail page` | Clicking the first cluster link navigates to `/clusters/{name}` and the detail page renders ODF/health content |
| `non-owner cluster hides workload launcher` | For a cluster not owned by the test user, the `▶ Launch` button and workload launcher panel are absent — confirms the `isOwner` access control works in the UI |

---

## `deploy.spec.ts` — Deploy page flows

Tests the deployment catalog, cluster name handling, job modification, and build triggering. All tests switch to **list view** (`☰` button) since grid view doesn't expose the name inputs or ⚙ buttons.

| Test | What it checks |
|---|---|
| `job list loads with at least one row` | After the catalog loads, at least one `▶ Build` button is visible — confirms the `GET /api/jobs/deployments` endpoint and catalog rendering work |
| `cluster name fields exist and are editable` | Each job row has an editable `name` input that accepts typed text — confirms the input renders correctly and `onChange` works. Name pre-fill via the suggest-name API is covered separately by `test_api_jenkins.py` |
| `search filters job list` | Typing `vsphere` into the search bar reduces the list to only vSphere jobs — confirms the search filter logic works |
| `modify drawer opens and shows params` | Clicking ⚙ on a job row opens the modify drawer. If the catalog has params (warmed with real credentials), asserts `OCP_VERSION` and `OCS_VERSION` are visible. If the catalog was warmed anonymously (empty params), asserts the page didn't crash — graceful degradation for the anonymous-warmup case |
| `trigger a build and immediately abort it` | Clicks `▶ Build`, waits for the `/api/jobs/trigger` response (accepts 200 or 502 — stage Jenkins may reject API token POSTs), verifies the UI shows a toast (✓ or ✕). If triggered successfully (200), waits 8s then calls the abort endpoint via the browser session cookie and asserts the abort responded |

### Known limitations

- **Suggest-name pre-fill on first page load**: 76+ concurrent Jenkins calls for all job rows can take > 60s; the test doesn't wait for pre-fill and instead types manually
- **Stage Jenkins POST auth**: `buildWithParameters` may return 502 if the stage Jenkins instance rejects API token POSTs; the test accepts this as a known limitation and verifies the UI response rather than the Jenkins outcome
- **Catalog params with anonymous warmup**: If the backend started without valid credentials, the modify drawer shows no params; the test detects and logs this rather than failing
