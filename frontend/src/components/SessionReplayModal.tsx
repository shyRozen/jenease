import { useEffect, useMemo, useRef, useState } from 'react'
import ThroughputChart, { type DataPoint, SERIES } from './ThroughputChart'

export interface SessionEvent {
  offset_ms: number
  workload_type: string
  size_gb: number
  mode: string
  pattern: string
  block_size: string
  num_jobs: number
  iodepth: number
  duration_sec: number
  obj_size_mb: number
  workers: number
}

export interface ThroughputSample {
  offset_ms: number
  rbd: number
  cephfs: number
  noobaa: number
  total: number
}

export interface SessionFull {
  id: number
  name: string
  cluster_name: string
  username: string
  status: string
  started_at: string
  started_at_ms: number
  ended_at: string | null
  event_count: number
  duration_ms: number
  events: SessionEvent[]
  throughput: ThroughputSample[]
}

const TYPE_COLORS: Record<string, string> = {
  rbd:    '#00d4ff',
  cephfs: '#50fa7b',
  noobaa: '#ff9f43',
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

function fmtParams(e: SessionEvent): string {
  if ((e as any).type === 'delete') return 'deleted'
  if (e.workload_type === 'noobaa') {
    return `${e.size_gb}GB · ${e.mode} · ${(e.obj_size_mb ?? 64)}MB obj · ${(e.workers ?? 8)}w`
  }
  const dur = e.duration_sec > 0 ? `${e.duration_sec}s` : `${e.size_gb}GB`
  return `${dur} · ${e.mode} · ${e.pattern ?? 'seq'} · bs=${e.block_size ?? '1m'} · j=${e.num_jobs ?? 4}`
}

// Pair each launch event with its matching delete event (FIFO per workload_type)
function buildPairs(events: SessionEvent[]) {
  const deleteQueues: Record<string, SessionEvent[]> = {}
  for (const e of events) {
    if ((e as any).type === 'delete') {
      deleteQueues[e.workload_type] = [...(deleteQueues[e.workload_type] || []), e]
    }
  }
  return events
    .filter(e => (e as any).type !== 'delete')
    .map(launch => {
      const q = deleteQueues[launch.workload_type] || []
      const idx = q.findIndex(d => d.offset_ms > launch.offset_ms)
      if (idx >= 0) {
        const del = q[idx]
        deleteQueues[launch.workload_type] = q.filter((_, i) => i !== idx)
        return { launch, del }
      }
      return { launch, del: null as SessionEvent | null }
    })
}

// Blink opacity computed from currentMs — syncs with playback, pauses when paused
function blinkOpacity(launchMs: number, deleteMs: number | null, totalMs: number, currentMs: number): number {
  if (currentMs < launchMs) return 0.3               // not started yet
  if (deleteMs !== null && currentMs >= deleteMs) return 0.35  // deleted
  const elapsed = currentMs - launchMs
  const period  = elapsed < 3000 ? 500 : 2000        // fast (2Hz) then slow (0.5Hz)
  const wave    = (Math.sin((currentMs / period) * Math.PI * 2) + 1) / 2  // 0→1
  return 0.35 + 0.65 * wave                          // 0.35→1.0
}

function WorkloadMarkers({ events, currentMs, totalMs }: {
  events: SessionEvent[]; currentMs: number; totalMs: number
}) {
  const pairs = useMemo(() => buildPairs(events), [events])

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {pairs.map(({ launch: e, del }, i) => {
        const deleteMs = del?.offset_ms ?? null
        const opacity  = blinkOpacity(e.offset_ms, deleteMs, totalMs, currentMs)
        const isDeleted = deleteMs !== null && currentMs >= deleteMs
        const isRunning = currentMs >= e.offset_ms && !isDeleted
        const color = TYPE_COLORS[e.workload_type] ?? '#888'

        return (
          <div key={i} className="flex items-center gap-1 text-[9px] font-mono" style={{ opacity }}>
            {/* Status dot */}
            <span style={{ color: isDeleted ? '#6b7280' : color }}>
              {isDeleted ? '✕' : isRunning ? '●' : '○'}
            </span>
            {/* Timestamp */}
            <span style={{ color }} className="text-[8px]">+{fmtMs(e.offset_ms)}</span>
            {/* Type + params */}
            <span style={{ color }} className="font-semibold">{e.workload_type.toUpperCase()}</span>
            <span className={isDeleted ? 'text-gray-500 line-through' : 'text-text-muted'}>
              {fmtParams(e)}
            </span>
            {/* Delete indicator */}
            {deleteMs !== null && (
              <span className="text-red-400 text-[8px]">
                {isDeleted ? `✕ +${fmtMs(deleteMs)}` : `→✕ +${fmtMs(deleteMs)}`}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function SessionReplayModal({ session, onClose }: { session: SessionFull; onClose: () => void }) {
  const [playing, setPlaying]   = useState(true)   // auto-play on open
  const [speed, setSpeed]       = useState(1)
  const [currentMs, setCurrentMs] = useState(0)
  const rafRef    = useRef<number | null>(null)
  const lastTsRef = useRef<number | null>(null)
  const playingRef = useRef(false)
  const speedRef   = useRef(2)
  playingRef.current = playing
  speedRef.current   = speed

  const totalMs = session.duration_ms
    || (session.throughput.length > 0
        ? session.throughput[session.throughput.length - 1].offset_ms
        : 0)
  const totalMsRef = useRef(totalMs)
  totalMsRef.current = totalMs

  // rAF-based playback — immune to Strict Mode double-run and stale closures
  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      lastTsRef.current = null
      return
    }
    lastTsRef.current = null
    function tick(now: number) {
      if (!playingRef.current) return
      if (lastTsRef.current !== null) {
        const realElapsed = now - lastTsRef.current           // ms since last frame
        const recordingElapsed = realElapsed * speedRef.current  // scaled recording ms
        setCurrentMs(prev => {
          const next = prev + recordingElapsed
          if (next >= totalMsRef.current) {
            playingRef.current = false
            setPlaying(false)
            return totalMsRef.current
          }
          return next
        })
      }
      lastTsRef.current = now
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [playing])

  function reset() {
    setPlaying(false)
    setCurrentMs(0)
  }

  function setMaxSpeed() {
    setPlaying(false)
    setCurrentMs(totalMs)
  }

  const displayData: DataPoint[] = session.throughput
    .filter(t => t.offset_ms <= currentMs)
    .map(t => ({
      ts: session.started_at_ms + t.offset_ms,
      rbd: t.rbd,
      cephfs: t.cephfs,
      noobaa: t.noobaa,
      total: t.total,
    }))

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const speeds = [1, 2, 5, 10]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-surface-1 border border-surface-4 rounded-xl shadow-2xl w-[80vw] max-w-5xl flex flex-col gap-0 overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-surface-4">
          <div>
            <p className="text-sm font-mono font-semibold text-text-primary">{session.name}</p>
            <p className="text-[10px] font-mono text-text-muted mt-0.5">
              Recorded on {session.cluster_name} · {session.event_count} workload{session.event_count !== 1 ? 's' : ''} · {fmtMs(totalMs)} total
            </p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-lg font-mono leading-none">✕</button>
        </div>


        {/* Chart */}
        <div className="px-5 pt-2 pb-2">
          <ThroughputChart data={displayData} />
        </div>

        {/* Workload event markers with correlated blink */}
        {session.events.length > 0 && (
          <div className="px-5 pb-2">
            <WorkloadMarkers events={session.events} currentMs={currentMs} totalMs={totalMs} />
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center gap-4 px-5 py-3 border-t border-surface-4 bg-surface-2/40">
          {/* Reset */}
          <button onClick={reset}
            className="text-[10px] font-mono px-2 py-0.5 rounded border border-surface-4 text-text-muted hover:text-text-primary transition-colors">
            ◀◀ Reset
          </button>

          {/* Play / Pause */}
          <button
            onClick={() => {
              if (currentMs >= totalMs) { setCurrentMs(0); setPlaying(true) }
              else setPlaying(p => !p)
            }}
            className="text-[11px] font-mono px-3 py-1 rounded border border-accent-cyan/50 text-accent-cyan hover:bg-accent-cyan/10 transition-colors min-w-[60px] text-center"
          >
            {playing ? '⏸ Pause' : currentMs >= totalMs ? '▶ Replay' : '▶ Play'}
          </button>

          {/* Speed selector */}
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-mono text-text-muted mr-1">Speed</span>
            {speeds.map(s => (
              <button key={s} onClick={() => setSpeed(s)}
                className={`text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                  speed === s && !false
                    ? 'border-accent-cyan text-accent-cyan bg-accent-cyan/10'
                    : 'border-surface-4 text-text-primary hover:border-accent-cyan/40'
                }`}>
                {s}x
              </button>
            ))}
            <button onClick={setMaxSpeed}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-surface-4 text-text-primary hover:border-accent-cyan/40 transition-colors ml-0.5">
              Max
            </button>
          </div>

          {/* Elapsed / total */}
          <span className="text-[10px] font-mono text-text-muted ml-auto">
            {fmtMs(currentMs)} / {fmtMs(totalMs)}
          </span>

          {/* Series legend */}
          <div className="flex items-center gap-3">
            {SERIES.map(s => (
              <span key={s.key} className="flex items-center gap-1 text-[9px] font-mono text-text-muted">
                <span className="w-3 h-0.5 inline-block" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
