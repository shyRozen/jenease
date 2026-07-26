import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'

interface Props {
  clusterName: string
  // Cluster snapshot for sharing
  kubeconfigUrl?: string
  consoleUrl?: string
  ocpVersion?: string
  ocsVersion?: string
  platformConf?: string
  credentialsConf?: string
  buildUrl?: string
  buildNum?: number
  onClose: () => void
}

interface UserOption { username: string; full_name: string }
interface ShareEntry { id: number; shared_with: string; created_at: string }

export default function ShareDrawer({
  clusterName, kubeconfigUrl, consoleUrl, ocpVersion, ocsVersion,
  platformConf, credentialsConf, buildUrl, buildNum, onClose,
}: Props) {
  const queryClient = useQueryClient()
  const [shareAll, setShareAll] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<UserOption | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [step, setStep] = useState<'options' | 'sending' | 'done' | 'error'>('options')
  const [error, setError] = useState('')
  const searchRef = useRef<HTMLDivElement>(null)

  // User search — from DB
  const { data: searchResults = [] } = useQuery<UserOption[]>({
    queryKey: ['users-search', search],
    queryFn: () => api.get(`/users/search?q=${encodeURIComponent(search)}`),
    enabled: !shareAll,
    staleTime: 10_000,
  })

  // Extract unique owners from cached all-clusters (supplements DB users)
  const cachedClusters = queryClient.getQueryData<any[]>(['all-clusters']) ?? []
  const clusterOwners: UserOption[] = [...new Set(
    cachedClusters
      .map((c: any) => c.owner || c.cluster_name?.split(/\d/)[0])
      .filter((o: string) => o && o !== queryClient.getQueryData<any>(['me'])?.username)
  )].map((u: string) => ({ username: u, full_name: '' }))

  // Merge DB results with cluster owners, dedup by username
  const allOptions: UserOption[] = [...searchResults]
  for (const co of clusterOwners) {
    if (!allOptions.find(u => u.username === co.username)) {
      if (!search.trim() || co.username.toLowerCase().includes(search.toLowerCase())) {
        allOptions.push(co)
      }
    }
  }

  // Current shares list
  const { data: shares = [], refetch: refetchShares } = useQuery<ShareEntry[]>({
    queryKey: ['shares', clusterName],
    queryFn: () => api.get(`/clusters/${clusterName}/shares`),
  })

  // Close dropdown on outside click
  useEffect(() => {
    function h(e: MouseEvent) {
      if (!searchRef.current?.contains(e.target as Node)) setDropdownOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  async function handleShare() {
    setStep('sending')
    setError('')
    try {
      await api.post(`/clusters/${clusterName}/share`, {
        shared_with: shareAll ? '*' : selected?.username,
        kubeconfig_url: kubeconfigUrl ?? '',
        console_url: consoleUrl ?? '',
        ocp_version: ocpVersion ?? '',
        ocs_version: ocsVersion ?? '',
        platform_conf: platformConf ?? '',
        credentials_conf: credentialsConf ?? '',
        build_url: buildUrl ?? '',
        build_num: buildNum ?? 0,
      })
      setStep('done')
      refetchShares()
      setTimeout(() => setStep('options'), 1500)
    } catch (e: any) {
      setError(e.message ?? 'Share failed')
      setStep('error')
      setTimeout(() => setStep('options'), 3000)
    }
  }

  async function handleUnshare(sharedWith: string) {
    await api.delete(`/clusters/${clusterName}/share/${encodeURIComponent(sharedWith)}`).catch(() => {})
    refetchShares()
  }

  const canShare = shareAll || !!selected

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={step === 'options' ? onClose : undefined} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-surface-1 border border-surface-4 rounded-lg shadow-2xl w-full max-w-md flex flex-col gap-0">

          {/* Header */}
          <div className="px-5 py-4 border-b border-surface-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-mono font-semibold text-text-primary">Share Cluster</h2>
              <p className="text-xs font-mono text-text-muted mt-0.5">{clusterName}</p>
            </div>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary text-lg">✕</button>
          </div>

          {/* Share-to-all toggle */}
          <div className="px-5 py-3 border-b border-surface-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={shareAll} onChange={e => { setShareAll(e.target.checked); setSelected(null) }}
                className="accent-accent-cyan" />
              <span className="text-xs font-mono text-text-secondary">Share with all team members</span>
            </label>
          </div>

          {/* User search */}
          {!shareAll && (
            <div className="px-5 py-3 border-b border-surface-4">
              <p className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-2">Share with a teammate</p>
              <div ref={searchRef} className="relative">
                <input
                  value={selected ? selected.username : search}
                  onChange={e => { setSearch(e.target.value); setSelected(null); setDropdownOpen(true) }}
                  onFocus={() => setDropdownOpen(true)}
                  placeholder="Search username…"
                  className="input text-xs w-full"
                  disabled={step !== 'options'}
                />
                {selected && (
                  <button onClick={() => { setSelected(null); setSearch('') }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary text-sm">✕</button>
                )}
                {dropdownOpen && !selected && allOptions.length > 0 && (
                  <div className="absolute top-full left-0 mt-0.5 w-full bg-surface-2 border border-surface-4 rounded shadow-xl z-10 max-h-40 overflow-y-auto">
                    {allOptions.map(u => (
                      <div key={u.username}
                        onMouseDown={() => { setSelected(u); setSearch(''); setDropdownOpen(false) }}
                        className="px-3 py-2 text-xs font-mono hover:bg-surface-3 cursor-pointer flex items-center justify-between">
                        <span className="text-text-primary">{u.username}</span>
                        {u.full_name && <span className="text-text-muted text-[10px]">{u.full_name}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Current shares */}
          {shares.length > 0 && (
            <div className="px-5 py-3 border-b border-surface-4">
              <p className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-2">Currently shared with</p>
              <div className="space-y-1">
                {shares.map(s => (
                  <div key={s.id} className="flex items-center justify-between">
                    <span className="text-xs font-mono text-text-secondary">
                      {s.shared_with === '*' ? '★ Everyone' : s.shared_with}
                    </span>
                    <button onClick={() => handleUnshare(s.shared_with)}
                      className="text-[10px] font-mono text-text-muted hover:text-accent-red">Unshare</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="px-5 py-3 flex items-center gap-3 justify-end">
            <button onClick={onClose} className="btn-ghost">Cancel</button>
            <button
              onClick={handleShare}
              disabled={!canShare || step === 'sending'}
              className={`btn-primary text-xs disabled:opacity-40 ${step === 'done' ? 'bg-accent-green' : ''}`}
            >
              {step === 'sending' ? '…' : step === 'done' ? '✓ Shared!' : step === 'error' ? `✕ ${error}` : 'Share'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
