import { useQuery } from '@tanstack/react-query'
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
