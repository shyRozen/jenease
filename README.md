# Jenease — Jenkins Cluster Management Web App

A modern web interface for deploying and managing OCS/ODF clusters via Jenkins.  
Replaces the 100+ parameter Jenkins form with a fast, searchable, team-friendly UI.

---

## Architecture

```
Browser (React + Vite)
    ↕ /api/* proxy
FastAPI backend (Python)
    ↕ Basic Auth (username:token from cookie)
Jenkins (prod: jenkins-csb-odf-qe-ocs4.dno.corp.redhat.com)
    ↕
magna002.ceph.redhat.com  (kubeconfig download, NFS HTTP server)
    ↕
OCP clusters (via squid proxy from kubeconfig proxy-url field)
    ↕
Prometheus/Thanos (IOPS via OAuth token + squid proxy)
```

**Stack:** React + TypeScript + Tailwind CSS (Vite) · FastAPI + Python · SQLite · Docker Compose

---

## Features

### My Clusters
- Detects active clusters by parsing `qe-deploy-ocs-cluster` build descriptions AND checking `CLUSTER_NAME` build parameters (catches early-stage builds before description is written)
- Clusters with a running or successful destroy job are automatically removed from the list
- Each cluster card: node diagram (M/W icons), OSD disk tiles, ODF status, kubeadmin password (blurred), links
- Click a card → full detail view: OCP node panels, ODF capacity bar, OSD tiles, pod swimlanes, PVCs
- Parallel async health queries per cluster:
  - Downloads kubeconfig from magna002 (contains `proxy-url` for IPv6 clusters)
  - Queries OCP nodes, ODF StorageCluster CR, OSD pods, CephCluster CR (capacity)
  - Queries Prometheus via Thanos external route for per-OSD IOPS (`irate(ceph_osd_op_r/w[2m])`)
  - 30-second timeout on all kubernetes calls (prevents hanging on dead clusters)
- **Abort button** on building clusters (two-click confirmation)
- **Destroy button** on completed clusters → opens modal with FORCE_JSLAVE_DESTROY, LONGEVITY_CLUSTER, DO_NOT_RELEASE_LOCK options; cleanup shown step-by-step in log terminal (pod → PVC → namespace)
- Health data refreshes every **2 seconds** when a workload is running, 30 seconds otherwise

### Cluster Detail View
- OCP node panels (conditions, kubelet version)
- ODF status: phase badge, HEALTH_OK/WARN badge, up/in/total OSD count
- Real Ceph capacity bar (bytes from CephCluster CR)
- Individual OSD tiles with:
  - Per-disk capacity bar and % used
  - Live R/W IOPS from Prometheus (updates every 2s during workloads)
- ODF pod swimlanes (MON, OSD, MGR, MDS, CSI RBD/CephFS, NooBaa, etc.)
- PVC list
- Full OCP version (from ClusterVersion CR), full ODF version (from CSV)
- **Workload panel** (right side): launch and monitor IO workloads directly from the UI

### IO Workloads
- Launch RBD, CephFS, or NooBaa IO workloads directly against a live cluster
- **RBD / CephFS**: fio 3.41 (`quay.io/ocsci/nginx:latest` — Alpine + fio pre-installed)
  - `libaio`, `direct=1`, `numjobs=4`, `iodepth=16` (sequential) / `iodepth=32` (random)
  - Sequential: `bs=1m` · Random: `bs=4k`
  - fsync every 64MB so capacity changes are visible in real time
- **NooBaa**: Python + boto3 writing/reading S3 objects via ObjectBucketClaim
- Parameters: Type (RBD/CephFS/NooBaa), Size (1/10/50/100 GB), Mode (Write/Read/R+W), Pattern (Sequential/Random)
- Live log terminal in the workload card (SSE stream with `withCredentials`)
- Progress bar computed from fio's `io=NMiB` output and the total workload size
- IO rate displayed in MB/s
- Cleanup shows step-by-step in the log terminal (pod → PVC → namespace)
- Purge button to force-remove all orphaned `jenease-wl-*` namespaces (including those stuck on NooBaa OBC finalizers)
- Workload records survive navigation (stored in SQLite), auto-removed on cleanup

### Deploy Tab
- 179 `qe-trigger-*-deployment` pre-configured jobs loaded at startup (cached 1h)
- **Multi-token any-order search**: "vsphere ipv6" finds all vsphere+ipv6 configs
- **Filter chips**: Platform (OR within group), Installer, Topology, Storage, Features
- Grid and list view with sort
- Each card: inline OCP/OCS/OSD version dropdowns, auto-suggested cluster name (≤15 chars), Build + Modify buttons
- **All builds go to `qe-deploy-ocs-cluster`** (not production trigger jobs), with non-prod defaults:
  - `RUN_TEST=false`, `LOCK_PRIORITY=3`, `REPORT_PORTAL=false`, `COLLECT_LOGS_ON_SUCCESS=false`, `PRODUCTION_RUN=false`, `CLUSTER_PREFIX=''`
  - vSphere credentials forced to `vSphere8-DC-CP_VC1` (or IPv6 variant) — not production ECO
- **Modify drawer**: full 93-param form (pre-loaded from catalog, opens instantly), searchable, grouped booleans with `?` tooltips, `FULL_PLATFORM_CONF` searchable combobox
- After Build: shows spinner → API call display (no token) → "✓ Triggered" → navigates to My Clusters with cluster name pre-filled and search bar blinking 6×

### Agents
- Lists user's Jenkins agents by username prefix
- Status: busy/idle/offline with color coding

---

## Cluster Name Convention
- Max **15 characters** (Jenkins validation)
- Pattern: `{username}{n?}-{platform_abbrev}-{storage_abbrev}`
- Platform abbreviations: `a`=aws, `v`=vsphere, `az`=azure, `ib`=ibmcloud, `bm`=baremetal, `g`=gcp
- Storage abbreviations: `vs`=vsan, `vm`=vmfs, `ls`=lso, `nv`=nvme, `lr`=lso-rdm, `lv`=lso-vmdk
- Number 1–9 automatically chosen to avoid collision with existing agents/builds
- Examples: `srozen1-v-vs` (vSphere vSAN), `srozen2-a-ls` (AWS LSO)

---

## Authentication
- Login page: Jenkins username + API token, with **Remember me** checkbox (default: checked)
  - Checked → 30-day persistent cookie
  - Unchecked → session cookie (expires on browser close)
- Token stored in a signed httpOnly cookie (`itsdangerous` library)
- Token **never stored on server** — decoded from cookie per request
- If Jenkins returns 401 (wrong instance/expired token): backend returns 401 → frontend clears cookie → redirects to login
- Session-aware: `/auth/me` 401 is handled silently (shows login page), other 401s trigger logout

---

## Server Configuration

**Target server:** `10.1.161.147` (Fedora, inside Red Hat network)

**Deployment:** Docker Compose on port 8080 (backend) and 8082 (frontend), behind Apache reverse proxy.

### Apache config (add to existing httpd):
```apache
ProxyPass        /jenease/api  http://127.0.0.1:8080/api
ProxyPassReverse /jenease/api  http://127.0.0.1:8080/api
ProxyPass        /jenease      http://127.0.0.1:8082
ProxyPassReverse /jenease      http://127.0.0.1:8082
```

### `.env` file (never commit):
```
JENKINS_URL=https://your-jenkins-instance.example.com
SECRET_KEY=<random 32-char string>   # python3 -c "import secrets; print(secrets.token_hex(32))"
JENKINS_WARM_USER=<your-username>    # optional: pre-warms job catalog at startup
JENKINS_WARM_TOKEN=<your-token>      # optional: pre-warms job catalog at startup
```

### Install Docker on Fedora:
```bash
dnf install -y dnf-plugins-core
dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker
```

### Deploy:
```bash
git clone https://github.com/shyRozen/jenease jenease && cd jenease
cp .env.example .env && vi .env   # fill in JENKINS_URL and SECRET_KEY
docker compose up -d --build
```

### Update:
```bash
git pull && docker compose up -d --build
```

---

## Local Development

```bash
# Backend (from jenease/backend/)
pip install -r requirements.txt
JENKINS_URL=https://... SECRET_KEY=dev-secret uvicorn main:app --port 8099

# Frontend (from jenease/frontend/)
npm install && npm run dev -- --port 5199
# Vite proxies /api → localhost:8099
```

---

## Key Technical Notes

### Kubeconfig & Proxy
Kubeconfig is served from magna002 — no auth needed. Contains `proxy-url: http://10.1.112.21:3128` for IPv6 clusters (squid proxy). The Python `kubernetes` client ignores `proxy-url` by default — we extract and set `cfg.proxy` manually.

### Per-OSD IOPS (Prometheus)
- Query: `irate(ceph_osd_op_r/w[2m])` via Thanos external route
- Auth: OAuth token obtained through squid proxy using kubeadmin credentials
- Falls back gracefully if Prometheus is unreachable
- Refreshes every 2s when a workload is running

### Active Cluster Detection
1. Fetch last 200 `qe-deploy-ocs-cluster` builds
2. Parse cluster name from build description URL (`/openshift-clusters/{name}/`)
3. For `building=True` builds with no description yet: fetch `CLUSTER_NAME` parameter
4. Cross-reference with `qe-destroy-ocs-cluster` builds (running OR successful destroys remove the cluster)
5. Filter to builds where cluster name starts with `{username}`

### Workload Cleanup
- Explicit order: pod → OBC finalizer removal → PVC → namespace
- Cleanup progress streamed via SSE to the log terminal
- Stuck NooBaa namespaces: OBC finalizers are patched to `[]` before namespace deletion
- Purge endpoint: finds all `jenease-wl-*` namespaces and force-deletes them

### Job Catalog
- Built from 179 `qe-trigger-*-deployment` jobs at startup (background task)
- Each job: trigger job params merged with full `qe-deploy-ocs-cluster` param schema (93 params)
- Cached in memory for 1 hour

### Build Flow
1. User picks job in Deploy tab → clicks Build (card) or Modify → Build (drawer)
2. Backend: redirects to `qe-deploy-ocs-cluster`, enforces non-prod params, forces DC-CP credentials for vSphere
3. After success: navigates to My Clusters with `?highlight={cluster_name}` → search bar pre-filled and blinks 6×

---

## Jenkins API Used

| Operation | Endpoint |
|---|---|
| Validate credentials | `GET /user/{username}/api/json` |
| List builds | `GET /job/{job}/api/json?tree=builds[...]` |
| Get build params | `GET /job/{job}/{n}/api/json` → `actions[].parameters[]` |
| Trigger job | `POST /job/{job}/buildWithParameters` (form-encoded) |
| Abort build | `POST /job/{job}/{n}/stop` |
| List agents | `GET /computer/api/json` |
| Queue status | `GET /queue/item/{n}/api/json` |

Auth: `Authorization: Basic base64(username:token)` — no CSRF crumb needed for API tokens.

---

## File Structure

```
jenease/
├── backend/
│   ├── main.py              # FastAPI app, lifespan (catalog warm-up)
│   ├── config.py            # Settings from .env
│   ├── auth.py              # Cookie sign/verify (itsdangerous)
│   ├── jenkins.py           # JenkinsClient — all Jenkins API calls
│   ├── cluster_health.py    # k8s health queries + Prometheus IOPS
│   ├── workload_runner.py   # k8s workload create/delete/log-stream (fio/NooBaa)
│   ├── job_parser.py        # Parses qe-trigger-* job names into metadata
│   ├── models.py            # SQLModel DB models (Preset, Workload)
│   ├── database.py          # SQLite engine
│   ├── routers/
│   │   ├── auth.py          # /api/auth/login, /me, /logout
│   │   ├── clusters.py      # /api/clusters/active, /health, /details, /abort, /destroy, /kubeconfig
│   │   ├── agents.py        # /api/agents
│   │   ├── names.py         # /api/suggest-name
│   │   ├── jobs.py          # /api/jobs/deployments, /trigger
│   │   └── workloads.py     # /api/clusters/{name}/workloads (CRUD + SSE logs/cleanup)
│   ├── data/                # SQLite DB (gitignored)
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.tsx          # Router, auth check
│   │   ├── api/client.ts    # fetch wrapper, 401 → logout
│   │   ├── hooks/useLiveFilter.ts   # multi-token any-order search
│   │   ├── components/
│   │   │   ├── Layout.tsx        # Sidebar nav
│   │   │   ├── ClusterCard.tsx   # Card + prefetch details query + destroy button
│   │   │   ├── DestroyDrawer.tsx # Destroy modal with cleanup SSE log
│   │   │   ├── NodeDiagram.tsx   # Node rack visual
│   │   │   ├── JobCard.tsx       # Deploy job card
│   │   │   ├── ModifyDrawer.tsx  # Full 93-param form
│   │   │   ├── WorkloadPanel.tsx # IO workload launcher + live log terminal
│   │   │   └── SearchBar.tsx     # Search with × clear + blink animation
│   │   └── pages/
│   │       ├── Login.tsx
│   │       ├── MyClusters.tsx
│   │       ├── ClusterDetail.tsx  # Node panels, ODF capacity, OSD IOPS, pod swimlanes, PVCs, workloads
│   │       ├── Deploy.tsx         # 179 job cards, filter chips, view toggle
│   │       └── Agents.tsx
│   ├── nginx.conf           # Proxies /api to backend, SPA fallback
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml
├── .env.example
└── .gitignore
```
