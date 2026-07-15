import { useQuery } from '@tanstack/react-query'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { User } from '../types'

const NAV = [
  { to: '/clusters', label: 'My Clusters', icon: '⬡' },
  { to: '/deploy',   label: 'Deploy',      icon: '▶' },
  { to: '/destroy',  label: 'Destroy',     icon: '✕' },
  { to: '/presets',  label: 'Presets',     icon: '◈' },
  { to: '/agents',   label: 'Agents',      icon: '◉' },
]

export default function Layout() {
  const navigate = useNavigate()
  const { data: user } = useQuery<User>({ queryKey: ['me'], queryFn: () => api.get('/auth/me') })

  async function logout() {
    await api.post('/auth/logout')
    navigate('/login')
    window.location.reload()
  }

  return (
    <div className="flex overflow-hidden bg-surface-0 w-full" style={{ height: '100dvh' }}>
      {/* Sidebar */}
      <aside className="w-52 flex flex-col border-r border-surface-4 bg-surface-1 shrink-0">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-surface-4">
          <span className="font-mono text-xl font-semibold tracking-tight">
            <span className="text-accent-cyan">Jen</span>
            <span className="text-accent-green">Ease</span>
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-4 space-y-0.5 px-2">
          {NAV.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded text-sm font-mono transition-colors ${
                  isActive
                    ? 'bg-surface-3 text-accent-cyan border-l-2 border-accent-cyan pl-[10px]'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-2'
                }`
              }
            >
              <span className="text-xs opacity-70">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>

        {/* User */}
        <div className="border-t border-surface-4 px-4 py-3">
          <p className="text-xs font-mono text-text-muted mb-1">signed in as</p>
          <p className="text-sm font-mono text-accent-green truncate">{user?.username}</p>
          <button
            onClick={logout}
            className="mt-2 text-xs font-mono text-text-muted hover:text-accent-red transition-colors"
          >
            sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-hidden bg-surface-1 min-h-0">
        <Outlet />
      </main>
    </div>
  )
}
