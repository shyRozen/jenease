import { useEffect, useId, useRef, useState } from 'react'

export interface SeriesDef {
  key: string
  label: string
  color: string
  dash?: string
}

export interface DataPoint {
  ts: number
  total: number
  rbd: number
  cephfs: number
  noobaa: number
  ceph_r?: number
  ceph_w?: number
  [key: string]: number | undefined
}

const VISIBLE_SECS = 60
const CHART_H      = 176
const PAD = { top: 10, right: 8, bottom: 20, left: 44 }

export const SERIES: SeriesDef[] = [
  { key: 'rbd',    label: 'RBD',    color: '#00d4ff', dash: ''    },
  { key: 'cephfs', label: 'CephFS', color: '#50fa7b', dash: ''    },
  { key: 'noobaa', label: 'NooBaa', color: '#ff9f43', dash: ''    },
  { key: 'total',  label: 'Total',  color: '#f8f8f2', dash: '4,2' },
]

export const RW_SERIES: SeriesDef[] = [
  { key: 'ceph_r', label: 'Ceph Read',  color: '#00d4ff', dash: '' },
  { key: 'ceph_w', label: 'Ceph Write', color: '#50fa7b', dash: '' },
]

export const OSD_SERIES: SeriesDef[] = [
  { key: 'r', label: 'Read',  color: '#00d4ff', dash: '' },
  { key: 'w', label: 'Write', color: '#50fa7b', dash: '' },
]

function fmtMb(v: number): string {
  if (v >= 100) return v.toFixed(0)
  if (v >= 10)  return v.toFixed(1)
  if (v >= 1)   return v.toFixed(2)
  return v.toFixed(3)
}

function niceMax(v: number) {
  if (v <= 0) return 10
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  return Math.ceil(v / mag) * mag
}

export default function ThroughputChart({
  data,
  visibleSecs,
  series: customSeries,
  areaKey,
  title,
  height,
  containerWidth,
}: {
  data: DataPoint[]
  visibleSecs?: number
  series?: SeriesDef[]
  areaKey?: string
  title?: string
  height?: number
  containerWidth?: number  // if provided, skip internal ResizeObserver
}) {
  const VISIBLE  = visibleSecs ?? VISIBLE_SECS
  const CHEIGHT  = height ?? CHART_H
  const activeSeries = customSeries ?? SERIES
  const fillKey  = areaKey ?? (customSeries ? customSeries[0]?.key : 'total')

  const uid = useId().replace(/:/g, '')
  const containerRef = useRef<HTMLDivElement>(null)
  const [measuredWidth, setMeasuredWidth] = useState(400)
  const width = containerWidth ?? measuredWidth
  const [offset, setOffset] = useState(0)
  const isDragging     = useRef(false)
  const dragStartX     = useRef(0)
  const dragStartOffset = useRef(0)
  const autoScroll     = useRef(true)

  useEffect(() => {
    if (containerWidth != null) return  // skip observer when width is provided externally
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setMeasuredWidth(e.contentRect.width))
    ro.observe(el)
    setMeasuredWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [containerWidth])

  useEffect(() => {
    if (autoScroll.current) setOffset(0)
  }, [data.length])

  const W = width - PAD.left - PAD.right
  const H = CHEIGHT - PAD.top - PAD.bottom

  const nowMs   = data.length > 0 ? data[data.length - 1].ts : Date.now()
  const endMs   = nowMs - offset * 1000
  const startMs = endMs - VISIBLE * 1000

  const visible = data.filter(d => d.ts >= startMs - 2000 && d.ts <= endMs + 2000)

  const maxVal = niceMax(Math.max(
    ...data.slice(-300).flatMap(d => activeSeries.map(s => d[s.key] ?? 0)),
    1
  ))

  function makePath(key: string) {
    const pts = visible.map(d =>
      `${tsToX(d.ts).toFixed(1)},${valToY(d[key] ?? 0).toFixed(1)}`
    )
    return pts.length > 1 ? `M${pts.join('L')}` : ''
  }

  function tsToX(ts: number) { return PAD.left + ((ts - startMs) / (VISIBLE * 1000)) * W }
  function valToY(v: number)  { return PAD.top + H - (v / maxVal) * H }

  // Area fill for the primary series
  const fillPts = fillKey ? visible.map(d => `${tsToX(d.ts).toFixed(1)},${valToY(d[fillKey] ?? 0).toFixed(1)}`) : []
  const areaPath = fillPts.length > 1
    ? `M${tsToX(visible[0].ts).toFixed(1)},${(PAD.top + H).toFixed(1)}L${fillPts.join('L')}L${tsToX(visible[visible.length - 1].ts).toFixed(1)},${(PAD.top + H).toFixed(1)}Z`
    : ''

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ y: valToY(maxVal * f), label: `${(maxVal * f).toFixed(0)}` }))

  const xTicks: { x: number; label: string }[] = []
  const tickInterval = 10
  const firstTick = Math.ceil(startMs / (tickInterval * 1000)) * tickInterval * 1000
  for (let ts = firstTick; ts <= endMs; ts += tickInterval * 1000) {
    const secsAgo = Math.round((nowMs - ts) / 1000)
    xTicks.push({ x: tsToX(ts), label: secsAgo === 0 ? 'now' : `-${secsAgo}s` })
  }

  function onPointerDown(e: React.PointerEvent) {
    isDragging.current = true
    dragStartX.current = e.clientX
    dragStartOffset.current = offset
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!isDragging.current) return
    const dx = e.clientX - dragStartX.current
    const secsMoved = (dx / W) * VISIBLE
    const maxPast = Math.max(0, (data.length - 1))
    const newOffset = Math.max(0, Math.min(dragStartOffset.current + secsMoved, maxPast))
    autoScroll.current = newOffset < 1
    setOffset(newOffset)
  }
  function onPointerUp() { isDragging.current = false }

  const isLive = offset < 1
  const last   = visible.length > 0 ? visible[visible.length - 1] : null
  const fillColor = fillKey ? (activeSeries.find(s => s.key === fillKey)?.color ?? '#00d4ff') : '#00d4ff'

  return (
    <div ref={containerRef} className="select-none">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3">
          <p className="text-[9px] font-mono text-text-muted uppercase tracking-widest">
            {title ?? 'Throughput'}
          </p>
          {activeSeries.map(s => (
            <span key={s.key} className="flex items-center gap-1">
              <span className="w-3 h-0.5 inline-block rounded"
                style={{ background: s.color, opacity: s.key === 'total' ? 0.7 : 0.9 }} />
              <span className="text-[9px] font-mono" style={{ color: s.color }}>
                {s.label}
                {last && last[s.key] != null
                  ? ` ${fmtMb(last[s.key] ?? 0)}`
                  : ''}
              </span>
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
        height={CHEIGHT}
        className="cursor-grab active:cursor-grabbing rounded"
        style={{ background: '#0d1117' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
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

        <defs>
          <clipPath id={`plot-clip-${uid}`}>
            <rect x={PAD.left} y={PAD.top} width={W} height={H} />
          </clipPath>
          <linearGradient id={`area-grad-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={fillColor} stopOpacity="0.25" />
            <stop offset="100%" stopColor={fillColor} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {areaPath && (
          <path d={areaPath} fill={`url(#area-grad-${uid})`} clipPath={`url(#plot-clip-${uid})`} />
        )}

        {activeSeries.map(s => {
          const p = makePath(s.key)
          return p ? (
            <path key={s.key} d={p} fill="none" stroke={s.color}
              strokeWidth={s.key === 'total' ? 1.5 : 1}
              strokeDasharray={s.dash}
              strokeOpacity={s.key === 'total' ? 0.7 : 0.9}
              strokeLinejoin="round" clipPath={`url(#plot-clip-${uid})`} />
          ) : null
        })}

        {/* Live dot on first series */}
        {isLive && last && (() => {
          const firstKey = activeSeries[0]?.key
          if (!firstKey || last[firstKey] == null) return null
          return (
            <circle cx={tsToX(last.ts)} cy={valToY(last[firstKey] ?? 0)} r={3}
              fill="#e6edf3" clipPath={`url(#plot-clip-${uid})`} />
          )
        })()}

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

        <line x1={PAD.left} y1={PAD.top + H} x2={PAD.left + W} y2={PAD.top + H}
          stroke="#30363d" strokeWidth={0.5} />

        {/* MB/s label for primary fill series */}
        {last && fillKey && last[fillKey] != null && (() => {
          const x = Math.min(tsToX(last.ts), PAD.left + W - 70)
          const y = Math.max(valToY(last[fillKey] ?? 0) - 6, PAD.top + 10)
          return (
            <text x={x + 6} y={y} fontSize={9} fill="#e6edf3" fontFamily="monospace" fontWeight="bold">
              {fmtMb(last[fillKey] ?? 0)} MB/s
            </text>
          )
        })()}

        {data.length === 0 && (
          <text x={PAD.left + W / 2} y={PAD.top + H / 2 + 4}
            textAnchor="middle" fontSize={9} fill="#484f58" fontFamily="monospace">
            Waiting for data…
          </text>
        )}
      </svg>
    </div>
  )
}
