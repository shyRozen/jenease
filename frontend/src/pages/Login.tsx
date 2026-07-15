import { useState } from 'react'
import { api } from '../api/client'
import type { User } from '../types'

interface Props {
  onLogin: (user: User) => void
}

export default function Login({ onLogin }: Props) {
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await api.post<User>('/auth/login', { username, token, remember })
      // Full reload clears React Query cache and re-reads the new cookie
      window.location.href = '/'
    } catch (err: any) {
      setError(err.message ?? 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-0 flex items-center justify-center p-4">
      {/* grid lines background */}
      <div
        className="fixed inset-0 pointer-events-none opacity-[0.04]"
        style={{
          backgroundImage:
            'linear-gradient(#00d4ff 1px, transparent 1px), linear-gradient(90deg, #00d4ff 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />

      <div className="w-full max-w-sm relative">
        {/* logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-3">
            <span className="text-accent-cyan font-mono text-3xl font-semibold tracking-tight">
              Jen<span className="text-accent-green">Ease</span>
            </span>
          </div>
          <p className="text-text-secondary text-sm font-mono">
            Jenkins Cluster Control
          </p>
        </div>

        {/* card */}
        <div className="card p-6 shadow-glow">
          <div className="flex items-center gap-2 mb-5">
            <div className="w-1.5 h-5 bg-accent-cyan rounded-full" />
            <span className="text-text-secondary text-xs font-mono uppercase tracking-widest">
              Authenticate
            </span>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-mono text-text-secondary mb-1.5 uppercase tracking-wider">
                Username
              </label>
              <input
                className="input font-mono"
                placeholder="Username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-mono text-text-secondary mb-1.5 uppercase tracking-wider">
                API Token
              </label>
              <input
                className="input font-mono"
                type="password"
                placeholder="••••••••••••••••••••"
                value={token}
                onChange={e => setToken(e.target.value)}
                autoComplete="current-password"
                required
              />
              <p className="text-text-muted text-xs mt-1.5 font-mono">
                Jenkins → User → Configure → API Token
              </p>
            </div>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={remember}
                onChange={e => setRemember(e.target.checked)}
                className="accent-accent-cyan"
              />
              <span className="text-xs font-mono text-text-secondary">Remember me (30 days)</span>
            </label>

            {error && (
              <div className="flex items-center gap-2 text-accent-red text-xs font-mono bg-accent-red/10 border border-accent-red/20 rounded px-3 py-2">
                <span>✕</span>
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !username || !token}
              className="btn-primary w-full mt-2"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-surface-0/30 border-t-surface-0 rounded-full animate-spin" />
                  Authenticating…
                </span>
              ) : (
                'Connect'
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-text-muted text-xs font-mono mt-4">
          Token never stored on server
        </p>
      </div>
    </div>
  )
}
