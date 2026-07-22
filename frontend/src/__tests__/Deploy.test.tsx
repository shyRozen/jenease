import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from './mocks/server'
import { renderWithProviders } from './helpers'
import Deploy from '../pages/Deploy'

describe('Deploy page', () => {
  it('renders the search bar', async () => {
    renderWithProviders(<Deploy />)
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/vsphere ipv6/i)).toBeInTheDocument()
    })
  })

  it('shows job rows after loading', async () => {
    renderWithProviders(<Deploy />)
    await waitFor(() => {
      expect(screen.getByText(/vSphere/i)).toBeInTheDocument()
    })
  })

  it('pre-fills cluster name with username + flavor', async () => {
    renderWithProviders(<Deploy />)
    await waitFor(() => {
      // The cluster name input should be pre-filled with srozen-v-vs
      const inputs = screen.getAllByRole('textbox')
      const nameInput = inputs.find(i => (i as HTMLInputElement).value.startsWith('srozen'))
      expect(nameInput).toBeDefined()
      expect((nameInput as HTMLInputElement).value).toMatch(/^srozen/)
    }, { timeout: 3000 })
  })

  it('build button is disabled when name is empty', async () => {
    // Override suggest-name to return empty
    server.use(
      http.get('/api/suggest-name', () => HttpResponse.json({ name: '', taken: [] }))
    )
    renderWithProviders(<Deploy />)
    await waitFor(() => {
      const buildBtns = screen.getAllByText(/▶ Build/)
      // All build buttons should be disabled (no name)
      buildBtns.forEach(btn => expect(btn).toBeDisabled())
    }, { timeout: 3000 })
  })
})
