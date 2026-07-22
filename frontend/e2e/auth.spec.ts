import { test, expect } from '@playwright/test'
import { login, TEST_USER } from './helpers'

test.describe('Authentication', () => {
  test('login with valid credentials shows My Clusters nav', async ({ page }) => {
    await login(page)
    await expect(page.locator('nav').getByText('My Clusters')).toBeVisible()
    await expect(page.locator('nav').getByText('Deploy')).toBeVisible()
  })

  test('shows signed-in username in sidebar', async ({ page }) => {
    await login(page)
    await expect(page.locator(`text=${TEST_USER}`)).toBeVisible()
  })

  test('logout returns to login page without reload loop', async ({ page }) => {
    await login(page)
    await page.click('text=sign out')
    // Should land on login page — not loop
    await expect(page.locator('input[type="password"], input[placeholder*="token"]')).toBeVisible({ timeout: 5_000 })
    // Wait 2s and confirm it stays stable (no reload loop)
    await page.waitForTimeout(2000)
    await expect(page.locator('input[type="password"], input[placeholder*="token"]')).toBeVisible()
  })
})
