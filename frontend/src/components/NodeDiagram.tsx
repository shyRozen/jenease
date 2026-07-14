interface Node { role: string; ready: boolean; name?: string }

interface Props {
  masters: number
  workers: number
  liveNodes?: Node[]
  osdCount?: number
  osdSize?: string
  loading?: boolean
}

function NodeDot({ role, ready, loading, estimated }: { role: string; ready?: boolean; loading?: boolean; estimated?: boolean }) {
  const isMaster = role === 'master'
  const base = 'flex items-center justify-center rounded font-mono text-[9px] font-semibold select-none transition-all'
  const size = isMaster ? 'w-7 h-7' : 'w-6 h-6'
  const color = loading
    ? 'bg-surface-3 text-text-muted animate-pulse'
    : ready === false && !estimated
    ? 'bg-accent-red/20 text-accent-red border border-accent-red/40'
    : estimated
    ? isMaster
      ? 'bg-accent-cyan/8 text-accent-cyan/50 border border-accent-cyan/20'
      : 'bg-accent-green/8 text-accent-green/50 border border-accent-green/20'
    : isMaster
    ? 'bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30'
    : 'bg-accent-green/15 text-accent-green border border-accent-green/30'

  return (
    <div className={`${base} ${size} ${color}`} title={role}>
      {isMaster ? 'M' : 'W'}
    </div>
  )
}

function OsdDisk({ loading }: { loading?: boolean }) {
  return (
    <div
      className={`w-4 h-5 rounded-sm border flex flex-col items-center justify-center transition-all ${
        loading
          ? 'border-surface-4 bg-surface-3 animate-pulse'
          : 'border-accent-amber/40 bg-accent-amber/10'
      }`}
    >
      <div className={`w-2 h-0.5 rounded-full ${loading ? 'bg-surface-4' : 'bg-accent-amber/60'}`} />
      <div className={`w-2 h-0.5 rounded-full mt-0.5 ${loading ? 'bg-surface-4' : 'bg-accent-amber/40'}`} />
    </div>
  )
}

export default function NodeDiagram({ masters, workers, liveNodes, osdCount, osdSize, loading }: Props) {
  const hasLiveNodes = liveNodes && liveNodes.length > 0
  const masterNodes = liveNodes?.filter(n => n.role === 'master') ?? Array(masters).fill(null)
  const workerNodes = liveNodes?.filter(n => n.role !== 'master') ?? Array(workers).fill(null)
  const displayOsds = osdCount ?? 0

  return (
    <div className="space-y-2">
      {/* Node grid */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {masterNodes.map((n, i) => (
          <NodeDot key={`m-${i}`} role="master" ready={n?.ready} loading={loading} estimated={!hasLiveNodes && !loading} />
        ))}
        {masterNodes.length > 0 && workerNodes.length > 0 && (
          <div className="w-px h-5 bg-surface-4 mx-0.5" />
        )}
        {workerNodes.map((n, i) => (
          <NodeDot key={`w-${i}`} role="worker" ready={n?.ready} loading={loading} estimated={!hasLiveNodes && !loading} />
        ))}
      </div>

      {/* OSD disks */}
      {(displayOsds > 0 || loading) && (
        <div className="flex items-center gap-1">
          {(loading ? Array(3).fill(null) : Array(displayOsds).fill(null)).map((_, i) => (
            <OsdDisk key={i} loading={loading} />
          ))}
          {!loading && osdSize && (
            <span className="text-[10px] font-mono text-text-muted ml-1">
              {displayOsds}×{osdSize}GB
            </span>
          )}
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-3 text-[10px] font-mono text-text-muted">
        <span>{masterNodes.length}M + {workerNodes.length}W</span>
        {displayOsds > 0 && <span>{displayOsds} OSD</span>}
      </div>
    </div>
  )
}
