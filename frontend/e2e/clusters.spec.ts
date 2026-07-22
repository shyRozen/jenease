import { test, expect } from '@playwright/test'
import { login, TEST_USER } from './helpers'

test.describe('My Clusters', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('My Clusters page loads and shows at least a heading', async ({ page }) => {
    await page.click('nav >> text=My Clusters')
    await expect(page).toHaveURL(/\/clusters/)
    // Page heading or empty state — use first() to avoid strict mode violation with nav item
    await expect(
      page.locator('text=My Clusters').or(page.locator('text=No active clusters')).first()
    ).toBeVisible({ timeout: 10_000 })
  })

  test('own clusters start with username', async ({ page }) => {
    await page.click('nav >> text=My Clusters')
    await page.waitForTimeout(3000) // let clusters load
    const clusterLinks = page.locator(`a[href*="/clusters/${TEST_USER}"]`)
    const count = await clusterLinks.count()
    if (count > 0) {
      // All visible cluster names start with our username
      for (let i = 0; i < Math.min(count, 5); i++) {
        const text = await clusterLinks.nth(i).textContent()
        expect(text?.toLowerCase()).toContain(TEST_USER.toLowerCase())
      }
    }
    // If count=0, user has no active clusters — that's fine
  })
})

test.describe('All Clusters', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('All Clusters page loads with search bar', async ({ page }) => {
    await page.click('nav >> text=All Clusters')
    await expect(page).toHaveURL(/\/all-clusters/)
    await expect(page.locator('input[placeholder]').first()).toBeVisible({ timeout: 10_000 })
  })

  test('clusters show OCP and OCS versions', async ({ page }) => {
    await page.click('nav >> text=All Clusters')
    // Wait for at least one cluster row
    await page.waitForSelector('text=/OCP [0-9]/', { timeout: 15_000 })
    const ocpLabels = page.locator('text=/OCP [0-9]/')
    expect(await ocpLabels.count()).toBeGreaterThan(0)
  })

  test('clusters show platform chip', async ({ page }) => {
    await page.click('nav >> text=All Clusters')
    await page.waitForSelector('text=/OCP [0-9]/', { timeout: 15_000 })
    // At least one platform chip visible
    const platforms = page.locator('text=/vSphere|AWS|IBM Cloud|Azure|Bare Metal/').first()
    await expect(platforms).toBeVisible()
  })

  test('can navigate into a cluster detail page', async ({ page }) => {
    await page.click('nav >> text=All Clusters')
    await page.waitForSelector('text=/OCP [0-9]/', { timeout: 15_000 })
    // Click the first cluster link
    const firstCluster = page.locator('a[href*="/clusters/"]').first()
    const clusterName = await firstCluster.getAttribute('href')
    await firstCluster.click()
    await expect(page).toHaveURL(/\/clusters\//, { timeout: 10_000 })
    // Detail page should show some cluster-specific content
    await expect(page.locator('text=/ODF|OCP|nodes|health/i').first()).toBeVisible({ timeout: 15_000 })
  })

  test('non-owner cluster hides workload launcher', async ({ page }) => {
    await page.click('nav >> text=All Clusters')
    await page.waitForSelector('text=/OCP [0-9]/', { timeout: 15_000 })

    // Find a cluster NOT owned by the test user
    const allLinks = await page.locator('a[href*="/clusters/"]').all()
    let nonOwnerUrl: string | null = null
    for (const link of allLinks) {
      const href = await link.getAttribute('href') ?? ''
      const name = href.split('/clusters/')[1]?.split('/')[0] ?? ''
      if (name && !name.toLowerCase().startsWith(TEST_USER.toLowerCase())) {
        nonOwnerUrl = href
        break
      }
    }

    if (!nonOwnerUrl) {
      test.skip() // all visible clusters belong to this user
      return
    }

    await page.goto(nonOwnerUrl)
    await expect(page).toHaveURL(/\/clusters\//, { timeout: 10_000 })
    await page.waitForTimeout(2000)

    // Workload launcher (right panel) should NOT be present for non-owner
    await expect(page.locator('text=Launch Workload')).not.toBeVisible()
    await expect(page.locator('button:has-text("▶ Launch")')).not.toBeVisible()
  })
})
