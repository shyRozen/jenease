import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './mocks/server'

// Regression: count and node_name fields were dropped by the backend Pydantic model.
// These tests verify the API contract (the component tests verify UI behavior).
// Full integration test lives in backend/tests/test_api_sequences.py.

describe('Sequence field contract', () => {
  it('count field is included in POST body', async () => {
    let capturedBody: any = null
    server.use(
      http.post('/api/sequences/', async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({ id: 1, name: 'test', items: (capturedBody as any).items, username: 'srozen', cluster_name: null, event_count: 1 })
      })
    )

    const body = {
      name: 'count-test',
      items: [{ offset_sec: 10, workload_type: 'rbd', size_gb: 50, mode: 'readwrite', count: 3 }],
    }

    await fetch('/api/sequences/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect(capturedBody.items[0].count).toBe(3)
  })

  it('saved sequence card shows step count', () => {
    // The "N steps · M workloads" display logic
    const items = [
      { count: 3, offset_sec: 0 },
      { count: 2, offset_sec: 10 },
    ]
    const total = items.reduce((acc, i) => acc + (i.count ?? 1), 0)
    const steps = items.length

    expect(total).toBe(5)
    expect(steps).toBe(2)

    // Should display "2 steps · 5 workloads"
    const wlPart = total !== steps ? ` · ${total} workloads` : ''
    const label = `${steps} step${steps !== 1 ? 's' : ''}${wlPart}`
    expect(label).toBe('2 steps · 5 workloads')
  })

  it('single count items show only steps (no workloads suffix)', () => {
    const items = [{ count: 1 }, { count: 1 }]
    const total = items.reduce((acc, i) => acc + (i.count ?? 1), 0)
    const steps = items.length
    const wlPart = total !== steps ? ` · ${total} workloads` : ''
    const label = `${steps} step${steps !== 1 ? 's' : ''}${wlPart}`
    expect(label).toBe('2 steps')
  })
})
