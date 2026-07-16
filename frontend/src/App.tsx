import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom'
import { api } from './api/client'
import Layout from './components/Layout'
import Agents from './pages/Agents'
import AllClusters from './pages/AllClusters'
import ClusterDetail from './pages/ClusterDetail'
import Deploy from './pages/Deploy'
import Login from './pages/Login'
import MyClusters from './pages/MyClusters'
import type { User } from './types'

function Placeholder({ title }: { title: string }) {
  return (
    <div className="p-6">
      <h1 className="text-lg font-mono font-semibold text-text-primary">{title}</h1>
      <p className="text-text-muted text-sm font-mono mt-2">Coming in the next phase…</p>
    </div>
  )
}

function PrefetchManager({ username }: { username: string }) {
  const queryClient = useQueryClient()

  useEffect(() => {
    // Kick off catalog prefetch immediately — runs in background while user is on any page
    queryClient.prefetchQuery({
      queryKey: ['deployments'],
      queryFn: () => api.get('/jobs/deployments'),
      staleTime: 3_600_000,
    })

    // Step 1: fetch all clusters list
    queryClient.fetchQuery<any[]>({
      queryKey: ['all-clusters'],
      queryFn: () => api.get('/clusters/all'),
      staleTime: 30_000,
    }).then(clusters => {
      if (!clusters?.length) return

      // Step 2: stagger health prefetches across all clusters (100ms apart)
      // so we don't hammer the backend with 50+ simultaneous k8s connections
      clusters.forEach((c: any, i: number) => {
        if (c.building || c.destroying || c.destroy_failed) return
        setTimeout(() => {
          queryClient.fetchQuery<{ status: string }>({
            queryKey: ['health', c.cluster_name],
            queryFn: () => api.get(`/clusters/${c.cluster_name}/health`),
            staleTime: 30_000,
          }).then(health => {
            // Step 3: for reachable clusters prefetch full details
            if (health?.status === 'HEALTHY' || health?.status === 'DEGRADED') {
              queryClient.prefetchQuery({
                queryKey: ['details', c.cluster_name],
                queryFn: () => api.get(`/clusters/${c.cluster_name}/details`),
                staleTime: 60_000,
              })
            }
          }).catch(() => {})
        }, i * 150) // 150ms between each cluster — 50 clusters = 7.5s total spread
      })
    }).catch(() => {})
  // Run once per session (user identity change)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username])

  return null
}

function App() {
  const { data: user, isLoading, refetch } = useQuery<User>({
    queryKey: ['me'],
    queryFn: () => api.get<User>('/auth/me'),
    retry: false,
  })

  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface-0 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-surface-4 border-t-accent-cyan rounded-full animate-spin" />
      </div>
    )
  }

  if (!user) {
    return <Login onLogin={() => refetch()} />
  }

  return (
    <Router>
      <PrefetchManager username={user.username} />
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/clusters" replace />} />
          <Route path="clusters" element={<MyClusters />} />
          <Route path="clusters/:name" element={<ClusterDetail />} />
          <Route path="all-clusters" element={<AllClusters username={user.username} />} />
          <Route path="deploy"   element={<Deploy />} />
          <Route path="destroy"  element={<Placeholder title="Destroy" />} />
          <Route path="presets"  element={<Placeholder title="Presets" />} />
          <Route path="agents"   element={<Agents />} />
        </Route>
      </Routes>
    </Router>
  )
}

export default App
