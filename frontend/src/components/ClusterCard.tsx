import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import NodeDiagram from './NodeDiagram'
import DestroyDrawer from './DestroyDrawer'

interface ClusterInfo {
  cluster_name: string
  build_num: number
  build_url: string
  building: boolean
  result: string | null
  timestamp: number | null
  ocp_version: string
  ocs_version: string
  credentials_conf: string
  osd_size: string
  kubeconfig_url?: string
  console_url?: string
  logs_url?: string
  kubeadmin_password?: string
  topology: { masters: number; workers: number }
}

interface HealthData {
  status: string
  degraded_reason?: string | null
  nodes?: { role: string; ready: boolean; name: string }[]
  odf?: { phase: string; health: string }
  osd_count?: number
}

const STAGE_COLORS: Record<string, string> = {
  locker_queue:  'text-accent-amber',
  paused_input:  'text-accent-amber',
  init:          'text-text-muted',
  prepare_jslave:'text-text-muted',
  install_ocp:   'text-accent-cyan',
  install_ocs:   'text-accent-cyan',
  rhcs:          'text-accent-cyan',
  upgrade:       'text-accent-green',
  test:          'text-accent-green',
  teardown:      'text-text-muted',
}

function ageStr(iso: string): string {
  const ms = Date.now() - new Date(iso + (iso.includes('Z') ? '' : 'Z')).getTime()
  const m = Math.floor(ms / 60_000)
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}

function StatusBadge({ status, building, stage, queueSince, pausedAt, degradedReason }: {
  status: string; building: boolean; stage?: string | null; queueSince?: string | null
  pausedAt?: string | null; degradedReason?: string | null
}) {
  if (building) return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="flex items-center gap-1.5 text-xs font-mono text-accent-cyan">
        <span className="w-2 h-2 rounded-full bg-accent-cyan animate-pulse" />BUILDING
      </span>
      {stage && (
        <span className={`text-[10px] font-mono ${STAGE_COLORS[stage] ?? 'text-text-muted'}`}>
          {stage === 'locker_queue' && queueSince ? `locker_queue · ${ageStr(queueSince)}`
            : stage === 'paused_input' && pausedAt ? `paused · ${pausedAt}`
            : stage}
        </span>
      )}
    </div>
  )
  const map: Record<string, { dot: string; text: string }> = {
    HEALTHY:     { dot: 'bg-accent-green',               text: 'text-accent-green' },
    DEGRADED:    { dot: 'bg-accent-amber animate-pulse', text: 'text-accent-amber' },
    UNREACHABLE: { dot: 'bg-text-muted',                 text: 'text-text-muted' },
    FAILED:      { dot: 'bg-accent-red',                 text: 'text-accent-red' },
    LOADING:     { dot: 'bg-surface-4 animate-pulse',    text: 'text-text-muted' },
  }
  const s = map[status] ?? map.UNREACHABLE
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className={`flex items-center gap-1.5 text-xs font-mono ${s.text}`}>
        <span className={`w-2 h-2 rounded-full ${s.dot}`} />{status}
      </span>
      {status === 'DEGRADED' && degradedReason && (
        <span className="text-[10px] font-mono text-accent-amber">{degradedReason}</span>
      )}
    </div>
  )
}

function PwField({ password }: { password?: string }) {
  const [revealed, setRevealed] = useState(false)
  if (!password) return null
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-mono text-text-muted">kubeadmin</span>
      <span
        className="text-xs font-mono px-1.5 py-0.5 rounded bg-surface-3 border border-surface-4 cursor-pointer select-none transition-all"
        style={{ filter: revealed ? 'none' : 'blur(4px)' }}
        onClick={e => { e.preventDefault(); setRevealed(r => !r) }}
      >
        {password}
      </span>
      <button
        className="text-xs font-mono text-text-muted hover:text-accent-cyan transition-colors relative z-20"
        onClick={e => { e.preventDefault(); navigator.clipboard.writeText(password) }}
      >
        copy
      </button>
    </div>
  )
}

export default function ClusterCard({ cluster, isOwner = true }: { cluster: ClusterInfo; isOwner?: boolean }) {
  const { data: stageData } = useQuery<{ stage: string | null; queue_since?: string; paused_at?: string }>({
    queryKey: ['stage', cluster.cluster_name],
    queryFn: () => api.get(`/clusters/${cluster.cluster_name}/stage`),
    enabled: cluster.building,
    staleTime: 25_000,
    refetchInterval: 30_000,
    retry: false,
  })

  const { data: health, isLoading: healthLoading } = useQuery<HealthData>({
    queryKey: ['health', cluster.cluster_name],
    queryFn: () => api.get(`/clusters/${cluster.cluster_name}/health`),
    enabled: !cluster.building,
    staleTime: 60_000,
    retry: false,
  })

  // Prefetch Level 2 detail data in the background as soon as health resolves.
  // TanStack Query caches this under ['details', name] — same key ClusterDetail uses,
  // so navigating into the detail page is instant instead of waiting for a fresh fetch.
  const isReachable = health?.status === 'HEALTHY' || health?.status === 'DEGRADED'
  useQuery({
    queryKey: ['details', cluster.cluster_name],
    queryFn: () => api.get(`/clusters/${cluster.cluster_name}/details`),
    enabled: isReachable,
    staleTime: 60_000,
    retry: false,
    // gcTime keeps data in cache longer even if ClusterCard unmounts while detail loads
    gcTime: 300_000,
  })

  const queryClient = useQueryClient()
  const [abortState, setAbortState] = useState<'idle' | 'confirm' | 'aborting' | 'done'>('idle')
  const [destroyOpen, setDestroyOpen] = useState(false)

  async function handleAbort(e: React.MouseEvent) {
    e.preventDefault()
    if (abortState === 'idle') { setAbortState('confirm'); return }
    if (abortState !== 'confirm') return
    setAbortState('aborting')
    try {
      await api.post(`/clusters/${cluster.cluster_name}/abort`)
      setAbortState('done')
      // Refresh active clusters list
      queryClient.invalidateQueries({ queryKey: ['clusters'] })
    } catch {
      setAbortState('idle')
    }
  }

  const status = cluster.building ? 'BUILDING' : health ? health.status : 'LOADING'
  const platform = cluster.credentials_conf
    ? cluster.credentials_conf.replace(/-VC\d+$/, '').replace(/-/g, ' ').trim()
    : ''

  const age = cluster.timestamp ? (() => {
    const h = Math.floor((Date.now() - cluster.timestamp) / 3_600_000)
    const d = Math.floor(h / 24)
    return d > 0 ? `${d}d ago` : `${h}h ago`
  })() : ''

  return (
    <>
    <Link
      to={`/clusters/${cluster.cluster_name}`}
      className="card p-4 flex flex-col gap-3 hover:border-accent-cyan/40 transition-colors group block"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-mono text-text-primary font-semibold tracking-tight group-hover:text-accent-cyan transition-colors">
            {cluster.cluster_name}
          </h3>
          <p className="text-xs text-text-muted font-mono mt-0.5">
            OCP {cluster.ocp_version} · OCS {cluster.ocs_version}
            {age && <span> · {age}</span>}
          </p>
        </div>
        <StatusBadge
          status={status}
          building={cluster.building}
          stage={stageData?.stage}
          queueSince={stageData?.queue_since}
          pausedAt={stageData?.paused_at}
          degradedReason={health?.degraded_reason}
        />
      </div>

      {platform && <p className="text-xs font-mono text-text-secondary truncate">{platform}</p>}

      {/* Node diagram */}
      <NodeDiagram
        masters={cluster.topology.masters}
        workers={cluster.topology.workers}
        liveNodes={health?.nodes}
        osdCount={health?.osd_count}
        osdSize={cluster.osd_size}
        loading={!cluster.building && healthLoading}
      />

      {/* ODF health */}
      {health?.odf?.phase && (
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="text-text-muted">ODF</span>
          <span className={health.odf.phase === 'Ready' ? 'text-accent-green' : 'text-accent-amber'}>
            {health.odf.phase}
          </span>
          {health.odf.health && (
            <span className="text-text-muted truncate">{health.odf.health}</span>
          )}
        </div>
      )}

      <div className="border-t border-surface-4" />

      {/* Footer */}
      <div className="space-y-2">
        {/* Abort button — only while building and owner */}
        {isOwner && cluster.building && (
          <div onClick={e => e.preventDefault()}>
            {abortState === 'done' ? (
              <p className="text-xs font-mono text-accent-amber">Abort sent — refreshing…</p>
            ) : (
              <button
                onClick={handleAbort}
                disabled={abortState === 'aborting'}
                className={`text-xs font-mono px-3 py-1 rounded border transition-colors w-full ${
                  abortState === 'confirm'
                    ? 'border-accent-red text-accent-red bg-accent-red/10 hover:bg-accent-red/20'
                    : 'border-surface-4 text-text-muted hover:border-accent-red hover:text-accent-red'
                }`}
              >
                {abortState === 'aborting' && '…Aborting'}
                {abortState === 'confirm' && '⚠ Confirm Abort?'}
                {abortState === 'idle' && '✕ Abort Build'}
              </button>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          {cluster.console_url && (
            <a href={cluster.console_url} target="_blank" rel="noreferrer"
              onClick={e => e.stopPropagation()}
              className="text-xs font-mono text-text-secondary hover:text-accent-cyan transition-colors">
              Console ↗
            </a>
          )}
          {cluster.logs_url && (
            <a href={cluster.logs_url} target="_blank" rel="noreferrer"
              onClick={e => e.stopPropagation()}
              className="text-xs font-mono text-text-secondary hover:text-accent-cyan transition-colors">
              Logs ↗
            </a>
          )}
          <a href={cluster.build_url} target="_blank" rel="noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-xs font-mono text-text-secondary hover:text-accent-cyan transition-colors">
            Jenkins #{cluster.build_num} ↗
          </a>
          {isOwner && (
            <button
              onClick={e => { e.preventDefault(); setDestroyOpen(true) }}
              className="text-xs font-mono text-accent-red/30 hover:text-accent-red transition-colors"
            >
              ✕ Destroy
            </button>
          )}
          {cluster.kubeconfig_url && (
            <a
              href={`/api/clusters/${cluster.cluster_name}/kubeconfig`}
              download={`kubeconfig-${cluster.cluster_name}`}
              onClick={e => e.stopPropagation()}
              className="text-xs font-mono text-accent-green hover:brightness-125 transition-colors"
            >
              ↓ kubeconfig
            </a>
          )}
        </div>
        <div onClick={e => e.stopPropagation()}>
          <PwField password={cluster.kubeadmin_password} />
        </div>
      </div>
    </Link>

    {/* Destroy drawer — rendered outside the Link to avoid navigation */}
    {destroyOpen && (
      <DestroyDrawer
        clusterName={cluster.cluster_name}
        ocpVersion={cluster.ocp_version}
        ocsVersion={cluster.ocs_version}
        credentialsConf={cluster.credentials_conf}
        onClose={() => setDestroyOpen(false)}
        onDestroyed={() => queryClient.invalidateQueries({ queryKey: ['clusters'] })}
      />
    )}
    </>
  )
}
