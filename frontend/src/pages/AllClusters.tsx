import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import ClusterCard from '../components/ClusterCard'
import DestroyDrawer from '../components/DestroyDrawer'

// ── types ─────────────────────────────────────────────────────────────────────

interface ClusterEntry {
  cluster_name: string
  owner: string
  build_num: number
  build_url: string
  building: boolean
  result: string | null
  timestamp: number | null
  ocp_version: string
  ocs_version: string
  credentials_conf: string
  platform_conf: string
  osd_size: string
  topology: { masters: number; workers: number }
  console_url?: string
  logs_url?: string
  kubeconfig_url?: string
}

// ── helpers ───────────────────────────────────────────────────────────────────

function detectPlatform(cred: string, conf: string): string {
  const s = (cred + ' ' + conf).toLowerCase()
  if (s.includes('vsphere') || s.includes('vsan') || s.includes('vmfs')) return 'vsphere'
  if (s.includes('ibm')) return 'ibmcloud'
  if (s.includes('azure') || s.includes('aro')) return 'azure'
  if (s.includes('baremetal') || s.includes('/baremetal') || s.includes('bm-')) return 'baremetal'
  if (s.includes('gcp') || s.includes('google')) return 'gcp'
  if (s.includes('aws') || s.includes('rosa')) return 'aws'
  return 'other'
}

const PLATFORM_LABELS: Record<string, string> = {
  vsphere: 'vSphere', aws: 'AWS', azure: 'Azure',
  ibmcloud: 'IBM Cloud', baremetal: 'Bare Metal', gcp: 'GCP', other: 'Other',
}

const PLATFORM_COLORS: Record<string, string> = {
  vsphere:   'border-accent-cyan/40 text-accent-cyan',
  aws:       'border-accent-amber/40 text-accent-amber',
  azure:     'border-blue-400/40 text-blue-400',
  ibmcloud:  'border-purple-400/40 text-purple-400',
  baremetal: 'border-accent-green/40 text-accent-green',
  gcp:       'border-red-400/40 text-red-400',
  other:     'border-surface-4 text-text-muted',
}

function jenkinsStatus(c: ClusterEntry): string {
  if (c.building) return 'Building'
  if (c.result === 'FAILURE') return 'Failed'
  if (c.result === 'ABORTED') return 'Aborted'
  return 'Active'
}

const STATUS_COLORS: Record<string, string> = {
  Building:      'text-accent-cyan',
  HEALTHY:       'text-accent-green',
  DEGRADED:      'text-accent-amber',
  UNREACHABLE:   'text-text-muted',
  Failed:        'text-accent-red',
  Aborted:       'text-text-muted',
  LOADING:       'text-text-muted',
  Active:        'text-text-muted',
}

const STAGE_COLORS: Record<string, string> = {
  locker_queue:   'text-accent-amber',
  paused_input:   'text-accent-amber',
  init:           'text-text-muted',
  prepare_jslave: 'text-text-muted',
  install_ocp:    'text-accent-cyan',
  install_ocs:    'text-accent-cyan',
  rhcs:           'text-accent-cyan',
  upgrade:        'text-accent-green',
  test:           'text-accent-green',
  teardown:       'text-text-muted',
}

function ageStr(iso: string): string {
  const ms = Date.now() - new Date(iso + (iso.includes('Z') ? '' : 'Z')).getTime()
  const m = Math.floor(ms / 60_000)
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}

function age(ts: number | null): string {
  if (!ts) return '—'
  const h = Math.floor((Date.now() - ts) / 3_600_000)
  const d = Math.floor(h / 24)
  return d > 0 ? `${d}d` : `${h}h`
}

// ── filter chips ──────────────────────────────────────────────────────────────

function Chips({ label, options, selected, onChange }: {
  label: string
  options: string[]
  selected: Set<string>
  onChange: (v: Set<string>) => void
}) {
  if (!options.length) return null
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[9px] font-mono text-text-muted uppercase tracking-wider shrink-0">{label}</span>
      {options.map(o => {
        const on = selected.has(o)
        return (
          <button key={o} onClick={() => {
            const next = new Set(selected)
            on ? next.delete(o) : next.add(o)
            onChange(next)
          }} className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
            on ? 'border-accent-cyan text-accent-cyan bg-accent-cyan/10'
               : 'border-surface-4 text-text-muted hover:border-surface-4 hover:text-text-secondary'
          }`}>{o}</button>
        )
      })}
    </div>
  )
}

// ── cluster row (list view) ───────────────────────────────────────────────────

function ClusterRow({ c, me }: { c: ClusterEntry; me: string }) {
  const [open, setOpen]           = useState(false)
  const [destroyOpen, setDestroyOpen] = useState(false)
  const queryClient = useQueryClient()
  const platform = detectPlatform(c.credentials_conf, c.platform_conf)
  const isMe = c.owner === me

  const { data: stageData } = useQuery<{ stage: string | null; queue_since?: string; paused_at?: string }>({
    queryKey: ['stage', c.cluster_name],
    queryFn: () => api.get(`/clusters/${c.cluster_name}/stage`),
    enabled: c.building,
    staleTime: 25_000,
    refetchInterval: 30_000,
    retry: false,
  })

  const pausedAtTeardown = stageData?.stage === 'paused_input' && stageData?.paused_at === 'teardown'

  const { data: health } = useQuery({
    queryKey: ['health', c.cluster_name],
    queryFn: () => api.get<{ status: string; degraded_reason?: string | null }>(`/clusters/${c.cluster_name}/health`),
    enabled: !c.building || pausedAtTeardown,
    staleTime: 30_000,
    retry: false,
  })

  // Prefetch details once health resolves as reachable
  useQuery({
    queryKey: ['details', c.cluster_name],
    queryFn: () => api.get(`/clusters/${c.cluster_name}/details`),
    enabled: health?.status === 'HEALTHY' || health?.status === 'DEGRADED',
    staleTime: 60_000,
    retry: false,
  })

  const status = (c.building && !pausedAtTeardown) ? 'Building'
    : health ? health.status
    : jenkinsStatus(c)

  return (
    <div className="border-b border-surface-4/50 last:border-0">
      <div className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2/50 transition-colors group">
        <button onClick={() => setOpen(o => !o)}
          className="text-text-muted hover:text-text-primary text-xs w-4 shrink-0">
          {open ? '▾' : '▸'}
        </button>
        <Link to={`/clusters/${c.cluster_name}`} className="flex-1 flex items-center gap-2 min-w-0">
          <span className="font-mono text-xs text-text-primary group-hover:text-accent-cyan transition-colors truncate w-36 shrink-0">
            {c.cluster_name}
          </span>
          {!isMe && <span className="text-[9px] font-mono text-text-muted shrink-0 w-16 truncate">{c.owner}</span>}
          <div className="flex flex-col shrink-0 w-32">
            <span className={`text-[10px] font-mono ${STATUS_COLORS[status]}`}>
              {c.building && !pausedAtTeardown && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse mr-1" />
              )}
              {status}
            </span>
            {status === 'DEGRADED' && health?.degraded_reason && (
              <span className="text-[9px] font-mono text-accent-amber">{health.degraded_reason}</span>
            )}
            {pausedAtTeardown && (
              <span className="text-[9px] font-mono text-text-muted">paused · teardown</span>
            )}
            {c.building && !pausedAtTeardown && stageData?.stage && (
              <span className={`text-[9px] font-mono ${STAGE_COLORS[stageData.stage] ?? 'text-text-muted'}`}>
                {stageData.stage === 'locker_queue' && stageData.queue_since
                  ? `locker_queue · ${ageStr(stageData.queue_since)}`
                  : stageData.stage === 'paused_input' && stageData.paused_at
                  ? `paused · ${stageData.paused_at}`
                  : stageData.stage}
              </span>
            )}
          </div>
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${PLATFORM_COLORS[platform] ?? PLATFORM_COLORS.other}`}>
            {PLATFORM_LABELS[platform] ?? platform}
          </span>
          <span className="text-[10px] font-mono text-text-muted shrink-0">OCP {c.ocp_version || '—'}</span>
          <span className="text-[10px] font-mono text-text-muted shrink-0">OCS {c.ocs_version || '—'}</span>
          <span className="text-[10px] font-mono text-text-muted shrink-0">{c.topology.masters}M+{c.topology.workers}W</span>
          <span className="text-[10px] font-mono text-text-muted ml-auto shrink-0">{age(c.timestamp)}</span>
        </Link>
        {/* All action buttons — same as box view */}
        <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
          {c.console_url && (
            <a href={c.console_url} target="_blank" rel="noreferrer"
              className="text-[10px] font-mono text-text-muted hover:text-accent-cyan transition-colors">
              Console↗
            </a>
          )}
          {c.logs_url && (
            <a href={c.logs_url} target="_blank" rel="noreferrer"
              className="text-[10px] font-mono text-text-muted hover:text-accent-cyan transition-colors">
              Logs↗
            </a>
          )}
          <a href={c.build_url} target="_blank" rel="noreferrer"
            className="text-[10px] font-mono text-text-muted hover:text-accent-cyan transition-colors">
            Jenkins #{c.build_num}↗
          </a>
          {c.kubeconfig_url && (
            <a
              href={`/api/clusters/${c.cluster_name}/kubeconfig`}
              download={`kubeconfig-${c.cluster_name}`}
              className="text-[10px] font-mono text-accent-green hover:brightness-125 transition-colors"
            >
              ↓ kubeconfig
            </a>
          )}
          {isMe && (
            <button
              onClick={() => setDestroyOpen(true)}
              className="text-[10px] font-mono text-accent-red/50 hover:text-accent-red border border-accent-red/30 hover:border-accent-red px-1.5 rounded transition-colors"
            >
              ✕ Destroy
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="px-10 py-2 bg-surface-2/30 border-t border-surface-4/30 flex items-center gap-4 flex-wrap">
          <span className="text-[10px] font-mono text-text-muted">OSD {c.osd_size || '—'} GB</span>
          {c.platform_conf && <span className="text-[10px] font-mono text-text-muted truncate max-w-xs">{c.platform_conf}</span>}
          <Link to={`/clusters/${c.cluster_name}`}
            className="ml-auto text-[10px] font-mono text-accent-cyan hover:brightness-125">
            Open detail →
          </Link>
        </div>
      )}
      {destroyOpen && (
        <DestroyDrawer
          clusterName={c.cluster_name}
          ocpVersion={c.ocp_version}
          ocsVersion={c.ocs_version}
          credentialsConf={c.credentials_conf}
          onClose={() => setDestroyOpen(false)}
          onDestroyed={() => {
            setDestroyOpen(false)
            queryClient.invalidateQueries({ queryKey: ['all-clusters'] })
            queryClient.invalidateQueries({ queryKey: ['clusters'] })
          }}
        />
      )}
    </div>
  )
}

// Box view reuses ClusterCard which already handles health queries + prefetch

// ── collapsible group ─────────────────────────────────────────────────────────

function Group({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="border border-surface-4 rounded-lg overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-surface-2 hover:bg-surface-2/70 transition-colors text-left">
        <span className="text-xs font-mono text-text-secondary">{open ? '▾' : '▸'}</span>
        <span className="text-xs font-mono text-text-primary font-semibold">{label}</span>
        <span className="text-[10px] font-mono text-text-muted ml-1">({count})</span>
      </button>
      {open && <div>{children}</div>}
    </div>
  )
}

// ── sort / group helpers ──────────────────────────────────────────────────────

type SortKey = 'age' | 'owner' | 'platform' | 'ocp' | 'ocs' | 'status'
type GroupKey = 'none' | 'owner' | 'platform' | 'status' | 'stage' | 'ocp' | 'ocs'

function sortClusters(list: ClusterEntry[], by: SortKey): ClusterEntry[] {
  return [...list].sort((a, b) => {
    switch (by) {
      case 'age':      return (b.timestamp ?? 0) - (a.timestamp ?? 0)
      case 'owner':    return a.owner.localeCompare(b.owner)
      case 'platform': return detectPlatform(a.credentials_conf, a.platform_conf)
                              .localeCompare(detectPlatform(b.credentials_conf, b.platform_conf))
      case 'ocp':      return (b.ocp_version || '').localeCompare(a.ocp_version || '')
      case 'ocs':      return (b.ocs_version || '').localeCompare(a.ocs_version || '')
      case 'status':   return jenkinsStatus(a).localeCompare(jenkinsStatus(b))
      default:         return 0
    }
  })
}

function groupClusters(
  list: ClusterEntry[], by: GroupKey,
  qc?: ReturnType<typeof useQueryClient>
): [string, ClusterEntry[]][] {
  if (by === 'none') return [['All', list]]
  const map = new Map<string, ClusterEntry[]>()
  for (const c of list) {
    let key: string
    if (by === 'stage' && c.building) {
      const { stage, paused_at } = qc ? getStageFromCache(qc, c.cluster_name) : { stage: null }
      if (stage === 'paused_input' && paused_at === 'teardown') {
        // Cluster is fully deployed, paused waiting for teardown input — group by health
        key = (qc ? getHealthStatusFromCache(qc, c.cluster_name) : null) ?? 'Active'
      } else {
        key = stage ? `Building · ${stage}` : 'Building'
      }
    } else {
      key = by === 'owner'    ? c.owner
          : by === 'platform' ? (PLATFORM_LABELS[detectPlatform(c.credentials_conf, c.platform_conf)] ?? 'Other')
          : by === 'status' || by === 'stage' ? jenkinsStatus(c)
          : by === 'ocp'      ? (c.ocp_version || 'Unknown')
          : by === 'ocs'      ? (c.ocs_version || 'Unknown')
          : 'All'
    }
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(c)
  }
  return [...map.entries()].sort((a, b) => {
    const aB = a[0].startsWith('Building'), bB = b[0].startsWith('Building')
    if (aB !== bB) return aB ? -1 : 1
    return b[1].length - a[1].length
  })
}

// ── main page ─────────────────────────────────────────────────────────────────

function getStageFromCache(qc: ReturnType<typeof useQueryClient>, clusterName: string): { stage: string | null; paused_at?: string } {
  const d = qc.getQueryData<{ stage: string | null; paused_at?: string }>(['stage', clusterName])
  return { stage: d?.stage ?? null, paused_at: d?.paused_at }
}

function getHealthStatusFromCache(qc: ReturnType<typeof useQueryClient>, clusterName: string): string | null {
  const d = qc.getQueryData<{ status: string }>(['health', clusterName])
  return d?.status ?? null
}

export default function AllClusters({ username }: { username: string }) {
  const { data: clusters = [], isLoading } = useQuery<ClusterEntry[]>({
    queryKey: ['all-clusters'],
    queryFn: () => api.get('/clusters/all'),
    staleTime: 30_000,
    refetchInterval: 30_000,
  })

  const [search, setSearch] = useState('')
  const [platformFilter, setPlatformFilter] = useState<Set<string>>(new Set())
  const [statusFilter, setStatusFilter]   = useState<Set<string>>(new Set())
  const [ownerFilter, setOwnerFilter]     = useState<Set<string>>(new Set())
  const [sortBy, setSortBy]   = useState<SortKey>('age')
  const [groupBy, setGroupBy] = useState<GroupKey>('owner')
  const [view, setView]       = useState<'box' | 'list'>('list')

  // Derive available filter options
  const platforms = useMemo(() =>
    [...new Set(clusters.map(c => PLATFORM_LABELS[detectPlatform(c.credentials_conf, c.platform_conf)] ?? 'Other'))].sort()
  , [clusters])

  const statuses = useMemo(() =>
    [...new Set(clusters.map(jenkinsStatus))].sort()
  , [clusters])

  const owners = useMemo(() =>
    [...new Set(clusters.map(c => c.owner))].sort()
  , [clusters])

  // Filter
  const filtered = useMemo(() => {
    let list = clusters
    // Multi-token search
    if (search.trim()) {
      const tokens = search.toLowerCase().split(/\s+/).filter(Boolean)
      list = list.filter(c => {
        const hay = [c.cluster_name, c.owner, c.ocp_version, c.ocs_version,
                     c.credentials_conf, c.platform_conf].join(' ').toLowerCase()
        return tokens.every(t => hay.includes(t))
      })
    }
    if (platformFilter.size)
      list = list.filter(c => platformFilter.has(PLATFORM_LABELS[detectPlatform(c.credentials_conf, c.platform_conf)] ?? 'Other'))
    if (statusFilter.size)
      list = list.filter(c => statusFilter.has(jenkinsStatus(c)))
    if (ownerFilter.size)
      list = list.filter(c => ownerFilter.has(c.owner))
    return list
  }, [clusters, search, platformFilter, statusFilter, ownerFilter])

  const sorted = useMemo(() => sortClusters(filtered, sortBy), [filtered, sortBy])
  const queryClient = useQueryClient()
  const grouped = useMemo(() => groupClusters(sorted, groupBy, queryClient), [sorted, groupBy, queryClient])

  const SelectBtn = ({ value, current, set, label }: { value: string; current: string; set: (v: any) => void; label: string }) => (
    <button onClick={() => set(value)}
      className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
        current === value
          ? 'border-accent-cyan text-accent-cyan bg-accent-cyan/10'
          : 'border-surface-4 text-text-muted hover:text-text-secondary'
      }`}>{label}</button>
  )

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-surface-4 shrink-0 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-sm font-mono font-semibold text-text-primary">All Clusters</h1>
            <p className="text-[10px] font-mono text-text-muted mt-0.5">
              {isLoading ? 'Loading…' : `${filtered.length} / ${clusters.length} clusters`}
            </p>
          </div>
          {/* View toggle */}
          <div className="flex items-center gap-1 border border-surface-4 rounded p-0.5">
            <button onClick={() => setView('list')}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${view === 'list' ? 'bg-surface-3 text-text-primary' : 'text-text-muted'}`}>
              ☰ List
            </button>
            <button onClick={() => setView('box')}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${view === 'box' ? 'bg-surface-3 text-text-primary' : 'text-text-muted'}`}>
              ⊞ Box
            </button>
          </div>
        </div>

        {/* Search */}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search clusters, owners, versions…"
          className="input font-mono text-xs w-full"
        />

        {/* Filter chips */}
        <div className="space-y-1.5">
          <Chips label="Platform" options={platforms} selected={platformFilter} onChange={setPlatformFilter} />
          <Chips label="Status"   options={statuses}  selected={statusFilter}   onChange={setStatusFilter} />
          <Chips label="Owner"    options={owners}     selected={ownerFilter}    onChange={setOwnerFilter} />
        </div>

        {/* Sort + Group */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Sort</span>
            {(['age','owner','platform','ocp','ocs','status'] as SortKey[]).map(s => (
              <SelectBtn key={s} value={s} current={sortBy} set={setSortBy}
                label={s === 'age' ? 'Age' : s === 'ocp' ? 'OCP' : s === 'ocs' ? 'OCS' : s.charAt(0).toUpperCase() + s.slice(1)} />
            ))}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[9px] font-mono text-text-muted uppercase tracking-wider">Group</span>
            {(['none','owner','platform','status','stage','ocp','ocs'] as GroupKey[]).map(g => (
              <SelectBtn key={g} value={g} current={groupBy} set={setGroupBy}
                label={g === 'none' ? 'None' : g === 'ocp' ? 'OCP' : g === 'ocs' ? 'OCS' : g === 'stage' ? 'Stage' : g.charAt(0).toUpperCase() + g.slice(1)} />
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading && <p className="text-xs font-mono text-text-muted animate-pulse">Loading clusters…</p>}
        {!isLoading && filtered.length === 0 && (
          <p className="text-xs font-mono text-text-muted">No clusters match your filters.</p>
        )}

        {view === 'list' ? (
          <div className="space-y-3">
            {grouped.map(([label, items]) =>
              groupBy === 'none' ? (
                <div key={label} className="border border-surface-4 rounded-lg overflow-hidden">
                  {items.map(c => <ClusterRow key={c.cluster_name} c={c} me={username} />)}
                </div>
              ) : (
                <Group key={label} label={label} count={items.length}>
                  {items.map(c => <ClusterRow key={c.cluster_name} c={c} me={username} />)}
                </Group>
              )
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {grouped.map(([label, items]) => (
              <div key={label}>
                {groupBy !== 'none' && (
                  <p className="text-[9px] font-mono text-text-muted uppercase tracking-widest mb-2">{label} ({items.length})</p>
                )}
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {items.map(c => (
                    <ClusterCard key={c.cluster_name} cluster={c} isOwner={c.owner === username} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
