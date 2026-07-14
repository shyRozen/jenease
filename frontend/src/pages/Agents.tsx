import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import SearchBar from '../components/SearchBar'
import { useLiveFilter } from '../hooks/useLiveFilter'

interface Agent {
  name: string
  status: 'offline' | 'idle' | 'busy'
  description: string
}

const STATUS_STYLE: Record<string, string> = {
  busy:    'text-accent-cyan bg-accent-cyan/10 border-accent-cyan/30',
  idle:    'text-accent-green bg-accent-green/10 border-accent-green/30',
  offline: 'text-text-muted bg-surface-3 border-surface-4',
}

export default function Agents() {
  const { data: agents = [], isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<Agent[]>('/agents'),
    refetchInterval: 20_000,
  })

  const { query, setQuery, filtered } = useLiveFilter(
    agents,
    a => `${a.name} ${a.status} ${a.description}`,
  )

  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-mono font-semibold text-text-primary">Agents</h1>
          <p className="text-xs font-mono text-text-muted mt-0.5">
            {agents.length} agent{agents.length !== 1 ? 's' : ''} · refreshes every 20s
          </p>
        </div>
        <SearchBar value={query} onChange={setQuery} placeholder="search agents…" className="w-56" />
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array(4).fill(null).map((_, i) => (
            <div key={i} className="card h-14 animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <p className="font-mono text-text-muted text-sm text-center py-16">
          {agents.length === 0 ? 'No agents found.' : 'No results.'}
        </p>
      )}

      {!isLoading && filtered.length > 0 && (
        <div className="space-y-1.5">
          {filtered.map(agent => (
            <div key={agent.name} className="card px-4 py-3 flex items-center justify-between gap-4">
              <span className="font-mono text-sm text-text-primary">{agent.name}</span>
              <span
                className={`text-[10px] font-mono px-2 py-0.5 rounded border uppercase tracking-wider ${STATUS_STYLE[agent.status]}`}
              >
                {agent.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
