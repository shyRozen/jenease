import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { DeployJob } from '../pages/Deploy'

const PLATFORM_COLOR: Record<string, string> = {
  aws:       'text-accent-amber  border-accent-amber/30  bg-accent-amber/10',
  vsphere:   'text-accent-cyan   border-accent-cyan/30   bg-accent-cyan/10',
  azure:     'text-blue-400      border-blue-400/30      bg-blue-400/10',
  ibmcloud:  'text-purple-400    border-purple-400/30    bg-purple-400/10',
  baremetal: 'text-text-secondary border-surface-4       bg-surface-3',
  gcp:       'text-accent-green  border-accent-green/30  bg-accent-green/10',
  rhv:       'text-text-secondary border-surface-4       bg-surface-3',
}

const PLATFORM_LABELS: Record<string, string> = {
  aws: 'AWS', vsphere: 'vSphere', azure: 'Azure',
  ibmcloud: 'IBM Cloud', baremetal: 'BM', gcp: 'GCP', rhv: 'RHV',
}
const STORAGE_LABELS: Record<string, string> = {
  vsan: 'vSAN', vmfs: 'VMFS', 'lso-rdm': 'LSO RDM',
  'lso-vmdk': 'LSO VMDK', 'nvme-intel': 'NVMe', lso: 'LSO', nvme: 'NVMe', sts: 'STS',
}
const FEATURE_LABELS: Record<string, string> = {
  fips: 'FIPS', encryption: 'ENC', 'kms-vault-v1': 'KMS v1',
  'kms-vault-v2': 'KMS v2', 'kms-thales': 'Thales', multus: 'Multus',
  ipv6: 'IPv6', disconnected: 'Disco', external: 'Ext', arbiter: 'Arbiter',
  proxy: 'Proxy', graviton: 'Graviton', 'mcg-only': 'MCG',
  'intransit-encryption': 'IntransitEnc', 'compact-mode': 'Compact',
  'lowerreq': 'LowerReq', perfplus: 'Perf+', privatlink: 'PL', '3i': '3I',
}

interface Props {
  job: DeployJob
  onModify: (clusterName: string) => void
}

export default function JobCard({ job, onModify }: Props) {
  const ocp = job.params.find(p => p.name === 'OCP_VERSION')
  const ocs = job.params.find(p => p.name === 'OCS_VERSION')
  const osd = job.params.find(p => p.name === 'OSD_SIZE')

  const [ocpVal, setOcpVal] = useState(String(ocp?.default ?? ''))
  const [ocsVal, setOcsVal] = useState(String(ocs?.default ?? ''))
  const [osdVal, setOsdVal] = useState(String(osd?.default ?? ''))
  const [clusterName, setClusterName] = useState('')
  const [buildState, setBuildState] = useState<'idle'|'sending'|'success'|'error'>('idle')
  const [toast, setToast] = useState('')
  const navigate = useNavigate()

  // Max 15 chars total — use very short abbreviations
  const PLAT_SHORT: Record<string, string> = {
    aws: 'a', vsphere: 'v', azure: 'az', ibmcloud: 'ib',
    baremetal: 'bm', gcp: 'g', rhv: 'r',
  }
  const STOR_SHORT: Record<string, string> = {
    vsan: 'vs', vmfs: 'vm', 'lso-rdm': 'lr', 'lso-vmdk': 'lv',
    'nvme-intel': 'nv', lso: 'ls', nvme: 'nv', sts: 'st',
  }
  const ipv6 = job.features.includes('ipv6') ? 'v6' : ''
  const fips = job.features.includes('fips') ? 'f' : ''
  const platShort = PLAT_SHORT[job.platform ?? ''] ?? (job.platform ?? '').slice(0, 2)
  const storShort = STOR_SHORT[job.storage ?? ''] ?? (job.storage ?? '').slice(0, 2)
  const flavor = [platShort, storShort, ipv6, fips].filter(Boolean).join('-')

  // Name suggestion — pre-fill as real value once loaded
  const { data: suggestion } = useQuery({
    queryKey: ['suggest-name', flavor],
    queryFn: () => api.get<{ name: string }>(`/suggest-name?flavor=${flavor}`),
    staleTime: 30_000,
  })

  useEffect(() => {
    if (suggestion?.name && !clusterName) {
      setClusterName(suggestion.name)
    }
  }, [suggestion?.name])
  const platformColor = PLATFORM_COLOR[job.platform ?? ''] ?? 'text-text-muted border-surface-4 bg-surface-3'
  const shownFeatures = job.features.slice(0, 4)

  async function handleBuild() {
    const name = clusterName || suggestion?.name || ''
    if (!name || name.length > 15) return
    setBuildState('sending')
    setToast('Sending to Jenkins…')
    try {
      // Build params from all trigger job defaults, then override with user selections
      const baseParams: Record<string, string | boolean> = {}
      for (const p of job.params) {
        if (p.default !== '' && p.default !== null && p.default !== undefined) {
          baseParams[p.name] = p.type === 'boolean'
            ? (p.default === 'True' || p.default === true)
            : String(p.default)
        }
      }
      // Apply user-selected values on top
      const params = { ...baseParams, OCP_VERSION: ocpVal, OCS_VERSION: ocsVal, OSD_SIZE: osdVal }

      await api.post<any>('/jobs/trigger', {
        job_name: job.job_name,  // backend will redirect to qe-deploy-ocs-cluster
        params,
        cluster_name: name,
      })
      setBuildState('success')
      setToast('✓ Triggered!')
      setTimeout(() => {
        navigate(`/clusters?highlight=${encodeURIComponent(name)}`)
      }, 1200)
    } catch (e: any) {
      setBuildState('error')
      setToast(`✕ ${e.message}`)
      setTimeout(() => setBuildState('idle'), 3000)
    }
  }

  return (
    <div className="card p-4 flex flex-col gap-3 hover:border-surface-4/80 transition-colors">
      {/* Badge row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {job.platform && (
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${platformColor}`}>
            {PLATFORM_LABELS[job.platform] ?? job.platform}
          </span>
        )}
        {job.installer && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-surface-4 text-text-muted">
            {job.installer.toUpperCase()}
          </span>
        )}
        {job.storage && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-surface-4 text-text-muted">
            {STORAGE_LABELS[job.storage] ?? job.storage}
          </span>
        )}
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-surface-4 text-text-muted">
          {job.masters}M+{job.workers === 0 ? 'Compact' : `${job.workers}W`}
        </span>
        {shownFeatures.map(f => (
          <span key={f} className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-accent-cyan/20 text-accent-cyan/70">
            {FEATURE_LABELS[f] ?? f}
          </span>
        ))}
      </div>

      {/* Title */}
      <p className="text-sm font-mono text-text-primary leading-snug">{job.title}</p>

      {/* Inline editable params */}
      <div className="flex gap-2 flex-wrap">
        {[
          { label: 'OCP', val: ocpVal, set: setOcpVal, choices: ocp?.choices ?? [], show: true },
          { label: 'OCS', val: ocsVal, set: setOcsVal, choices: ocs?.choices ?? [], show: true },
          { label: 'OSD GB', val: osdVal, set: setOsdVal, choices: osd?.choices ?? [], show: (osd?.choices?.length ?? 0) > 0 },
        ].filter(p => p.show).map(({ label, val, set, choices }) => (
          <div key={label} className="flex-1 min-w-[90px]">
            <label className="block text-[9px] font-mono text-text-muted uppercase mb-0.5">{label}</label>
            <select
              value={val}
              onChange={e => set(e.target.value)}
              className="w-full bg-surface-3 border border-surface-4 rounded px-1.5 py-1 text-[11px] font-mono text-text-primary focus:outline-none focus:border-accent-cyan"
            >
              {(choices.length > 0 ? choices : [val]).map(c => <option key={c} value={c}>{c || '(default)'}</option>)}
            </select>
          </div>
        ))}
      </div>

      {/* Cluster name */}
      <div>
        <div className="flex items-center justify-between mb-0.5">
          <label className="text-[9px] font-mono text-text-muted uppercase">Cluster Name</label>
          <span className={`text-[9px] font-mono ${clusterName.length > 15 ? 'text-accent-red' : clusterName.length > 12 ? 'text-accent-amber' : 'text-text-muted'}`}>
            {clusterName.length}/15
          </span>
        </div>
        <input
          value={clusterName}
          onChange={e => setClusterName(e.target.value)}
          maxLength={15}
          placeholder="loading…"
          className={`w-full bg-surface-3 border rounded px-2 py-1 text-xs font-mono text-text-primary focus:outline-none transition-colors ${
            clusterName.length > 15 ? 'border-accent-red focus:border-accent-red' :
            clusterName.length > 12 ? 'border-accent-amber focus:border-accent-amber' :
            'border-surface-4 focus:border-accent-cyan'
          }`}
        />
      </div>

      {/* Toast */}
      {toast && (
        <p className={`text-[10px] font-mono ${toast.startsWith('✓') ? 'text-accent-green' : 'text-accent-red'}`}>
          {toast}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-2 mt-auto pt-1">
        <button
          onClick={handleBuild}
          disabled={buildState !== 'idle' || !clusterName || clusterName.length > 15}
          className={`btn-primary flex-1 text-xs py-1.5 transition-colors ${buildState === 'success' ? 'bg-accent-green' : ''}`}
        >
          {buildState === 'sending' && (
            <span className="flex items-center justify-center gap-1.5">
              <span className="w-2.5 h-2.5 border-2 border-surface-0/30 border-t-surface-0 rounded-full animate-spin" />
              Sending…
            </span>
          )}
          {buildState === 'success' && '✓ Triggered!'}
          {buildState === 'error' && '✕ Failed'}
          {buildState === 'idle' && '▶ Build'}
        </button>
        <button
          onClick={() => onModify(clusterName)}
          className="btn-ghost text-xs px-3 py-1.5"
        >
          ⚙ Modify
        </button>
      </div>
    </div>
  )
}
