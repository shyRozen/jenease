const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  // 401 from Jenkins (wrong token/instance) on a real API call → force re-login
  // Exclude /auth/* and /clusters/active so normal "not logged in" state doesn't loop
  const isAuthEndpoint = path.startsWith('/auth/')
  const isPassiveCheck = path === '/clusters/active' || path === '/agents'
  if (res.status === 401 && !isAuthEndpoint && !isPassiveCheck) {
    await fetch(`${BASE}/auth/logout`, { method: 'POST', credentials: 'include' })
    window.location.href = '/'
    throw new Error('Session expired — please log in again')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw Object.assign(new Error(err.detail ?? 'Request failed'), { status: res.status })
  }
  return res.json()
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}
