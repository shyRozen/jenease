/**
 * Module-level singleton that keeps both the OSD SSE stream and the workload
 * log SSE stream alive across navigation.
 *
 * OSD stream: stays alive permanently for the current cluster. Feeds the OSD
 * tile charts and total throughput history.
 *
 * Log stream: stays alive while workloads are active (same cluster). Buffers
 * the last 5 minutes of log lines and current rates per workload. On return
 * to the page, WorkloadCard terminals seed immediately — no "waiting for output".
 */

export type IopsData = {
  osd_iops?: Record<string, { r?: number; w?: number }>
  osd_throughput_mb?: Record<string, { r?: number; w?: number }>
  pool_throughput_mb?: Record<string, { r?: number; w?: number }>
  osd_status?: Record<string, { up?: number; in?: number }>
}

export type OsdPoint = { ts: number; r: number; w: number; total: number }

// Matches ThroughputChart's DataPoint (avoid circular import)
export type ThroughputPoint = {
  ts: number; total: number
  rbd: number; cephfs: number; noobaa: number
  ceph_r?: number; ceph_w?: number
  [key: string]: number | undefined
}

export type LogLine = { ts: number; text: string }

type Listener = (data: IopsData) => void

const state: {
  // ── OSD stream ──────────────────────────────────────────────────────────────
  clusterName: string
  kubeconfigUrl: string
  es: EventSource | null
  osdHistory: Record<string, OsdPoint[]>
  throughputHistory: ThroughputPoint[]
  lastData: IopsData | null
  holdlastRates: Record<number, number>
  holdlastByType: { rbd: number; cephfs: number; noobaa: number }
  listeners: Set<Listener>
  // ── Log stream ───────────────────────────────────────────────────────────────
  logEs: EventSource | null
  logClusterName: string
  logActiveIds: string
  logLines: Record<number, LogLine[]>    // last 5 min per workload
  logRates: Record<number, number>       // latest MB/s per workload
  logCallbacks: Map<number, (data: any) => void>
} = {
  clusterName: '',
  kubeconfigUrl: '',
  es: null,
  osdHistory: {},
  throughputHistory: [],
  lastData: null,
  holdlastRates: {},
  holdlastByType: { rbd: 0, cephfs: 0, noobaa: 0 },
  listeners: new Set(),
  logEs: null,
  logClusterName: '',
  logActiveIds: '',
  logLines: {},
  logRates: {},
  logCallbacks: new Map(),
}

// ── Persistence (sessionStorage) ─────────────────────────────────────────────

const STORAGE_KEY = 'jenease_stream_v1'

function persistState() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      clusterName:      state.clusterName,
      kubeconfigUrl:    state.kubeconfigUrl,
      throughputHistory: state.throughputHistory,
      osdHistory:       state.osdHistory,
      holdlastRates:    state.holdlastRates,
      holdlastByType:   state.holdlastByType,
      logClusterName:   state.logClusterName,
      logActiveIds:     state.logActiveIds,
      logLines:         state.logLines,
      logRates:         state.logRates,
    }))
  } catch {}
}

function restoreState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const d = JSON.parse(raw)
    const cutoff = Date.now() - 5 * 60 * 1000
    state.clusterName      = d.clusterName      ?? ''
    state.kubeconfigUrl    = d.kubeconfigUrl     ?? ''
    state.throughputHistory = d.throughputHistory ?? []
    state.osdHistory       = d.osdHistory        ?? {}
    state.holdlastRates    = d.holdlastRates     ?? {}
    state.holdlastByType   = d.holdlastByType    ?? { rbd: 0, cephfs: 0, noobaa: 0 }
    state.logClusterName   = d.logClusterName    ?? ''
    state.logActiveIds     = d.logActiveIds      ?? ''
    state.logRates         = d.logRates          ?? {}
    if (d.logLines) {
      for (const [id, lines] of Object.entries(d.logLines as Record<string, LogLine[]>)) {
        const fresh = lines.filter(l => l.ts > cutoff)
        if (fresh.length) state.logLines[Number(id)] = fresh
      }
    }
  } catch {}
}

restoreState()

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', persistState)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistState()
  })
}

// ─────────────────────────────────────────────────────────────────────────────

function parseRateMb(rateStr: string): number | null {
  const m = rateStr.match(/^([\d.]+)\s*(MiB|MB|KiB|KB|GiB|GB)\/s/)
  if (!m) return null
  const val = parseFloat(m[1])
  const unit = m[2]
  return unit.startsWith('K') ? val / 1024 : unit.startsWith('G') ? val * 1024 : val
}

// keepHistory=true: same cluster reconnecting (refresh) — preserve buffered data
function openStream(clusterName: string, kubeconfigUrl: string, keepHistory = false) {
  state.clusterName   = clusterName
  state.kubeconfigUrl = kubeconfigUrl
  if (!keepHistory) {
    state.osdHistory       = {}
    state.throughputHistory = []
    state.lastData         = null
    state.holdlastRates    = {}
    state.holdlastByType   = { rbd: 0, cephfs: 0, noobaa: 0 }
    state.logEs?.close()
    state.logEs          = null
    state.logClusterName = ''
    state.logActiveIds   = ''
    state.logLines       = {}
    state.logRates       = {}
    state.logCallbacks.clear()
  }

  const url = `/api/clusters/${clusterName}/iops/stream?kubeconfig_url=${encodeURIComponent(kubeconfigUrl)}`
  const es  = new EventSource(url, { withCredentials: true })
  state.es  = es

  es.onmessage = (e) => {
    try {
      const data: IopsData = JSON.parse(e.data)
      state.lastData = data
      const now = Date.now()

      const osds = new Set<string>([
        ...Object.keys(data.osd_throughput_mb ?? {}),
        ...Object.keys(data.osd_iops ?? {}),
      ])
      let totalR = 0, totalW = 0
      for (const osd of osds) {
        const mb = data.osd_throughput_mb?.[osd]
        const r = mb?.r ?? 0, w = mb?.w ?? 0
        totalR += r; totalW += w
        const prev = state.osdHistory[osd] ?? []
        state.osdHistory[osd] = [...prev.slice(-720), { ts: now, r, w, total: r + w }]
      }

      state.throughputHistory = [
        ...state.throughputHistory.slice(-300),
        { ts: now, total: totalR + totalW, rbd: 0, cephfs: 0, noobaa: 0, ceph_r: totalR, ceph_w: totalW },
      ]

      state.listeners.forEach(fn => fn(data))
    } catch {}
  }

  es.onerror = () => {}
}

/**
 * Attach to the OSD stream for a cluster. Returns existing history immediately.
 * Call detachStream() on unmount — stream keeps running in the background.
 */
export function attachStream(
  clusterName: string,
  kubeconfigUrl: string,
  onData: Listener,
): { osdHistory: Record<string, OsdPoint[]>; throughputHistory: ThroughputPoint[]; lastData: IopsData | null } {
  const sameCluster = state.clusterName === clusterName && state.kubeconfigUrl === kubeconfigUrl
  const streamDead  = !state.es || state.es.readyState === EventSource.CLOSED

  if (!sameCluster || streamDead) {
    state.es?.close()
    openStream(clusterName, kubeconfigUrl, sameCluster)  // keep history if same cluster (refresh)
  }

  state.listeners.add(onData)
  return { osdHistory: state.osdHistory, throughputHistory: state.throughputHistory, lastData: state.lastData }
}

export function detachStream(onData: Listener) {
  state.listeners.delete(onData)
  // Stream intentionally left running
}

/**
 * Synchronously read current OSD history — safe to call during render.
 * Returns null if singleton is tracking a different cluster.
 */
export function getStreamHistory(clusterName: string): {
  throughputHistory: ThroughputPoint[]
  osdHistory: Record<string, OsdPoint[]>
  lastData: IopsData | null
  holdlastRates: Record<number, number>
  holdlastByType: { rbd: number; cephfs: number; noobaa: number }
} | null {
  if (state.clusterName !== clusterName || !state.es) return null
  return {
    throughputHistory: state.throughputHistory,
    osdHistory: state.osdHistory,
    lastData: state.lastData,
    holdlastRates: state.holdlastRates,
    holdlastByType: state.holdlastByType,
  }
}

export function updateHoldlast(id: number, rate: number | null) {
  if (rate != null && rate > 0) state.holdlastRates[id] = rate
  else delete state.holdlastRates[id]
}

export function updateHoldlastByType(byType: { rbd: number; cephfs: number; noobaa: number }) {
  state.holdlastByType = { ...byType }
}

// ── Log stream ────────────────────────────────────────────────────────────────

/**
 * Open or reuse the multiplexed log SSE for the given cluster + workload IDs.
 * Reconnects only when the ID set changes. Stays alive when WorkloadPanel unmounts.
 * Buffers last 5 min of log lines and current rates per workload.
 */
export function setLogStream(clusterName: string, activeIds: string) {
  const same = state.logClusterName === clusterName && state.logActiveIds === activeIds
  const dead  = !state.logEs || state.logEs.readyState === EventSource.CLOSED
  if (same && !dead) return

  state.logEs?.close()
  state.logClusterName = clusterName
  state.logActiveIds   = activeIds

  // Evict log lines and rates for IDs no longer in the active set so stale
  // data from previous runs doesn't appear as [hist] in new workload terminals.
  const activeSet = new Set(activeIds.split(',').filter(Boolean).map(Number))
  for (const id of Object.keys(state.logLines).map(Number)) {
    if (!activeSet.has(id)) delete state.logLines[id]
  }
  for (const id of Object.keys(state.logRates).map(Number)) {
    if (!activeSet.has(id)) delete state.logRates[id]
  }

  if (!activeIds) { state.logEs = null; return }

  const url = `/api/clusters/${clusterName}/workloads/logs/multi?ids=${activeIds}`
  const es  = new EventSource(url, { withCredentials: true })
  state.logEs = es

  es.onmessage = (e) => {
    try {
      const { workload_id, ...data } = JSON.parse(e.data)
      const now = Date.now()
      const cutoff = now - 5 * 60 * 1000

      if (data.line) {
        const prev = state.logLines[workload_id] ?? []
        state.logLines[workload_id] = [
          ...prev.filter((l: LogLine) => l.ts > cutoff),
          { ts: now, text: data.line },
        ]
      }
      if (data.rate) {
        const mb = parseRateMb(data.rate)
        if (mb !== null) {
          state.logRates[workload_id] = mb
          // Keep OSD holdlast in sync so the chart never drops while off-page
          if (mb > 0) state.holdlastRates[workload_id] = mb
        }
      }

      state.logCallbacks.get(workload_id)?.(data)
    } catch {}
  }

  es.onerror = () => {}
}

/** Register a per-WorkloadCard callback. Cleared on card unmount, stream stays alive. */
export function registerLogCallback(workloadId: number, cb: ((data: any) => void) | null) {
  if (cb) state.logCallbacks.set(workloadId, cb)
  else    state.logCallbacks.delete(workloadId)
}

/**
 * Synchronously read buffered log lines and current rates — safe to call during render.
 * Returns null if the singleton is tracking a different cluster.
 */
export function getLogState(clusterName: string): {
  logLines: Record<number, LogLine[]>
  logRates: Record<number, number>
} | null {
  if (state.logClusterName !== clusterName) return null
  return { logLines: state.logLines, logRates: state.logRates }
}

/** Call on logout to clean up both streams and wipe persisted state. */
export function closeStream() {
  try { sessionStorage.removeItem(STORAGE_KEY) } catch {}
  state.es?.close()
  state.es = null
  state.clusterName = ''
  state.osdHistory = {}
  state.throughputHistory = []
  state.lastData = null
  state.holdlastRates = {}
  state.holdlastByType = { rbd: 0, cephfs: 0, noobaa: 0 }
  state.listeners.clear()
  state.logEs?.close()
  state.logEs = null
  state.logClusterName = ''
  state.logActiveIds = ''
  state.logLines = {}
  state.logRates = {}
  state.logCallbacks.clear()
}
