import { defineConfig, devices } from '@playwright/test'
import * as dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Load test credentials from .env.test (one level up from frontend/)
dotenv.config({ path: path.resolve(__dirname, '..', '.env.test') })

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,             // run sequentially — tests share a browser session
  retries: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5199',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Auto-start local dev servers before running tests
  webServer: [
    {
      command: 'cd ../backend && env -u JENKINS_URL /home/srozen/.local/bin/uvicorn main:app --port 8099',
      port: 8099,
      reuseExistingServer: true,
      timeout: 15_000,
      env: {
        SECRET_KEY: process.env.SECRET_KEY ?? 'test-secret-key-for-testing-only',
        JENKINS_URL: process.env.JENKINS_URL ?? 'https://jenkins-csb-odf-qe-stage.dno.corp.redhat.com',
      },
    },
    {
      command: 'cd . && npm run dev -- --port 5199',
      port: 5199,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
})
