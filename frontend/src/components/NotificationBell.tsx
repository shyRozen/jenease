import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'

interface NotifItem {
  id: number
  from_user: string
  cluster_name: string
  message: string
  read: boolean
  created_at: string
}

interface Toast {
  id: number
  message: string
  cluster_name: string
}

function timeAgo(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function NotificationBell() {
  const [notifications, setNotifications] = useState<NotifItem[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const panelRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  // Load existing notifications on mount
  useEffect(() => {
    api.get<NotifItem[]>('/notifications/').then(data => {
      setNotifications(data)
      setUnread(data.filter(n => !n.read).length)
    }).catch(() => {})
  }, [])

  // SSE stream for real-time notifications
  useEffect(() => {
    const es = new EventSource('/api/notifications/stream', { withCredentials: true })
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data)
        if (data.type === 'init') {
          setUnread(data.unread)
        } else if (data.type === 'notification') {
          const n: NotifItem = {
            id: data.id,
            from_user: data.from_user,
            cluster_name: data.cluster_name,
            message: data.message,
            read: false,
            created_at: data.created_at,
          }
          setNotifications(prev => [n, ...prev])
          setUnread(u => u + 1)
          // Show toast popup
          const toast: Toast = { id: data.id, message: data.message, cluster_name: data.cluster_name }
          setToasts(prev => [...prev, toast])
          setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toast.id)), 5000)
        }
      } catch {}
    }
    return () => es.close()
  }, [])

  // Close dropdown when clicking outside
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  async function markRead(id: number) {
    await api.post(`/notifications/${id}/read`).catch(() => {})
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))
    setUnread(u => Math.max(0, u - 1))
  }

  async function markUnread(id: number) {
    await api.post(`/notifications/${id}/unread`).catch(() => {})
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: false } : n))
    setUnread(u => u + 1)
  }

  async function markAllRead() {
    await api.post('/notifications/read-all').catch(() => {})
    setNotifications(prev => prev.map(n => ({ ...n, read: true })))
    setUnread(0)
  }

  function handleNotifClick(n: NotifItem) {
    if (!n.read) markRead(n.id)
    setOpen(false)
    navigate(`/clusters/${n.cluster_name}`)
  }

  return (
    <>
      {/* Toast popups — top center of screen */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] flex flex-col gap-2 items-center pointer-events-none">
        {toasts.map(t => (
          <div key={t.id}
            className="bg-surface-0 border border-accent-cyan/40 rounded-lg px-4 py-3 shadow-2xl pointer-events-auto max-w-sm w-full animate-in slide-in-from-top-2"
            style={{ animation: 'slideDown 0.2s ease-out' }}
          >
            <p className="text-[11px] font-mono text-accent-cyan font-semibold mb-0.5">🔔 New notification</p>
            <p className="text-xs font-mono text-text-primary">{t.message}</p>
          </div>
        ))}
      </div>

      {/* Bell + dropdown */}
      <div ref={panelRef} className="relative">
        <button
          onClick={() => setOpen(o => !o)}
          className="relative p-2 rounded-lg hover:bg-surface-2 transition-colors flex items-center gap-1.5"
          title="Notifications"
        >
          <span className="text-xl leading-none select-none">🔔</span>
          {unread > 0 && (
            <span className="absolute top-0.5 right-0.5 bg-accent-red text-white text-[9px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center leading-none px-0.5">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>

        {open && (
          <div className="absolute top-full right-0 mt-1 w-80 bg-surface-0 border border-surface-4 rounded-lg shadow-2xl z-50 flex flex-col max-h-96 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-surface-4">
              <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Notifications</span>
              {unread > 0 && (
                <button onClick={markAllRead} className="text-[10px] font-mono text-accent-cyan hover:text-accent-cyan/70">
                  Mark all read
                </button>
              )}
            </div>
            <div className="overflow-y-auto flex-1">
              {notifications.length === 0 ? (
                <p className="text-[11px] font-mono text-text-muted text-center py-6">No notifications yet</p>
              ) : notifications.map(n => (
                <div
                  key={n.id}
                  className={`px-3 py-2.5 border-b border-surface-4/50 flex gap-2 items-start group ${!n.read ? 'bg-surface-2/50' : ''}`}
                >
                  <div className="mt-1.5 shrink-0">
                    {!n.read
                      ? <div className="w-1.5 h-1.5 rounded-full bg-accent-cyan" />
                      : <div className="w-1.5" />
                    }
                  </div>
                  <div className="min-w-0 flex-1 cursor-pointer hover:opacity-80" onClick={() => handleNotifClick(n)}>
                    <p className="text-[11px] font-mono text-text-primary leading-snug">{n.message}</p>
                    <p className="text-[9px] font-mono text-text-muted mt-0.5">{timeAgo(n.created_at)}</p>
                  </div>
                  {!n.read ? (
                    <button
                      onClick={e => { e.stopPropagation(); markRead(n.id) }}
                      className="shrink-0 text-[9px] font-mono text-text-muted hover:text-accent-cyan transition-colors opacity-0 group-hover:opacity-100 mt-0.5"
                      title="Mark as read"
                    >✓</button>
                  ) : (
                    <button
                      onClick={e => { e.stopPropagation(); markUnread(n.id) }}
                      className="shrink-0 text-[9px] font-mono text-text-muted hover:text-accent-amber transition-colors opacity-0 group-hover:opacity-100 mt-0.5"
                      title="Mark as unread"
                    >○</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
