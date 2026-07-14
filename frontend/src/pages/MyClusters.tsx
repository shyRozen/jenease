import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../api/client'
import ClusterCard from '../components/ClusterCard'
import SearchBar from '../components/SearchBar'
import { useLiveFilter } from '../hooks/useLiveFilter'

export default function MyClusters() {
  const location = useLocation()
  const [searchHighlight, setSearchHighlight] = useState(false)

  const { data: clusters = [], isLoading, error } = useQuery({
    queryKey: ['clusters'],
    queryFn: () => api.get<any[]>('/clusters/active'),
    refetchInterval: 30_000,
  })

  const { query, setQuery, filtered } = useLiveFilter(
    clusters,
    c => `${c.cluster_name} ${c.ocp_version} ${c.ocs_version} ${c.credentials_conf} ${c.platform_conf}`,
  )

  // On arrival from a Build trigger, pre-fill search with the new cluster name and blink
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const highlight = params.get('highlight')
    if (highlight) {
      setQuery(highlight)
      setSearchHighlight(false)
      // Small delay so the component mounts before triggering animation
      setTimeout(() => setSearchHighlight(true), 100)
    }
  }, [location.search])

  return (
    <div className="p-6 h-full overflow-y-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-mono font-semibold text-text-primary">My Clusters</h1>
          <p className="text-xs font-mono text-text-muted mt-0.5">
            {clusters.length} active · auto-refreshes every 30s
          </p>
        </div>

        <SearchBar
          value={query}
          onChange={setQuery}
          placeholder="vsphere ipv6 fips…"
          className="w-64"
          highlight={searchHighlight}
        />
      </div>

      {/* States */}
      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array(3).fill(null).map((_, i) => (
            <div key={i} className="card p-4 h-52 animate-pulse bg-surface-2" />
          ))}
        </div>
      )}

      {error && (
        <div className="text-accent-red font-mono text-sm">
          Failed to load clusters — {(error as Error).message}
        </div>
      )}

      {!isLoading && !error && filtered.length === 0 && (
        <div className="text-center py-20">
          <p className="font-mono text-text-muted text-sm">
            {clusters.length === 0 ? 'No active clusters found.' : 'No results for that search.'}
          </p>
        </div>
      )}

      {/* Cluster grid */}
      {!isLoading && filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(cluster => (
            <ClusterCard key={cluster.cluster_name} cluster={cluster} />
          ))}
        </div>
      )}
    </div>
  )
}
