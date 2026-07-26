import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import ModifyDrawer from '../components/ModifyDrawer'
import SearchBar from '../components/SearchBar'
import type { DeployJob, Preset } from './Deploy'

const PLATFORM_COLOR: Record<string, string> = {
  aws:       'text-accent-amber  border-accent-amber/30  bg-accent-amber/10',
  vsphere:   'text-accent-cyan   border-accent-cyan/30   bg-accent-cyan/10',
  azure:     'text-blue-400      border-blue-400/30      bg-blue-400/10',
  ibmcloud:  'text-purple-400    border-purple-400/30    bg-purple-400/10',
  baremetal: 'text-text-secondary border-surface-4       bg-surface-3',
  gcp:       'text-accent-green  border-accent-green/30  bg-accent-green/10',
}
const PLATFORM_LABELS: Record<string, string> = {
  aws: 'AWS', vsphere: 'vSphere', azure: 'Azure',
  ibmcloud: 'IBM Cloud', baremetal: 'BM', gcp: 'GCP', rhv: 'RHV',
}

function timeAgo(isoStr: string): string {
  const ms = Date.now() - new Date(isoStr).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function Presets() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const [query, setQuery] = useState('')
  const [view, setView] = useState<'grid' | 'list'>(() =>
    (localStorage.getItem('presets-view') as 'grid' | 'list') ?? 'grid'
  )
  const [modifyJob, setModifyJob] = useState<DeployJob | null>(null)
  const [modifyClusterName, setModifyClusterName] = useState('')
  const [modifyInitialValues, setModifyInitialValues] = useState<Record<string, string | boolean> | undefined>(undefined)
  const [modifyPresetId, setModifyPresetId] = useState<number | undefined>(undefined)
  const [modifyPresetName, setModifyPresetName] = useState<string | undefined>(undefined)
  const [buildingId, setBuildingId] = useState<number | null>(null)
  const [toasts, setToasts] = useState<Record<number, string>>({})

  const { data: presets = [], isLoading } = useQuery<Preset[]>({
    queryKey: ['presets'],
    queryFn: () => api.get('/presets/'),
  })

  const { data: jobs = [] } = useQuery<DeployJob[]>({
    queryKey: ['deployments'],
    queryFn: () => api.get('/jobs/deployments'),
    staleTime: 3_600_000,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/presets/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['presets'] }),
  })

  const filtered = useMemo(() => {
    if (!query.trim()) return presets
    const q = query.toLowerCase()
    return presets.filter(p => {
      const job = jobs.find(j => j.job_name === p.job)
      return (
        p.name.toLowerCase().includes(q) ||
        p.job.toLowerCase().includes(q) ||
        job?.search_string.toLowerCase().includes(q)
      )
    })
  }, [presets, jobs, query])

  function openEdit(preset: Preset) {
    const job = jobs.find(j => j.job_name === preset.job)
    if (!job) return
    const { _cluster_name, ...paramValues } = preset.params as Record<string, any>
    setModifyJob(job)
    setModifyClusterName(String(_cluster_name ?? ''))
    setModifyInitialValues(paramValues as Record<string, string | boolean>)
    setModifyPresetId(preset.id)
    setModifyPresetName(preset.name)
  }

  function closeDrawer() {
    setModifyJob(null)
    setModifyInitialValues(undefined)
    setModifyPresetId(undefined)
    setModifyPresetName(undefined)
  }

  async function quickBuild(preset: Preset) {
    setBuildingId(preset.id)
    const { _cluster_name, ...params } = preset.params as Record<string, any>
    const clusterName = String(_cluster_name ?? '')
    try {
      await api.post('/jobs/trigger', { job_name: preset.job, params, cluster_name: clusterName, user_set_credentials: true })
      setToasts(t => ({ ...t, [preset.id]: '✓ Triggered!' }))
      setTimeout(() => navigate(`/clusters?highlight=${encodeURIComponent(clusterName)}`), 1200)
    } catch (e: any) {
      setToasts(t => ({ ...t, [preset.id]: `✕ ${e.message ?? 'failed'}` }))
      setTimeout(() => setToasts(t => { const n = { ...t }; delete n[preset.id]; return n }), 3000)
    } finally {
      setBuildingId(null)
    }
  }

  function toggleView(v: 'grid' | 'list') {
    setView(v)
    localStorage.setItem('presets-view', v)
  }

  return (
    <div className="p-6 flex flex-col gap-4 h-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-mono font-semibold text-text-primary">Favorites</h1>
          <p className="text-xs font-mono text-text-muted mt-0.5">
            {isLoading ? 'Loading…' : presets.length === 0
              ? 'No saved configurations yet'
              : `${filtered.length} of ${presets.length} saved configuration${presets.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        {presets.length > 0 && (
          <div className="flex items-center gap-3">
            <SearchBar value={query} onChange={setQuery} placeholder="name, platform…" className="w-64" />
            <div className="flex border border-surface-4 rounded overflow-hidden">
              {(['grid', 'list'] as const).map(v => (
                <button key={v} onClick={() => toggleView(v)}
                  className={`px-3 py-1.5 text-xs font-mono transition-colors ${view === v ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}>
                  {v === 'grid' ? '▦' : '☰'}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {!isLoading && presets.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
          <span className="text-4xl text-text-muted/30">★</span>
          <p className="text-sm font-mono text-text-muted max-w-sm leading-relaxed">
            Open any deploy job, click <span className="text-text-secondary">⚙ Modify</span>, configure
            the parameters you want, then click <span className="text-accent-amber">★ Save as Favorite</span>.
          </p>
          <button onClick={() => navigate('/deploy')} className="btn-ghost text-xs mt-2">→ Go to Deploy</button>
        </div>
      )}

      {filtered.length === 0 && presets.length > 0 && (
        <div className="text-center py-16">
          <p className="font-mono text-text-muted text-sm">No favorites match that search.</p>
        </div>
      )}

      {/* Grid view */}
      {filtered.length > 0 && view === 'grid' && (
        <div className="overflow-y-auto flex-1">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pb-6">
            {filtered.map(preset => {
              const job = jobs.find(j => j.job_name === preset.job)
              const clusterName = String((preset.params as any)._cluster_name ?? '')
              const platColor = PLATFORM_COLOR[job?.platform ?? ''] ?? 'text-text-muted border-surface-4 bg-surface-3'
              const toast = toasts[preset.id]
              const isBuilding = buildingId === preset.id

              return (
                <div key={preset.id} className="card p-4 flex flex-col gap-3 hover:border-surface-4/80 transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-accent-amber text-sm">★</span>
                        <p className="text-sm font-mono font-semibold text-text-primary truncate">{preset.name}</p>
                      </div>
                      <p className="text-[10px] font-mono text-text-muted mt-0.5 truncate">{preset.job}</p>
                    </div>
                    <button onClick={() => deleteMutation.mutate(preset.id)}
                      className="text-text-muted hover:text-accent-red text-lg leading-none shrink-0 transition-colors" title="Remove">✕</button>
                  </div>

                  {job && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {job.platform && <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${platColor}`}>{PLATFORM_LABELS[job.platform] ?? job.platform}</span>}
                      {job.installer && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-surface-4 text-text-muted">{job.installer.toUpperCase()}</span>}
                      {job.storage && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-surface-4 text-text-muted">{job.storage}</span>}
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-surface-4 text-text-muted">{job.masters}M+{job.workers === 0 ? 'Compact' : `${job.workers}W`}</span>
                    </div>
                  )}
                  {!job && <p className="text-[10px] font-mono text-text-muted/50 italic">Job no longer in catalog</p>}

                  <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                    {['OCP_VERSION', 'OCS_VERSION'].map(k => {
                      const v = (preset.params as any)[k]
                      return v ? (
                        <div key={k} className="flex items-center gap-1">
                          <span className="text-[9px] font-mono text-text-muted uppercase">{k.replace('_VERSION', '')}</span>
                          <span className="text-[10px] font-mono text-text-secondary">{v}</span>
                        </div>
                      ) : null
                    })}
                    {clusterName && (
                      <div className="flex items-center gap-1">
                        <span className="text-[9px] font-mono text-text-muted uppercase">Name</span>
                        <span className="text-[10px] font-mono text-text-secondary">{clusterName}</span>
                      </div>
                    )}
                  </div>

                  <p className="text-[9px] font-mono text-text-muted/60 -mt-1">updated {timeAgo(preset.updated_at)}</p>

                  {toast && <p className={`text-[10px] font-mono ${toast.startsWith('✓') ? 'text-accent-green' : 'text-accent-red'}`}>{toast}</p>}

                  <div className="flex gap-2 mt-auto pt-1">
                    <button onClick={() => quickBuild(preset)} disabled={isBuilding || !job || !clusterName}
                      className="btn-primary flex-1 text-xs py-1.5 disabled:opacity-40">
                      {isBuilding ? <span className="flex items-center justify-center gap-1.5"><span className="w-2.5 h-2.5 border-2 border-surface-0/30 border-t-surface-0 rounded-full animate-spin" />Sending…</span> : '▶ Build'}
                    </button>
                    <button onClick={() => openEdit(preset)} disabled={!job}
                      className="btn-ghost text-xs px-3 py-1.5 disabled:opacity-40">⚙ Modify</button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* List view */}
      {filtered.length > 0 && view === 'list' && (
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-xs font-mono table-fixed">
            <colgroup>
              <col className="w-[28%]" /><col className="w-[18%]" /><col className="w-[10%]" />
              <col className="w-[8%]" /><col className="w-[8%]" /><col className="w-[12%]" /><col className="w-[16%]" />
            </colgroup>
            <thead className="sticky top-0 bg-surface-1 z-10">
              <tr className="border-b border-surface-4">
                {['Favorite', 'Config', 'OCP', 'OCS', 'Nodes', 'Name', ''].map(h => (
                  <th key={h} className="text-left py-2 px-2 text-text-muted uppercase tracking-wider text-[10px]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(preset => {
                const job = jobs.find(j => j.job_name === preset.job)
                const clusterName = String((preset.params as any)._cluster_name ?? '')
                const ocp = String((preset.params as any).OCP_VERSION ?? '')
                const ocs = String((preset.params as any).OCS_VERSION ?? '')
                const toast = toasts[preset.id]
                const isBuilding = buildingId === preset.id

                return (
                  <tr key={preset.id} className="border-b border-surface-4/50 hover:bg-surface-2/50 transition-colors">
                    <td className="py-2 px-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-accent-amber">★</span>
                        <span className="text-text-primary font-semibold truncate">{preset.name}</span>
                      </div>
                    </td>
                    <td className="py-2 px-2">
                      <div className="flex items-center gap-1 flex-wrap">
                        {job?.platform && <span className="text-text-primary">{PLATFORM_LABELS[job.platform] ?? job.platform}</span>}
                        {job?.installer && <span className="text-text-muted">{job.installer.toUpperCase()}</span>}
                        {job?.storage && <span className="text-text-muted">· {job.storage}</span>}
                      </div>
                    </td>
                    <td className="py-2 px-2 text-text-muted">{ocp}</td>
                    <td className="py-2 px-2 text-text-muted">{ocs}</td>
                    <td className="py-2 px-2 text-text-muted whitespace-nowrap">
                      {job ? `${job.masters}M+${job.workers === 0 ? 'C' : `${job.workers}W`}` : '—'}
                    </td>
                    <td className="py-2 px-2 text-text-secondary truncate">{clusterName}</td>
                    <td className="py-2 px-2">
                      <div className="flex gap-1 items-center">
                        {toast && <span className={`text-[9px] ${toast.startsWith('✓') ? 'text-accent-green' : 'text-accent-red'}`}>{toast}</span>}
                        <button onClick={() => quickBuild(preset)} disabled={isBuilding || !job || !clusterName}
                          className="btn-primary text-[10px] py-1 px-2 disabled:opacity-40">
                          {isBuilding ? '…' : '▶'}
                        </button>
                        <button onClick={() => openEdit(preset)} disabled={!job}
                          className="btn-ghost text-[10px] py-1 px-1.5 disabled:opacity-40">⚙</button>
                        <button onClick={() => deleteMutation.mutate(preset.id)}
                          className="text-text-muted hover:text-accent-red text-[10px] py-1 px-1 transition-colors">✕</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {modifyJob && (
        <ModifyDrawer job={modifyJob} initialClusterName={modifyClusterName} initialValues={modifyInitialValues}
          presetId={modifyPresetId} presetName={modifyPresetName} onClose={closeDrawer} />
      )}
    </div>
  )
}
