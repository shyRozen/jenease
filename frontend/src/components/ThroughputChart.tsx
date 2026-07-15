import { useEffect, useRef, useState } from 'react'

export interface DataPoint {
  ts: number
  total: number
  rbd: number
  cephfs: number
  noobaa: number
}

const VISIBLE_SECS = 60
const CHART_H      = 176
const PAD = { top: 10, right: 8, bottom: 20, left: 44 }

export const SERIES = [
  { key: 'rbd'    as const, label: 'RBD',    color: '#00d4ff', dash: ''    },
  { key: 'cephfs' as const, label: 'CephFS', color: '#50fa7b', dash: ''    },
  { key: 'noobaa' as const, label: 'NooBaa', color: '#ff9f43', dash: ''    },
  { key: 'total'  as const, label: 'Total',  color: '#f8f8f2', dash: '4,2' },
] as const

function niceMax(v: number) {
  if (v <= 0) return 10
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  return Math.ceil(v / mag) * mag
}

export default function ThroughputChart({ data }: { data: DataPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth]       = useState(400)
  const [offset, setOffset]     = useState(0) // seconds from right (0 = live)
  const isDragging              = useRef(false)
  const dragStartX              = useRef(0)
  const dragStartOffset         = useRef(0)
  const autoScroll              = useRef(true)  // follow live edge unless user dragged

  // Measure container width
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Auto-advance to live edge when new data arrives (unless user panned)
  useEffect(() => {
    if (autoScroll.current) setOffset(0)
  }, [data.length])

  const W = width - PAD.left - PAD.right
  const H = CHART_H - PAD.top - PAD.bottom

  const nowMs   = data.length > 0 ? data[data.length - 1].ts : Date.now()
  const endMs   = nowMs - offset * 1000
  const startMs = endMs - VISIBLE_SECS * 1000

  const visible = data.filter(d => d.ts >= startMs - 2000 && d.ts <= endMs + 2000)
  const maxVal  = niceMax(Math.max(...data.slice(-300).map(d => d.total), 1))

  function makePath(key: keyof DataPoint) {
    const pts = visible.map(d => `${tsToX(d.ts).toFixed(1)},${valToY(Number(d[key])).toFixed(1)}`)
    return pts.length > 1 ? `M${pts.join('L')}` : ''
  }

  function tsToX(ts: number) {
    return PAD.left + ((ts - startMs) / (VISIBLE_SECS * 1000)) * W
  }
  function valToY(v: number) {
    return PAD.top + H - (v / maxVal) * H
  }

  // Area fill just for total
  const totalPts = visible.map(d => `${tsToX(d.ts).toFixed(1)},${valToY(d.total).toFixed(1)}`)
  const areaPath = totalPts.length > 1
    ? `M${tsToX(visible[0].ts).toFixed(1)},${(PAD.top + H).toFixed(1)}L${totalPts.join('L')}L${tsToX(visible[visible.length - 1].ts).toFixed(1)},${(PAD.top + H).toFixed(1)}Z`
    : ''

  // Y-axis ticks
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ y: valToY(maxVal * f), label: `${(maxVal * f).toFixed(0)}` }))

  // X-axis ticks: every 10s
  const xTicks: { x: number; label: string }[] = []
  const tickInterval = 10
  const firstTick = Math.ceil(startMs / (tickInterval * 1000)) * tickInterval * 1000
  for (let ts = firstTick; ts <= endMs; ts += tickInterval * 1000) {
    const secsAgo = Math.round((nowMs - ts) / 1000)
    xTicks.push({ x: tsToX(ts), label: secsAgo === 0 ? 'now' : `-${secsAgo}s` })
  }

  // Drag handlers
  function onPointerDown(e: React.PointerEvent) {
    isDragging.current = true
    dragStartX.current = e.clientX
    dragStartOffset.current = offset
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!isDragging.current) return
    const dx = dragStartX.current - e.clientX
    const secsMoved = (dx / W) * VISIBLE_SECS
    const maxPast = Math.max(0, (data.length - 1))
    const newOffset = Math.max(0, Math.min(dragStartOffset.current + secsMoved, maxPast))
    autoScroll.current = newOffset < 1
    setOffset(newOffset)
  }
  function onPointerUp() { isDragging.current = false }

  const isLive = offset < 1

  return (
    <div ref={containerRef} className="select-none">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3">
          <p className="text-[9px] font-mono text-text-muted uppercase tracking-widest">Throughput</p>
          {SERIES.map(s => (
            <span key={s.key} className="flex items-center gap-1">
              <span className="w-3 h-0.5 inline-block rounded"
                style={{ background: s.color, opacity: s.key === 'total' ? 0.7 : 0.9 }} />
              <span className="text-[9px] font-mono" style={{ color: s.color }}>{s.label}</span>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {!isLive && (
            <button
              onClick={() => { setOffset(0); autoScroll.current = true }}
              className="text-[9px] font-mono text-accent-cyan hover:brightness-125 transition-colors"
            >
              ↦ live
            </button>
          )}
          <span className="text-[9px] font-mono text-text-muted">← drag</span>
        </div>
      </div>

      <svg
        width={width}
        height={CHART_H}
        className="cursor-grab active:cursor-grabbing rounded"
        style={{ background: '#0d1117' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {/* Y gridlines + labels */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} y1={t.y} x2={PAD.left + W} y2={t.y}
              stroke="#30363d" strokeWidth={0.5} />
            <text x={PAD.left - 4} y={t.y + 3} textAnchor="end"
              fontSize={8} fill="#484f58" fontFamily="monospace">
              {t.label}
            </text>
          </g>
        ))}

        {/* Clip region */}
        <defs>
          <clipPath id="plot-clip">
            <rect x={PAD.left} y={PAD.top} width={W} height={H} />
          </clipPath>
          <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00d4ff" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#00d4ff" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Total area fill */}
        {areaPath && (
          <path d={areaPath} fill="url(#area-grad)" clipPath="url(#plot-clip)" />
        )}

        {/* Per-series lines (draw total last so it's on top) */}
        {SERIES.map(s => {
          const p = makePath(s.key)
          return p ? (
            <path key={s.key} d={p} fill="none" stroke={s.color}
              strokeWidth={s.key === 'total' ? 1.5 : 1}
              strokeDasharray={s.dash}
              strokeOpacity={s.key === 'total' ? 0.7 : 0.9}
              strokeLinejoin="round" clipPath="url(#plot-clip)" />
          ) : null
        })}

        {/* Live indicator dot on total */}
        {isLive && visible.length > 0 && (() => {
          const last = visible[visible.length - 1]
          return (
            <circle cx={tsToX(last.ts)} cy={valToY(last.total)} r={3}
              fill="#e6edf3" clipPath="url(#plot-clip)" />
          )
        })()}

        {/* X-axis ticks */}
        {xTicks.map((t, i) => (
          <g key={i}>
            <line x1={t.x} y1={PAD.top + H} x2={t.x} y2={PAD.top + H + 3}
              stroke="#30363d" strokeWidth={0.5} />
            <text x={t.x} y={PAD.top + H + 13} textAnchor="middle"
              fontSize={8} fill="#484f58" fontFamily="monospace">
              {t.label}
            </text>
          </g>
        ))}

        {/* X axis baseline */}
        <line x1={PAD.left} y1={PAD.top + H} x2={PAD.left + W} y2={PAD.top + H}
          stroke="#30363d" strokeWidth={0.5} />

        {/* Current total label */}
        {visible.length > 0 && (() => {
          const last = visible[visible.length - 1]
          const x = Math.min(tsToX(last.ts), PAD.left + W - 70)
          const y = Math.max(valToY(last.total) - 6, PAD.top + 10)
          return (
            <text x={x + 6} y={y} fontSize={9} fill="#e6edf3" fontFamily="monospace" fontWeight="bold">
              {last.total.toFixed(0)} MB/s
            </text>
          )
        })()}

        {data.length === 0 && (
          <text x={PAD.left + W / 2} y={PAD.top + H / 2 + 4}
            textAnchor="middle" fontSize={9} fill="#484f58" fontFamily="monospace">
            Waiting for workload data…
          </text>
        )}
      </svg>
    </div>
  )
}
