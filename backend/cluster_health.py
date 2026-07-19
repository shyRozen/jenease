"""
Cluster health queries via OCP API.

Primary path: OAuth login with kubeadmin credentials (works from any machine
that can reach the cluster API — no kubeconfig file or magna002 needed).

Fallback: download kubeconfig from magna002 (works when running on company LAN).
"""
import asyncio
import re
import time
from typing import Optional

import httpx
import yaml

# Cache OAuth tokens per api_url — tokens last ~1h, cache for 55 min
_token_cache: dict[str, tuple[str, float]] = {}  # api_url → (token, expires_at)
_TOKEN_TTL = 3300  # 55 minutes

# Previous raw Ceph counter samples for delta-based throughput calculation
# Two separate caches so health-check scrapes and iops-poll scrapes don't interfere
_CEPH_PREV_SAMPLE: dict[str, dict] = {}         # keyed by "{host}:throughput"

# Cached k8s ApiClient instances to avoid recreating on every 5s poll
# key: api_server_host → (api_client, cfg, expires_monotonic)
_K8S_CLIENT_CACHE: dict[str, tuple] = {}
_K8S_CLIENT_TTL = 3300  # 55 min (same as OAuth token)


def _extract_cluster_domain(console_url: str) -> Optional[str]:
    """console-openshift-console.apps.CLUSTER.DOMAIN → CLUSTER.DOMAIN"""
    m = re.search(r'\.apps\.(.+)$', console_url.rstrip('/'))
    return m.group(1) if m else None


async def _get_oauth_token(api_url: str, password: str, proxy_url: Optional[str] = None) -> Optional[str]:
    """Get a Bearer token via OCP OAuth using kubeadmin credentials. Cached for 55 min."""
    cache_key = f"{api_url}:{password[:8]}"
    cached = _token_cache.get(cache_key)
    if cached and time.time() < cached[1]:
        return cached[0]

    oauth_url = api_url.replace('api.', 'oauth-openshift.apps.', 1).replace(':6443', '')
    authorize_url = f"{oauth_url}/oauth/authorize"
    params = {
        'client_id': 'openshift-challenging-client',
        'response_type': 'token',
    }
    client_kwargs: dict = dict(verify=False, follow_redirects=False, timeout=15.0)
    if proxy_url:
        client_kwargs['proxy'] = proxy_url
    async with httpx.AsyncClient(**client_kwargs) as c:
        try:
            r = await c.get(
                authorize_url,
                params=params,
                auth=('kubeadmin', password),
                headers={'X-CSRF-Token': 'x'},
            )
            # OCP returns 302 with token in Location fragment
            location = r.headers.get('location', '')
            m = re.search(r'access_token=([^&]+)', location)
            if m:
                token = m.group(1)
                _token_cache[cache_key] = (token, time.time() + _TOKEN_TTL)
                return token
        except Exception:
            pass
    return None


def _query_osd_via_k8s_proxy(api_client, cfg) -> dict:
    """Query Prometheus through the k8s API server proxy.
    Uses the kubeconfig credentials (mTLS or bearer token) — no separate OAuth needed.
    URL pattern: https://api.<cluster>:6443/api/v1/namespaces/openshift-monitoring/services/prometheus-k8s:web/proxy/...
    """
    import json as _json, urllib.parse as _up

    base     = cfg.host.rstrip('/')
    prom_pfx = f"{base}/api/v1/namespaces/openshift-monitoring/services/prometheus-k8s:web/proxy"

    queries = [
        ('osd_iops_r', 'rate(ceph_osd_op_r[30s])'),
        ('osd_iops_w', 'rate(ceph_osd_op_w[30s])'),
        ('osd_bytes_r', 'irate(ceph_osd_op_r_out_bytes[30s])'),
        ('osd_bytes_w', 'irate(ceph_osd_op_w_in_bytes[30s])'),
        ('pool_r',      'irate(ceph_pool_rd_bytes[30s])'),
        ('pool_w',      'irate(ceph_pool_wr_bytes[30s])'),
    ]

    osd_iops:          dict = {}
    osd_throughput_mb: dict = {}
    pool_throughput_mb: dict = {}

    # Add auth header (bearer token if present; mTLS kubeconfigs handle auth at TLS layer)
    hdrs: dict = {'Accept': 'application/json'}
    try:
        api_client.update_params_for_auth(hdrs, [], ['BearerToken'])
    except Exception:
        pass

    try:
        for kind, promql in queries:
            url  = f"{prom_pfx}/api/v1/query?query={_up.quote(promql)}"
            resp = api_client.rest_client.request('GET', url, headers=hdrs)
            for item in _json.loads(resp.data).get('data', {}).get('result', []):
                metric = item['metric']
                val    = float(item['value'][1])
                if kind.startswith('osd_'):
                    daemon = metric.get('ceph_daemon', '')
                    if not daemon.startswith('osd.'):
                        continue
                    oid = int(daemon.split('.')[1])
                    if kind == 'osd_iops_r':
                        osd_iops.setdefault(oid, {})['r'] = int(val)
                    elif kind == 'osd_iops_w':
                        osd_iops.setdefault(oid, {})['w'] = int(val)
                    elif kind == 'osd_bytes_r':
                        osd_throughput_mb.setdefault(oid, {})['r'] = round(val / 1_048_576, 3)
                    elif kind == 'osd_bytes_w':
                        osd_throughput_mb.setdefault(oid, {})['w'] = round(val / 1_048_576, 3)
                elif kind in ('pool_r', 'pool_w'):
                    pool_name = next((metric.get(k, '') for k in ('name', 'pool', 'pool_id') if metric.get(k)), '')
                    wtype = _pool_to_workload(pool_name)
                    if not wtype:
                        continue
                    mb = round(val / 1_048_576, 3)
                    pool_throughput_mb.setdefault(wtype, {'r': 0.0, 'w': 0.0})
                    pool_throughput_mb[wtype]['r' if kind == 'pool_r' else 'w'] = round(
                        pool_throughput_mb[wtype]['r' if kind == 'pool_r' else 'w'] + mb, 3
                    )
    except Exception:
        return {}

    if not osd_iops:
        return {}
    result: dict = {'osd_iops': osd_iops}
    if osd_throughput_mb:
        result['osd_throughput_mb'] = osd_throughput_mb
    if pool_throughput_mb:
        result['pool_throughput_mb'] = pool_throughput_mb
    return result


def _parse_prom_text(text: str, wanted: set) -> dict:
    """Parse raw Prometheus text format. Returns {metric: [(labels_dict, float_value)]}."""
    result: dict = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        bi = line.find('{')
        if bi >= 0:
            name = line[:bi]
            ei   = line.rfind('}')
            labels_raw = line[bi + 1:ei]
            rest_parts = line[ei + 1:].strip().split()
        else:
            parts = line.split(None, 2)
            name  = parts[0]
            labels_raw = ''
            rest_parts = parts[1:]
        if name not in wanted:
            continue
        try:
            val = float(rest_parts[0])
        except (IndexError, ValueError):
            continue
        labels: dict = {}
        for kv in labels_raw.split(','):
            k, _, v = kv.partition('=')
            labels[k.strip()] = v.strip().strip('"')
        result.setdefault(name, []).append((labels, val))
    return result


def _scrape_k8s_service(api_client, base: str, svc_variants: list, hdrs: dict) -> Optional[str]:
    """Try each service:port variant, return first successful metrics text body."""
    for svc in svc_variants:
        url = f"{base}/api/v1/namespaces/openshift-storage/services/{svc}/proxy/metrics"
        try:
            resp = api_client.rest_client.request('GET', url, headers=hdrs)
            if resp.status == 200:
                return resp.data.decode('utf-8') if isinstance(resp.data, bytes) else resp.data
        except Exception:
            continue
    return None


def _fetch_ceph_metrics_direct(api_client, cfg, cache_suffix: str = 'iops') -> dict:
    """Scrape rook-ceph-mgr (pool data) and rook-ceph-exporter (per-OSD bytes)
    directly via k8s API proxy. Returns ONLY osd_throughput_mb and pool_throughput_mb —
    IOPS comes separately from Prometheus (stable rate[30s], no delta-induced drops)."""
    base = cfg.host.rstrip('/')
    hdrs: dict = {'Accept': 'text/plain, */*'}
    try:
        api_client.update_params_for_auth(hdrs, [], ['BearerToken'])
    except Exception:
        pass

    # rook-ceph-mgr — pool bytes + pool name metadata
    mgr_text = _scrape_k8s_service(api_client, base, [
        'rook-ceph-mgr:http-metrics',
        'rook-ceph-mgr:9283',
    ], hdrs)

    # rook-ceph-exporter is a DaemonSet: each pod reports only its local OSD(s).
    # Querying the Service gives a random pod per call → different OSD → delta never matches.
    # Fix: list all pods and query each one → all OSDs every call.
    import json as _json
    exporter_text = ''
    try:
        hdrs_json = {**hdrs, 'Accept': 'application/json'}
        for selector in ('app=rook-ceph-exporter', 'app.kubernetes.io/name=rook-ceph-exporter'):
            url = f"{base}/api/v1/namespaces/openshift-storage/pods?labelSelector={selector}"
            resp = api_client.rest_client.request('GET', url, headers=hdrs_json)
            if resp.status == 200:
                pods = _json.loads(resp.data).get('items', [])
                if pods:
                    for pod in pods:
                        pod_name = pod['metadata']['name']
                        purl = f"{base}/api/v1/namespaces/openshift-storage/pods/{pod_name}/proxy/metrics"
                        try:
                            pr = api_client.rest_client.request('GET', purl, headers=hdrs)
                            if pr.status == 200:
                                chunk = pr.data.decode('utf-8') if isinstance(pr.data, bytes) else pr.data
                                exporter_text += chunk + '\n'
                        except Exception:
                            pass
                    break
    except Exception:
        pass
    # Fallback: service call (partial data, but better than nothing)
    if not exporter_text:
        exporter_text = _scrape_k8s_service(api_client, base, [
            'rook-ceph-exporter:ceph-exporter-http-metrics',
            'rook-ceph-exporter:9926',
        ], hdrs) or ''

    if not mgr_text and not exporter_text:
        return {}

    mgr_wanted = {
        'ceph_osd_op_r', 'ceph_osd_op_w',
        'ceph_osd_up', 'ceph_osd_in',
        'ceph_pool_rd_bytes', 'ceph_pool_wr_bytes',
        'ceph_pool_metadata',
    }
    exporter_wanted = {
        'ceph_osd_op_r_out_bytes', 'ceph_osd_op_w_in_bytes',
        'ceph_osd_op_r_latency_count', 'ceph_osd_op_w_latency_count',
    }

    mgr_cur      = _parse_prom_text(mgr_text,      mgr_wanted)      if mgr_text      else {}
    exporter_cur = _parse_prom_text(exporter_text,  exporter_wanted) if exporter_text else {}
    all_cur      = {**mgr_cur, **exporter_cur}

    # pool_id → workload type from pool_metadata (only in mgr)
    pool_id_to_type: dict = {}
    for labels, _ in mgr_cur.get('ceph_pool_metadata', []):
        pid  = labels.get('pool_id', '')
        name = labels.get('name', '')
        wt   = _pool_to_workload(name)
        if wt and pid:
            pool_id_to_type[pid] = wt

    now_ts    = time.monotonic()
    cache_key = f"{base}:{cache_suffix}"
    prev      = _CEPH_PREV_SAMPLE.get(cache_key)
    _CEPH_PREV_SAMPLE[cache_key] = {'data': all_cur, 'ts': now_ts, 'pool_map': pool_id_to_type}

    if not prev:
        return {}   # need two samples for delta

    dt = now_ts - prev['ts']
    if dt < 0.5:
        return {}

    prev_data = prev['data']
    pool_map  = pool_id_to_type or prev.get('pool_map', {})

    # Hard ceiling: 5 GB/s per OSD or pool. Anything above is a bad delta
    # (counter reset, first-sample artifact, or corrupt reading).
    _MAX_MB_S = 5000.0

    def delta_rate(metric: str) -> list:
        idx = {tuple(sorted(pl.items())): pv for pl, pv in prev_data.get(metric, [])}
        out = []
        for labels, cv in all_cur.get(metric, []):
            pv = idx.get(tuple(sorted(labels.items())))
            if pv is not None:
                rate = max(0.0, cv - pv) / dt
                out.append((labels, rate))
        return out

    def mb_s(rate_bytes: float) -> float:
        return round(min(rate_bytes / 1_048_576, _MAX_MB_S), 3)

    osd_throughput_mb:  dict = {}
    pool_throughput_mb: dict = {}
    osd_status:         dict = {}

    # Per-OSD up/in status from mgr (not delta-based, just current value)
    for labels, val in mgr_cur.get('ceph_osd_up', []):
        d = labels.get('ceph_daemon', '')
        if d.startswith('osd.'):
            osd_status.setdefault(int(d.split('.')[1]), {})['up'] = int(val)
    for labels, val in mgr_cur.get('ceph_osd_in', []):
        d = labels.get('ceph_daemon', '')
        if d.startswith('osd.'):
            osd_status.setdefault(int(d.split('.')[1]), {})['in'] = int(val)

    # Per-OSD bytes → MB/s capped at 5 GB/s (from ceph-exporter)
    for labels, rate in delta_rate('ceph_osd_op_r_out_bytes'):
        d = labels.get('ceph_daemon', '')
        if d.startswith('osd.'):
            osd_throughput_mb.setdefault(int(d.split('.')[1]), {})['r'] = mb_s(rate)
    for labels, rate in delta_rate('ceph_osd_op_w_in_bytes'):
        d = labels.get('ceph_daemon', '')
        if d.startswith('osd.'):
            osd_throughput_mb.setdefault(int(d.split('.')[1]), {})['w'] = mb_s(rate)

    # Pool bytes → MB/s capped (from mgr)
    for labels, rate in delta_rate('ceph_pool_rd_bytes'):
        wt = pool_map.get(labels.get('pool_id', ''))
        if wt:
            pool_throughput_mb.setdefault(wt, {'r': 0.0, 'w': 0.0})
            pool_throughput_mb[wt]['r'] = round(min(pool_throughput_mb[wt]['r'] + mb_s(rate), _MAX_MB_S), 3)
    for labels, rate in delta_rate('ceph_pool_wr_bytes'):
        wt = pool_map.get(labels.get('pool_id', ''))
        if wt:
            pool_throughput_mb.setdefault(wt, {'r': 0.0, 'w': 0.0})
            pool_throughput_mb[wt]['w'] = round(min(pool_throughput_mb[wt]['w'] + mb_s(rate), _MAX_MB_S), 3)

    result: dict = {}
    if osd_throughput_mb:  result['osd_throughput_mb']  = osd_throughput_mb
    if pool_throughput_mb: result['pool_throughput_mb'] = pool_throughput_mb
    if osd_status:         result['osd_status']         = osd_status
    return result


def _pool_to_workload(name: str) -> Optional[str]:
    """Map a Ceph pool name to a workload type, or None to skip internal pools."""
    n = name.lower()
    # Skip internal/mgr pools
    if n in ('.mgr', '.rgw.root') or n.startswith('mgr.'):
        return None
    # CephFS data pools only (skip metadata pools — they're tiny overhead)
    if 'cephfilesystem' in n or 'cephfs' in n:
        return None if 'metadata' in n else 'cephfs'
    if any(k in n for k in ('rbd', 'cephblockpool', 'blockpool')):
        return 'rbd'
    # RGW buckets.data → closest to NooBaa S3 workload
    if 'rgw.buckets.data' in n:
        return 'noobaa'
    if any(k in n for k in ('noobaa', 'builtin-mgr')):
        return 'noobaa'
    return None


def _query_osd_iops(api_url: str, token: str, proxy_url: Optional[str] = None) -> dict:
    """Query Thanos for per-OSD IOPS, throughput, and pool-level workload breakdown.
    Uses irate for responsive values (not smoothed over 30s window)."""
    import urllib.parse as _up

    cluster_domain = api_url.replace('https://api.', '').replace(':6443', '')
    thanos = f"https://thanos-querier-openshift-monitoring.apps.{cluster_domain}/api/v1/query"
    headers = {'Authorization': f'Bearer {token}'}

    osd_iops: dict = {}
    osd_throughput_mb: dict = {}
    pool_throughput_mb: dict = {}

    # irate[30s]: instantaneous rate using last 2 samples — responsive, not smoothed
    queries = [
        ('osd_iops_r', 'rate(ceph_osd_op_r[30s])'),
        ('osd_iops_w', 'rate(ceph_osd_op_w[30s])'),
        ('osd_bytes_r', 'irate(ceph_osd_op_r_out_bytes[30s])'),
        ('osd_bytes_w', 'irate(ceph_osd_op_w_in_bytes[30s])'),
        ('pool_r',      'irate(ceph_pool_rd_bytes[30s])'),
        ('pool_w',      'irate(ceph_pool_wr_bytes[30s])'),
    ]
    try:
        with httpx.Client(verify=False, proxy=proxy_url, timeout=10) as c:
            for kind, promql in queries:
                resp = c.get(f"{thanos}?query={_up.quote(promql)}", headers=headers)
                for item in resp.json().get('data', {}).get('result', []):
                    metric = item['metric']
                    val    = float(item['value'][1])
                    if kind.startswith('osd_'):
                        daemon = metric.get('ceph_daemon', '')
                        if not daemon.startswith('osd.'):
                            continue
                        osd_id = int(daemon.split('.')[1])
                        if kind == 'osd_iops_r':
                            osd_iops.setdefault(osd_id, {})['r'] = int(val)
                        elif kind == 'osd_iops_w':
                            osd_iops.setdefault(osd_id, {})['w'] = int(val)
                        elif kind == 'osd_bytes_r':
                            osd_throughput_mb.setdefault(osd_id, {})['r'] = round(val / 1_048_576, 2)
                        elif kind == 'osd_bytes_w':
                            osd_throughput_mb.setdefault(osd_id, {})['w'] = round(val / 1_048_576, 2)
                    elif kind in ('pool_r', 'pool_w'):
                        pool_name = metric.get('pool_id', '') or metric.get('name', '') or metric.get('pool', '')
                        # Thanos may expose pool name differently; try common label keys
                        for lk in ('name', 'pool', 'pool_id'):
                            pool_name = metric.get(lk, '')
                            if pool_name:
                                break
                        wtype = _pool_to_workload(pool_name)
                        if not wtype:
                            continue
                        mb = round(val / 1_048_576, 2)
                        pool_throughput_mb.setdefault(wtype, {'r': 0.0, 'w': 0.0})
                        if kind == 'pool_r':
                            pool_throughput_mb[wtype]['r'] = round(pool_throughput_mb[wtype]['r'] + mb, 2)
                        else:
                            pool_throughput_mb[wtype]['w'] = round(pool_throughput_mb[wtype]['w'] + mb, 2)
    except Exception:
        return {}
    if not osd_iops:
        return {}
    result: dict = {'osd_iops': osd_iops}
    if osd_throughput_mb:
        result['osd_throughput_mb'] = osd_throughput_mb
    if pool_throughput_mb:
        result['pool_throughput_mb'] = pool_throughput_mb
    return result


def _sync_query_with_token(api_url: str, token: str, proxy_url: Optional[str] = None) -> dict:
    """Query nodes + ODF using a Bearer token. Runs in thread pool."""
    from kubernetes import client

    cfg = client.Configuration()
    cfg.host = api_url
    cfg.verify_ssl = False
    cfg.api_key = {'authorization': f'Bearer {token}'}
    if proxy_url:
        cfg.proxy = proxy_url
    api_client = client.ApiClient(cfg)

    result: dict = {'nodes': [], 'odf': {}, 'osd_count': 0}

    try:
        core = client.CoreV1Api(api_client)
        for n in core.list_node().items:
            labels = n.metadata.labels or {}
            role = (
                'master'
                if 'node-role.kubernetes.io/master' in labels
                or 'node-role.kubernetes.io/control-plane' in labels
                else 'worker'
            )
            ready = any(
                c.type == 'Ready' and c.status == 'True'
                for c in (n.status.conditions or [])
            )
            result['nodes'].append({'name': n.metadata.name, 'role': role, 'ready': ready})
    except Exception:
        pass

    try:
        custom = client.CustomObjectsApi(api_client)
        sc = custom.get_namespaced_custom_object(
            group='ocs.openshift.io', version='v1',
            namespace='openshift-storage',
            plural='storageclusters', name='ocs-storagecluster',
        )
        status = sc.get('status', {})
        conditions = status.get('conditions', [])
        result['odf'] = {
            'phase': status.get('phase', 'Unknown'),
            'health': conditions[0].get('message', '') if conditions else '',
        }
    except Exception:
        pass

    try:
        core = client.CoreV1Api(api_client)
        pods = core.list_namespaced_pod(
            'openshift-storage',
            label_selector='app=rook-ceph-osd',
        )
        result['osd_count'] = sum(
            1 for p in pods.items
            if p.status.phase == 'Running'
        )
    except Exception:
        pass

    # Full OCP version from ClusterVersion CR
    try:
        custom = client.CustomObjectsApi(api_client)
        cv = custom.get_cluster_custom_object(
            group='config.openshift.io', version='v1',
            plural='clusterversions', name='version',
        )
        history = cv.get('status', {}).get('history', [])
        result['ocp_full_version'] = (
            history[0].get('version', '') if history
            else cv.get('status', {}).get('desired', {}).get('version', '')
        )
    except Exception:
        pass

    # Full ODF version from CSV in openshift-storage
    try:
        custom = client.CustomObjectsApi(api_client)
        csvs = custom.list_namespaced_custom_object(
            group='operators.coreos.com', version='v1alpha1',
            namespace='openshift-storage', plural='clusterserviceversions',
        )
        for csv in csvs.get('items', []):
            name = csv.get('metadata', {}).get('name', '')
            if any(x in name for x in ['ocs-operator', 'odf-operator']):
                result['odf_full_version'] = csv.get('spec', {}).get('version', name)
                break
    except Exception:
        pass

    # CephCluster capacity (bytes total/used/available + OSD up/in)
    try:
        custom = client.CustomObjectsApi(api_client)
        ccs = custom.list_namespaced_custom_object(
            group='ceph.rook.io', version='v1',
            namespace='openshift-storage', plural='cephclusters',
        )
        if ccs.get('items'):
            ceph_st = ccs['items'][0].get('status', {}).get('ceph', {})
            cap = ceph_st.get('capacity', {})
            result['ceph_capacity'] = {
                'bytes_total': cap.get('bytesTotal', 0),
                'bytes_used': cap.get('bytesUsed', 0),
                'bytes_available': cap.get('bytesAvailable', 0),
                'health': ceph_st.get('health', ''),
            }
            osd_map = ceph_st.get('osdMap', {})
            result['osd_up'] = osd_map.get('osdUp', 0)
            result['osd_in'] = osd_map.get('osdIn', 0)
    except Exception:
        pass

    proxy = getattr(cfg, 'proxy', None)
    result.update(_query_osd_iops(api_url, token, proxy))
    return result


def _sync_query_with_kubeconfig(kubeconfig_str: str) -> dict:
    """Query using a kubeconfig string. Runs in thread pool."""
    from kubernetes import client, config as k8s_config

    kube_dict = yaml.safe_load(kubeconfig_str)
    cfg = client.Configuration()
    k8s_config.load_kube_config_from_dict(kube_dict, client_configuration=cfg)
    cfg.verify_ssl = False

    # load_kube_config_from_dict doesn't populate cfg.proxy from proxy-url —
    # extract and set it manually so IPv6 clusters via squid proxy work
    for cluster_entry in kube_dict.get('clusters', []):
        proxy_url = cluster_entry.get('cluster', {}).get('proxy-url')
        if proxy_url:
            cfg.proxy = proxy_url
            break

    api_client = client.ApiClient(cfg)

    result: dict = {'nodes': [], 'odf': {}, 'osd_count': 0}

    try:
        core = client.CoreV1Api(api_client)
        for n in core.list_node().items:
            labels = n.metadata.labels or {}
            role = (
                'master'
                if 'node-role.kubernetes.io/master' in labels
                or 'node-role.kubernetes.io/control-plane' in labels
                else 'worker'
            )
            ready = any(
                c.type == 'Ready' and c.status == 'True'
                for c in (n.status.conditions or [])
            )
            result['nodes'].append({'name': n.metadata.name, 'role': role, 'ready': ready})
    except Exception:
        pass

    try:
        custom = client.CustomObjectsApi(api_client)
        sc = custom.get_namespaced_custom_object(
            group='ocs.openshift.io', version='v1',
            namespace='openshift-storage',
            plural='storageclusters', name='ocs-storagecluster',
        )
        status = sc.get('status', {})
        conditions = status.get('conditions', [])
        result['odf'] = {
            'phase': status.get('phase', 'Unknown'),
            'health': conditions[0].get('message', '') if conditions else '',
        }
    except Exception:
        pass

    try:
        core = client.CoreV1Api(api_client)
        pods = core.list_namespaced_pod(
            'openshift-storage',
            label_selector='app=rook-ceph-osd',
        )
        result['osd_count'] = sum(
            1 for p in pods.items
            if p.status.phase == 'Running'
        )
    except Exception:
        pass

    # Full OCP version
    try:
        custom = client.CustomObjectsApi(api_client)
        cv = custom.get_cluster_custom_object(
            group='config.openshift.io', version='v1',
            plural='clusterversions', name='version',
        )
        history = cv.get('status', {}).get('history', [])
        result['ocp_full_version'] = (
            history[0].get('version', '') if history
            else cv.get('status', {}).get('desired', {}).get('version', '')
        )
    except Exception:
        pass

    # Full ODF version from CSV
    try:
        custom = client.CustomObjectsApi(api_client)
        csvs = custom.list_namespaced_custom_object(
            group='operators.coreos.com', version='v1alpha1',
            namespace='openshift-storage', plural='clusterserviceversions',
        )
        for csv in csvs.get('items', []):
            name = csv.get('metadata', {}).get('name', '')
            if any(x in name for x in ['ocs-operator', 'odf-operator']):
                result['odf_full_version'] = csv.get('spec', {}).get('version', name)
                break
    except Exception:
        pass

    # CephCluster capacity
    try:
        custom = client.CustomObjectsApi(api_client)
        ccs = custom.list_namespaced_custom_object(
            group='ceph.rook.io', version='v1',
            namespace='openshift-storage', plural='cephclusters',
        )
        if ccs.get('items'):
            ceph_st = ccs['items'][0].get('status', {}).get('ceph', {})
            cap = ceph_st.get('capacity', {})
            result['ceph_capacity'] = {
                'bytes_total': cap.get('bytesTotal', 0),
                'bytes_used': cap.get('bytesUsed', 0),
                'bytes_available': cap.get('bytesAvailable', 0),
                'health': ceph_st.get('health', ''),
            }
            osd_map = ceph_st.get('osdMap', {})
            result['osd_up'] = osd_map.get('osdUp', 0)
            result['osd_in'] = osd_map.get('osdIn', 0)
    except Exception:
        pass

    # OSD throughput from direct Ceph scrape (health check path, separate delta cache)
    result.update(_fetch_ceph_metrics_direct(api_client, cfg, cache_suffix='health'))
    return result


async def fetch_cluster_health(
    console_url: Optional[str] = None,
    kubeadmin_password: Optional[str] = None,
    kubeconfig_url: Optional[str] = None,
) -> Optional[dict]:
    """
    Try to get cluster health data.
    1. Primary: kubeconfig from magna002 — has proxy-url baked in, works for IPv6 clusters.
    2. Fallback: OAuth login via console URL + kubeadmin password (direct API, no proxy).
    """
    loop = asyncio.get_event_loop()

    K8S_TIMEOUT = 30.0  # max wait for k8s API calls — dead clusters hang otherwise

    # --- Primary: kubeconfig from magna002 (contains proxy-url, k8s client uses it) ---
    if kubeconfig_url:
        try:
            async with httpx.AsyncClient(timeout=10.0) as c:
                r = await c.get(kubeconfig_url)
                if r.is_success and 'not available' not in r.text.lower():
                    kubeconfig_text = r.text
                    kube_dict = yaml.safe_load(kubeconfig_text)

                    # Extract proxy and api_url from kubeconfig
                    kube_proxy = None
                    kube_api_url = None
                    for entry in kube_dict.get('clusters', []):
                        c_data = entry.get('cluster', {})
                        kube_proxy = c_data.get('proxy-url')
                        kube_api_url = c_data.get('server')
                        break

                    # Try to get OAuth token — through proxy if present, directly otherwise
                    kube_token = None
                    if kube_api_url and kubeadmin_password:
                        kube_token = await _get_oauth_token(
                            kube_api_url, kubeadmin_password, proxy_url=kube_proxy
                        )

                    if kube_token and kube_api_url:
                        # Use Bearer token path (has Prometheus access) + proxy
                        try:
                            result = await asyncio.wait_for(
                                loop.run_in_executor(
                                    None, _sync_query_with_token,
                                    kube_api_url, kube_token, kube_proxy
                                ),
                                timeout=K8S_TIMEOUT,
                            )
                            if result and result.get('nodes'):
                                return result
                        except (asyncio.TimeoutError, Exception):
                            pass

                    # Fallback: kubeconfig cert auth (no Prometheus IOPS)
                    result = await asyncio.wait_for(
                        loop.run_in_executor(None, _sync_query_with_kubeconfig, kubeconfig_text),
                        timeout=K8S_TIMEOUT,
                    )
                    if result and result.get('nodes'):
                        return result
        except (asyncio.TimeoutError, Exception):
            pass

    # --- Fallback: OAuth (direct connection, works when cluster API is routable) ---
    if console_url and kubeadmin_password:
        domain = _extract_cluster_domain(console_url)
        if domain:
            api_url = f'https://api.{domain}:6443'
            token = await _get_oauth_token(api_url, kubeadmin_password)
            if token:
                try:
                    return await asyncio.wait_for(
                        loop.run_in_executor(None, _sync_query_with_token, api_url, token),
                        timeout=K8S_TIMEOUT,
                    )
                except (asyncio.TimeoutError, Exception):
                    pass

    return None


def _make_k8s_client(kubeconfig_text: str):
    """Load kubeconfig into a k8s ApiClient. Result is cached by api_server_host."""
    from kubernetes import client as k8s_client, config as k8s_config
    kube_dict = yaml.safe_load(kubeconfig_text)
    cfg = k8s_client.Configuration()
    k8s_config.load_kube_config_from_dict(kube_dict, client_configuration=cfg)
    cfg.verify_ssl = False
    for entry in kube_dict.get('clusters', []):
        proxy_url = entry.get('cluster', {}).get('proxy-url')
        if proxy_url:
            cfg.proxy = proxy_url
            break
    return k8s_client.ApiClient(cfg), cfg


def _get_cached_k8s_client(kubeconfig_text: str):
    """Return a cached k8s ApiClient (reused across calls for connection pooling)."""
    import hashlib
    key = hashlib.md5(kubeconfig_text[:200].encode()).hexdigest()
    cached = _K8S_CLIENT_CACHE.get(key)
    if cached and time.monotonic() < cached[2]:
        return cached[0], cached[1]
    api_client, cfg = _make_k8s_client(kubeconfig_text)
    _K8S_CLIENT_CACHE[key] = (api_client, cfg, time.monotonic() + _K8S_CLIENT_TTL)
    return api_client, cfg


def _query_osd_iops_via_prom_proxy(api_client, cfg) -> dict:
    """Get OSD IOPS from Prometheus via k8s API proxy — stable rate[30s], no drops."""
    import json as _json, urllib.parse as _up
    base     = cfg.host.rstrip('/')
    prom_pfx = f"{base}/api/v1/namespaces/openshift-monitoring/services/prometheus-k8s:web/proxy"
    hdrs: dict = {'Accept': 'application/json'}
    try:
        api_client.update_params_for_auth(hdrs, [], ['BearerToken'])
    except Exception:
        pass
    osd_iops: dict = {}
    for op, promql in [('r', 'rate(ceph_osd_op_r[30s])'), ('w', 'rate(ceph_osd_op_w[30s])')]:
        try:
            url  = f"{prom_pfx}/api/v1/query?query={_up.quote(promql)}"
            resp = api_client.rest_client.request('GET', url, headers=hdrs)
            for item in _json.loads(resp.data).get('data', {}).get('result', []):
                daemon = item['metric'].get('ceph_daemon', '')
                if daemon.startswith('osd.'):
                    osd_id = int(daemon.split('.')[1])
                    osd_iops.setdefault(osd_id, {})[op] = int(float(item['value'][1]))
        except Exception:
            pass
    return {'osd_iops': osd_iops} if osd_iops else {}


def _fetch_iops_via_kubeconfig_sync(kubeconfig_text: str) -> dict:
    """Get OSD IOPS (from Prometheus, stable) + throughput (from direct Ceph, real-time)."""
    api_client, cfg = _get_cached_k8s_client(kubeconfig_text)

    # IOPS: Prometheus rate[30s] — stable, no drops, exactly as before
    result = _query_osd_iops_via_prom_proxy(api_client, cfg)

    # Throughput: direct Ceph scrape (mgr + exporter) with delta calculation
    throughput = _fetch_ceph_metrics_direct(api_client, cfg, cache_suffix='iops')
    result.update(throughput)  # adds osd_throughput_mb and pool_throughput_mb

    return result


async def fetch_cluster_iops(
    kubeconfig_url: Optional[str] = None,
    console_url: Optional[str] = None,
    kubeadmin_password: Optional[str] = None,
) -> dict:
    """Fetch OSD IOPS + throughput every 5s via k8s API proxy → Prometheus (kubeconfig auth)."""
    loop = asyncio.get_event_loop()

    # Primary: kubeconfig → k8s API proxy → Prometheus (no OAuth dance)
    if kubeconfig_url:
        try:
            async with httpx.AsyncClient(timeout=10.0) as c:
                r = await c.get(kubeconfig_url)
                if r.is_success and 'not available' not in r.text.lower():
                    result = await asyncio.wait_for(
                        loop.run_in_executor(None, _fetch_iops_via_kubeconfig_sync, r.text),
                        timeout=8.0,
                    )
                    if result:
                        return result
        except Exception:
            pass

    # Fallback: OAuth token → Thanos route (old approach)
    async def _get_iops_oauth(api_url: str, password: str, proxy: Optional[str]) -> dict:
        token = await _get_oauth_token(api_url, password, proxy_url=proxy)
        if not token:
            return {}
        return await asyncio.wait_for(
            loop.run_in_executor(None, _query_osd_iops, api_url, token, proxy),
            timeout=8.0,
        )

    if kubeconfig_url:
        try:
            async with httpx.AsyncClient(timeout=10.0) as c:
                r = await c.get(kubeconfig_url)
                if r.is_success:
                    kube_dict = yaml.safe_load(r.text)
                    kube_proxy, kube_api_url = None, None
                    for entry in kube_dict.get('clusters', []):
                        d = entry.get('cluster', {})
                        kube_proxy = d.get('proxy-url')
                        kube_api_url = d.get('server')
                        break
                    if kube_api_url and kubeadmin_password:
                        result = await _get_iops_oauth(kube_api_url, kubeadmin_password, kube_proxy)
                        if result:
                            return result
        except Exception:
            pass

    if console_url and kubeadmin_password:
        domain = _extract_cluster_domain(console_url)
        if domain:
            try:
                result = await _get_iops_oauth(f'https://api.{domain}:6443', kubeadmin_password, None)
                if result:
                    return result
            except Exception:
                pass

    return {}


def _sync_query_details(api_url: str, token: str) -> dict:
    """Fetch pods + PVCs + node conditions for the detail view. Runs in thread pool."""
    from kubernetes import client

    cfg = client.Configuration()
    cfg.host = api_url
    cfg.verify_ssl = False
    cfg.api_key = {'authorization': f'Bearer {token}'}
    api_client = client.ApiClient(cfg)

    result: dict = {'pods': [], 'pvcs': [], 'nodes_detail': []}

    try:
        core = client.CoreV1Api(api_client)
        pods = core.list_namespaced_pod('openshift-storage')
        for p in pods.items:
            labels = p.metadata.labels or {}
            component = (
                labels.get('app') or
                labels.get('app.kubernetes.io/name') or
                labels.get('rook_ceph_daemon_type') or
                'other'
            )
            result['pods'].append({
                'name': p.metadata.name,
                'component': component,
                'phase': p.status.phase or 'Unknown',
                'node': p.spec.node_name or '',
                'restarts': sum(
                    (cs.restart_count or 0)
                    for cs in (p.status.container_statuses or [])
                ),
                'ready': all(
                    cs.ready for cs in (p.status.container_statuses or [])
                ) if p.status.container_statuses else False,
            })
    except Exception:
        pass

    try:
        core = client.CoreV1Api(api_client)
        pvcs = core.list_namespaced_persistent_volume_claim('openshift-storage')
        for p in pvcs.items:
            result['pvcs'].append({
                'name': p.metadata.name,
                'namespace': p.metadata.namespace,
                'phase': p.status.phase or 'Unknown',
                'capacity': (p.status.capacity or {}).get('storage', ''),
                'storage_class': p.spec.storage_class_name or '',
            })
    except Exception:
        pass

    try:
        core = client.CoreV1Api(api_client)
        nodes = core.list_node()
        for n in nodes.items:
            labels = n.metadata.labels or {}
            role = (
                'master'
                if 'node-role.kubernetes.io/master' in labels
                or 'node-role.kubernetes.io/control-plane' in labels
                else 'worker'
            )
            conditions = {}
            for c in (n.status.conditions or []):
                conditions[c.type] = c.status
            result['nodes_detail'].append({
                'name': n.metadata.name,
                'role': role,
                'ready': conditions.get('Ready') == 'True',
                'conditions': conditions,
                'kernel': (n.status.node_info or {}).kernel_version if n.status.node_info else '',
                'os_image': (n.status.node_info or {}).os_image if n.status.node_info else '',
                'kubelet': (n.status.node_info or {}).kubelet_version if n.status.node_info else '',
            })
    except Exception:
        pass

    return result


async def fetch_cluster_details(
    console_url: Optional[str] = None,
    kubeadmin_password: Optional[str] = None,
    kubeconfig_url: Optional[str] = None,
) -> Optional[dict]:
    """Fetch detailed cluster info (pods, PVCs, node detail)."""
    loop = asyncio.get_event_loop()

    # Primary: kubeconfig from magna002 (has proxy-url)
    if kubeconfig_url:
        try:
            async with httpx.AsyncClient(timeout=10.0) as c:
                r = await c.get(kubeconfig_url)
                if r.is_success and 'not available' not in r.text.lower():
                    kube_dict = yaml.safe_load(r.text)

                    # Build a token-based client using the kubeconfig credentials
                    # by extracting server + proxy and using cert auth
                    cluster_cfg = kube_dict.get('clusters', [{}])[0].get('cluster', {})
                    api_url = cluster_cfg.get('server', '')
                    proxy_url = cluster_cfg.get('proxy-url')

                    if api_url:
                        from kubernetes import client as k8s_client, config as k8s_config
                        cfg = k8s_client.Configuration()
                        k8s_config.load_kube_config_from_dict(kube_dict, client_configuration=cfg)
                        cfg.verify_ssl = False
                        if proxy_url:
                            cfg.proxy = proxy_url

                        def _run():
                            import yaml as _yaml
                            kd = _yaml.safe_load(r.text)
                            return _sync_query_details_with_cfg(cfg)

                        return await asyncio.wait_for(
                            loop.run_in_executor(None, lambda: _sync_query_details_with_cfg(cfg)),
                            timeout=30.0,
                        )
        except (asyncio.TimeoutError, Exception):
            pass

    # Fallback: OAuth token
    if console_url and kubeadmin_password:
        domain = _extract_cluster_domain(console_url)
        if domain:
            api_url = f'https://api.{domain}:6443'
            token = await _get_oauth_token(api_url, kubeadmin_password)
            if token:
                try:
                    return await asyncio.wait_for(
                        loop.run_in_executor(None, _sync_query_details, api_url, token),
                        timeout=30.0,
                    )
                except (asyncio.TimeoutError, Exception):
                    pass

    return None


def _sync_query_details_with_cfg(cfg) -> dict:
    """Like _sync_query_details but takes a pre-built Configuration."""
    from kubernetes import client

    api_client = client.ApiClient(cfg)
    result: dict = {'pods': [], 'pvcs': [], 'nodes_detail': []}

    try:
        core = client.CoreV1Api(api_client)
        for p in core.list_namespaced_pod('openshift-storage').items:
            labels = p.metadata.labels or {}
            pod_name = p.metadata.name
            # Match by pod name first — most reliable for ODF components
            KEYWORDS = [
                'rook-ceph-mon', 'rook-ceph-osd', 'rook-ceph-mgr', 'rook-ceph-mds',
                'rook-ceph-rgw', 'rook-ceph-crashcollector', 'rook-ceph-exporter',
                'rook-ceph-tools', 'rook-ceph-operator',
                'csi-cephfsplugin', 'csi-rbdplugin',
                'odf-operator', 'noobaa', 'ux-backend',
            ]
            component = next((k for k in KEYWORDS if k in pod_name), None)
            if not component:
                component = labels.get('app') or labels.get('app.kubernetes.io/name', 'other')
            result['pods'].append({
                'name': pod_name,
                'component': component,
                'phase': p.status.phase or 'Unknown',
                'node': p.spec.node_name or '',
                'restarts': sum(
                    (cs.restart_count or 0) for cs in (p.status.container_statuses or [])
                ),
                'ready': all(
                    cs.ready for cs in (p.status.container_statuses or [])
                ) if p.status.container_statuses else False,
            })
    except Exception:
        pass

    try:
        core = client.CoreV1Api(api_client)
        for p in core.list_namespaced_persistent_volume_claim('openshift-storage').items:
            result['pvcs'].append({
                'name': p.metadata.name,
                'namespace': p.metadata.namespace,
                'phase': p.status.phase or 'Unknown',
                'capacity': (p.status.capacity or {}).get('storage', ''),
                'storage_class': p.spec.storage_class_name or '',
            })
    except Exception:
        pass

    try:
        core = client.CoreV1Api(api_client)
        for n in core.list_node().items:
            labels = n.metadata.labels or {}
            role = (
                'master'
                if 'node-role.kubernetes.io/master' in labels
                or 'node-role.kubernetes.io/control-plane' in labels
                else 'worker'
            )
            conditions = {c.type: c.status for c in (n.status.conditions or [])}
            info = n.status.node_info
            result['nodes_detail'].append({
                'name': n.metadata.name,
                'role': role,
                'ready': conditions.get('Ready') == 'True',
                'conditions': conditions,
                'kernel': info.kernel_version if info else '',
                'os_image': info.os_image if info else '',
                'kubelet': info.kubelet_version if info else '',
            })
    except Exception:
        pass

    return result


def _parse_topology(platform_conf: str) -> tuple[int, int]:
    """Extract (masters, workers) from a platform conf filename."""
    m = re.search(r'(\d+)m[_-](\d+)w', platform_conf)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r'(\d+)m[_-]0w', platform_conf)
    if m:
        return int(m.group(1)), 0
    return 3, 3
