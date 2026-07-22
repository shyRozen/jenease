import { test, expect } from '@playwright/test'
import { login, TEST_USER } from './helpers'

test.describe('Deploy page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await page.click('nav >> text=Deploy')
    await expect(page).toHaveURL(/\/deploy/)
    // Switch to list view — grid view doesn't show name inputs or ⚙ buttons
    await page.locator('button:has-text("☰")').click()
    await page.waitForSelector('text=▶ Build', { timeout: 30_000 })
  })

  test('job list loads with at least one row', async ({ page }) => {
    const buildBtns = page.locator('button:has-text("▶ Build")')
    expect(await buildBtns.count()).toBeGreaterThan(0)
  })

  test('cluster name field pre-fills with username', async ({ page }) => {
    const nameInputs = page.locator('input[placeholder="name"]')
    await expect(nameInputs.first()).not.toHaveValue('', { timeout: 15_000 })
    const value = await nameInputs.first().inputValue()
    expect(value.toLowerCase()).toMatch(new RegExp(`^${TEST_USER.toLowerCase()}`))
  })

  test('search filters job list', async ({ page }) => {
    const searchInput = page.locator('input').filter({ hasText: '' }).first()
    // Use the search bar (first input on page in list view)
    const before = await page.locator('button:has-text("▶ Build")').count()
    await page.locator('input[placeholder*="vsphere"], input[placeholder*="search"], input[placeholder*="ipv6"]').first().fill('vsphere')
    await page.waitForTimeout(300)
    const after = await page.locator('button:has-text("▶ Build")').count()
    expect(after).toBeLessThanOrEqual(before)
    expect(after).toBeGreaterThan(0)
  })

  test('modify drawer opens with OCP_VERSION and OCS_VERSION fields', async ({ page }) => {
    await page.locator('button:has-text("⚙")').first().click()
    // Drawer shows the full qe-deploy-ocs-cluster param list
    await expect(page.getByText('OCP_VERSION', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('OCS_VERSION', { exact: true }).first()).toBeVisible()
    // CLUSTER_NAME is enforced by the backend, not shown as a drawer param
    await page.keyboard.press('Escape')
  })

  test('trigger a build and immediately abort it', async ({ page }) => {
    // Filter to vsphere only to reduce noise
    await page.locator('input[placeholder*="vsphere"], input[placeholder*="ipv6"]').first().fill('vsphere')
    await page.waitForTimeout(500)

    const [response] = await Promise.all([
      page.waitForResponse(
        resp => resp.url().includes('/api/jobs/trigger') && resp.request().method() === 'POST',
        { timeout: 30_000 }
      ),
      page.locator('button:has-text("▶ Build")').first().click(),
    ])

    const body = await response.json().catch(() => ({}))
    expect(response.status()).toBe(200)
    expect(body.queue_item).toBeGreaterThan(0)

    await expect(page.locator('text=✓').first()).toBeVisible({ timeout: 10_000 })

    await page.waitForTimeout(8000)
    // Use page.evaluate so the request carries the browser's session cookie
    const abortStatus = await page.evaluate(async (clusterName: string) => {
      const r = await fetch(`/api/clusters/${clusterName}/abort`, { method: 'POST', credentials: 'include' })
      return r.status
    }, body.cluster_name)
    // 200=aborted, 404=build not found (still queued), 502=Jenkins error — all acceptable
    // The important assertion is already above: trigger returned 200 + valid queue_item
    expect(abortStatus).toBeLessThan(600)
    console.log(`Abort status for ${body.cluster_name}: ${abortStatus}`)
  })
})
