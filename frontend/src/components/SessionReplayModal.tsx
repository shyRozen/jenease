import { useEffect, useRef, useState } from 'react'
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
  if (e.workload_type === 'noobaa') {
    return `${e.size_gb}GB · ${e.mode} · ${e.obj_size_mb}MB obj · ${e.workers}w`
  }
  const dur = e.duration_sec > 0 ? `${e.duration_sec}s` : `${e.size_gb}GB`
  return `${dur} · ${e.mode} · ${e.pattern} · bs=${e.block_size} · j=${e.num_jobs}`
}

export default function SessionReplayModal({ session, onClose }: { session: SessionFull; onClose: () => void }) {
  const [playing, setPlaying]   = useState(false)
  const [speed, setSpeed]       = useState(2)
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

  // Full recording duration in seconds (for chart x-axis)
  const durationSecs = Math.ceil(totalMs / 1000) || 60

  // Build display data — anchor to a fixed start so the chart window doesn't shift
  // We add a synthetic t=0 point so the x-axis always starts at recording start
  const anchor: DataPoint = { ts: session.started_at_ms, rbd: 0, cephfs: 0, noobaa: 0, total: 0 }
  const displayData: DataPoint[] = [
    anchor,
    ...session.throughput
      .filter(t => t.offset_ms <= currentMs)
      .map(t => ({
        ts: session.started_at_ms + t.offset_ms,
        rbd: t.rbd,
        cephfs: t.cephfs,
        noobaa: t.noobaa,
        total: t.total,
      })),
    // Anchor end point at the full duration so the window stays fixed
    { ts: session.started_at_ms + totalMs, rbd: 0, cephfs: 0, noobaa: 0, total: 0 },
  ]

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

        {/* Debug info — remove once confirmed working */}
        {(() => {
          const firstSample = session.throughput[0]
          const firstNonZero = session.throughput.find(t => t.total > 0)
          return (
            <div className="px-5 pt-2 text-[9px] font-mono text-text-muted flex gap-3 flex-wrap">
              <span className={playing ? 'text-accent-green' : ''}>playing: {playing ? 'YES' : 'no'}</span>
              <span>cur: {Math.round(currentMs)}ms</span>
              <span>total: {totalMs}ms</span>
              <span>visible: {displayData.length}</span>
              <span>first@: {firstSample?.offset_ms ?? '—'}ms</span>
              <span>IO@: {firstNonZero?.offset_ms ?? '—'}ms ({firstNonZero ? `${firstNonZero.total.toFixed(0)}MB/s` : 'none'})</span>
            </div>
          )
        })()}

        {/* Chart */}
        <div className="px-5 pt-2 pb-2">
          <ThroughputChart data={displayData} visibleSecs={durationSecs} />
        </div>

        {/* Workload event markers (timeline labels below chart) */}
        {session.events.length > 0 && (
          <div className="px-5 pb-2">
            <div className="flex flex-wrap gap-2">
              {session.events.map((e, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[9px] font-mono text-text-muted">
                  <span style={{ color: TYPE_COLORS[e.workload_type] ?? '#888' }}>
                    ▸ +{fmtMs(e.offset_ms)}
                  </span>
                  <span className="text-text-secondary">{e.workload_type.toUpperCase()}</span>
                  <span>{fmtParams(e)}</span>
                </div>
              ))}
            </div>
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
