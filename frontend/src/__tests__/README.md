# Frontend Component Tests

Vitest + Testing Library suite for React components. All tests run offline — API calls are intercepted by MSW (Mock Service Worker), no backend needed.

## Run

```bash
# From repo root
make test-frontend

# Or from frontend/
cd frontend
npm test              # single run
npm run test:watch    # re-runs on file save
```

## Files

| File | What it tests |
|---|---|
| `Deploy.test.tsx` | Jobs load and render, name field pre-fills with username+flavor, build button disabled when name empty |
| `AllClusters.test.tsx` | OCP/OCS versions rendered, platform chip visible, search filter hides non-matching clusters |
| `Sequences.test.tsx` | `count` field preserved in save/load, "N steps · M workloads" display logic |

## Setup files

| File | Purpose |
|---|---|
| `setup.ts` | MSW server lifecycle (start before tests, reset between tests, close after) |
| `helpers.tsx` | `renderWithProviders()` — wraps components with QueryClient + MemoryRouter |
| `mocks/server.ts` | MSW node server instance |
| `mocks/handlers.ts` | API mock handlers for `/auth/me`, `/clusters/all`, `/jobs/deployments`, `/suggest-name`, `/sequences/` |

## Adding a test

```tsx
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from './mocks/server'
import { renderWithProviders } from './helpers'
import MyComponent from '../components/MyComponent'

describe('MyComponent', () => {
  it('shows the thing', async () => {
    server.use(http.get('/api/something', () => HttpResponse.json({ data: 'value' })))
    renderWithProviders(<MyComponent />)
    await waitFor(() => expect(screen.getByText('expected text')).toBeInTheDocument())
  })
})
```

## Key regression guards

| Test | Bug it would have caught |
|---|---|
| `Deploy — pre-fills cluster name` | Name field empty on prod (`list_agents` missing SSO fallback) |
| `Sequences — count preserved` | `count` dropped to 1 when loading saved sequences |
| `Sequences — step · workloads label` | Sequence card showed "2 steps" instead of "2 steps · 5 workloads" |
| `AllClusters — OCP/OCS version` | OCP/OCS version blank (get_build missing SSO fallback) |
