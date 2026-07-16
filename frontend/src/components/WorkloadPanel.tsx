import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import ThroughputChart, { type DataPoint, SERIES } from './ThroughputChart'
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
}: {
  workload: WorkloadEntry
  clusterName: string
  onDelete: () => void
  onRateUpdate?: (id: number, rateMb: number | null) => void
}) {
  const [logs, setLogs]           = useState<string[]>([])
  const [progress, setProgress]   = useState<number | null>(null)
  const [rate, setRate]           = useState<string>('')
  const [eta, setEta]             = useState<string>('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [cleaning, setCleaning]   = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const esRef  = useRef<EventSource | null>(null)

  const isActive = workload.phase === 'Running' || workload.phase === 'Pending'

  useEffect(() => {
    if (!isActive || cleaning) return
    const es = new EventSource(`/api/clusters/${clusterName}/workloads/${workload.id}/logs`, { withCredentials: true })
    esRef.current = es

    es.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.line) setLogs(prev => [...prev, data.line].slice(-150))
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

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }

    onRateUpdate?.(workload.id, null)
    // Close existing log stream and switch to cleanup SSE in the terminal
    // (cleanup SSE handles both k8s deletion and DB record removal)
    esRef.current?.close()
    setCleaning(true)
    setLogs(prev => [...prev, '[jenease] Starting cleanup…'])
    setProgress(null)

    const es = new EventSource(`/api/clusters/${clusterName}/workloads/${workload.id}/cleanup`, { withCredentials: true })
    esRef.current = es

    es.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.line) setLogs(prev => [...prev, data.line].slice(-150))
      if (data.done) {
        es.close()
        setTimeout(() => onDelete(), 800)
      }
    }
    es.onerror = () => { es.close(); setTimeout(() => onDelete(), 1000) }
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
  showLauncher = true,
  showList = true,
}: {
  clusterName: string
  showLauncher?: boolean
  showList?: boolean
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
  // NooBaa options
  const [objSizeMb,  setObjSizeMb]  = useState(64)
  const [workers,    setWorkers]    = useState(8)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState('')

  const [purging, setPurging] = useState(false)
  const [rates, setRates] = useState<Record<number, number>>({})
  const [history, setHistory] = useState<DataPoint[]>([])
  const ratesRef    = useRef<Record<number, number>>({})
  const workloadsRef = useRef<WorkloadEntry[]>([])

  // Recording state
  const [recordingId,    setRecordingId]    = useState<number | null>(null)
  const [recordingStart, setRecordingStart] = useState<number | null>(null)
  const [recordingElapsed, setRecordingElapsed] = useState(0)
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
    queryFn: () => api.get('/sessions'),
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
      const total = Object.values(byType).reduce((a, b) => a + b, 0)
      const now = Date.now()
      setHistory(prev => [...prev.slice(-600), {
        ts: now, total,
        rbd: byType.rbd, cephfs: byType.cephfs, noobaa: byType.noobaa,
      }])

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
        session_id: recordingId,
      })
      await refetch()
    } catch (e: any) {
      setLaunchError((e as Error).message)
    } finally {
      setLaunching(false)
    }
  }

  async function startRecording() {
    const res = await api.post<{ id: number; name: string }>('/sessions', { cluster_name: clusterName })
    setRecordingId(res.id)
    setRecordingStart(Date.now())
    setRecordingElapsed(0)
    refetchSessions()
  }

  async function stopRecording() {
    if (!recordingId) return
    await api.post(`/sessions/${recordingId}/stop`, {})
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
    for (const e of events) {
      const delay = e.offset_ms
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
          session_id: null,
        }).then(() => refetch()).catch(() => {})
      }, delay)
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
        {/* Type */}
        <div className="space-y-1">
          <p className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Type</p>
          <div className="flex gap-1.5 flex-wrap">
            <Btn active={type === 'rbd'}    onClick={() => setType('rbd')}>RBD</Btn>
            <Btn active={type === 'cephfs'} onClick={() => setType('cephfs')}>CephFS</Btn>
            <Btn active={type === 'noobaa'} onClick={() => setType('noobaa')}>NooBaa</Btn>
          </div>
        </div>

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
      </div>}

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
            <button onClick={startRecording}
              className="text-[10px] font-mono px-3 py-1 rounded border border-surface-4 text-text-primary hover:border-accent-red/50 hover:text-accent-red transition-colors">
              ● Start Recording
            </button>
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
                    className="text-[9px] text-text-muted hover:text-text-primary transition-colors">✏</button>
                  <button onClick={() => deleteSession(s.id)}
                    title="Delete"
                    className="text-[9px] text-text-muted hover:text-accent-red transition-colors">✕</button>
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
                    {deployFull.events.map((e: SessionEvent, i: number) => (
                      <p key={i} className="text-[9px] font-mono text-text-secondary">
                        +{(e.offset_ms / 1000).toFixed(0)}s · {e.workload_type.toUpperCase()} · {e.size_gb}GB · {e.mode}
                        {e.workload_type !== 'noobaa' ? ` · bs=${e.block_size} j=${e.num_jobs}` : ` · ${e.obj_size_mb}MB obj`}
                      </p>
                    ))}
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

      {/* Active workloads */}
      {showList && (
        <ThroughputChart data={history} />
      )}

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
          {workloads.map(w => (
            <WorkloadCard
              key={w.id}
              workload={w}
              clusterName={clusterName}
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

    {/* Session replay modal — renders outside the panel div so it overlays everything */}
    {replaySession && (
      <SessionReplayModal session={replaySession} onClose={() => setReplaySession(null)} />
    )}
    </>
  )
}
