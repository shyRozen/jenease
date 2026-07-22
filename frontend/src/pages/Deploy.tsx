import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import { useLiveFilter } from '../hooks/useLiveFilter'
import ModifyDrawer from '../components/ModifyDrawer'
import JobCard from '../components/JobCard'
import SearchBar from '../components/SearchBar'

// ── types ──────────────────────────────────────────────────────────────────

export interface JobParam {
  name: string
  type: string
  default: string | boolean
  choices: string[]
  description: string
}

export interface DeployJob {
  job_name: string
  title: string
  platform: string | null
  installer: string | null
  az: string | null
  os: string | null
  storage: string | null
  masters: number
  workers: number
  features: string[]
  search_string: string
  params: JobParam[]
}

// ── filter chips config ─────────────────────────────────────────────────────

const CHIP_GROUPS = [
  {
    label: 'Platform',
    chips: [
      { key: 'aws', label: 'AWS' },
      { key: 'vsphere', label: 'vSphere' },
      { key: 'azure', label: 'Azure' },
      { key: 'ibmcloud', label: 'IBM Cloud' },
      { key: 'baremetal', label: 'Bare Metal' },
      { key: 'gcp', label: 'GCP' },
    ],
  },
  {
    label: 'Installer',
    chips: [
      { key: 'ipi', label: 'IPI' },
      { key: 'upi', label: 'UPI' },
    ],
  },
  {
    label: 'Topology',
    chips: [
      { key: '3m-3w', label: '3M+3W' },
      { key: '3m-6w', label: '3M+6W' },
      { key: 'compact', label: 'Compact' },
    ],
  },
  {
    label: 'Storage',
    chips: [
      { key: 'vsan', label: 'vSAN' },
      { key: 'vmfs', label: 'VMFS' },
      { key: 'lso', label: 'LSO' },
      { key: 'nvme', label: 'NVMe' },
    ],
  },
  {
    label: 'Features',
    chips: [
      { key: 'fips', label: 'FIPS' },
      { key: 'encryption', label: 'Encryption' },
      { key: 'ipv6', label: 'IPv6' },
      { key: 'multus', label: 'Multus' },
      { key: 'disconnected', label: 'Disconnected' },
      { key: 'external', label: 'External' },
      { key: 'arbiter', label: 'Arbiter' },
      { key: 'proxy', label: 'Proxy' },
    ],
  },
]

// ── helpers ─────────────────────────────────────────────────────────────────

function jobMatchesChip(job: DeployJob, chip: string): boolean {
  if (['aws', 'vsphere', 'azure', 'ibmcloud', 'baremetal', 'gcp'].includes(chip))
    return job.platform === chip
  if (['ipi', 'upi'].includes(chip))
    return job.installer === chip
  if (chip === '3m-3w') return job.masters === 3 && job.workers === 3
  if (chip === '3m-6w') return job.masters === 3 && job.workers === 6
  if (chip === 'compact') return job.workers === 0
  if (['vsan', 'vmfs', 'nvme'].includes(chip)) return (job.storage ?? '').includes(chip)
  if (chip === 'lso') return (job.storage ?? '').startsWith('lso')
  return job.features.includes(chip) || job.search_string.includes(chip)
}

// ── view toggle ─────────────────────────────────────────────────────────────

function ViewToggle({ view, onChange }: { view: 'grid' | 'list'; onChange: (v: 'grid' | 'list') => void }) {
  return (
    <div className="flex border border-surface-4 rounded overflow-hidden">
      {(['grid', 'list'] as const).map(v => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`px-3 py-1.5 text-xs font-mono transition-colors ${
            view === v
              ? 'bg-surface-3 text-text-primary'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          {v === 'grid' ? '▦' : '☰'}
        </button>
      ))}
    </div>
  )
}

// ── sort control ─────────────────────────────────────────────────────────────

type SortKey = 'name' | 'platform'

function sortJobs(jobs: DeployJob[], key: SortKey, asc: boolean): DeployJob[] {
  return [...jobs].sort((a, b) => {
    let cmp = 0
    if (key === 'name') cmp = a.job_name.localeCompare(b.job_name)
    else if (key === 'platform') cmp = (a.platform ?? '').localeCompare(b.platform ?? '')
    return asc ? cmp : -cmp
  })
}

// ── main component ───────────────────────────────────────────────────────────

export default function Deploy() {
  const [activeChips, setActiveChips] = useState<Set<string>>(new Set())
  const [view, setView] = useState<'grid' | 'list'>(() =>
    (localStorage.getItem('deploy-view') as 'grid' | 'list') ?? 'grid'
  )
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const [modifyJob, setModifyJob] = useState<DeployJob | null>(null)
  const [modifyClusterName, setModifyClusterName] = useState('')

  const { data: jobs = [], isLoading } = useQuery<DeployJob[]>({
    queryKey: ['deployments'],
    queryFn: () => api.get('/jobs/deployments'),
    staleTime: 3_600_000,
  })

  const { query, setQuery, filtered: textFiltered } = useLiveFilter(
    jobs,
    useCallback((j: DeployJob) => j.search_string, [])
  )

  const chipFiltered = useMemo(() => {
    if (activeChips.size === 0) return textFiltered

    // Group active chips by their chip group label
    const byGroup = new Map<string, string[]>()
    for (const chip of activeChips) {
      const group = CHIP_GROUPS.find(g => g.chips.some(c => c.key === chip))
      const label = group?.label ?? 'other'
      if (!byGroup.has(label)) byGroup.set(label, [])
      byGroup.get(label)!.push(chip)
    }

    // OR within each group, AND across groups
    return textFiltered.filter(j =>
      [...byGroup.values()].every(chips => chips.some(c => jobMatchesChip(j, c)))
    )
  }, [textFiltered, activeChips])

  const sorted = useMemo(() => sortJobs(chipFiltered, sortKey, sortAsc), [chipFiltered, sortKey, sortAsc])

  function toggleChip(key: string) {
    setActiveChips(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function toggleView(v: 'grid' | 'list') {
    setView(v)
    localStorage.setItem('deploy-view', v)
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(a => !a)
    else { setSortKey(key); setSortAsc(true) }
  }

  return (
    <div className="p-6 flex flex-col gap-4 h-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-mono font-semibold text-text-primary">Deploy</h1>
          <p className="text-xs font-mono text-text-muted mt-0.5">
            {isLoading ? 'Loading jobs…' : `${sorted.length} of ${jobs.length} deployment configurations`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SearchBar value={query} onChange={setQuery} placeholder="vsphere ipv6 fips…" className="w-72" />
          <ViewToggle view={view} onChange={toggleView} />
          <div className="flex items-center gap-1 border border-surface-4 rounded px-2 py-1.5">
            <span className="text-[10px] font-mono text-text-muted mr-1">SORT</span>
            {(['name', 'platform'] as SortKey[]).map(k => (
              <button
                key={k}
                onClick={() => toggleSort(k)}
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded transition-colors ${
                  sortKey === k ? 'text-accent-cyan bg-surface-3' : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {k} {sortKey === k ? (sortAsc ? '↑' : '↓') : ''}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {CHIP_GROUPS.map(group => (
          <div key={group.label} className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">{group.label}</span>
            {group.chips.map(chip => (
              <button
                key={chip.key}
                onClick={() => toggleChip(chip.key)}
                className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
                  activeChips.has(chip.key)
                    ? 'bg-accent-cyan/20 border-accent-cyan/50 text-accent-cyan'
                    : 'border-surface-4 text-text-muted hover:border-surface-4/80 hover:text-text-secondary'
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>
        ))}
        {activeChips.size > 0 && (
          <button
            onClick={() => setActiveChips(new Set())}
            className="text-[10px] font-mono text-text-muted hover:text-accent-red transition-colors"
          >
            clear filters
          </button>
        )}
      </div>

      {/* Content */}
      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array(6).fill(null).map((_, i) => (
            <div key={i} className="card h-40 animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && sorted.length === 0 && (
        <div className="text-center py-20">
          <p className="font-mono text-text-muted text-sm">No jobs match that search.</p>
        </div>
      )}

      {!isLoading && sorted.length > 0 && view === 'grid' && (
        <div className="overflow-y-auto flex-1">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pb-6">
            {sorted.map(job => (
              <JobCard key={job.job_name} job={job} onModify={name => { setModifyJob(job); setModifyClusterName(name) }} />
            ))}
          </div>
        </div>
      )}

      {!isLoading && sorted.length > 0 && view === 'list' && (
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-xs font-mono table-fixed">
            <colgroup>
              <col className="w-[38%]" />
              <col className="w-[8%]" />
              <col className="w-[11%]" />
              <col className="w-[11%]" />
              <col className="w-[14%]" />
              <col className="w-[18%]" />
            </colgroup>
            <thead className="sticky top-0 bg-surface-1 z-10">
              <tr className="border-b border-surface-4">
                {['Config', 'Nodes', 'OCP', 'OCS', 'Name', ''].map(h => (
                  <th key={h} className="text-left py-2 px-2 text-text-muted uppercase tracking-wider text-[10px]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(job => (
                <JobListRow key={job.job_name} job={job} onModify={name => { setModifyJob(job); setModifyClusterName(name) }} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modify drawer */}
      {modifyJob && (
        <ModifyDrawer job={modifyJob} initialClusterName={modifyClusterName} onClose={() => setModifyJob(null)} />
      )}
    </div>
  )
}

// ── list row (inline) ────────────────────────────────────────────────────────

// Shared abbreviation logic — same as JobCard
const PLAT_SHORT: Record<string, string> = {
  aws: 'a', vsphere: 'v', azure: 'az', ibmcloud: 'ib',
  baremetal: 'bm', gcp: 'g', rhv: 'r',
}
const STOR_SHORT: Record<string, string> = {
  vsan: 'vs', vmfs: 'vm', 'lso-rdm': 'lr', 'lso-vmdk': 'lv',
  'nvme-intel': 'nv', lso: 'ls', nvme: 'nv', sts: 'st',
}
function jobFlavor(job: DeployJob): string {
  const plat = PLAT_SHORT[job.platform ?? ''] ?? (job.platform ?? '').slice(0, 2)
  const stor = STOR_SHORT[job.storage ?? ''] ?? (job.storage ?? '').slice(0, 2)
  const v6 = job.features.includes('ipv6') ? 'v6' : ''
  const fips = job.features.includes('fips') ? 'f' : ''
  return [plat, stor, v6, fips].filter(Boolean).join('-')
}

function JobListRow({ job, onModify }: { job: DeployJob; onModify: (name: string) => void }) {
  const ocp = job.params.find(p => p.name === 'OCP_VERSION')
  const ocs = job.params.find(p => p.name === 'OCS_VERSION')
  const [ocpVal, setOcpVal] = useState(String(ocp?.default ?? ''))
  const [ocsVal, setOcsVal] = useState(String(ocs?.default ?? ''))
  const [clusterName, setClusterName] = useState('')

  const flavor = jobFlavor(job)
  const { data: suggestion } = useQuery({
    queryKey: ['suggest-name', flavor],
    queryFn: () => api.get<{ name: string }>(`/suggest-name?flavor=${flavor}`),
    staleTime: 30_000,
  })
  useEffect(() => {
    if (suggestion?.name && !clusterName) setClusterName(suggestion.name)
  }, [suggestion?.name])
  const [building, setBuilding] = useState(false)
  const [toast, setToast] = useState('')

  const PLATFORM_LABELS: Record<string, string> = {
    aws: 'AWS', vsphere: 'vSphere', azure: 'Azure',
    ibmcloud: 'IBM Cloud', baremetal: 'BM', gcp: 'GCP', rhv: 'RHV',
  }

  async function build() {
    if (!clusterName) return
    setBuilding(true)
    try {
      await api.post('/jobs/trigger', {
        job_name: job.job_name,
        params: { OCP_VERSION: ocpVal, OCS_VERSION: ocsVal },
        cluster_name: clusterName,
      })
      setToast('✓')
      setTimeout(() => setToast(''), 3000)
    } catch (e: any) {
      setToast(`✕ ${e.message ?? 'failed'}`)
    } finally {
      setBuilding(false)
    }
  }

  const sel = 'w-full bg-surface-3 border border-surface-4 rounded px-1 py-0.5 text-text-primary text-[11px] font-mono focus:outline-none focus:border-accent-cyan'

  return (
    <tr className="border-b border-surface-4/50 hover:bg-surface-2/50 transition-colors">
      {/* Config: platform · installer · storage · features */}
      <td className="py-2 px-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-text-primary font-semibold">{PLATFORM_LABELS[job.platform ?? ''] ?? job.platform}</span>
          {job.installer && <span className="text-text-muted">{job.installer.toUpperCase()}</span>}
          {job.storage && <span className="text-text-muted">· {job.storage}</span>}
          {job.features.slice(0, 3).map(f => (
            <span key={f} className="px-1 border border-surface-4/50 rounded text-accent-cyan/60 text-[9px]">{f}</span>
          ))}
        </div>
      </td>
      <td className="py-2 px-2 text-text-muted whitespace-nowrap">{job.masters}M+{job.workers === 0 ? 'C' : `${job.workers}W`}</td>
      <td className="py-2 px-2">
        <select className={sel} value={ocpVal} onChange={e => setOcpVal(e.target.value)}>
          {(ocp?.choices ?? [ocpVal]).map(c => <option key={c}>{c}</option>)}
        </select>
      </td>
      <td className="py-2 px-2">
        <select className={sel} value={ocsVal} onChange={e => setOcsVal(e.target.value)}>
          {(ocs?.choices ?? [ocsVal]).map(c => <option key={c}>{c}</option>)}
        </select>
      </td>
      <td className="py-2 px-2">
        <input
          value={clusterName}
          onChange={e => setClusterName(e.target.value.slice(0, 15))}
          placeholder="name"
          className={`w-full bg-surface-3 border rounded px-1.5 py-0.5 text-[11px] font-mono text-text-primary focus:outline-none ${
            clusterName.length > 15 ? 'border-accent-red' : 'border-surface-4 focus:border-accent-cyan'
          }`}
        />
      </td>
      <td className="py-2 px-2">
        <div className="flex gap-1 items-center">
          {toast && <span className={`text-[9px] max-w-[200px] truncate ${toast.startsWith('✓') ? 'text-accent-green' : 'text-accent-red'}`} title={toast}>{toast}</span>}
          <button onClick={build} disabled={building || !clusterName}
            className="btn-primary text-[10px] py-1 px-2">{building ? '…' : '▶ Build'}</button>
          <button onClick={() => onModify(clusterName)} className="btn-ghost text-[10px] py-1 px-1.5">⚙</button>
        </div>
      </td>
    </tr>
  )
}
