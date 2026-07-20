import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import ThroughputChart, { type DataPoint, SERIES, RW_SERIES } from './ThroughputChart'
import SessionReplayModal, { type SessionFull, type SessionEvent } from './SessionReplayModal'

interface SessionSummary {
  id: number; name: string; cluster_name: string; username: string
  status: string; started_at: string; ended_at: string | null
  event_count: number; duration_ms: number
}

interface WorkloadEntry {
  id: number
  workload_type: string
  size_gb: number
  mode: string
  pattern: string
  namespace: string
  pod_name: string
  created_at: string
  phase: string
}

const TYPE_LABELS: Record<string, string> = { rbd: 'RBD', cephfs: 'CephFS', noobaa: 'NooBaa' }
const TYPE_COLORS: Record<string, string> = {
  rbd:    'text-accent-cyan border-accent-cyan/40',
  cephfs: 'text-accent-green border-accent-green/40',
  noobaa: 'text-accent-amber border-accent-amber/40',
}
const PHASE_COLORS: Record<string, string> = {
  Running:   'text-accent-cyan',
  Succeeded: 'text-accent-green',
  Failed:    'text-accent-red',
  Pending:   'text-accent-amber',
  Unknown:   'text-text-muted',
}

function ProgressBar({ progress }: { progress: number | null }) {
  if (progress === null) {
    return (
      <div className="h-1.5 bg-surface-4 rounded-full overflow-hidden">
        <div className="h-full bg-accent-cyan/40 rounded-full animate-pulse w-full" />
      </div>
    )
  }
  return (
    <div className="h-1.5 bg-surface-4 rounded-full overflow-hidden">
      <div
        className="h-full bg-accent-cyan rounded-full transition-all duration-500"
        style={{ width: `${Math.min(progress, 100)}%` }}
      />
    </div>
  )
}

function WorkloadCard({
  workload,
  clusterName,
  onDelete,
  onRateUpdate,
  autoDelete = false,
}: {
  workload: WorkloadEntry
  clusterName: string
  onDelete: () => void
  onRateUpdate?: (id: number, rateMb: number | null) => void
  autoDelete?: boolean
}) {
  const [logs, setLogs]           = useState<string[]>([])
  const [progress, setProgress]   = useState<number | null>(null)
  const [rate, setRate]           = useState<string>('')
  const [eta, setEta]             = useState<string>('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [cleaning, setCleaning]   = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const esRef  = useRef<EventSource | null>(null)

  const ageMs = Date.now() - new Date(workload.created_at).getTime()
  const isActive = workload.phase === 'Running' || workload.phase === 'Pending' ||
    (workload.phase === 'Unknown' && ageMs < 10 * 60 * 1000)

  useEffect(() => {
    if (!isActive || cleaning) return
    const es = new EventSource(`/api/clusters/${clusterName}/workloads/${workload.id}/logs`, { withCredentials: true })
    esRef.current = es
    const streamStart = Date.now()

    es.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.line) {
        const elapsed = ((Date.now() - streamStart) / 1000).toFixed(1)
        setLogs(prev => [...prev, `[+${elapsed}s] ${data.line}`].slice(-150))
      }
      if (data.progress != null) setProgress(data.progress)
      if (data.eta)              setEta(data.eta)
      if (data.rate) {
        setRate(data.rate)
        // Parse to MB/s number for aggregation: "234MiB/s", "7MB/s", "45MB/s"
        const m = data.rate.match(/^([\d.]+)\s*(MiB|MB|KiB|KB|GiB|GB)\/s/)
        if (m) {
          const val = parseFloat(m[1])
          const unit = m[2]
          const mb = unit.startsWith('K') ? val / 1024 : unit.startsWith('G') ? val * 1024 : val
          onRateUpdate?.(workload.id, mb)
        }
      }
    }
    es.onerror = () => { es.close(); onRateUpdate?.(workload.id, null) }
    return () => { es.close(); esRef.current = null; onRateUpdate?.(workload.id, null) }
  }, [workload.id, isActive, cleaning, clusterName])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  function triggerCleanup() {
    if (cleaning) return
    onRateUpdate?.(workload.id, null)
    esRef.current?.close()
    setCleaning(true)
    setLogs(prev => [...prev, '[jenease] Starting cleanup…'])
    setProgress(null)
    const es = new EventSource(`/api/clusters/${clusterName}/workloads/${workload.id}/cleanup`, { withCredentials: true })
    esRef.current = es
    es.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.line) setLogs(prev => [...prev, data.line].slice(-150))
      if (data.done) { es.close(); setTimeout(() => onDelete(), 800) }
    }
    es.onerror = () => { es.close(); setTimeout(() => onDelete(), 1000) }
  }

  // Trigger cleanup automatically when parent requests clear-all
  useEffect(() => { if (autoDelete) triggerCleanup() }, [autoDelete])

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    triggerCleanup()
  }

  const age = (() => {
    const ms = Date.now() - new Date(workload.created_at).getTime()
    const m  = Math.floor(ms / 60_000)
    const h  = Math.floor(m / 60)
    return h > 0 ? `${h}h ${m % 60}m` : `${m}m`
  })()

  return (
    <div className="border border-surface-4 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-2 border-b border-surface-4">
        <span className={`text-[10px] font-mono font-semibold border rounded px-1.5 py-0.5 ${TYPE_COLORS[workload.workload_type] ?? 'text-text-secondary border-surface-4'}`}>
          {TYPE_LABELS[workload.workload_type] ?? workload.workload_type}
        </span>
        <span className="text-xs font-mono text-text-secondary">{workload.size_gb}GB</span>
        <span className="text-xs font-mono text-text-muted">{workload.mode}</span>
        <span className="text-xs font-mono text-text-muted">{workload.pattern}</span>
        <span className={`text-[10px] font-mono ml-auto ${PHASE_COLORS[workload.phase] ?? 'text-text-muted'}`}>
          {workload.phase === 'Running' && <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse mr-1" />}
          {workload.phase}
        </span>
        <span className="text-[10px] font-mono text-text-muted">{age}</span>
        {!cleaning && (
          <>
            <button
              onClick={handleDelete}
              className={`text-[10px] font-mono transition-colors ml-1 ${
                confirmDelete ? 'text-accent-red' : 'text-text-muted hover:text-accent-red'
              }`}
            >
              {confirmDelete ? 'Confirm?' : '✕'}
            </button>
            {confirmDelete && (
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-[10px] font-mono text-text-muted hover:text-text-primary"
              >
                Cancel
              </button>
            )}
          </>
        )}
        {cleaning && (
          <span className="text-[10px] font-mono text-accent-amber ml-1">cleaning…</span>
        )}
      </div>

      {/* Progress bar + stats */}
      <div className="px-3 py-2 space-y-1 bg-surface-2/50">
        <div className="flex items-center justify-between text-[10px] font-mono text-text-muted mb-1">
          <span>{progress != null ? `${progress.toFixed(1)}%` : workload.phase === 'Pending' ? 'Waiting for pod…' : '—'}</span>
          <span className="flex gap-3">
            {rate && <span className="text-accent-cyan">{rate}/s</span>}
            {eta  && <span>eta {eta}</span>}
          </span>
        </div>
        <ProgressBar progress={progress} />
      </div>

      {/* Log terminal */}
      <div
        ref={logRef}
        className="bg-surface-0 px-3 py-2 h-36 overflow-y-auto font-mono text-[10px] leading-relaxed text-text-secondary"
      >
        {logs.length === 0 ? (
          <span className="text-text-muted animate-pulse">Waiting for output…</span>
        ) : (
          logs.map((line, i) => (
            <div key={i} className={
              line.includes('[jenease]') ? 'text-accent-cyan' :
              line.includes('[error]')   ? 'text-accent-red' :
              line.includes('%')         ? 'text-text-primary' :
              'text-text-secondary'
            }>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default function WorkloadPanel({
  clusterName,
  kubeconfigUrl,
  showLauncher = true,
  showList = true,
  sharedRatesRef,
  cephAgg,
  historyRef,
  poolBreakdown,
}: {
  clusterName: string
  kubeconfigUrl?: string
  showLauncher?: boolean
  showList?: boolean
  sharedRatesRef?: React.MutableRefObject<Record<number, number>>
  cephAgg?: { r: number; w: number }
  poolBreakdown?: { rbd: number; cephfs: number; noobaa: number }
  historyRef?: React.MutableRefObject<DataPoint[]>
}) {
  const queryClient = useQueryClient()

  // Form state
  const [type,       setType]       = useState<'rbd' | 'cephfs' | 'noobaa'>('rbd')
  const [size,       setSize]       = useState(10)
  const [mode,       setMode]       = useState<'write' | 'read' | 'readwrite'>('write')
  const [pattern,    setPattern]    = useState<'sequential' | 'random'>('sequential')
  // RBD / CephFS fio options
  const [blockSize,  setBlockSize]  = useState('1m')
  const [numJobs,    setNumJobs]    = useState(4)
  const [iodepth,    setIodepth]    = useState(32)
  const [duration,   setDuration]   = useState(0)   // 0 = size-based
  const [engine,     setEngine]     = useState('libaio')
  const [direct,     setDirect]     = useState(true)
  // NooBaa options
  const [objSizeMb,  setObjSizeMb]  = useState(64)
  const [workers,    setWorkers]    = useState(8)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState('')

  // Node pin state
  const [nodeName, setNodeName] = useState<string>('')

  // ── Sequence state ──────────────────────────────────────────────────────
  interface SeqItem {
    id: number; offset_sec: number; workload_type: string; size_gb: number
    mode: string; pattern: string; block_size: string; num_jobs: number
    iodepth: number; duration_sec: number; obj_size_mb: number; workers: number
    engine: string; direct: boolean; node_name?: string
  }
  const [seqItems,    setSeqItems]    = useState<SeqItem[]>([])
  const [seqName,     setSeqName]     = useState('')
  const [seqRecord,   setSeqRecord]   = useState(false)
  const [seqSync,     setSeqSync]     = useState(false)
  const [seqRunning,  setSeqRunning]  = useState(false)
  const [seqCounter,  setSeqCounter]  = useState(0)   // local id generator
  const [showAllSeqs, setShowAllSeqs] = useState(false)
  const { data: savedSeqs = [], refetch: refetchSeqs } = useQuery<any[]>({
    queryKey: ['sequences', showAllSeqs],
    queryFn: () => api.get(`/sequences/${showAllSeqs ? '?all=true' : ''}`),
    staleTime: 30_000,
  })

  const { data: imageStatus, refetch: refetchImageStatus } = useQuery<{
    nodes: { name: string; fio: boolean; noobaa: boolean }[]
    all_cached: boolean
  }>({
    queryKey: ['image-status', clusterName],
    queryFn: () => api.get(`/clusters/${clusterName}/image-status`),
    staleTime: 60_000,
    refetchInterval: 90_000,
    enabled: showLauncher,
  })

  const { data: workerNodesData } = useQuery<{ nodes: { name: string; fio: boolean; noobaa: boolean }[] }>({
    queryKey: ['worker-nodes', clusterName],
    queryFn: () => api.get(`/clusters/${clusterName}/worker-nodes?kubeconfig_url=${encodeURIComponent(kubeconfigUrl ?? '')}`),
    staleTime: 60_000,
    refetchInterval: 60_000,
    enabled: showLauncher && !!kubeconfigUrl,
  })
  const workerNodes = workerNodesData?.nodes ?? []

  const cephAggRef = useRef<{r: number; w: number}>({r: 0, w: 0})
  cephAggRef.current = cephAgg ?? {r: 0, w: 0}
  const poolBreakdownRef = useRef<{rbd: number; cephfs: number; noobaa: number}>({rbd: 0, cephfs: 0, noobaa: 0})
  poolBreakdownRef.current = poolBreakdown ?? {rbd: 0, cephfs: 0, noobaa: 0}
  const [showRW, setShowRW] = useState(false)

  const [purging, setPurging] = useState(false)
  const [clearAll, setClearAll] = useState(false)
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const [prepulling, setPrepulling] = useState(false)
  const [prepullMsg, setPrepullMsg] = useState('')
  const [rates, setRates] = useState<Record<number, number>>({})
  const [history, setHistory] = useState<DataPoint[]>([])
  const localRatesRef = useRef<Record<number, number>>({})
  const ratesRef = sharedRatesRef ?? localRatesRef
  const workloadsRef = useRef<WorkloadEntry[]>([])

  // Recording state
  const [recordingId,    setRecordingId]    = useState<number | null>(null)
  const [recordingStart, setRecordingStart] = useState<number | null>(null)
  const [recordingElapsed, setRecordingElapsed] = useState(0)
  const [recordingError,   setRecordingError]   = useState('')
  const [startingRec,      setStartingRec]      = useState(false)
  const [replaySession,  setReplaySession]  = useState<SessionFull | null>(null)
  const [deploySession,  setDeploySession]  = useState<SessionSummary | null>(null)
  const [deployFull,     setDeployFull]     = useState<SessionFull | null>(null)
  const [deploying,      setDeploying]      = useState(false)
  const [renamingId,     setRenamingId]     = useState<number | null>(null)
  const [renameValue,    setRenameValue]    = useState('')
  const recordingIdRef = useRef<number | null>(null)
  recordingIdRef.current = recordingId

  const { data: sessions = [], refetch: refetchSessions } = useQuery<SessionSummary[]>({
    queryKey: ['sessions'],
    queryFn: () => api.get('/sessions/'),
    staleTime: 30_000,
  })

  function handleRateUpdate(id: number, rateMb: number | null) {
    setRates(prev => {
      const next = { ...prev }
      if (rateMb == null) delete next[id]
      else next[id] = rateMb
      ratesRef.current = next
      return next
    })
  }

  // Sample per-type and total MB/s every second; push to recording if active
  useEffect(() => {
    const id = setInterval(() => {
      const byType: Record<string, number> = { rbd: 0, cephfs: 0, noobaa: 0 }
      for (const w of workloadsRef.current) {
        const r = ratesRef.current[w.id] ?? 0
        byType[w.workload_type] = (byType[w.workload_type] ?? 0) + r
      }
      const fioTotal = Object.values(byType).reduce((a, b) => a + b, 0)
      // When no fio workloads active, fill in pool breakdown from Ceph metrics
      // so the chart shows RBD/CephFS/NooBaa lines for all users at 1s resolution.
      const pool = poolBreakdownRef.current
      const rbd    = fioTotal > 0 ? byType.rbd    : pool.rbd
      const cephfs = fioTotal > 0 ? byType.cephfs : pool.cephfs
      const noobaa = fioTotal > 0 ? byType.noobaa : pool.noobaa
      const total  = fioTotal > 0 ? fioTotal : rbd + cephfs + noobaa
      const now = Date.now()
      setHistory(prev => {
        const next = [...prev.slice(-600), {
          ts: now, total,
          rbd, cephfs, noobaa,
          ceph_r: cephAggRef.current.r,
          ceph_w: cephAggRef.current.w,
        }]
        if (historyRef) historyRef.current = next
        return next
      })

      // Push throughput sample to active recording
      const sid = recordingIdRef.current
      if (sid && recordingStart !== null) {
        setRecordingElapsed(e => e + 1)
        const offset_ms = now - recordingStart
        api.post(`/sessions/${sid}/throughput`, [{
          offset_ms,
          rbd: byType.rbd,
          cephfs: byType.cephfs,
          noobaa: byType.noobaa,
          total,
        }]).catch(() => {})
      }
    }, 1000)
    return () => clearInterval(id)
  }, [recordingStart])

  const { data: workloads = [], refetch } = useQuery<WorkloadEntry[]>({
    queryKey: ['workloads', clusterName],
    queryFn: () => api.get(`/clusters/${clusterName}/workloads`),
    refetchInterval: 10_000,
  })

  const activeWorkloads = workloads.filter(w => w.phase === 'Running' || w.phase === 'Pending')
  // Reset clearAll once all workloads have been removed
  useEffect(() => { if (clearAll && workloads.length === 0) setClearAll(false) }, [clearAll, workloads.length])
  const { data: healthData } = useQuery<{ ceph_capacity?: { health?: string }; degraded_reason?: string; status?: string }>({
    queryKey: ['health', clusterName],
    queryFn: () => api.get(`/clusters/${clusterName}/health`),
    refetchInterval: 2_000,
    enabled: showList && workloads.length > 0,
  })
  workloadsRef.current = workloads

  async function handlePurge() {
    setPurging(true)
    try {
      await api.post(`/clusters/${clusterName}/workloads/purge`, {})
      await refetch()
    } finally {
      setPurging(false)
    }
  }

  async function handleLaunch() {
    setLaunching(true)
    setLaunchError('')
    try {
      await api.post(`/clusters/${clusterName}/workloads`, {
        workload_type: type,
        size_gb: size,
        mode,
        pattern,
        block_size: blockSize,
        num_jobs: numJobs,
        iodepth,
        duration_sec: duration,
        obj_size_mb: objSizeMb,
        workers,
        engine,
        direct,
        node_name: nodeName,
        session_id: recordingId,
        kubeconfig_url: kubeconfigUrl,
      })
      await refetch()
    } catch (e: any) {
      setLaunchError((e as Error).message)
    } finally {
      setLaunching(false)
    }
  }

  async function startRecording() {
    setStartingRec(true)
    setRecordingError('')
    try {
      const res = await api.post<{ id: number; name: string }>('/sessions/', { cluster_name: clusterName })
      setRecordingId(res.id)
      setRecordingStart(Date.now())
      setRecordingElapsed(0)
      refetchSessions()
    } catch (e: any) {
      setRecordingError(e?.message ?? 'Failed to start recording')
    } finally {
      setStartingRec(false)
    }
  }

  async function stopRecording() {
    if (!recordingId) return
    try {
      await api.post(`/sessions/${recordingId}/stop`, {})
    } catch { /* best-effort */ }
    setRecordingId(null)
    setRecordingStart(null)
    setRecordingElapsed(0)
    refetchSessions()
  }

  async function openDeploy(s: SessionSummary) {
    const full = await api.get<SessionFull>(`/sessions/${s.id}`)
    setDeploySession(s)
    setDeployFull(full)
  }

  async function openReplay(s: SessionSummary) {
    const full = await api.get<SessionFull>(`/sessions/${s.id}`)
    setReplaySession(full)
  }

  async function execDeploy() {
    if (!deployFull) return
    setDeploying(true)
    const events = [...deployFull.events].sort((a, b) => a.offset_ms - b.offset_ms)
    // Track launched workload IDs by type for delete event matching (FIFO per type)
    const launched: Record<string, number[]> = {}
    for (const e of events) {
      const delay = e.offset_ms
      if ((e as any).type === 'delete') {
        setTimeout(async () => {
          // Find oldest running workload of this type and clean it up
          const queue = launched[(e as any).workload_type] || []
          const wid = queue.shift()
          if (wid) {
            const es = new EventSource(
              `/api/clusters/${clusterName}/workloads/${wid}/cleanup`,
              { withCredentials: true }
            )
            es.onmessage = (ev) => { try { if (JSON.parse(ev.data).done) { es.close(); refetch() } } catch {} }
            es.onerror = () => { es.close(); refetch() }
          }
        }, delay)
      } else {
        setTimeout(() => {
          api.post(`/clusters/${clusterName}/workloads`, {
            workload_type: e.workload_type,
            size_gb: e.size_gb,
            mode: e.mode,
            pattern: e.pattern,
            block_size: e.block_size,
            num_jobs: e.num_jobs,
            iodepth: e.iodepth,
            duration_sec: e.duration_sec,
            obj_size_mb: e.obj_size_mb,
            workers: e.workers,
            node_name: (e as any).node_name ?? '',
            session_id: null,
            kubeconfig_url: kubeconfigUrl,
          }).then((res: any) => {
            if (res?.id) {
              const t = e.workload_type
              launched[t] = [...(launched[t] || []), res.id]
            }
            refetch()
          }).catch(() => {})
        }, delay)
      }
    }
    setDeploying(false)
    setDeploySession(null)
    setDeployFull(null)
  }

  async function deleteSession(id: number) {
    await api.delete(`/sessions/${id}`)
    refetchSessions()
  }

  async function saveRename(id: number) {
    if (renameValue.trim()) {
      await api.patch(`/sessions/${id}`, { name: renameValue.trim() })
      refetchSessions()
    }
    setRenamingId(null)
    setRenameValue('')
  }

  function fmtElapsed(s: number) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  function fmtDuration(ms: number) {
    const s = Math.floor(ms / 1000)
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
  }

  function captureCurrentParams() {
    return { workload_type: type, size_gb: size, mode, pattern, block_size: blockSize,
      num_jobs: numJobs, iodepth, duration_sec: duration, obj_size_mb: objSizeMb,
      workers, engine, direct, node_name: nodeName }
  }

  function handleAddToSequence() {
    const lastOffset = seqItems.length > 0 ? seqItems[seqItems.length - 1].offset_sec : -10
    const id = seqCounter + 1; setSeqCounter(id)
    setSeqItems(prev => [...prev, { id, offset_sec: Math.max(0, lastOffset + 10), ...captureCurrentParams() }])
  }

  async function handleRunSequence() {
    if (seqItems.length === 0) return
    setSeqRunning(true)

    // Start recording FIRST — before any workload is initiated
    // If seqRecord is checked, create a new session; otherwise fall back to any active manual recording
    let sessionId: number | null = recordingId
    if (seqRecord) {
      try {
        const name = seqSync ? `[sync] ${clusterName}` : clusterName
        const res = await api.post<{ id: number; name: string }>('/sessions/', { cluster_name: name })
        sessionId = res.id
        setRecordingId(res.id)
        setRecordingStart(Date.now())
        setRecordingElapsed(0)
      } catch { /* best-effort */ }
    }

    if (seqSync) {
      // Synchronized mode — create all pods first, then fire IO simultaneously
      try {
        await api.post(`/clusters/${clusterName}/workloads/sync-launch`, {
          workloads: seqItems.map(({ id: _id, ...rest }) => rest),
          session_id: sessionId,
          kubeconfig_url: kubeconfigUrl,
        })
        await refetch()
      } catch (e: any) {
        console.error('[sequence sync] failed:', e?.message)
      }
    } else {
      const t0 = Date.now()
      for (const item of [...seqItems].sort((a, b) => a.offset_sec - b.offset_sec)) {
        const delay = item.offset_sec * 1000 - (Date.now() - t0)
        await new Promise(r => setTimeout(r, Math.max(0, delay)))
        api.post(`/clusters/${clusterName}/workloads`, { ...item, node_name: item.node_name ?? '', session_id: sessionId, kubeconfig_url: kubeconfigUrl })
          .then(() => refetch())
          .catch((e: any) => console.error(`[sequence] ${item.workload_type} failed:`, e?.message))
      }
    }
    setSeqRunning(false)
  }

  async function handleSaveSequence() {
    const name = seqName.trim() || `Sequence ${new Date().toLocaleTimeString()}`
    await api.post('/sequences/', { name, items: seqItems.map(({ id: _id, ...rest }) => rest) })
    refetchSeqs()
  }

  async function handleDeleteSeq(id: number) {
    await api.delete(`/sequences/${id}`)
    refetchSeqs()
  }

  function loadSavedSeq(s: any) {
    let counter = seqCounter
    setSeqItems(s.items.map((item: any) => { counter++; return { id: counter, ...item } }))
    setSeqCounter(counter)
    setSeqName(s.name)
  }

  function seqItemLabel(item: SeqItem) {
    const nodeTag = item.node_name ? ` [${item.node_name}]` : ''
    if (item.workload_type === 'noobaa') return `NooBaa ${item.size_gb}GB ${item.mode}${nodeTag}`
    return `${item.workload_type.toUpperCase()} ${item.size_gb}GB ${item.mode} ${item.pattern}${nodeTag}`
  }

  function Btn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
      <button
        onClick={onClick}
        className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
          active
            ? 'border-accent-cyan text-accent-cyan bg-accent-cyan/10'
            : 'border-surface-4 text-text-primary hover:border-accent-cyan/40 hover:text-accent-cyan'
        }`}
      >
        {children}
      </button>
    )
  }

  return (
    <>
    <div className="flex flex-col gap-3 min-w-0">
      {showLauncher && <p className="text-[9px] font-mono text-text-muted uppercase tracking-widest">Workloads</p>}

      {/* Launcher */}
      {showLauncher && <div className="border border-surface-4 rounded-lg p-3 space-y-2.5 bg-surface-2/30">
        {/* Image cache status + pre-pull */}
        {imageStatus && (
          <div className="pb-1 border-b border-surface-4 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Images</span>
              <button onClick={() => refetchImageStatus()} className="text-[9px] font-mono text-text-muted hover:text-accent-cyan transition-colors">↻</button>
              <div className="flex gap-1.5">
                {imageStatus.nodes.map(node => (
                  <div key={node.name} className="relative group cursor-default">
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                      node.fio && node.noobaa
                        ? 'bg-accent-green/10 text-accent-green'
                        : node.fio || node.noobaa
                          ? 'bg-yellow-500/10 text-yellow-400'
                          : 'bg-accent-red/10 text-accent-red'
                    }`}>
                      {node.name} {node.fio && node.noobaa ? '✓' : '⚠'}
                    </span>
                    <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-20
                      bg-surface-3 border border-border rounded p-1.5 text-[8px] font-mono whitespace-nowrap shadow-lg">
                      <div className={node.fio ? 'text-accent-green' : 'text-accent-red'}>
                        {node.fio ? '✓' : '✗'} quay.io/ocsci/nginx:latest
                      </div>
                      <div className={node.noobaa ? 'text-accent-green' : 'text-accent-red'}>
                        {node.noobaa ? '✓' : '✗'} ubi9/python-311:latest
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {!imageStatus.all_cached && (
              <div className="flex items-center gap-2">
                <button onClick={async () => {
                  setPrepulling(true); setPrepullMsg('')
                  try {
                    await api.post(`/clusters/${clusterName}/prepull`, {})
                    setPrepullMsg('⏳ Pulling… status updates automatically')
                    const poll = setInterval(() => refetchImageStatus(), 30_000)
                    setTimeout(() => {
                      clearInterval(poll)
                      refetchImageStatus().then(r => {
                        const allDone = r.data?.all_cached
                        setPrepullMsg(allDone ? '✓ All nodes cached' : '⚠ Some nodes still missing — try again')
                      })
                    }, 6 * 60 * 1000)
                  } catch { setPrepullMsg('Pre-pull failed') }
                  finally { setPrepulling(false) }
                }} disabled={prepulling}
                  className="text-[9px] font-mono text-accent-cyan hover:text-accent-cyan/80 transition-colors">
                  {prepulling ? '⏳ Starting…' : '⬇ Pre-pull missing images'}
                </button>
                {prepullMsg && <span className="text-[9px] font-mono text-text-muted">{prepullMsg}</span>}
              </div>
            )}
          </div>
        )}
        {/* Type */}
        <div className="space-y-1">
          <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Type</p>
          <div className="flex gap-1.5 flex-wrap">
            <Btn active={type === 'rbd'}    onClick={() => setType('rbd')}>RBD</Btn>
            <Btn active={type === 'cephfs'} onClick={() => setType('cephfs')}>CephFS</Btn>
            <Btn active={type === 'noobaa'} onClick={() => setType('noobaa')}>NooBaa</Btn>
          </div>
        </div>

        {/* Node pin — only shown when worker nodes are known */}
        {workerNodes.length > 0 && (
          <div className="space-y-1">
            <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Node</p>
            <div className="flex gap-1.5 flex-wrap">
              <Btn active={nodeName === ''} onClick={() => setNodeName('')}>None</Btn>
              {workerNodes.map(n => {
                const dotColor = n.fio && n.noobaa
                  ? 'bg-accent-green'
                  : (n.fio || n.noobaa) ? 'bg-yellow-400' : 'bg-accent-red'
                return (
                  <button key={n.name}
                    onClick={() => setNodeName(n.name)}
                    className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors flex items-center gap-1 ${
                      nodeName === n.name
                        ? 'border-accent-cyan text-accent-cyan bg-accent-cyan/10'
                        : 'border-surface-4 text-text-primary hover:border-accent-cyan/40 hover:text-accent-cyan'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                    {n.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Size — PVC / total data */}
        <div className="space-y-1">
          <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">
            {type === 'noobaa' ? 'Total Data' : 'PVC Size'}
          </p>
          <div className="flex gap-1.5 flex-wrap">
            {[1, 10, 50, 100].map(s => (
              <Btn key={s} active={size === s} onClick={() => setSize(s)}>{s}GB</Btn>
            ))}
          </div>
        </div>

        {/* Mode */}
        <div className="space-y-1">
          <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Mode</p>
          <div className="flex gap-1.5 flex-wrap">
            <Btn active={mode === 'write'}     onClick={() => setMode('write')}>Write</Btn>
            <Btn active={mode === 'read'}      onClick={() => setMode('read')}>Read</Btn>
            <Btn active={mode === 'readwrite'} onClick={() => setMode('readwrite')}>R+W</Btn>
          </div>
        </div>

        {/* ── RBD / CephFS options ── */}
        {type !== 'noobaa' && (<>
          <div className="space-y-1">
            <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Pattern</p>
            <div className="flex gap-1.5">
              <Btn active={pattern === 'sequential'} onClick={() => setPattern('sequential')}>Sequential</Btn>
              <Btn active={pattern === 'random'}     onClick={() => setPattern('random')}>Random</Btn>
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Block Size</p>
            <div className="flex gap-1.5 flex-wrap">
              {['4k', '64k', '512k', '1m', '4m'].map(bs => (
                <Btn key={bs} active={blockSize === bs} onClick={() => setBlockSize(bs)}>{bs}</Btn>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">numjobs</p>
            <div className="flex gap-1.5 flex-wrap">
              {[1, 2, 4, 8].map(n => (
                <Btn key={n} active={numJobs === n} onClick={() => setNumJobs(n)}>{n}</Btn>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">iodepth</p>
            <div className="flex gap-1.5 flex-wrap">
              {[1, 8, 32, 64, 128].map(d => (
                <Btn key={d} active={iodepth === d} onClick={() => setIodepth(d)}>{d}</Btn>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Duration</p>
            <div className="flex gap-1.5 flex-wrap">
              <Btn active={duration === 0}    onClick={() => setDuration(0)}>Size</Btn>
              <Btn active={duration === 30}   onClick={() => setDuration(30)}>30s</Btn>
              <Btn active={duration === 60}   onClick={() => setDuration(60)}>1m</Btn>
              <Btn active={duration === 300}  onClick={() => setDuration(300)}>5m</Btn>
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">IO Engine</p>
            <div className="flex gap-1.5 flex-wrap">
              <Btn active={engine === 'psync'}    onClick={() => setEngine('psync')}>psync</Btn>
              <Btn active={engine === 'posixaio'} onClick={() => setEngine('posixaio')}>posixaio</Btn>
              <Btn active={engine === 'io_uring'} onClick={() => setEngine('io_uring')}>io_uring</Btn>
              <Btn active={engine === 'libaio'}   onClick={() => setEngine('libaio')}>libaio</Btn>
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Direct IO</p>
            <div className="flex gap-1.5">
              <Btn active={direct}  onClick={() => setDirect(true)}>On</Btn>
              <Btn active={!direct} onClick={() => setDirect(false)}>Off</Btn>
            </div>
          </div>
        </>)}

        {/* ── NooBaa options ── */}
        {type === 'noobaa' && (<>
          <div className="space-y-1">
            <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Object Size</p>
            <div className="flex gap-1.5 flex-wrap">
              {[1, 16, 64, 256].map(mb => (
                <Btn key={mb} active={objSizeMb === mb} onClick={() => setObjSizeMb(mb)}>{mb}MB</Btn>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Workers</p>
            <div className="flex gap-1.5 flex-wrap">
              {[1, 4, 8, 16, 32].map(w => (
                <Btn key={w} active={workers === w} onClick={() => setWorkers(w)}>{w}</Btn>
              ))}
            </div>
          </div>
        </>)}

        {launchError && (
          <p className="text-[10px] font-mono text-accent-red">{launchError}</p>
        )}

        <button
          onClick={handleLaunch}
          disabled={launching}
          className="w-full text-xs font-mono py-1.5 rounded border border-accent-cyan/40 text-accent-cyan hover:bg-accent-cyan/10 transition-colors disabled:opacity-50"
        >
          {launching ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-3 h-3 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
              Launching…
            </span>
          ) : '▶ Launch Workload'}
        </button>

        {/* Add to Sequence */}
        <button onClick={handleAddToSequence}
          className="w-full text-[10px] font-mono py-1 rounded border border-surface-4 text-text-primary hover:border-accent-amber/50 hover:text-accent-amber transition-colors">
          + Add to Sequence
        </button>
      </div>}

      {/* ── Current Sequence ── */}
      {showLauncher && seqItems.length > 0 && (
        <div className="border border-accent-amber/30 rounded-lg p-3 space-y-2 bg-surface-2/30">
          <p className="text-[9px] font-mono text-accent-amber uppercase tracking-wider">Sequence ({seqItems.length} steps)</p>

          <div className="space-y-1">
            {[...seqItems].sort((a, b) => a.offset_sec - b.offset_sec).map(item => (
              <div key={item.id} className="flex items-center gap-2">
                <span className="text-[9px] font-mono text-text-muted">T+</span>
                <input
                  type="number" min={0} value={item.offset_sec}
                  onChange={e => setSeqItems(prev => prev.map(i => i.id === item.id ? { ...i, offset_sec: Math.max(0, Number(e.target.value)) } : i))}
                  className="w-12 text-[10px] font-mono bg-surface-3 border border-surface-4 rounded px-1 py-0.5 text-accent-amber outline-none text-center"
                />
                <span className="text-[9px] font-mono text-text-muted">s</span>
                <span className="text-[10px] font-mono text-text-secondary flex-1 truncate">{seqItemLabel(item)}</span>
                <button onClick={() => setSeqItems(prev => prev.filter(i => i.id !== item.id))}
                  className="text-text-muted hover:text-accent-red transition-colors shrink-0">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                    <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/>
                    <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>

          <input value={seqName} onChange={e => setSeqName(e.target.value)} placeholder="Sequence name…"
            className="w-full text-[10px] font-mono bg-surface-3 border border-surface-4 rounded px-2 py-1 text-text-primary outline-none" />

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={seqRecord} onChange={e => setSeqRecord(e.target.checked)}
              className="accent-accent-amber" />
            <span className="text-[10px] font-mono text-text-muted">Start recording with sequence</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={seqSync} onChange={e => setSeqSync(e.target.checked)}
              className="accent-accent-cyan" />
            <span className="text-[10px] font-mono text-text-muted">⚡ Sync IO start — create all pods first, then fire simultaneously</span>
          </label>

          <div className="flex gap-1.5">
            <button onClick={handleRunSequence} disabled={seqRunning}
              className="flex-1 text-[10px] font-mono py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10 transition-colors disabled:opacity-50">
              {seqRunning ? '⏳ Running…' : '▶ Run'}
            </button>
            <button onClick={handleSaveSequence}
              className="flex-1 text-[10px] font-mono py-1 rounded border border-accent-amber/40 text-accent-amber hover:bg-accent-amber/10 transition-colors">
              💾 Save
            </button>
            <button onClick={() => setSeqItems([])}
              className="text-[10px] font-mono px-2 py-1 rounded border border-surface-4 text-text-muted hover:text-accent-red hover:border-accent-red/40 transition-colors">
              ✕ Clear
            </button>
          </div>
        </div>
      )}

      {/* ── Recording section ── */}
      {showLauncher && (
        <div className="border border-surface-4 rounded-lg p-3 space-y-2 bg-surface-2/30">
          <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Recording</p>
          {recordingId ? (
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-[10px] font-mono text-accent-red">
                <span className="w-2 h-2 rounded-full bg-accent-red animate-pulse" />
                REC {fmtElapsed(recordingElapsed)}
              </span>
              <button onClick={stopRecording}
                className="text-[10px] font-mono px-2 py-0.5 rounded border border-accent-red/40 text-accent-red hover:bg-accent-red/10 transition-colors">
                ■ Stop
              </button>
            </div>
          ) : (
            <div className="space-y-1">
              <button onClick={startRecording} disabled={startingRec}
                className="text-[10px] font-mono px-3 py-1 rounded border border-surface-4 text-text-primary hover:border-accent-red/50 hover:text-accent-red transition-colors disabled:opacity-50 flex items-center gap-2">
                {startingRec ? (
                  <><span className="w-2.5 h-2.5 border border-text-muted border-t-text-primary rounded-full animate-spin" />Starting…</>
                ) : '● Start Recording'}
              </button>
              {recordingError && (
                <p className="text-[9px] font-mono text-accent-red">{recordingError}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Session list ── */}
      {showLauncher && sessions.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Sessions</p>
          {sessions.slice(0, 8).map(s => (
            <div key={s.id} className="border border-surface-4 rounded-lg p-2.5 bg-surface-2/20 space-y-1.5">
              {/* Name row */}
              <div className="flex items-start justify-between gap-2">
                {renamingId === s.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={() => saveRename(s.id)}
                    onKeyDown={e => { if (e.key === 'Enter') saveRename(s.id); if (e.key === 'Escape') { setRenamingId(null); setRenameValue('') } }}
                    className="flex-1 text-[10px] font-mono bg-surface-3 border border-accent-cyan/40 rounded px-1.5 py-0.5 text-text-primary outline-none"
                  />
                ) : (
                  <span className="text-[10px] font-mono text-text-primary truncate flex-1">{s.name}</span>
                )}
                <div className="flex items-center gap-1 shrink-0">
                  {s.status === 'recording' && (
                    <span className="text-[8px] font-mono text-accent-red flex items-center gap-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-accent-red animate-pulse" />REC
                    </span>
                  )}
                  <button onClick={() => { setRenamingId(s.id); setRenameValue(s.name) }}
                    title="Rename"
                    className="text-text-muted hover:text-text-primary transition-colors p-0.5">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
                      <path d="M12.854.146a.5.5 0 0 0-.707 0L10.5 1.793 14.207 5.5l1.647-1.646a.5.5 0 0 0 0-.708zm.646 6.061L9.793 2.5 3.293 9H3.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.207zm-7.468 7.468A.5.5 0 0 1 6 13.5V13h-.5a.5.5 0 0 1-.5-.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.5-.5V10h-.5a.499.499 0 0 1-.175-.032l-.179.178a.5.5 0 0 0-.11.168l-2 5a.5.5 0 0 0 .65.65l5-2a.5.5 0 0 0 .168-.11z"/>
                    </svg>
                  </button>
                  <button onClick={() => deleteSession(s.id)}
                    title="Delete"
                    className="text-text-muted hover:text-accent-red transition-colors p-0.5">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
                      <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/>
                      <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Meta */}
              <p className="text-[9px] font-mono text-text-muted">
                {s.cluster_name} · {s.event_count} workload{s.event_count !== 1 ? 's' : ''}
                {s.duration_ms > 0 ? ` · ${fmtDuration(s.duration_ms)}` : ''}
              </p>

              {/* Actions */}
              {s.status === 'stopped' && (
                <div className="flex gap-1.5">
                  <button onClick={() => openReplay(s)}
                    className="text-[9px] font-mono px-2 py-0.5 rounded border border-surface-4 text-text-primary hover:border-accent-cyan/50 hover:text-accent-cyan transition-colors">
                    ▶ Graph
                  </button>
                  {s.event_count > 0 && (
                    <button onClick={() => openDeploy(s)}
                      className="text-[9px] font-mono px-2 py-0.5 rounded border border-surface-4 text-text-primary hover:border-accent-green/50 hover:text-accent-green transition-colors">
                      ↗ Deploy
                    </button>
                  )}
                </div>
              )}

              {/* Deploy summary panel (inline) */}
              {deploySession?.id === s.id && deployFull && (
                <div className="border border-accent-green/30 rounded p-2 space-y-2 bg-surface-3/50">
                  <p className="text-[9px] font-mono text-accent-green uppercase tracking-wider">Deploy to: {clusterName}</p>
                  <div className="space-y-0.5">
                    {deployFull.events.map((e: SessionEvent, i: number) => {
                      const isDel = (e as any).type === 'delete'
                      return (
                        <p key={i} className={`text-[9px] font-mono ${isDel ? 'text-accent-red' : 'text-text-secondary'}`}>
                          {isDel ? '✕' : '▸'} +{(e.offset_ms / 1000).toFixed(0)}s · {e.workload_type.toUpperCase()}
                          {isDel ? ' deleted' : ` · ${e.size_gb}GB · ${e.mode}${e.workload_type !== 'noobaa' ? ` · bs=${e.block_size ?? '1m'} j=${e.num_jobs ?? 4}` : ` · ${e.obj_size_mb ?? 64}MB obj`}`}
                        </p>
                      )
                    })}
                  </div>
                  <p className="text-[9px] font-mono text-text-muted">
                    Total duration: {fmtDuration(deployFull.duration_ms)}
                  </p>
                  <div className="flex gap-2">
                    <button onClick={() => { setDeploySession(null); setDeployFull(null) }}
                      className="text-[9px] font-mono px-2 py-0.5 rounded border border-surface-4 text-text-muted hover:text-text-primary transition-colors">
                      Cancel
                    </button>
                    <button onClick={execDeploy} disabled={deploying}
                      className="text-[9px] font-mono px-2 py-0.5 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10 transition-colors disabled:opacity-50">
                      {deploying ? 'Launching…' : '↗ Confirm Deploy'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Active workloads — throughput chart with R/W toggle */}
      {showList && (
        <div className="space-y-1">
          <div className="flex items-center justify-end gap-1.5">
            <button
              onClick={() => setShowRW(false)}
              className={`text-[9px] font-mono px-2 py-0.5 rounded border transition-colors ${
                !showRW
                  ? 'border-accent-cyan/60 text-accent-cyan bg-accent-cyan/10'
                  : 'border-surface-4 text-text-muted hover:border-accent-cyan/30'
              }`}
            >
              Workloads
            </button>
            <button
              onClick={() => setShowRW(true)}
              className={`text-[9px] font-mono px-2 py-0.5 rounded border transition-colors ${
                showRW
                  ? 'border-accent-cyan/60 text-accent-cyan bg-accent-cyan/10'
                  : 'border-surface-4 text-text-muted hover:border-accent-cyan/30'
              }`}
            >
              Ceph R/W
            </button>
          </div>
          <ThroughputChart
            data={history}
            series={showRW ? RW_SERIES : undefined}
            areaKey={showRW ? 'ceph_r' : undefined}
          />
        </div>
      )}

      {showList && activeWorkloads.length > 0 && (() => {
        const ceph = healthData?.ceph_capacity?.health
        if (!ceph) return null
        const isOk = ceph === 'HEALTH_OK'
        const isWarn = ceph === 'HEALTH_WARN'
        const color = isOk ? 'text-accent-green' : isWarn ? 'text-yellow-400' : 'text-accent-red'
        const dot   = isOk ? 'bg-accent-green' : isWarn ? 'bg-yellow-400' : 'bg-accent-red'
        return (
          <div className={`flex items-center gap-1.5 text-[9px] font-mono ${color}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${dot} ${isOk ? '' : 'animate-pulse'}`} />
            <span>CEPH {ceph}{healthData?.degraded_reason && !isOk ? ` · ${healthData.degraded_reason}` : ''}</span>
          </div>
        )
      })()}

      {showList && workloads.length > 0 && (() => {
        const byType: Record<string, number> = {}
        let total = 0
        for (const w of workloads) {
          const r = rates[w.id] ?? 0
          byType[w.workload_type] = (byType[w.workload_type] ?? 0) + r
          total += r
        }
        const hasAny = total > 0
        const colorMap = Object.fromEntries(SERIES.map(s => [s.key, s.color]))
        return hasAny ? (
          <div className="border border-surface-4 rounded-lg px-3 py-2 bg-surface-2/40">
            <div className="flex flex-wrap gap-x-4 gap-y-0.5">
              {SERIES.filter(s => s.key !== 'total' && byType[s.key]).map(s => (
                <span key={s.key} className="text-[10px] font-mono">
                  <span className="text-text-muted">{s.label} </span>
                  <span style={{ color: s.color }}>{(byType[s.key] ?? 0).toFixed(0)} MB/s</span>
                </span>
              ))}
              {total > 0 && (
                <span className="text-[10px] font-mono ml-auto">
                  <span className="text-text-muted">Total </span>
                  <span style={{ color: colorMap.total }} className="font-semibold">{total.toFixed(0)} MB/s</span>
                </span>
              )}
            </div>
          </div>
        ) : null
      })()}

      {showList && workloads.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[9px] font-mono text-text-muted">{workloads.length} workload{workloads.length !== 1 ? 's' : ''}</p>
            <div className="flex items-center gap-2">
              {confirmClearAll && !clearAll && (
                <>
                  <button
                    onClick={() => { setClearAll(true); setConfirmClearAll(false) }}
                    className="text-[9px] font-mono text-accent-red hover:text-accent-red/80 transition-colors"
                  >
                    Confirm?
                  </button>
                  <button
                    onClick={() => setConfirmClearAll(false)}
                    className="text-[9px] font-mono text-text-muted hover:text-text-primary transition-colors"
                  >
                    Cancel
                  </button>
                </>
              )}
              {!confirmClearAll && (
                <button
                  onClick={() => setConfirmClearAll(true)}
                  disabled={clearAll}
                  className="text-[9px] font-mono text-accent-red/70 hover:text-accent-red transition-colors disabled:opacity-40"
                >
                  ✕ Clear all
                </button>
              )}
            </div>
          </div>
          {workloads.map(w => (
            <WorkloadCard
              key={w.id}
              workload={w}
              clusterName={clusterName}
              autoDelete={clearAll}
              onRateUpdate={handleRateUpdate}
              onDelete={() => {
                setRates(prev => { const n = {...prev}; delete n[w.id]; return n })
                queryClient.invalidateQueries({ queryKey: ['workloads', clusterName] })
              }}
            />
          ))}
        </div>
      )}

      {showList && workloads.length === 0 && (
        <p className="text-[10px] font-mono text-text-muted text-center py-2">No active workloads</p>
      )}

      {showList && (
        <button
          onClick={handlePurge}
          disabled={purging}
          className="text-[9px] font-mono text-text-muted hover:text-accent-red transition-colors mt-1"
        >
          {purging ? 'Purging…' : '⚠ Purge all orphaned namespaces'}
        </button>
      )}

    </div>

      {/* ── Saved Sequences ── */}
      {showLauncher && (savedSeqs.length > 0 || showAllSeqs) && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">
              {showAllSeqs ? 'All Sequences' : 'My Sequences'}
            </p>
            <button onClick={() => setShowAllSeqs(v => !v)}
              className="text-[9px] font-mono text-text-muted hover:text-accent-cyan transition-colors">
              {showAllSeqs ? '← My sequences' : '⊕ Load all sequences'}
            </button>
          </div>
          {savedSeqs.length === 0 && (
            <p className="text-[9px] font-mono text-text-muted">No sequences yet.</p>
          )}
          {savedSeqs.map((s: any) => {
            const isOwner = s.username === queryClient.getQueryData<{username:string}>(['me'])?.username
            return (
              <div key={s.id} className="border border-surface-4 rounded-lg px-2.5 py-2 bg-surface-2/20 flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-mono text-text-primary truncate">{s.name}</p>
                  <p className="text-[9px] font-mono text-text-muted">
                    {s.items.length} steps{showAllSeqs ? ` · ${s.username}` : ''}
                  </p>
                </div>
                <button onClick={() => loadSavedSeq(s)} title="Load into editor"
                  className="text-[9px] font-mono text-text-muted hover:text-accent-amber transition-colors shrink-0">Load</button>
                <button onClick={async () => { loadSavedSeq(s); setTimeout(handleRunSequence, 50) }}
                  title="Run directly"
                  className="text-[9px] font-mono text-text-muted hover:text-accent-green transition-colors shrink-0">▶</button>
                {isOwner && (
                  <button onClick={() => handleDeleteSeq(s.id)} title="Delete"
                    className="text-text-muted hover:text-accent-red transition-colors shrink-0">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                      <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/>
                      <path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/>
                    </svg>
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Show "Load all sequences" even when list is empty and not expanded */}
      {showLauncher && savedSeqs.length === 0 && !showAllSeqs && (
        <button onClick={() => setShowAllSeqs(true)}
          className="text-[9px] font-mono text-text-muted hover:text-accent-cyan transition-colors">
          ⊕ Load all sequences
        </button>
      )}

    {/* Session replay modal — renders outside the panel div so it overlays everything */}
    {replaySession && (
      <SessionReplayModal session={replaySession} onClose={() => setReplaySession(null)} />
    )}
    </>
  )
}
