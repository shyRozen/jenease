import { useEffect, useRef } from 'react'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  highlight?: boolean  // triggers blink animation
}

export default function SearchBar({ value, onChange, placeholder = 'search…', className = '', highlight }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!highlight || !inputRef.current) return
    const el = inputRef.current
    el.classList.remove('search-blink')
    // Force reflow so removing+re-adding the class restarts animation
    void el.offsetWidth
    el.classList.add('search-blink')
    const timer = setTimeout(() => el.classList.remove('search-blink'), 3000)
    return () => clearTimeout(timer)
  }, [highlight])

  return (
    <div className={`relative ${className}`}>
      <input
        ref={inputRef}
        className="input font-mono text-sm pr-7"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors text-sm leading-none"
          aria-label="Clear search"
        >
          ✕
        </button>
      )}
    </div>
  )
}
