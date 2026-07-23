/**
 * Module-level singleton that keeps the OSD SSE stream alive across navigation.
 *
 * Problem: when the user navigates away from ClusterDetail, the EventSource
 * closes. On return, a new exec fires into the toolbox pod and fio may burst
 * multiple disk-stats lines in rapid succession → tiny delta_t → huge spike.
 *
 * Solution: never close the stream while the user is logged in.
 * The stream for the last-visited cluster keeps running in the background.
 * On return to the same cluster: no reconnect, no spike, full history ready.
 * On navigation to a different cluster: old stream closes, new one opens.
 *
 * Weight: 1 EventSource (TCP socket), ~1 KB/s, ceph command already running.
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

type Listener = (data: IopsData) => void

const state: {
  clusterName: string
  kubeconfigUrl: string
  es: EventSource | null
  osdHistory: Record<string, OsdPoint[]>
  // Total throughput history — last 300 points (~10 min at 2s)
  // Workload breakdown (rbd/cephfs/noobaa) is 0 while user is away;
  // total reflects real Ceph I/O the whole time.
  throughputHistory: ThroughputPoint[]
  lastData: IopsData | null
  listeners: Set<Listener>
} = {
  clusterName: '',
  kubeconfigUrl: '',
  es: null,
  osdHistory: {},
  throughputHistory: [],
  lastData: null,
  listeners: new Set(),
}

function openStream(clusterName: string, kubeconfigUrl: string) {
  state.clusterName      = clusterName
  state.kubeconfigUrl    = kubeconfigUrl
  state.osdHistory       = {}
  state.throughputHistory = []
  state.lastData         = null

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

      // Accumulate total throughput history (workload breakdown stays 0 while user is away)
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
 * Attach to the stream for a cluster. Returns the existing OSD history
 * immediately so the component can render without waiting for first event.
 * Call detach() on unmount — the stream keeps running in the background.
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
    openStream(clusterName, kubeconfigUrl)
  }

  state.listeners.add(onData)
  return { osdHistory: state.osdHistory, throughputHistory: state.throughputHistory, lastData: state.lastData }
}

export function detachStream(onData: Listener) {
  state.listeners.delete(onData)
  // Stream intentionally left running — kept alive for instant reconnect
}

/** Call on logout or page unload to clean up. */
export function closeStream() {
  state.es?.close()
  state.es = null
  state.clusterName = ''
  state.osdHistory = {}
  state.throughputHistory = []
  state.lastData = null
  state.listeners.clear()
}
