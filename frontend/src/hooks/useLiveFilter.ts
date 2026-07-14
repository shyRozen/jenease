import { useMemo, useState } from 'react'

/** Multi-token, any-order search. Each space-separated token must appear somewhere in the target string. */
function matches(haystack: string, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const h = haystack.toLowerCase()
  return tokens.every(t => h.includes(t))
}

export function useLiveFilter<T>(
  items: T[],
  getSearchString: (item: T) => string,
) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!query.trim()) return items
    return items.filter(item => matches(getSearchString(item), query))
  }, [items, query, getSearchString])

  return { query, setQuery, filtered }
}
