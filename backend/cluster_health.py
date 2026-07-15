"""
Cluster health queries via OCP API.

Primary path: OAuth login with kubeadmin credentials (works from any machine
that can reach the cluster API — no kubeconfig file or magna002 needed).

Fallback: download kubeconfig from magna002 (works when running on company LAN).
"""
import asyncio
import re
from typing import Optional

import httpx
import yaml


def _extract_cluster_domain(console_url: str) -> Optional[str]:
    """console-openshift-console.apps.CLUSTER.DOMAIN → CLUSTER.DOMAIN"""
    m = re.search(r'\.apps\.(.+)$', console_url.rstrip('/'))
    return m.group(1) if m else None


async def _get_oauth_token(api_url: str, password: str, proxy_url: Optional[str] = None) -> Optional[str]:
    """Get a Bearer token via OCP OAuth using kubeadmin credentials."""
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
                return m.group(1)
        except Exception:
            pass
    return None


def _query_osd_iops(api_url: str, token: str, proxy_url: Optional[str] = None) -> dict:
    """Query Thanos external route for per-OSD IOPS via squid proxy + OAuth token."""
    import urllib.parse as _up

    cluster_domain = api_url.replace('https://api.', '').replace(':6443', '')
    thanos = f"https://thanos-querier-openshift-monitoring.apps.{cluster_domain}/api/v1/query"
    headers = {'Authorization': f'Bearer {token}'}

    osd_iops: dict = {}
    try:
        for op, metric in [('r', 'ceph_osd_op_r'), ('w', 'ceph_osd_op_w')]:
            query = _up.quote(f'irate({metric}[15s])')
            with httpx.Client(verify=False, proxy=proxy_url, timeout=5) as c:
                r = c.get(f"{thanos}?query={query}", headers=headers)
                data = r.json()
            for item in data.get('data', {}).get('result', []):
                daemon = item['metric'].get('ceph_daemon', '')
                if daemon.startswith('osd.'):
                    osd_id = int(daemon.split('.')[1])
                    osd_iops.setdefault(osd_id, {})
                    osd_iops[osd_id][op] = int(float(item['value'][1]))
    except Exception:
        return {}
    return {'osd_iops': osd_iops} if osd_iops else {}


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

    # IOPS: kubeconfig path has no token; Prometheus requires OAuth. Skip here —
    # fetch_cluster_health tries OAuth+proxy first and calls _sync_query_with_token.
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
