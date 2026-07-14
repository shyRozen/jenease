import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { DeployJob, JobParam } from '../pages/Deploy'

// Params to show prominently at the top
const PRIORITY_PARAMS = ['OCP_VERSION', 'OCS_VERSION', 'OSD_SIZE', 'CREDENTIALS_CONF', 'CLUSTER_PREFIX', 'LOCK_PRIORITY']
// Params to skip entirely
const SKIP_PARAMS = ['NFS_SHARE', 'CLUSTER_NAME']
// Each group: [label, ...param names]
const BOOL_GROUPS: [string, ...string[]][] = [
  // Deployment stages
  ['Stages', 'RUN_PREPARE_JSLAVE', 'RUN_INSTALL_OCP', 'RUN_INSTALL_OCS', 'RUN_TEARDOWN'],
  ['Upgrade', 'UPGRADE', 'PAUSE_BEFORE_UPGRADE', 'RUN_LIB_TEST', 'IGNORE_LIB_TEST_RESULTS'],
  // Deploy options
  ['Options', 'LIVE_DEPLOY', 'UI_DEPLOY', 'FIPS', 'MCG_ONLY', 'MULTUS', 'ENCRYPTION_AT_REST'],
  ['Extra', 'DEPLOY_EDR', 'USE_OCSQE_INGRESS_CERT', 'LIVE_STAGE_UPGRADE', 'CEPH_DEBUG'],
  // Tests
  ['Tests', 'RUN_TEST', 'RUN_TEST_WITH_ITR', 'AUTOMATICALLY_RE_TRIGGER_FAILED_TESTS'],
  ['Pause', 'PAUSE_BEFORE_TEARDOWN', 'PAUSE_BEFORE_TEST_EXECUTION', 'IO_IN_BACKGROUND'],
  // Reporting
  ['Reporting', 'REPORT_PORTAL', 'LOG_CLUSTER_UTILIZATION', 'COLLECT_LOGS', 'COLLECT_LOGS_ON_SUCCESS'],
  ['Logs', 'FULL_ERRORS', 'TRUNCATED_ERRORS', 'ERROR_LINES', 'REPORT_UPGRADE_TO_VERSION'],
  // RHCS
  ['RHCS', 'RUN_INSTALL_RHCS_CLUSTER', 'DESTROY_RHCS_CLUSTER', 'EXTERNAL_RHCS_RGW_SECURE'],
  // Infrastructure
  ['Infra', 'IGNORE_LOCK', 'LONGEVITY_CLUSTER', 'SKIP_USERNAME_IN_CLUSTER_NAME_CHECK'],
]

// Searchable combobox for large choice lists
function SearchableSelect({ choices, value, onChange }: {
  choices: string[]; value: string; onChange: (v: string) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (!query.trim()) return choices
    const q = query.toLowerCase()
    return choices.filter(c => c.toLowerCase().includes(q))
  }, [choices, query])

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} className="relative">
      <input
        value={open ? query : (value || '')}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => { setQuery(''); setOpen(true) }}
        placeholder="search…"
        className="w-full bg-surface-3 border border-surface-4 rounded px-2 py-0.5 text-xs font-mono text-text-primary focus:outline-none focus:border-accent-cyan"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-50 top-full left-0 mt-0.5 max-h-48 overflow-y-auto bg-surface-2 border border-surface-4 rounded shadow-xl" style={{ minWidth: '100%', width: 'max-content', maxWidth: 'calc(100vw - 20rem)' }}>
          {filtered.map(c => (
            <div
              key={c}
              onMouseDown={() => { onChange(c); setQuery(''); setOpen(false) }}
              className={`px-2 py-1 text-xs font-mono cursor-pointer hover:bg-surface-3 whitespace-nowrap ${c === value ? 'text-accent-cyan' : 'text-text-secondary'}`}
            >
              {c || '(default)'}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Params that use the searchable combobox instead of a plain select
const SEARCHABLE_PARAMS = new Set(['FULL_PLATFORM_CONF'])

function ParamRow({ param, value, onChange }: {
  param: JobParam; value: string | boolean; onChange: (v: string | boolean) => void
}) {
  const isYaml = param.name === 'YAML_TEXT_CONFIG'

  return (
    <div className="flex items-start gap-4 py-2.5 border-b border-surface-4/30 last:border-0">
      {/* Input */}
      <div className="w-56 shrink-0">
        {param.type === 'boolean' ? (
          <input
            type="checkbox"
            checked={value === true || value === 'true' || value === 'True'}
            onChange={e => onChange(e.target.checked)}
            className="accent-accent-cyan mt-0.5"
          />
        ) : SEARCHABLE_PARAMS.has(param.name) && param.choices.length > 0 ? (
          <SearchableSelect choices={param.choices} value={String(value)} onChange={onChange} />
        ) : param.choices.length > 0 ? (
          <select
            value={String(value)}
            onChange={e => onChange(e.target.value)}
            className="w-full bg-surface-3 border border-surface-4 rounded px-2 py-0.5 text-xs font-mono text-text-primary focus:outline-none focus:border-accent-cyan"
          >
            {param.choices.map(c => <option key={c} value={c}>{c || '(default)'}</option>)}
          </select>
        ) : isYaml ? (
          <textarea
            value={String(value)}
            onChange={e => onChange(e.target.value)}
            rows={3}
            placeholder="yaml config..."
            className="w-full bg-surface-3 border border-surface-4 rounded px-2 py-0.5 text-xs font-mono text-text-primary focus:outline-none focus:border-accent-cyan resize-y"
          />
        ) : (
          <input
            value={String(value)}
            onChange={e => onChange(e.target.value)}
            className="w-full bg-surface-3 border border-surface-4 rounded px-2 py-0.5 text-xs font-mono text-text-primary focus:outline-none focus:border-accent-cyan"
          />
        )}
      </div>
      {/* Label + description to the right */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-mono text-text-primary leading-none">{param.name}</p>
        {param.description && (
          <p className="text-[10px] font-mono text-text-secondary mt-0.5 leading-relaxed">
            {param.description}
          </p>
        )}
      </div>
    </div>
  )
}

function ParamTooltip({ description }: { description: string }) {
  const [show, setShow] = useState(false)
  if (!description) return null
  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onClick={e => { e.preventDefault(); setShow(s => !s) }}
        className="w-3.5 h-3.5 rounded-full border border-text-secondary text-text-secondary text-[8px] font-bold leading-none flex items-center justify-center hover:border-accent-cyan hover:text-accent-cyan transition-colors shrink-0"
      >
        ?
      </button>
      {show && (
        <div className="absolute bottom-full left-0 mb-1.5 w-72 bg-surface-0 border border-surface-4 rounded p-2 text-[10px] font-mono text-text-secondary z-50 shadow-xl pointer-events-none leading-relaxed">
          {description}
        </div>
      )}
    </div>
  )
}

function BoolGroupRow({ params, values, onChange }: {
  params: JobParam[]
  values: Record<string, string | boolean>
  onChange: (name: string, v: string | boolean) => void
}) {
  if (params.length === 0) return null
  return (
    <div className="flex items-center gap-4 py-2.5 border-b border-surface-4/30 flex-wrap">
      {params.map(p => (
        <div key={p.name} className="flex items-center gap-1">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={values[p.name] === true || values[p.name] === 'true' || values[p.name] === 'True'}
              onChange={e => onChange(p.name, e.target.checked)}
              className="accent-accent-cyan"
            />
            <span className="text-xs font-mono text-text-secondary">{p.name}</span>
          </label>
          <ParamTooltip description={p.description} />
        </div>
      ))}
    </div>
  )
}

export default function ModifyDrawer({ job, initialClusterName = '', onClose }: { job: DeployJob; initialClusterName?: string; onClose: () => void }) {
  // Params are already fully merged in the catalog (93 params per job, pre-fetched at startup)
  // No extra fetch needed — opens instantly
  const effectiveParams = job.params
  const paramsLoading = false

  const [values, setValues] = useState<Record<string, string | boolean>>({})

  // Initialize values from the pre-merged params in the catalog
  useEffect(() => {
    if (!job.params.length) return
    const init: Record<string, string | boolean> = {}
    for (const p of job.params) {
      init[p.name] = p.type === 'boolean'
        ? (p.default === 'True' || p.default === true)
        : String(p.default ?? '')
    }
    // Non-production team defaults — mirror what the backend enforces on submit
    init['RUN_TEST'] = false
    init['PRODUCTION_RUN'] = false
    init['REPORT_PORTAL'] = false
    init['COLLECT_LOGS_ON_SUCCESS'] = false
    init['LOCK_PRIORITY'] = '3'
    init['CLUSTER_PREFIX'] = ''

    // Smart credentials for DC-CP lab
    if (job.platform === 'vsphere') {
      init['CREDENTIALS_CONF'] = job.features?.includes('ipv6')
        ? 'vSphere8-DC-IPv6-CP_VC1'
        : 'vSphere8-DC-CP_VC1'
    }
    setValues(init)
  }, [job.job_name, job.params.length])
  const [clusterName, setClusterName] = useState(initialClusterName)
  const [paramSearch, setParamSearch] = useState('')
  const [buildState, setBuildState] = useState<'idle' | 'sending' | 'success' | 'error'>('idle')
  const [apiCallDisplay, setApiCallDisplay] = useState('')
  const navigate = useNavigate()

  function set(name: string, v: string | boolean) {
    setValues(prev => ({ ...prev, [name]: v }))
  }

  async function handleBuild() {
    if (!clusterName || clusterName.length > 15) return

    // Build the display string of the API call (no token)
    const keyParams: Record<string, string> = { CLUSTER_NAME: clusterName }
    const showParams = ['OCP_VERSION','OCS_VERSION','OSD_SIZE','CREDENTIALS_CONF','FULL_PLATFORM_CONF','CLUSTER_CONF','CLUSTER_PREFIX']
    for (const name of showParams) {
      const v = values[name]
      if (v && v !== '' && v !== 'false') keyParams[name] = String(v)
    }
    const paramStr = Object.entries(keyParams).map(([k, v]) => `${k}=${v}`).join('\n  ')
    setApiCallDisplay(`POST /job/${job.job_name}/buildWithParameters\n  ${paramStr}`)

    setBuildState('sending')
    try {
      await api.post<any>('/jobs/trigger', {
        job_name: job.job_name,
        params: values,
        cluster_name: clusterName,
      })
      setBuildState('success')
      setApiCallDisplay(prev => `${prev}\n\n✓ 201 — Job queued`)
      setTimeout(() => {
        onClose()
        navigate(`/clusters?highlight=${encodeURIComponent(clusterName)}`)
      }, 3500)
    } catch (e: any) {
      setBuildState('error')
      setApiCallDisplay(prev => `${prev}\n\n✕ ${(e as Error).message}`)
      setTimeout(() => { setBuildState('idle'); setApiCallDisplay('') }, 4000)
    }
  }

  // Classify params — filtered by search, using full merged params
  const allParams = useMemo(() => {
    const base = effectiveParams.filter(p => !SKIP_PARAMS.includes(p.name))
    if (!paramSearch.trim()) return base
    const tokens = paramSearch.toLowerCase().split(/\s+/).filter(Boolean)
    return base.filter(p =>
      tokens.every(t => p.name.toLowerCase().includes(t) || p.description.toLowerCase().includes(t))
    )
  }, [effectiveParams, paramSearch])

  const isSearching = paramSearch.trim().length > 0
  // When searching, show all matching params flat — no grouping
  const priorityParams = isSearching ? [] : PRIORITY_PARAMS.flatMap(n => allParams.filter(p => p.name === n))
  // Extract just param names (skip the label at index 0)
  const boolGroupedNames = new Set(BOOL_GROUPS.flatMap(g => g.slice(1)))
  const groupedBools: { label: string; params: JobParam[] }[] = isSearching ? [] : BOOL_GROUPS
    .map(g => ({
      label: g[0],
      params: (g.slice(1) as string[]).flatMap(n => allParams.filter(p => p.name === n && p.type === 'boolean')),
    }))
    .filter(g => g.params.length > 0)
  const remaining = isSearching
    ? allParams
    : allParams.filter(p => !PRIORITY_PARAMS.includes(p.name) && !boolGroupedNames.has(p.name))

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Drawer */}
      {/* w-52 = sidebar width; drawer fills everything to the right of it */}
      <div className="fixed inset-y-0 right-0 bg-surface-1 border-l border-surface-4 z-50 flex flex-col shadow-2xl"
           style={{ width: 'calc(100vw - 13rem)' }}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-surface-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-mono text-text-muted">{job.job_name}</p>
            <h2 className="text-sm font-mono font-semibold text-text-primary mt-0.5">{job.title}</h2>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-lg leading-none">✕</button>
        </div>

        {/* Cluster name */}
        <div className="px-5 py-3 border-b border-surface-4">
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Cluster Name *</label>
            <span className={`text-[10px] font-mono ${clusterName.length > 15 ? 'text-accent-red' : clusterName.length > 12 ? 'text-accent-amber' : 'text-text-muted'}`}>
              {clusterName.length}/15
            </span>
          </div>
          <input
            value={clusterName}
            onChange={e => setClusterName(e.target.value)}
            maxLength={15}
            placeholder="srozenN-flavor"
            className={`input font-mono text-sm ${clusterName.length > 17 ? 'border-accent-red' : clusterName.length > 14 ? 'border-accent-amber' : ''}`}
          />
        </div>

        {/* Param search */}
        <div className="px-5 py-2 border-b border-surface-4">
          <div className="relative">
            <input
              value={paramSearch}
              onChange={e => setParamSearch(e.target.value)}
              placeholder="search parameters…"
              className="input font-mono text-xs pr-7"
            />
            {paramSearch && (
              <button
                onClick={() => setParamSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary text-sm"
              >✕</button>
            )}
          </div>
        </div>

        {/* Params */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-0">
          {paramsLoading && (
            <p className="text-xs font-mono text-text-muted animate-pulse py-4">Loading full parameter list…</p>
          )}
          {/* Priority params */}
          {priorityParams.length > 0 && (
            <div className="mb-3">
              <p className="text-[9px] font-mono text-text-muted uppercase tracking-widest mb-1">Key Parameters</p>
              {priorityParams.map(p => (
                <ParamRow key={p.name} param={p} value={values[p.name] ?? ''} onChange={v => set(p.name, v)} />
              ))}
            </div>
          )}

          {/* Bool groups */}
          {groupedBools.length > 0 && (
            <div className="mb-3">
              <p className="text-[9px] font-mono text-text-muted uppercase tracking-widest mb-2">Flags</p>
              {groupedBools.map((group, i) => (
                <div key={i} className="flex items-start gap-3 py-2 border-b border-surface-4/30 last:border-0">
                  <span className="text-[9px] font-mono text-text-secondary uppercase tracking-wider w-16 shrink-0 pt-0.5">{group.label}</span>
                  <BoolGroupRow params={group.params} values={values} onChange={set} />
                </div>
              ))}
            </div>
          )}

          {/* Remaining / search results */}
          {remaining.length > 0 && (
            <div>
              <p className="text-[9px] font-mono text-text-muted uppercase tracking-widest mb-1">
                {isSearching ? `${remaining.length} result${remaining.length !== 1 ? 's' : ''}` : 'All Parameters'}
              </p>
              {remaining.map(p => (
                <ParamRow key={p.name} param={p} value={values[p.name] ?? ''} onChange={v => set(p.name, v)} />
              ))}
            </div>
          )}
          {isSearching && remaining.length === 0 && (
            <p className="text-xs font-mono text-text-muted py-4 text-center">No parameters match that search.</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-surface-4">
          {/* API call display */}
          {apiCallDisplay && (
            <pre className={`text-[10px] font-mono whitespace-pre-wrap mb-3 leading-relaxed rounded p-2 border ${
              buildState === 'success'
                ? 'text-accent-green bg-accent-green/5 border-accent-green/20'
                : buildState === 'error'
                ? 'text-accent-red bg-accent-red/5 border-accent-red/20'
                : 'text-text-secondary bg-surface-3 border-surface-4'
            }`}>
              {apiCallDisplay}
            </pre>
          )}
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="btn-ghost ml-auto">Cancel</button>
            <button
              onClick={handleBuild}
              disabled={buildState !== 'idle' || !clusterName || clusterName.length > 15}
              className={`btn-primary transition-colors ${buildState === 'success' ? 'bg-accent-green' : ''}`}
            >
              {buildState === 'sending' && (
                <span className="flex items-center gap-2">
                  <span className="w-3 h-3 border-2 border-surface-0/30 border-t-surface-0 rounded-full animate-spin" />
                  Sending…
                </span>
              )}
              {buildState === 'success' && '✓ Triggered!'}
              {buildState === 'error' && '✕ Failed'}
              {buildState === 'idle' && '▶ Build'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
