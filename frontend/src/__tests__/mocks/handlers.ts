import { http, HttpResponse } from 'msw'

export const TEST_USER = { username: 'srozen', full_name: 'Shai Rozen' }

export const MOCK_CLUSTERS = [
  {
    cluster_name: 'srozen-v-vs',
    ocp_version: '4.16',
    ocs_version: '4.16',
    platform_conf: 'conf/deployment/vsphere/upi_1az_rhcos_vsan_3m_3w.yaml',
    credentials_conf: 'vSphere8-DC-CP_VC1',
    build_num: 12345,
    building: false,
    result: 'SUCCESS',
    timestamp: Date.now() - 3600000,
    duration: 3600000,
    kubeconfig_url: 'http://magna002/clusters/srozen-v-vs/auth/kubeconfig',
    console_url: null,
    logs_url: null,
    kubeadmin_password: null,
    agent_ip: null,
    osd_size: '512',
    topology: { masters: 3, workers: 3 },
    owner: 'srozen',
  },
]

export const MOCK_JOBS = [
  {
    job_name: 'qe-trigger-vsphere-upi-1az-rhcos-vsan-3m-3w-deployment',
    platform: 'vsphere',
    installer: 'upi',
    storage: 'vsan',
    masters: 3,
    workers: 3,
    features: [],
    title: 'vSphere UPI · vSAN · 3M+3W',
    search_string: 'vsphere upi vsan',
    params: [
      { name: 'OCP_VERSION', type: 'choice', default: '4.16', choices: ['4.16', '4.17', '4.18'], description: '' },
      { name: 'OCS_VERSION', type: 'choice', default: '4.16', choices: ['4.16', '4.17', '4.18'], description: '' },
    ],
  },
]

export const handlers = [
  http.get('/api/auth/me', () => HttpResponse.json(TEST_USER)),

  http.get('/api/clusters/all', () => HttpResponse.json(MOCK_CLUSTERS)),

  http.get('/api/jobs/deployments', () => HttpResponse.json(MOCK_JOBS)),

  http.get('/api/suggest-name', ({ request }) => {
    const url = new URL(request.url)
    const flavor = url.searchParams.get('flavor') ?? ''
    return HttpResponse.json({ name: `srozen${flavor ? '-' + flavor : ''}`, taken: [] })
  }),

  http.get('/api/sequences/', () => HttpResponse.json([])),

  http.post('/api/sequences/', async ({ request }) => {
    const body = await request.json() as any
    return HttpResponse.json({
      id: 1,
      name: body.name,
      items: body.items,
      username: 'srozen',
      cluster_name: null,
      event_count: body.items.length,
    })
  }),
]
