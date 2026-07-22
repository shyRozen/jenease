import { Page, expect } from '@playwright/test'

export const TEST_USER  = process.env.JENKINS_TEST_USER  ?? 'srozen'
export const TEST_TOKEN = process.env.JENKINS_TEST_TOKEN ?? ''

export async function login(page: Page) {
  await page.goto('/')
  // If already logged in (session cookie still valid), skip login form
  if (!page.url().includes('/login') && await page.locator('text=My Clusters').isVisible().catch(() => false)) {
    return
  }
  await page.fill('input[placeholder="Username"]', TEST_USER)
  await page.fill('input[type="password"]', TEST_TOKEN)
  await page.click('button[type="submit"]')
  // Wait for nav sidebar to show (My Clusters appears in both nav and heading — use nav)
  await expect(page.locator('nav').getByText('My Clusters')).toBeVisible({ timeout: 20_000 })
}
