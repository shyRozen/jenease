# JenEase — Jenkins Cluster Management Web App

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
Prometheus/Thanos (IOPS via OAuth + squid proxy)
    ↕
RLocker (locker queue status, no auth needed)
```

**Stack:** React + TypeScript + Tailwind CSS (Vite) · FastAPI + Python · SQLite · Docker Compose

---

## Features

### My Clusters
- Detects active clusters by parsing `qe-deploy-ocs-cluster` build descriptions AND `CLUSTER_NAME` param (catches early-stage builds)
- Clusters with running/successful destroy jobs automatically removed from list
- **Abort button** on building clusters · **Destroy button** on all clusters (own only)
- Auto-refresh every 30s

### Cluster Detail View
- OCP node panels, ODF capacity bar, OSD tiles with per-disk capacity + **live R/W IOPS**
- IOPS: `irate(ceph_osd_op_r/w[15s])` via Thanos — updates every 3s (cluster scrapes every 1s)
- ODF pod swimlanes, PVC list
- Full OCP/ODF versions from CRs
- **Workload panel** (right side, owner only): launch IO workloads against the cluster
- Health refreshes every **3 seconds** always (was conditional on workloads)

### Health Status
- `HEALTHY` / `DEGRADED` / `UNREACHABLE` / `BUILDING`
- **DEGRADED sub-status** (priority order):
  - `osd_down` — OSDs not up
  - `ceph_err` — HEALTH_ERR
  - `node_not_ready` — node(s) not Ready
  - `odf_error` — StorageCluster Error/Failed
  - `node_pressure` — DiskPressure/MemoryPressure/PIDPressure
  - `ceph_warn` — HEALTH_WARN
  - `odf_progressing` — OCS upgrading/initializing
  - `osd_not_in` — OSDs not in
  - `node_unschedulable` — cordoned node
  - `odf_not_found` — ODF not installed or CR 404

### Deployment Stage Tracking (Building Clusters)
- `GET /api/clusters/{name}/stage` queries Jenkins `wfapi/describe`
- Shows current pipeline stage below `BUILDING` badge:
  - `init` · `prepare_jslave` · `install_ocp` · `install_ocs` · `rhcs` · `upgrade` · `test` · `teardown`
  - `locker_queue · Xh Ym` — stuck waiting for resource lock (checks RLocker queue)
  - `paused · <stage>` — `PAUSED_PENDING_INPUT` with stage it's waiting in
- Stage polls every 30s, only for building clusters
- Works even for early builds with no description yet (fetches CLUSTER_NAME param)

### IO Workloads
- Launch RBD, CephFS, or NooBaa workloads from cluster detail (owner only)
- **RBD / CephFS**: `quay.io/ocsci/nginx:latest` (Alpine + fio 3.41)
  - `numjobs=4`, `bs=1m iodepth=32` (sequential), `bs=4k iodepth=64` (random)
  - Per-job size = total_size / numjobs (fixes 4× PVC overflow bug)
- **NooBaa**: `ubi9/python-311` + boto3, 8 workers × 64MB objects
- Live log terminal (SSE), progress bar from fio output, rate in MB/s
- **Throughput chart**: live SVG chart with RBD/CephFS/NooBaa/Total lines
  - 60s moving window, drag right to scroll history (up to 10 min)
  - Throughput summary bar below chart
- Cleanup: pod → OBC finalizer → PVC → namespace (shown in log terminal)
- Purge button for orphaned `jenease-wl-*` namespaces

### All Clusters Page (`/all-clusters`)
- Shows ALL active clusters across all Jenkins users (not just yours)
- `GET /api/clusters/all` — same logic as active_clusters, no username filter, adds `owner` field
- Real health queries per cluster + details prefetch for healthy/degraded
- **Features**: multi-token search, filter chips (Platform/Status/Owner), sort (6 options), group by (Owner/Platform/Status/**Stage**/OCP/OCS)
- **Stage grouping**: building clusters split by stage (e.g., "Building · install_ocp (3)")
- Box view (ClusterCards) + List view with all links inline
- Destroy button for own clusters only; workload launcher hidden for other users' clusters

### Prefetch Cascade on Login
- `PrefetchManager` in App.tsx fetches all-clusters immediately after login
- Staggers health queries (150ms apart) across all clusters
- Prefetches details for healthy/degraded clusters in background
- Job catalog warmed using authenticated user's token on login

### Deploy Tab
- 179 `qe-trigger-*-deployment` jobs, pre-loaded at startup (catalog warmed on login)
- Multi-token search, filter chips, grid/list view
- All builds → `qe-deploy-ocs-cluster` with non-prod defaults enforced
- Modify drawer: 93 params, searchable, grouped booleans with `?` tooltips

### Agents
- Lists user's Jenkins agents by username prefix, status (busy/idle/offline)

---

## Cluster Name Convention
- Max **15 characters**, pattern: `{username}{n?}-{platform_abbrev}-{storage_abbrev}`
- Examples: `srozen1-v-vs` (vSphere vSAN), `srozen2-a-ls` (AWS LSO)

---

## Authentication
- Login: Jenkins username + API token, **Remember me** checkbox (default: 30-day cookie)
- Token in signed httpOnly cookie, never on server
- 401 from Jenkins → clears cookie → login page

---

## Server Configuration

**Production server:** `10.1.161.147` → `jenease.qe.rh-ocs.com`  
**Stack:** Docker Compose behind Apache httpd

### `.env` file (`/opt/jenease/.env`):
```
JENKINS_URL=https://your-jenkins-instance.example.com
SECRET_KEY=<random 32-char string>
JENKINS_WARM_USER=<username>    # optional
JENKINS_WARM_TOKEN=<token>      # optional
```

### Update server:
```bash
ssh root@10.1.161.147
cd /opt/jenease && git pull && docker compose up -d --build
```

---

## Local Development

```bash
# Backend (from jenease/backend/)
JENKINS_URL=https://... /usr/bin/python3 -m uvicorn main:app --port 8099
# Note: unset JENKINS_URL env var if set in shell (overrides .env)

# Frontend (from jenease/frontend/)
npm run dev -- --port 5199
```

---

## Key Technical Notes

### Kubeconfig & Proxy
Kubeconfig from magna002 contains `proxy-url` for IPv6 clusters. Python k8s client ignores it — extracted and set manually. OAuth token for Prometheus also fetched through the proxy.

### Prometheus IOPS
- `irate(ceph_osd_op_r/w[15s])` via Thanos external route
- Cluster scrapes Ceph at **1s interval** (verified via range query)
- Auth: OAuth Bearer token obtained through squid proxy

### Deployment Stage Detection
- `GET /wfapi/describe` on the Jenkins build
- `PAUSED_PENDING_INPUT` detected at wfapi level
- Locker queue: scrapes HTML at `odf-resourcelocker.apps.int.spoke.prod.us-east-1.aws.paas.redhat.com/pendingrequests/` (public, no auth)
- Matches by build URL in the JSON data embedded in table rows

### Workload fio
- Image: `quay.io/ocsci/nginx:latest` (Alpine + fio 3.41, accessible from cluster nodes)
- `--fallocate=none` — no pre-allocation delay
- Per-job size = `total_gb / NUMJOBS` to fit within PVC
- anyuid SCC granted to workload namespace

### All Clusters Owner Detection
- `owner` derived from cluster name alphabetic prefix: `srozen1-v-vs` → `srozen`

---

## File Structure

```
jenease/
├── backend/
│   ├── main.py              # FastAPI app, catalog warm-up, PrefetchManager hint
│   ├── cluster_health.py    # k8s health + Prometheus IOPS + degraded sub-status
│   ├── workload_runner.py   # k8s workload create/delete/log-stream (fio/NooBaa)
│   ├── routers/
│   │   ├── clusters.py      # /active, /all, /health (w/ degraded_reason), /stage, /details, /destroy
│   │   ├── workloads.py     # CRUD + SSE logs/cleanup
│   │   ├── jobs.py          # Deploy catalog + trigger
│   │   ├── auth.py          # Login (catalog warm on login)
│   │   ├── agents.py
│   │   └── names.py
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.tsx          # Router + PrefetchManager (login cascade)
│   │   ├── components/
│   │   │   ├── ClusterCard.tsx   # Health + stage + degraded_reason display
│   │   │   ├── DestroyDrawer.tsx
│   │   │   ├── WorkloadPanel.tsx # Launcher + workload list
│   │   │   └── ThroughputChart.tsx  # Live SVG throughput chart
│   │   └── pages/
│   │       ├── AllClusters.tsx   # All clusters page
│   │       ├── ClusterDetail.tsx # OSD IOPS, workloads, degraded_reason
│   │       ├── MyClusters.tsx
│   │       ├── Deploy.tsx
│   │       └── Agents.tsx
│   └── Dockerfile
├── docker-compose.yml
├── .env.example
└── .gitignore
```

---

## GitHub
https://github.com/shyRozen/jenease
