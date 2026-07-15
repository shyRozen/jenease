import { useEffect, useRef, useState } from 'react'

export interface DataPoint { ts: number; total: number }

const VISIBLE_SECS = 60
const PAD = { top: 8, right: 8, bottom: 20, left: 44 }

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
  const H = 88 - PAD.top - PAD.bottom   // plot area height

  const nowMs   = data.length > 0 ? data[data.length - 1].ts : Date.now()
  const endMs   = nowMs - offset * 1000
  const startMs = endMs - VISIBLE_SECS * 1000

  const visible = data.filter(d => d.ts >= startMs - 2000 && d.ts <= endMs + 2000)
  const maxVal  = niceMax(Math.max(...data.slice(-300).map(d => d.total), 1))

  function tsToX(ts: number) {
    return PAD.left + ((ts - startMs) / (VISIBLE_SECS * 1000)) * W
  }
  function valToY(v: number) {
    return PAD.top + H - (v / maxVal) * H
  }

  // Build SVG path
  const points = visible.map(d => `${tsToX(d.ts).toFixed(1)},${valToY(d.total).toFixed(1)}`)
  const linePath = points.length > 1 ? `M${points.join('L')}` : ''
  const areaPath = points.length > 1
    ? `M${tsToX(visible[0].ts).toFixed(1)},${(PAD.top + H).toFixed(1)}L${points.join('L')}L${tsToX(visible[visible.length - 1].ts).toFixed(1)},${(PAD.top + H).toFixed(1)}Z`
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
        <p className="text-[9px] font-mono text-text-muted uppercase tracking-widest">Total Throughput</p>
        <div className="flex items-center gap-2">
          {!isLive && (
            <button
              onClick={() => { setOffset(0); autoScroll.current = true }}
              className="text-[9px] font-mono text-accent-cyan hover:brightness-125 transition-colors"
            >
              ↦ live
            </button>
          )}
          <span className="text-[9px] font-mono text-text-muted">← drag to scroll history</span>
        </div>
      </div>

      <svg
        width={width}
        height={88}
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

        {/* Area fill */}
        {areaPath && (
          <path d={areaPath} fill="url(#area-grad)" clipPath="url(#plot-clip)" />
        )}

        {/* Line */}
        {linePath && (
          <path d={linePath} fill="none" stroke="#00d4ff" strokeWidth={1.5}
            strokeLinejoin="round" clipPath="url(#plot-clip)" />
        )}

        {/* Live indicator dot */}
        {isLive && visible.length > 0 && (() => {
          const last = visible[visible.length - 1]
          return (
            <circle cx={tsToX(last.ts)} cy={valToY(last.total)} r={3}
              fill="#00d4ff" clipPath="url(#plot-clip)" />
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

        {/* Current value label */}
        {visible.length > 0 && (() => {
          const last = visible[visible.length - 1]
          const x = Math.min(tsToX(last.ts), PAD.left + W - 60)
          const y = Math.max(valToY(last.total) - 6, PAD.top + 10)
          return (
            <text x={x + 6} y={y} fontSize={9} fill="#00d4ff" fontFamily="monospace">
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
