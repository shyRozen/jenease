# Frontend Component Tests

Vitest + Testing Library suite for React components. All API calls are intercepted by **MSW (Mock Service Worker)** — no backend or network required. Tests run in a jsdom environment.

## Run

```bash
# From repo root
make test-frontend

# From frontend/
npm test              # single run, all tests
npm run test:watch    # re-runs automatically on file save
```

## Setup files

| File | Purpose |
|---|---|
| `setup.ts` | Starts MSW server before tests, resets handlers between tests, shuts down after |
| `helpers.tsx` | `renderWithProviders()` — wraps UI in `QueryClientProvider` + `MemoryRouter` so components can use React Query and routing |
| `mocks/server.ts` | MSW node server instance |
| `mocks/handlers.ts` | Default API mock responses for every endpoint the tests touch |

### Default mock data (`mocks/handlers.ts`)

- **`/api/auth/me`** → `{ username: "srozen", full_name: "Shai Rozen" }`
- **`/api/clusters/all`** → one cluster: `srozen-v-vs` (vSphere, OCP 4.16, OCS 4.16)
- **`/api/jobs/deployments`** → one job: vSphere UPI vSAN with OCP/OCS version choices
- **`/api/suggest-name?flavor=...`** → `{ name: "srozen-{flavor}" }`
- **`/api/sequences/`** → empty list by default; POST returns a stub response

Individual tests override these with `server.use(...)` for specific scenarios.

---

## `Deploy.test.tsx` — Deploy page component tests

Tests the Deploy page in isolation using mock API data.

| Test | What it checks |
|---|---|
| `renders the search bar` | The search input with placeholder `vsphere ipv6 fips…` is present after the catalog loads |
| `shows job rows after loading` | At least one job row renders after the mock catalog is fetched — `vSphere` text visible |
| `pre-fills cluster name with username + flavor` | The cluster name input pre-fills with `srozen-v-vs` from the mocked suggest-name response — **regression guard** for the prod bug where the field stayed empty because `list_agents()` had no SSO fallback |
| `build button is disabled when name is empty` | When suggest-name returns `""`, all `▶ Build` buttons are disabled — prevents triggering with no cluster name |

---

## `AllClusters.test.tsx` — All Clusters page component tests

Tests the All Clusters page using a single mock cluster (`srozen-v-vs`).

| Test | What it checks |
|---|---|
| `shows cluster name` | The cluster name `srozen-v-vs` appears in the rendered list |
| `shows OCP version` | `OCP 4.16` text is visible — **regression guard** for the bug where OCP version was blank because `get_build` had no SSO fallback |
| `shows OCS version` | `OCS 4.16` text is visible — same regression guard |
| `shows platform label` | At least one `vSphere` label is rendered (appears in both the card chip and the filter chips) |
| `filters clusters by search` | Typing `nomatch` into the search input hides `srozen-v-vs` — verifies the live search filter works |

---

## `Sequences.test.tsx` — Sequence API contract + display logic

Tests the sequence `count` and `node_name` field contract (which was the root cause of the save/load bug) and the sequence card display label logic.

| Test | What it checks |
|---|---|
| `count field is included in POST body` | Intercepts the POST request and asserts `items[0].count === 3` — verifies the frontend sends `count` correctly (the backend Pydantic schema was missing this field, silently dropping it) |
| `saved sequence card shows step count` | The label logic for 2 steps with counts [3, 2] produces `"2 steps · 5 workloads"` — verifies the step-vs-workload distinction is correctly calculated |
| `single count items show only steps (no workloads suffix)` | When all steps have `count: 1`, the label shows `"2 steps"` without the workloads suffix — avoids showing redundant `"2 steps · 2 workloads"` |
