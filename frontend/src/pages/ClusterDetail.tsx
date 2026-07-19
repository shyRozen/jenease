import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { useRef, useEffect, useState } from 'react'
import { api } from '../api/client'
import WorkloadPanel from '../components/WorkloadPanel'
import ThroughputChart, { OSD_SERIES, type DataPoint } from '../components/ThroughputChart'

// ── types ──────────────────────────────────────────────────────────────────

interface NodeDetail {
  name: string; role: string; ready: boolean
  conditions: Record<string, string>
  kernel: string; os_image: string; kubelet: string
}

interface Pod {
  name: string; component: string; phase: string
  node: string; restarts: number; ready: boolean
}

interface PVC {
  name: string; namespace: string; phase: string
  capacity: string; storage_class: string
}

interface CephCapacity {
  bytes_total: number
  bytes_used: number
  bytes_available: number
  health: string
}

interface HealthData {
  status: string
  degraded_reason?: string | null
  nodes?: { role: string; ready: boolean; name: string }[]
  odf?: { phase: string; health: string }
  osd_count?: number
  osd_up?: number
  osd_in?: number
  ceph_capacity?: CephCapacity
  ocp_full_version?: string
  odf_full_version?: string
  osd_iops?: Record<string, { r?: number; w?: number }>
}

interface DetailsData {
  pods?: Pod[]; pvcs?: PVC[]; nodes_detail?: NodeDetail[]
}

// ── helpers ────────────────────────────────────────────────────────────────

const POD_COMPONENT_ORDER = [
  'rook-ceph-mon', 'rook-ceph-osd', 'rook-ceph-mgr', 'rook-ceph-mds',
  'rook-ceph-rgw', 'csi-rbdplugin', 'csi-cephfsplugin',
  'rook-ceph-crashcollector', 'rook-ceph-exporter', 'rook-ceph-tools',
  'rook-ceph-operator', 'odf-operator', 'noobaa', 'ux-backend',
]

const COMPONENT_LABEL: Record<string, string> = {
  'rook-ceph-mon':           'MON',
  'rook-ceph-osd':           'OSD',
  'rook-ceph-mgr':           'MGR',
  'rook-ceph-mds':           'MDS',
  'rook-ceph-rgw':           'RGW',
  'csi-rbdplugin':           'CSI RBD',
  'csi-cephfsplugin':        'CSI CephFS',
  'rook-ceph-crashcollector':'Crash Collector',
  'rook-ceph-exporter':      'Exporter',
  'rook-ceph-tools':         'Toolbox',
  'rook-ceph-operator':      'Rook Operator',
  'odf-operator':            'ODF Operator',
  'noobaa':                  'NooBaa',
  'ux-backend':              'UX Backend',
}

function groupPods(pods: Pod[]): Record<string, Pod[]> {
  const groups: Record<string, Pod[]> = {}
  for (const p of pods) {
    const key = POD_COMPONENT_ORDER.find(c => p.component?.includes(c)) ?? p.component ?? 'other'
    if (!groups[key]) groups[key] = []
    groups[key].push(p)
  }
  const sorted: Record<string, Pod[]> = {}
  for (const k of POD_COMPONENT_ORDER) if (groups[k]) sorted[k] = groups[k]
  for (const k of Object.keys(groups)) if (!sorted[k]) sorted[k] = groups[k]
  return sorted
}

function phaseColor(phase: string, ready: boolean) {
  if (phase === 'Running' && ready) return 'bg-accent-green/20 border-accent-green/40 text-accent-green'
  if (phase === 'Running') return 'bg-accent-amber/20 border-accent-amber/40 text-accent-amber'
  if (phase === 'Pending') return 'bg-accent-amber/20 border-accent-amber/40 text-accent-amber animate-pulse'
  if (['Failed', 'CrashLoopBackOff', 'Error'].includes(phase)) return 'bg-accent-red/20 border-accent-red/40 text-accent-red'
  return 'bg-surface-3 border-surface-4 text-text-muted'
}

// For pressure conditions, True = problem (red). For Ready, True = good (green).
const INVERTED_CONDITIONS = new Set(['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'])

function conditionDot(conditionName: string, status: string) {
  const isGood = INVERTED_CONDITIONS.has(conditionName)
    ? status === 'False'
    : status === 'True'
  return isGood
    ? 'w-1.5 h-1.5 rounded-full bg-accent-green'
    : 'w-1.5 h-1.5 rounded-full bg-accent-red'
}

// ── sub-components ─────────────────────────────────────────────────────────

function fmtBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function OsdCapacityBar({ capacity, clusterName, kubeconfigUrl }: {
  capacity: CephCapacity
  clusterName: string
  kubeconfigUrl?: string
}) {
  const { bytes_total, bytes_used, bytes_available } = capacity
  const [trimming, setTrimming] = useState(false)
  const [trimMsg, setTrimMsg] = useState('')
  if (!bytes_total) return null
  const usedPct = Math.round((bytes_used / bytes_total) * 100)
  const color = usedPct > 85 ? 'bg-accent-red' : usedPct > 70 ? 'bg-accent-amber' : 'bg-accent-cyan'

  async function handleTrim() {
    if (!kubeconfigUrl) { setTrimMsg('⚠ Kubeconfig URL not available yet'); return }
    setTrimming(true)
    setTrimMsg('')
    try {
      const url = `/api/clusters/${clusterName}/fstrim?kubeconfig_url=${encodeURIComponent(kubeconfigUrl)}`
      const res = await fetch(url, { method: 'POST', credentials: 'include' })
      const text = await res.text()
      let data: any = {}
      try { data = JSON.parse(text) } catch { /* non-JSON */ }
      if (!res.ok) {
        setTrimMsg(`⚠ ${data.detail ?? text.slice(0, 80)}`)
      } else if (data.output?.includes('ERROR')) {
        setTrimMsg(`⚠ ${data.output.slice(0, 100)}`)
      } else {
        setTrimMsg('✓ Trim complete')
      }
    } catch (e: any) {
      setTrimMsg(`⚠ ${e?.message ?? 'Request failed'}`)
    } finally {
      setTrimming(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[10px] font-mono text-text-muted">
        <span>Capacity</span>
        <span>{usedPct}% used</span>
      </div>
      <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${usedPct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono">
        <div className="flex items-center gap-2">
          <span className="text-text-secondary">Used <span className="text-text-primary">{fmtBytes(bytes_used)}</span></span>
          <button
            onClick={handleTrim}
            disabled={trimming}
            title="Run fstrim on all worker nodes — releases discarded blocks back to thin-provisioned storage (vSphere/cloud)"
            className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-surface-4 text-text-muted hover:border-accent-amber/50 hover:text-accent-amber transition-colors disabled:opacity-50"
          >
            {trimming ? '⏳' : '⟳ Trim'}
          </button>
          {trimMsg && <span className="text-[9px] font-mono text-text-muted">{trimMsg}</span>}
        </div>
        <span className="text-text-secondary">Free <span className="text-text-primary">{fmtBytes(bytes_available)}</span></span>
        <span className="text-text-secondary">Total <span className="text-text-primary">{fmtBytes(bytes_total)}</span></span>
      </div>
    </div>
  )
}

function OsdGrid({ count, up, osdSize, capacity, iops, osdStatus }: {
  count: number; up: number; osdSize?: string; capacity?: CephCapacity
  iops?: Record<string, { r?: number; w?: number }>
  osdStatus?: Record<string, { up?: number; in?: number }>
}) {
  const perOsdBytes = capacity?.bytes_total ? capacity.bytes_total / count : 0
  const perOsdUsed = capacity?.bytes_used ? capacity.bytes_used / count : 0
  const usedPct = perOsdBytes ? Math.round((perOsdUsed / perOsdBytes) * 100) : 0
  const barColor = usedPct > 85 ? 'bg-accent-red' : usedPct > 70 ? 'bg-accent-amber' : 'bg-accent-green'

  return (
    <div>
      <p className="text-[9px] font-mono text-text-muted uppercase tracking-widest mb-2">OSDs</p>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: count }).map((_, i) => {
          // Use per-OSD status from mgr if available, otherwise fall back to count heuristic
          const status = osdStatus?.[String(i)]
          const isUp   = status ? status.up === 1 : (up <= 0 || i < up)
          const isIn   = status ? status.in === 1 : true
          const osdIo  = iops?.[String(i)]
          const rIops  = osdIo?.r ?? null
          const wIops  = osdIo?.w ?? null
          return (
            <div key={i} className={`border rounded p-2 w-28 space-y-1.5 ${
              !isUp
                ? 'border-accent-red/60 bg-accent-red/10 animate-pulse'
                : !isIn
                  ? 'border-accent-amber/40 bg-accent-amber/5'
                  : 'border-accent-cyan/20 bg-accent-cyan/5'
            }`}>
              {/* OSD label + status dot */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-text-secondary">OSD {i}</span>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  !isUp ? 'bg-accent-red' : !isIn ? 'bg-accent-amber' : 'bg-accent-green'
                } ${!isUp ? 'animate-ping' : ''}`} />
              </div>
              {/* Size */}
              <p className="text-xs font-mono text-text-primary font-semibold">
                {perOsdBytes ? fmtBytes(perOsdBytes) : osdSize ? `${osdSize} GB` : '—'}
              </p>
              {/* Mini capacity bar */}
              {perOsdBytes > 0 && (
                <div className="h-1 bg-surface-4 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${barColor}`} style={{ width: `${usedPct}%` }} />
                </div>
              )}
              {perOsdBytes > 0 && (
                <p className="text-[9px] font-mono text-text-secondary">{usedPct}% used</p>
              )}
              {/* IOPS */}
              {(rIops !== null || wIops !== null) && (
                <div className="space-y-0.5 pt-0.5 border-t border-accent-cyan/10">
                  {rIops !== null && (
                    <p className="text-[9px] font-mono text-text-muted">
                      R <span className="text-accent-cyan">{rIops.toLocaleString()}</span> iops
                    </p>
                  )}
                  {wIops !== null && (
                    <p className="text-[9px] font-mono text-text-muted">
                      W <span className="text-accent-cyan">{wIops.toLocaleString()}</span> iops
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function NodePanel({ node }: { node: NodeDetail }) {
  const conditionKeys = ['Ready', 'MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable']
  return (
    <div className={`card p-3 space-y-2 border ${node.ready ? 'border-surface-4' : 'border-accent-red/40'}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs font-semibold text-text-primary truncate">{node.name}</span>
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border uppercase ${
          node.role === 'master'
            ? 'text-accent-cyan border-accent-cyan/30 bg-accent-cyan/10'
            : 'text-accent-green border-accent-green/30 bg-accent-green/10'
        }`}>{node.role}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {conditionKeys.map(k => (
          <div key={k} className="flex items-center gap-1.5">
            <span className={conditionDot(k, node.conditions[k] ?? 'False')} />
            <span className="text-[10px] font-mono text-text-muted">{k}</span>
          </div>
        ))}
      </div>
      {node.kubelet && (
        <p className="text-[10px] font-mono text-text-muted truncate">{node.kubelet}</p>
      )}
    </div>
  )
}

function PodChip({ pod }: { pod: Pod }) {
  return (
    <div
      title={`${pod.name}\nnode: ${pod.node}\nrestarts: ${pod.restarts}`}
      className={`text-[10px] font-mono px-1.5 py-0.5 rounded border cursor-default truncate max-w-[120px] ${phaseColor(pod.phase, pod.ready)}`}
    >
      {pod.name.replace(/^rook-ceph-(mon|osd|mgr|mds|rgw)-?/, '').replace(/^(csi-rbdplugin|csi-cephfsplugin)-/, '') || pod.name}
    </div>
  )
}

function PodSwimlane({ label, pods }: { label: string; pods: Pod[] }) {
  const healthy = pods.filter(p => p.phase === 'Running' && p.ready).length
  const displayLabel = COMPONENT_LABEL[label] ?? label
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-text-secondary uppercase tracking-wider w-32 shrink-0">{displayLabel}</span>
        <span className={`text-[10px] font-mono ${healthy === pods.length ? 'text-accent-green' : 'text-accent-amber'}`}>
          {healthy}/{pods.length}
        </span>
      </div>
      <div className="flex flex-wrap gap-1 pl-34">
        {pods.map(p => <PodChip key={p.name} pod={p} />)}
      </div>
    </div>
  )
}

// ── main page ──────────────────────────────────────────────────────────────

export default function ClusterDetail() {
  const { name } = useParams<{ name: string }>()
  const queryClient = useQueryClient()
  const me = (queryClient.getQueryData<{ username: string }>(['me']))?.username ?? ''
  const isOwner = !!name && name.toLowerCase().startsWith(me.toLowerCase())
  // Shared rates ref so the list panel (left) and launcher panel (right) see the same MB/s for recording
  const sharedRatesRef = useRef<Record<number, number>>({})
  const { data: health } = useQuery<HealthData>({
    queryKey: ['health', name],
    queryFn: () => api.get(`/clusters/${name}/health`),
    staleTime: 3_000,
    retry: false,
    refetchInterval: 3_000,
  })

  // Dedicated IOPS + throughput query — every 5s
  const { data: iopsData } = useQuery<{
    osd_iops?: Record<string, { r?: number; w?: number }>
    osd_throughput_mb?: Record<string, { r?: number; w?: number }>
    pool_throughput_mb?: Record<string, { r?: number; w?: number }>
    osd_status?: Record<string, { up?: number; in?: number }>
  }>({
    queryKey: ['iops', name],
    queryFn: () => api.get(`/clusters/${name}/iops`),
    refetchInterval: 5_000,
    staleTime: 4_000,
    retry: false,
    enabled: health?.status === 'HEALTHY' || health?.status === 'DEGRADED',
  })

  // Per-OSD throughput history (keyed by OSD id)
  const osdHistoryRef = useRef<Record<string, DataPoint[]>>({})
  // Pool-level workload breakdown history (rbd/cephfs/noobaa total r+w per type)
  const poolHistoryRef = useRef<DataPoint[]>([])
  // Workload history from WorkloadPanel (populated via historyRef prop)
  const workloadHistoryRef = useRef<DataPoint[]>([])
  // Current OSD aggregate totals (for text readout + WorkloadPanel R/W toggle)
  const [cephAgg, setCephAgg] = useState<{r: number, w: number}>({r: 0, w: 0})
  const [osdMode, setOsdMode] = useState<'osd' | 'pool'>('osd')
  const [osdGridWidth, setOsdGridWidth] = useState(0)
  const osdGridRef = useRef<HTMLDivElement>(null)
  const [, forceRender] = useState(0)

  // Last known IOPS per OSD — persists when Prometheus query intermittently fails
  const lastOsdIopsRef = useRef<Record<string, { r: number; w: number }>>({})

  useEffect(() => {
    if (!iopsData) return
    const now = Date.now()
    let totalR = 0, totalW = 0

    // Update last-known IOPS (Prometheus, stable)
    if (iopsData.osd_iops) {
      for (const [osd, io] of Object.entries(iopsData.osd_iops as Record<string, { r?: number; w?: number }>)) {
        lastOsdIopsRef.current[osd] = { r: io.r ?? 0, w: io.w ?? 0 }
      }
    }

    // Collect all known OSDs from any available source
    const knownOsds = new Set<string>([
      ...Object.keys(iopsData.osd_iops ?? {}),
      ...Object.keys(iopsData.osd_throughput_mb ?? {}),
    ])

    // Add a data point for EVERY known OSD on every poll — even 0 values.
    // This gives consistent 5s-interval points so the 60s chart fills completely.
    for (const osd of knownOsds) {
      const mb = (iopsData.osd_throughput_mb as Record<string, { r?: number; w?: number }> | undefined)?.[osd]
      const r = mb?.r ?? 0, w = mb?.w ?? 0
      totalR += r; totalW += w
      const prev = osdHistoryRef.current[osd] ?? []
      const pt = { ts: now, total: r + w, rbd: 0, cephfs: 0, noobaa: 0, r, w } as unknown as DataPoint
      osdHistoryRef.current[osd] = [...prev.slice(-720), pt]
    }

    if (iopsData.pool_throughput_mb) {
      const pools = iopsData.pool_throughput_mb as Record<string, { r?: number; w?: number }>
      const rbd    = (pools.rbd?.r   ?? 0) + (pools.rbd?.w   ?? 0)
      const cephfs = (pools.cephfs?.r ?? 0) + (pools.cephfs?.w ?? 0)
      const noobaa = (pools.noobaa?.r ?? 0) + (pools.noobaa?.w ?? 0)
      const total  = rbd + cephfs + noobaa
      poolHistoryRef.current = [
        ...poolHistoryRef.current.slice(-720),
        { ts: now, total, rbd, cephfs, noobaa } as DataPoint,
      ]
    }

    setCephAgg({ r: totalR, w: totalW })
    if (knownOsds.size > 0) forceRender(v => v + 1)
  }, [iopsData])

  // Single ResizeObserver for the OSD grid — all charts get the same width at once
  useEffect(() => {
    const el = osdGridRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setOsdGridWidth(e.contentRect.width))
    ro.observe(el)
    setOsdGridWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const { data: details, isLoading: detailsLoading } = useQuery<DetailsData>({
    queryKey: ['details', name],
    queryFn: () => api.get(`/clusters/${name}/details`),
    staleTime: 60_000,
    retry: false,
    enabled: health?.status === 'HEALTHY' || health?.status === 'DEGRADED',
  })

  const { data: clusterList = [] } = useQuery<any[]>({
    queryKey: ['clusters'],
    queryFn: () => api.get('/clusters/active'),
    staleTime: 30_000,
  })
  const cluster = clusterList.find((c: any) => c.cluster_name === name)

  const podGroups = groupPods(details?.pods ?? [])
  const masters = health?.nodes?.filter(n => n.role === 'master') ?? []
  const workers = health?.nodes?.filter(n => n.role !== 'master') ?? []
  const osd = health?.odf

  return (
    <div className="w-full h-full overflow-y-auto">
    <div className="p-8 max-w-[1800px] space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm font-mono">
        <Link to="/clusters" className="text-text-muted hover:text-accent-cyan transition-colors">
          My Clusters
        </Link>
        <span className="text-surface-4">/</span>
        <span className="text-text-primary">{name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-mono font-semibold text-text-primary">{name}</h1>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
            <span className="text-xs font-mono text-text-muted">
              OCP{' '}
              <span className="text-accent-cyan">
                {health?.ocp_full_version || cluster?.ocp_version || '…'}
              </span>
            </span>
            <span className="text-xs font-mono text-text-muted">
              ODF{' '}
              <span className="text-accent-green">
                {health?.odf_full_version || cluster?.ocs_version || '…'}
              </span>
            </span>
            {cluster?.credentials_conf && (
              <span className="text-xs font-mono text-text-muted">
                {cluster.credentials_conf.replace(/-VC\d+$/, '')}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap text-xs font-mono">
          {cluster?.console_url && (
            <a href={cluster.console_url} target="_blank" rel="noreferrer"
              className="btn-ghost text-xs">Console ↗</a>
          )}
          {cluster?.logs_url && (
            <a href={cluster.logs_url} target="_blank" rel="noreferrer"
              className="btn-ghost text-xs">Logs ↗</a>
          )}
          {cluster?.build_url && (
            <a href={cluster.build_url} target="_blank" rel="noreferrer"
              className="btn-ghost text-xs">Jenkins ↗</a>
          )}
          <a
            href={`/api/clusters/${name}/kubeconfig`}
            download={`kubeconfig-${name}`}
            className="btn-ghost text-xs text-accent-green border-accent-green/30 hover:border-accent-green"
          >
            ↓ kubeconfig
          </a>
        </div>
      </div>

      {/* OCP Nodes */}
      <section>
        <h2 className="text-xs font-mono text-text-muted uppercase tracking-widest mb-3">
          OCP Nodes
          {health?.nodes && (
            <span className="ml-2 text-text-secondary normal-case tracking-normal">
              {masters.length} masters · {workers.length} workers
            </span>
          )}
        </h2>
        {!details?.nodes_detail && detailsLoading && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {Array(6).fill(null).map((_, i) => (
              <div key={i} className="card h-24 animate-pulse" />
            ))}
          </div>
        )}
        {details?.nodes_detail && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {[...details.nodes_detail]
              .sort((a, b) => (a.role === b.role ? 0 : a.role === 'master' ? -1 : 1))
              .map(n => <NodePanel key={n.name} node={n} />)
            }
          </div>
        )}
      </section>

      {/* ODF Overview */}
      {osd && (
        <section>
          <h2 className="text-xs font-mono text-text-muted uppercase tracking-widest mb-3">ODF Status</h2>
          <div className="card p-4 space-y-4">
            {/* Phase + Ceph health */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className={`px-3 py-1 rounded border font-mono text-sm font-semibold ${
                osd.phase === 'Ready'
                  ? 'bg-accent-green/10 border-accent-green/30 text-accent-green'
                  : 'bg-accent-amber/10 border-accent-amber/30 text-accent-amber'
              }`}>
                {osd.phase}
              </span>
              {health?.ceph_capacity?.health && (
                <span className={`text-xs font-mono px-2 py-0.5 rounded border ${
                  health.ceph_capacity.health === 'HEALTH_OK'
                    ? 'text-accent-green border-accent-green/30 bg-accent-green/5'
                    : 'text-accent-amber border-accent-amber/30 bg-accent-amber/5'
                }`}>
                  {health.ceph_capacity.health}
                </span>
              )}
              {health?.status === 'DEGRADED' && health.degraded_reason && (
                <span className="text-xs font-mono px-2 py-0.5 rounded border border-accent-amber/30 bg-accent-amber/5 text-accent-amber">
                  ⚠ {health.degraded_reason}
                </span>
              )}
              <div className="flex items-center gap-3 ml-auto text-xs font-mono text-text-muted">
                {health?.osd_up != null && <span>{health.osd_up} up</span>}
                {health?.osd_in != null && <span>{health.osd_in} in</span>}
                {health?.osd_count != null && <span>{health.osd_count} total</span>}
              </div>
            </div>

            {/* Capacity bar */}
            {health?.ceph_capacity?.bytes_total ? (
              <OsdCapacityBar
                capacity={health.ceph_capacity}
                clusterName={name!}
                kubeconfigUrl={cluster?.kubeconfig_url}
              />
            ) : null}

            <div className="grid gap-8 items-start" style={{ gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)' }}>
              {/* Left: OSD tiles + OSD throughput + workload list/graph */}
              <div className="space-y-4">
                {health?.osd_count ? (
                  <OsdGrid
                    count={health.osd_count}
                    up={health.osd_up ?? health.osd_count}
                    osdSize={cluster?.osd_size}
                    capacity={health.ceph_capacity}
                    iops={
                      iopsData?.osd_iops ??
                      (Object.keys(lastOsdIopsRef.current).length > 0 ? lastOsdIopsRef.current : health.osd_iops)
                    }
                    osdStatus={iopsData?.osd_status}
                  />
                ) : null}

                {/* OSD throughput section with mode toggle */}
                {Object.keys(osdHistoryRef.current).length > 0 && (
                  <div className="space-y-2">
                    {/* Section header + toggle */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <p className="text-[9px] font-mono text-text-muted uppercase tracking-widest">OSD Throughput</p>
                        {osdMode === 'osd' && (cephAgg.r > 0 || cephAgg.w > 0) && (
                          <span className="text-[9px] font-mono text-text-muted">
                            R <span className="text-[#00d4ff]">{cephAgg.r.toFixed(1)}</span>
                            {' '}W <span className="text-[#50fa7b]">{cephAgg.w.toFixed(1)}</span>
                            {' '}MB/s total
                          </span>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <button onClick={() => setOsdMode('osd')}
                          className={`text-[9px] font-mono px-2 py-0.5 rounded border transition-colors ${
                            osdMode === 'osd'
                              ? 'border-accent-cyan/60 text-accent-cyan bg-accent-cyan/10'
                              : 'border-surface-4 text-text-muted hover:border-accent-cyan/30'
                          }`}>
                          Per OSD
                        </button>
                        <button onClick={() => setOsdMode('pool')}
                          className={`text-[9px] font-mono px-2 py-0.5 rounded border transition-colors ${
                            osdMode === 'pool'
                              ? 'border-accent-cyan/60 text-accent-cyan bg-accent-cyan/10'
                              : 'border-surface-4 text-text-muted hover:border-accent-cyan/30'
                          }`}>
                          By Pool
                        </button>
                      </div>
                    </div>

                    {/* Per OSD mode: per-OSD R/W charts, 3 per row, all same width */}
                    {osdMode === 'osd' && (() => {
                      const GAP = 8, COLS = 3
                      const cw = osdGridWidth > 0
                        ? Math.floor((osdGridWidth - GAP * (COLS - 1)) / COLS)
                        : undefined
                      return (
                        <div ref={osdGridRef} className="grid grid-cols-3 gap-2">
                          {Object.entries(osdHistoryRef.current)
                            .sort(([a], [b]) => Number(a) - Number(b))
                            .map(([osd, hist]) => (
                              <ThroughputChart
                                key={osd}
                                data={hist}
                                series={OSD_SERIES}
                                areaKey="total"
                                title={`OSD ${osd}`}
                                height={140}
                                containerWidth={cw}
                                visibleSecs={60}
                              />
                            ))}
                        </div>
                      )
                    })()}

                    {/* By Pool mode: RBD / CephFS / NooBaa from Prometheus pool metrics */}
                    {osdMode === 'pool' && (
                      <ThroughputChart
                        data={poolHistoryRef.current}
                        title="Pool Throughput"
                      />
                    )}
                  </div>
                )}

                <WorkloadPanel
                  clusterName={name!}
                  kubeconfigUrl={cluster?.kubeconfig_url}
                  showLauncher={false}
                  sharedRatesRef={isOwner ? sharedRatesRef : undefined}
                  cephAgg={cephAgg}
                />
              </div>
              {/* Right: launcher + recording (owner only) — shares ratesRef with list panel */}
              {isOwner && (
                <div>
                  <WorkloadPanel
                    clusterName={name!}
                    kubeconfigUrl={cluster?.kubeconfig_url}
                    showList={false}
                    sharedRatesRef={sharedRatesRef}
                    cephAgg={cephAgg}
                  />
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ODF Pods */}
      {(details?.pods?.length ?? 0) > 0 && (
        <section>
          <h2 className="text-xs font-mono text-text-muted uppercase tracking-widest mb-3">
            ODF Pods
            <span className="ml-2 text-text-secondary normal-case tracking-normal">
              {details!.pods!.filter(p => p.phase === 'Running' && p.ready).length}/{details!.pods!.length} running
            </span>
          </h2>
          <div className="card p-4 space-y-3">
            {Object.entries(podGroups).map(([label, pods]) => (
              <PodSwimlane key={label} label={label} pods={pods} />
            ))}
          </div>
        </section>
      )}

      {/* PVCs */}
      {(details?.pvcs?.length ?? 0) > 0 && (
        <section>
          <h2 className="text-xs font-mono text-text-muted uppercase tracking-widest mb-3">
            PVCs <span className="ml-2 text-text-secondary normal-case tracking-normal">{details!.pvcs!.length} total</span>
          </h2>
          <div className="card divide-y divide-surface-4">
            {details!.pvcs!.map(p => (
              <div key={p.name} className="px-4 py-2 flex items-center gap-4 text-xs font-mono">
                <span className="text-text-primary truncate flex-1">{p.name}</span>
                <span className="text-text-muted shrink-0">{p.capacity}</span>
                <span className="text-text-muted shrink-0 hidden md:block">{p.storage_class}</span>
                <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] ${
                  p.phase === 'Bound'
                    ? 'text-accent-green border-accent-green/30 bg-accent-green/10'
                    : 'text-accent-amber border-accent-amber/30 bg-accent-amber/10'
                }`}>{p.phase}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {detailsLoading && (
        <p className="text-xs font-mono text-text-muted animate-pulse">Loading cluster details…</p>
      )}

      {health?.status === 'UNREACHABLE' && (
        <div className="card p-4 text-sm font-mono text-text-muted">
          Cluster is unreachable — cannot fetch pod or PVC data.
        </div>
      )}
    </div>
    </div>
  )
}
