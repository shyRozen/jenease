import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from './helpers'
import AllClusters from '../pages/AllClusters'

describe('AllClusters page', () => {
  it('shows cluster name', async () => {
    renderWithProviders(<AllClusters username="srozen" />)
    await waitFor(() => {
      expect(screen.getByText('srozen-v-vs')).toBeInTheDocument()
    })
  })

  it('shows OCP version', async () => {
    renderWithProviders(<AllClusters username="srozen" />)
    await waitFor(() => {
      expect(screen.getByText(/OCP 4\.16/)).toBeInTheDocument()
    })
  })

  it('shows OCS version', async () => {
    renderWithProviders(<AllClusters username="srozen" />)
    await waitFor(() => {
      expect(screen.getByText(/OCS 4\.16/)).toBeInTheDocument()
    })
  })

  it('shows platform label', async () => {
    renderWithProviders(<AllClusters username="srozen" />)
    await waitFor(() => {
      const els = screen.queryAllByText('vSphere')
      expect(els.length).toBeGreaterThan(0)
    })
  })

  it('filters clusters by search', async () => {
    renderWithProviders(<AllClusters username="srozen" />)
    await waitFor(() => screen.getByText('srozen-v-vs'))

    const searchInput = screen.getByPlaceholderText(/search/i)
    await userEvent.type(searchInput, 'nomatch')

    await waitFor(() => {
      expect(screen.queryByText('srozen-v-vs')).not.toBeInTheDocument()
    })
  })
})
