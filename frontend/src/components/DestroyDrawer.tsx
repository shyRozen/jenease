import { useState } from 'react'
import { api } from '../api/client'

interface DestroyDrawerProps {
  clusterName: string
  ocpVersion?: string
  ocsVersion?: string
  credentialsConf?: string
  onClose: () => void
  onDestroyed?: () => void
}

export default function DestroyDrawer({
  clusterName,
  ocpVersion,
  ocsVersion,
  credentialsConf,
  onClose,
  onDestroyed,
}: DestroyDrawerProps) {
  const [forceJslave, setForceJslave] = useState(false)
  const [longevity, setLongevity] = useState(false)
  const [doNotRelease, setDoNotRelease] = useState(false)
  const [step, setStep] = useState<'options' | 'confirm' | 'sending' | 'success' | 'error'>('options')
  const [apiDisplay, setApiDisplay] = useState('')

  async function handleDestroy() {
    const paramStr = [
      `CLUSTER_NAME=${clusterName}`,
      forceJslave ? 'FORCE_JSLAVE_DESTROY=true' : null,
      longevity ? 'LONGEVITY_CLUSTER=true' : null,
      doNotRelease ? 'DO_NOT_RELEASE_LOCK=true' : null,
    ].filter(Boolean).join('\n  ')

    setApiDisplay(`POST /job/qe-destroy-ocs-cluster/buildWithParameters\n  ${paramStr}`)
    setStep('sending')

    try {
      await api.post<any>(`/clusters/${clusterName}/destroy`, {
        force_jslave_destroy: forceJslave,
        longevity_cluster: longevity,
        do_not_release_lock: doNotRelease,
      })
      setApiDisplay(prev => `${prev}\n\n✓ 201 — Destroy job queued`)
      setStep('success')
      setTimeout(() => {
        onClose()
        onDestroyed?.()
      }, 2500)
    } catch (e: any) {
      setApiDisplay(prev => `${prev}\n\n✕ ${(e as Error).message}`)
      setStep('error')
      setTimeout(() => { setStep('options'); setApiDisplay('') }, 4000)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 z-40" onClick={step === 'options' ? onClose : undefined} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={e => e.target === e.currentTarget && step === 'options' && onClose()}>
        <div className="bg-surface-1 border border-surface-4 rounded-lg shadow-2xl w-full max-w-md flex flex-col">
          {/* Header */}
          <div className="px-5 py-4 border-b border-surface-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="text-accent-red text-lg">⚠</span>
              <div>
                <h2 className="text-sm font-mono font-semibold text-text-primary">Destroy Cluster</h2>
                <p className="text-xs font-mono text-text-muted mt-0.5">{clusterName}</p>
              </div>
            </div>
            {step === 'options' && (
              <button onClick={onClose} className="text-text-muted hover:text-text-primary text-lg leading-none">✕</button>
            )}
          </div>

          {/* Info */}
          <div className="px-5 py-3 border-b border-surface-4 space-y-1">
            <p className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-2">Carried from deploy</p>
            {ocpVersion && (
              <div className="flex gap-3 text-xs font-mono">
                <span className="text-text-muted w-24">OCP</span>
                <span className="text-text-secondary">{ocpVersion}</span>
              </div>
            )}
            {ocsVersion && (
              <div className="flex gap-3 text-xs font-mono">
                <span className="text-text-muted w-24">OCS</span>
                <span className="text-text-secondary">{ocsVersion}</span>
              </div>
            )}
            {credentialsConf && (
              <div className="flex gap-3 text-xs font-mono">
                <span className="text-text-muted w-24">Credentials</span>
                <span className="text-text-secondary truncate">{credentialsConf}</span>
              </div>
            )}
          </div>

          {/* Options */}
          <div className="px-5 py-3 border-b border-surface-4 space-y-2.5">
            <p className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Options</p>
            <label className="flex items-start gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={forceJslave}
                onChange={e => setForceJslave(e.target.checked)}
                disabled={step !== 'options' && step !== 'confirm'}
                className="accent-accent-red mt-0.5 shrink-0"
              />
              <div>
                <span className="text-xs font-mono text-text-secondary group-hover:text-text-primary">FORCE_JSLAVE_DESTROY</span>
                <p className="text-[10px] font-mono text-text-muted leading-snug">Force agent destroy even if cluster teardown failed</p>
              </div>
            </label>
            <label className="flex items-start gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={longevity}
                onChange={e => setLongevity(e.target.checked)}
                disabled={step !== 'options' && step !== 'confirm'}
                className="accent-accent-red mt-0.5 shrink-0"
              />
              <div>
                <span className="text-xs font-mono text-text-secondary group-hover:text-text-primary">LONGEVITY_CLUSTER</span>
                <p className="text-[10px] font-mono text-text-muted leading-snug">Required if this cluster is marked as longevity</p>
              </div>
            </label>
            <label className="flex items-start gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={doNotRelease}
                onChange={e => setDoNotRelease(e.target.checked)}
                disabled={step !== 'options' && step !== 'confirm'}
                className="accent-accent-red mt-0.5 shrink-0"
              />
              <div>
                <span className="text-xs font-mono text-text-secondary group-hover:text-text-primary">DO_NOT_RELEASE_LOCK</span>
                <p className="text-[10px] font-mono text-text-muted leading-snug">Keep resource locked — use when redeploying immediately</p>
              </div>
            </label>
          </div>

          {/* API display */}
          {apiDisplay && (
            <div className="px-5 py-3 border-b border-surface-4">
              <pre className={`text-[10px] font-mono whitespace-pre-wrap leading-relaxed rounded p-2 border ${
                step === 'success'
                  ? 'text-accent-green bg-accent-green/5 border-accent-green/20'
                  : step === 'error'
                  ? 'text-accent-red bg-accent-red/5 border-accent-red/20'
                  : 'text-text-secondary bg-surface-3 border-surface-4'
              }`}>
                {apiDisplay}
              </pre>
            </div>
          )}

          {/* Confirm warning */}
          {step === 'confirm' && (
            <div className="px-5 py-3 border-b border-surface-4 bg-accent-red/5">
              <p className="text-xs font-mono text-accent-red">
                This will permanently destroy <span className="font-bold">{clusterName}</span> and delete the Jenkins agent. This cannot be undone.
              </p>
            </div>
          )}

          {/* Footer */}
          <div className="px-5 py-3 flex items-center gap-3 justify-end">
            {step === 'options' && (
              <>
                <button onClick={onClose} className="btn-ghost">Cancel</button>
                <button
                  onClick={() => setStep('confirm')}
                  className="text-xs font-mono px-3 py-1.5 rounded border border-accent-red text-accent-red hover:bg-accent-red/10 transition-colors"
                >
                  Destroy Cluster
                </button>
              </>
            )}
            {step === 'confirm' && (
              <>
                <button onClick={() => setStep('options')} className="btn-ghost">Back</button>
                <button
                  onClick={handleDestroy}
                  className="text-xs font-mono px-3 py-1.5 rounded bg-accent-red text-white hover:brightness-110 transition-colors font-semibold"
                >
                  Yes, destroy it
                </button>
              </>
            )}
            {step === 'sending' && (
              <span className="flex items-center gap-2 text-xs font-mono text-text-muted">
                <span className="w-3 h-3 border-2 border-surface-4/30 border-t-accent-red rounded-full animate-spin" />
                Triggering destroy…
              </span>
            )}
            {step === 'success' && (
              <span className="text-xs font-mono text-accent-green">✓ Destroy job queued — closing…</span>
            )}
            {step === 'error' && (
              <button onClick={onClose} className="btn-ghost">Close</button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
