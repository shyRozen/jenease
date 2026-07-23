"""
Kubernetes operations for Jenease workloads.

Creates namespaces, PVCs, and pods for RBD / CephFS / NooBaa I/O workloads,
streams pod logs back as an async generator, and cleans up on delete.
"""
import asyncio
import json
import re
import threading
import time
from typing import AsyncGenerator, Optional

import httpx
import yaml

# ── constants ────────────────────────────────────────────────────────────────

STORAGE_CLASSES = {
    "rbd":    "ocs-storagecluster-ceph-rbd",
    "cephfs": "ocs-storagecluster-cephfs",
}
ACCESS_MODES = {
    "rbd":    "ReadWriteOnce",
    "cephfs": "ReadWriteMany",
}

# fio --rw value for each (mode, pattern) combination
FIO_RW = {
    ("write",     "sequential"): "write",
    ("write",     "random"):     "randwrite",
    ("read",      "sequential"): "read",
    ("read",      "random"):     "randread",
    ("readwrite", "sequential"): "readwrite",
    ("readwrite", "random"):     "randrw",
}
BLOCK_SIZE  = {"sequential": "1m",  "random": "4k"}
IODEPTH     = {"sequential": 32,    "random": 64}
NUMJOBS     = 4

IO_IMAGE     = "quay.io/ocsci/nginx:latest"   # Alpine + fio 3.41 pre-installed
NOOBAA_IMAGE = "registry.access.redhat.com/ubi9/python-311:latest"

# Bash snippet prepended to pod command when sync mode is enabled.
# Pod reads its own namespace's jenease-sync ConfigMap via the k8s API using
# the mounted service-account token (available by default on OpenShift).
# Shared sync groups: sync_id → {expected, ready, lock, namespaces, kubeconfig_url}
_SYNC_GROUPS: dict[str, dict] = {}

# Protects load_kube_config_from_dict — that call mutates global k8s state, so
# concurrent calls from multiple threads produce a race that corrupts some configs.
_K8S_LOAD_LOCK = threading.Lock()


SYNC_POLL_CMD = (
    "echo '[jenease] Waiting for sync signal…' && "
    "until [ -f /tmp/jenease-start ]; do sleep 1; done && "
    "echo '[jenease] ✓ All pods ready — starting IO' && "
)

PROGRESS_RE = re.compile(r"\[(\d+\.?\d*)%\]")
RATE_RE      = re.compile(r"\[(?:r|w|rw)=([^\]]+)\]")
ETA_RE       = re.compile(r"\[eta\s+([^\]]+)\]")

# Python IO script — fsync per chunk so writes commit to Ceph immediately
_IO_SCRIPT = """
import os, sys, time, random

SIZE_GB  = int(os.environ.get('SIZE_GB', '1'))
MODE     = os.environ.get('MODE', 'write')
PATTERN  = os.environ.get('PATTERN', 'sequential')
PATH     = '/data/testfile'

size_bytes   = SIZE_GB * 1024 * 1024 * 1024
chunk_bytes  = 4 * 1024 * 1024   # 4MB chunks
total_chunks = size_bytes // chunk_bytes

def run_io(op, chunks):
    label  = 'WRITE' if op == 'write' else 'READ'
    rwtag  = 'w'     if op == 'write' else 'r'
    wchunk = b'\\x00' * chunk_bytes
    start  = time.time()
    last   = start
    done   = 0
    flags  = os.O_WRONLY | os.O_CREAT if op == 'write' else os.O_RDONLY
    SYNC_EVERY = 16   # fsync every 64MB (16 × 4MB chunks)
    fd     = os.open(PATH, flags, 0o644)
    try:
        for i, pos in enumerate(chunks):
            os.lseek(fd, pos * chunk_bytes, os.SEEK_SET)
            if op == 'write':
                os.write(fd, wchunk)
                if (i + 1) % SYNC_EVERY == 0:
                    os.fsync(fd)      # commit to Ceph every 64MB
            else:
                os.read(fd, chunk_bytes)
            done += chunk_bytes
            now = time.time()
            if now - last >= 1.0 or i == len(chunks) - 1:
                pct    = (i + 1) / len(chunks) * 100
                rate   = done / max(0.001, now - start) / 1048576
                eta_s  = int((len(chunks) - i - 1) / max(1, (i + 1) / max(0.001, now - start)))
                eta    = f'{eta_s // 60}m{eta_s % 60:02d}s' if eta_s > 60 else f'{eta_s}s'
                print(f'[{label}][{pct:.1f}%][{rwtag}={rate:.0f}MB/s][eta {eta}]', flush=True)
                last = now
        if op == 'write':
            os.fsync(fd)  # final flush
    finally:
        os.close(fd)

seqs   = list(range(total_chunks))
chunks = seqs if PATTERN == 'sequential' else random.sample(seqs, len(seqs))

if MODE in ('write', 'readwrite'):
    print(f'[jenease] Starting {SIZE_GB}GB {PATTERN} write...', flush=True)
    run_io('write', chunks)
    print('[jenease] Write complete.', flush=True)

if MODE in ('read', 'readwrite'):
    rchunks = seqs if PATTERN == 'sequential' else random.sample(seqs, len(seqs))
    print(f'[jenease] Starting {SIZE_GB}GB {PATTERN} read...', flush=True)
    run_io('read', rchunks)
    print('[jenease] Read complete.', flush=True)

print('[jenease] Workload complete.', flush=True)
"""

# NooBaa boto3 script injected via pod command
_NOOBAA_SCRIPT = """
import boto3, os, time, threading
import urllib3; urllib3.disable_warnings()

endpoint  = os.environ["S3_ENDPOINT"]
key_id    = os.environ["ACCESS_KEY"]
secret    = os.environ["SECRET_KEY"]
bucket    = os.environ["BUCKET_NAME"]
size_gb      = int(os.environ.get("SIZE_GB", "1"))
mode         = os.environ.get("MODE", "write")
WORKERS      = int(os.environ.get("WORKERS", "8"))
OBJ_SIZE     = int(os.environ.get("OBJ_SIZE_MB", "64")) * 1024 * 1024
total_objs   = max(1, size_gb * 1024 * 1024 * 1024 // OBJ_SIZE)
chunk        = b"x" * OBJ_SIZE

def make_s3():
    return boto3.client("s3", endpoint_url=endpoint,
                        aws_access_key_id=key_id, aws_secret_access_key=secret,
                        verify=False)

s3 = make_s3()
try:
    s3.create_bucket(Bucket=bucket)
except Exception:
    pass

def run_io(op):
    label   = "WRITE" if op == "write" else "READ"
    rwtag   = "w"     if op == "write" else "r"
    start   = time.time()
    done    = [0]
    lock    = threading.Lock()
    last_p  = [start]

    def worker(client, indices):
        for i in indices:
            if op == "write":
                client.put_object(Bucket=bucket, Key=f"obj-{i:06d}", Body=chunk)
            else:
                client.get_object(Bucket=bucket, Key=f"obj-{i:06d}")["Body"].read()
            with lock:
                done[0] += 1
                now = time.time()
                if now - last_p[0] >= 1.0 or done[0] == total_objs:
                    pct   = done[0] / total_objs * 100
                    mb    = done[0] * OBJ_SIZE / 1024 / 1024
                    rate  = mb / max(0.001, now - start)
                    eta_s = int((total_objs - done[0]) * OBJ_SIZE / 1024 / 1024 / max(0.001, rate))
                    eta   = f"{eta_s // 60}m{eta_s % 60:02d}s" if eta_s > 60 else f"{eta_s}s"
                    print(f"[{label}][{pct:.1f}%][{rwtag}={rate:.0f}MB/s][eta {eta}]", flush=True)
                    last_p[0] = now

    # Split work across workers
    per = [list(range(i, total_objs, WORKERS)) for i in range(WORKERS)]
    clients = [make_s3() for _ in range(WORKERS)]
    threads = [threading.Thread(target=worker, args=(clients[i], per[i])) for i in range(WORKERS)]
    for t in threads: t.start()
    for t in threads: t.join()

if mode in ("write", "readwrite"):
    print(f"[jenease] Writing {size_gb}GB ({total_objs} × {OBJ_SIZE//1024//1024}MB, {WORKERS} workers)...", flush=True)
    run_io("write")
    print("[jenease] Write complete.", flush=True)

if mode in ("read", "readwrite"):
    print(f"[jenease] Reading {size_gb}GB ({total_objs} × {OBJ_SIZE//1024//1024}MB, {WORKERS} workers)...", flush=True)
    run_io("read")
    print("[jenease] Read complete.", flush=True)

print("[jenease] Workload complete.", flush=True)
"""


# ── kubeconfig helpers ────────────────────────────────────────────────────────

_KUBECONFIG_CONTENT_CACHE: dict[str, tuple[dict, float]] = {}
_KUBECONFIG_CONTENT_TTL = 3600  # 1 hour


def _sync_load_k8s(kubeconfig_url: str):
    """Download kubeconfig and return (CoreV1Api, CustomObjectsApi, cfg). Content cached 1h."""
    from kubernetes import client, config as k8s_config

    cached = _KUBECONFIG_CONTENT_CACHE.get(kubeconfig_url)
    if cached and time.time() - cached[1] < _KUBECONFIG_CONTENT_TTL:
        kube_dict = cached[0]
    else:
        r = httpx.get(kubeconfig_url, timeout=10.0)
        r.raise_for_status()
        kube_dict = yaml.safe_load(r.text)
        _KUBECONFIG_CONTENT_CACHE[kubeconfig_url] = (kube_dict, time.time())

    with _K8S_LOAD_LOCK:
        k8s_config.load_kube_config_from_dict(kube_dict)
        cfg = client.Configuration.get_default_copy()

    for entry in kube_dict.get("clusters", []):
        proxy_url = (entry.get("cluster") or {}).get("proxy-url")
        if proxy_url:
            cfg.proxy = proxy_url
            break

    api_client = client.ApiClient(cfg)
    return client.CoreV1Api(api_client), client.CustomObjectsApi(api_client), cfg, api_client


# ── workload creation ─────────────────────────────────────────────────────────

def _sync_create_io_workload(
    kubeconfig_url: str,
    namespace: str,
    pvc_name: str,
    pod_name: str,
    workload_type: str,
    size_gb: int,
    mode: str,
    pattern: str,
    block_size: str = "1m",
    num_jobs: int = 4,
    iodepth: int = 32,
    duration_sec: int = 0,
    engine: str = "libaio",
    direct: bool = True,
):
    from kubernetes import client

    core, _, _, api_client = _sync_load_k8s(kubeconfig_url)

    sc          = STORAGE_CLASSES[workload_type]
    access_mode = ACCESS_MODES[workload_type]

    import base64 as _b64  # noqa: F401 (kept for NooBaa)
    rbac = client.RbacAuthorizationV1Api(api_client)

    # Namespace
    try:
        core.create_namespace(client.V1Namespace(
            metadata=client.V1ObjectMeta(name=namespace)
        ))
    except Exception:
        pass

    # Grant anyuid SCC so the pod can run as root and write to the PVC
    try:
        rbac.create_namespaced_role_binding(
            namespace,
            client.V1RoleBinding(
                metadata=client.V1ObjectMeta(name="jenease-anyuid", namespace=namespace),
                subjects=[client.V1Subject(kind="ServiceAccount", name="default", namespace=namespace)],
                role_ref=client.V1RoleRef(
                    api_group="rbac.authorization.k8s.io",
                    kind="ClusterRole",
                    name="system:openshift:scc:anyuid",
                ),
            ),
        )
    except Exception:
        pass

    # PVC
    core.create_namespaced_persistent_volume_claim(
        namespace,
        client.V1PersistentVolumeClaim(
            metadata=client.V1ObjectMeta(name=pvc_name),
            spec=client.V1PersistentVolumeClaimSpec(
                access_modes=[access_mode],
                storage_class_name=sc,
                resources=client.V1ResourceRequirements(
                    requests={"storage": f"{size_gb}Gi"}
                ),
            ),
        ),
    )

    fio_rw     = FIO_RW.get((mode, pattern), "write")
    per_job_gb = max(1, size_gb // num_jobs)

    duration_desc = f"{duration_sec}s" if duration_sec > 0 else f"{per_job_gb}GB"
    prefill = ""
    if mode == "read":
        mb = size_gb * 1024
        prefill = (
            f"echo '[jenease] Pre-filling {size_gb}GB for read workload...' && "
            f"dd if=/dev/zero of=/data/testfile bs=64M count={mb // 64 + 1} 2>&1 | "
            f"grep -v '^$' | while IFS= read -r l; do echo \"[PREFILL] $l\"; done && "
        )

    time_flags = f"--time_based --runtime={duration_sec}" if duration_sec > 0 else ""
    direct_flag = "--direct=1" if direct else ""

    fio_cmd = (
        f"fio --name=jenease --ioengine={engine} {direct_flag} "
        f"--bs={block_size} --numjobs={num_jobs} --iodepth={iodepth} --rw={fio_rw} "
        f"--size={per_job_gb}g {time_flags} "
        f"--filename=/data/testfile --fallocate=none "
        f"--status-interval=2 --group_reporting"
    ).strip()

    # With --direct=1, fio runs in non-TTY (pipe) mode and buffers stdout in 8KB chunks.
    # Status-interval lines accumulate in the buffer and only flush on job exit.
    # Wrapping in `script -q -c '...' /dev/null` forces a pseudo-TTY so fio uses
    # line-buffered output and compact status format ([w=...MiB/s]) visible in real-time.
    if direct_flag:
        wrapped_fio = f"script -q -c '{fio_cmd}' /dev/null 2>&1"
    else:
        wrapped_fio = f"{fio_cmd} 2>&1"

    cmd = (
        f"echo '[jenease] Starting fio ({fio_rw}, bs={block_size}, {num_jobs} jobs × {duration_desc}, iodepth={iodepth}, engine={engine})...' && "
        f"{prefill}"
        f"{wrapped_fio} && "
        f"echo '[jenease] Workload complete.'"
    )

    core.create_namespaced_pod(
        namespace,
        client.V1Pod(
            metadata=client.V1ObjectMeta(name=pod_name, namespace=namespace),
            spec=client.V1PodSpec(
                restart_policy="Never",
                security_context=client.V1PodSecurityContext(run_as_user=0, run_as_group=0, fs_group=0),
                containers=[
                    client.V1Container(
                        name="io",
                        image=IO_IMAGE,
                        command=["/bin/bash", "-c", cmd],
                        env=[
                            client.V1EnvVar(name="SIZE_GB", value=str(size_gb)),
                        ],
                        security_context=client.V1SecurityContext(
                            run_as_user=0,
                            allow_privilege_escalation=False,
                        ),
                        volume_mounts=[
                            client.V1VolumeMount(name="data", mount_path="/data")
                        ],
                    )
                ],
                volumes=[
                    client.V1Volume(
                        name="data",
                        persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(
                            claim_name=pvc_name
                        ),
                    )
                ],
            ),
        ),
    )
    api_client.close()


def _sync_create_noobaa_workload(
    kubeconfig_url: str,
    namespace: str,
    pvc_name: str,   # used as OBC name
    pod_name: str,
    size_gb: int,
    mode: str,
    obj_size_mb: int = 64,
    workers: int = 8,
):
    from kubernetes import client

    core, custom, _, api_client = _sync_load_k8s(kubeconfig_url)

    # Namespace
    try:
        core.create_namespace(client.V1Namespace(
            metadata=client.V1ObjectMeta(name=namespace)
        ))
    except Exception:
        pass

    # ObjectBucketClaim
    obc_name = pvc_name
    custom.create_namespaced_custom_object(
        group="objectbucket.io", version="v1alpha1",
        namespace=namespace, plural="objectbucketclaims",
        body={
            "apiVersion": "objectbucket.io/v1alpha1",
            "kind": "ObjectBucketClaim",
            "metadata": {"name": obc_name, "namespace": namespace},
            "spec": {
                "generateBucketName": "jenease-bucket",
                "storageClassName": "openshift-storage.noobaa.io",
            },
        },
    )

    # Wait for OBC to be bound (up to 120s)
    for _ in range(60):
        time.sleep(2)
        try:
            obc = custom.get_namespaced_custom_object(
                group="objectbucket.io", version="v1alpha1",
                namespace=namespace, plural="objectbucketclaims", name=obc_name,
            )
            if obc.get("status", {}).get("phase") == "Bound":
                break
        except Exception:
            pass

    # Read credentials from Secret and ConfigMap
    secret = core.read_namespaced_secret(obc_name, namespace)
    cm     = core.read_namespaced_config_map(obc_name, namespace)

    import base64
    def _decode(v):
        return base64.b64decode(v).decode() if v else ""

    access_key = _decode(secret.data.get("AWS_ACCESS_KEY_ID", ""))
    secret_key = _decode(secret.data.get("AWS_SECRET_ACCESS_KEY", ""))
    bucket_name = cm.data.get("BUCKET_NAME", "jenease-bucket")
    bucket_host = cm.data.get("BUCKET_HOST", "s3.openshift-storage.svc")
    bucket_port = cm.data.get("BUCKET_PORT", "80")
    protocol    = "https" if bucket_port in ("443", "8443") else "http"
    s3_endpoint = f"{protocol}://{bucket_host}:{bucket_port}"

    script_cmd = (
        "pip install boto3 --quiet 2>/dev/null && "
        "echo '" + __import__('base64').b64encode(_NOOBAA_SCRIPT.encode()).decode() + "' | base64 -d | python3"
    )

    core.create_namespaced_pod(
        namespace,
        client.V1Pod(
            metadata=client.V1ObjectMeta(name=pod_name, namespace=namespace),
            spec=client.V1PodSpec(
                restart_policy="Never",
                containers=[
                    client.V1Container(
                        name="noobaa-io",
                        image=NOOBAA_IMAGE,
                        command=["/bin/bash", "-c", script_cmd],
                        env=[
                            client.V1EnvVar(name="S3_ENDPOINT",  value=s3_endpoint),
                            client.V1EnvVar(name="ACCESS_KEY",   value=access_key),
                            client.V1EnvVar(name="SECRET_KEY",   value=secret_key),
                            client.V1EnvVar(name="BUCKET_NAME",  value=bucket_name),
                            client.V1EnvVar(name="SIZE_GB",      value=str(size_gb)),
                            client.V1EnvVar(name="MODE",         value=mode),
                            client.V1EnvVar(name="OBJ_SIZE_MB",  value=str(obj_size_mb)),
                            client.V1EnvVar(name="WORKERS",      value=str(workers)),
                        ],
                    )
                ],
            ),
        ),
    )
    api_client.close()


async def create_workload(
    kubeconfig_url: str,
    namespace: str,
    pvc_name: str,
    pod_name: str,
    workload_type: str,
    size_gb: int,
    mode: str,
    pattern: str,
    block_size: str = "1m",
    num_jobs: int = 4,
    iodepth: int = 32,
    duration_sec: int = 0,
    obj_size_mb: int = 64,
    workers: int = 8,
    engine: str = "libaio",
    direct: bool = True,
):
    loop = asyncio.get_event_loop()
    if workload_type == "noobaa":
        await asyncio.wait_for(
            loop.run_in_executor(None, _sync_create_noobaa_workload,
                kubeconfig_url, namespace, pvc_name, pod_name,
                size_gb, mode, obj_size_mb, workers),
            timeout=180.0,
        )
    else:
        await asyncio.wait_for(
            loop.run_in_executor(None, _sync_create_io_workload,
                kubeconfig_url, namespace, pvc_name, pod_name,
                workload_type, size_gb, mode, pattern,
                block_size, num_jobs, iodepth, duration_sec, engine, direct),
            timeout=120.0,
        )


# ── pod status ────────────────────────────────────────────────────────────────

def _sync_get_pod_phase(kubeconfig_url: str, namespace: str, pod_name: str) -> str:
    try:
        core, _, _, api_client = _sync_load_k8s(kubeconfig_url)
        pod = core.read_namespaced_pod(name=pod_name, namespace=namespace)
        api_client.close()
        return pod.status.phase or "Pending"
    except Exception:
        return "Unknown"


async def get_pod_phase(kubeconfig_url: str, namespace: str, pod_name: str) -> str:
    loop = asyncio.get_event_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(None, _sync_get_pod_phase, kubeconfig_url, namespace, pod_name),
            timeout=15.0,
        )
    except Exception:
        return "Unknown"


# ── namespace deletion ────────────────────────────────────────────────────────

def _sync_delete_namespace(kubeconfig_url: str, namespace: str):
    from kubernetes import client
    core, custom, _, api_client = _sync_load_k8s(kubeconfig_url)

    # Remove finalizers from any OBCs so NooBaa doesn't block namespace deletion
    try:
        obcs = custom.list_namespaced_custom_object(
            group="objectbucket.io", version="v1alpha1",
            namespace=namespace, plural="objectbucketclaims",
        )
        for obc in obcs.get("items", []):
            name = obc["metadata"]["name"]
            custom.patch_namespaced_custom_object(
                group="objectbucket.io", version="v1alpha1",
                namespace=namespace, plural="objectbucketclaims", name=name,
                body={"metadata": {"finalizers": []}},
            )
    except Exception:
        pass

    try:
        core.delete_namespace(namespace, body=client.V1DeleteOptions(grace_period_seconds=0))
    except Exception:
        pass
    api_client.close()


async def delete_workload_namespace(kubeconfig_url: str, namespace: str):
    loop = asyncio.get_event_loop()
    await asyncio.wait_for(
        loop.run_in_executor(None, _sync_delete_namespace, kubeconfig_url, namespace),
        timeout=30.0,
    )


async def stream_cleanup(
    kubeconfig_url: str,
    namespace: str,
    pod_name: str = "",
    pvc_name: str = "",
) -> AsyncGenerator[str, None]:
    """Async generator: deletes pod → PVC → namespace, yielding progress lines."""
    loop = asyncio.get_event_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def _do_cleanup():
        from kubernetes import client as _k8s

        def _put(msg):
            loop.call_soon_threadsafe(queue.put_nowait, msg)

        try:
            core, custom, _, api_client = _sync_load_k8s(kubeconfig_url)

            # 1. Delete pod (stops IO and releases RBD lock)
            if pod_name:
                _put(f"[jenease] Deleting pod {pod_name}…")
                try:
                    core.delete_namespaced_pod(
                        pod_name, namespace,
                        body=_k8s.V1DeleteOptions(grace_period_seconds=0),
                    )
                    _put("[jenease] Pod deleted.")
                except Exception as e:
                    if "404" in str(e) or "NotFound" in str(e):
                        _put("[jenease] Pod already gone.")
                    else:
                        _put(f"[jenease] Pod: {e}")

            # 2. Remove OBC finalizers (NooBaa) so PVC/namespace don't get stuck
            try:
                obcs = custom.list_namespaced_custom_object(
                    group="objectbucket.io", version="v1alpha1",
                    namespace=namespace, plural="objectbucketclaims",
                )
                for obc in obcs.get("items", []):
                    obc_name = obc["metadata"]["name"]
                    _put(f"[jenease] Removing OBC finalizers ({obc_name})…")
                    custom.patch_namespaced_custom_object(
                        group="objectbucket.io", version="v1alpha1",
                        namespace=namespace, plural="objectbucketclaims", name=obc_name,
                        body={"metadata": {"finalizers": []}},
                    )
            except Exception:
                pass

            # 3. Delete PVC (Ceph reclaims the volume)
            if pvc_name:
                _put(f"[jenease] Deleting PVC {pvc_name}…")
                try:
                    core.delete_namespaced_persistent_volume_claim(pvc_name, namespace)
                    _put("[jenease] PVC deleted.")
                except Exception as e:
                    if "404" in str(e) or "NotFound" in str(e):
                        _put("[jenease] PVC already gone.")
                    else:
                        _put(f"[jenease] PVC: {e}")

            # 4. Delete namespace
            _put(f"[jenease] Deleting namespace {namespace}…")
            try:
                core.delete_namespace(namespace, body=_k8s.V1DeleteOptions(grace_period_seconds=0))
            except Exception as e:
                if "404" not in str(e) and "NotFound" not in str(e):
                    _put(f"[jenease] Namespace: {e}")
            _put("[jenease] Cleanup complete.")

            api_client.close()
        except Exception as e:
            _put(f"[error] Cleanup failed: {e}")
            _put("[jenease] Cleanup complete.")
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    thread = threading.Thread(target=_do_cleanup, daemon=True)
    thread.start()

    while True:
        line = await queue.get()
        if line is None:
            break
        yield line


# ── log streaming ─────────────────────────────────────────────────────────────

async def stream_pod_logs(
    kubeconfig_url: str,
    namespace: str,
    pod_name: str,
) -> AsyncGenerator[str, None]:
    """Async generator that yields log lines from a running/completed pod."""
    loop = asyncio.get_event_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def _reader():
        try:
            core, _, _, api_client = _sync_load_k8s(kubeconfig_url)

            # Wait up to 10 min for pod to be Running (image pulls can be slow)
            for _ in range(300):
                try:
                    pod = core.read_namespaced_pod(name=pod_name, namespace=namespace)
                    phase = pod.status.phase or ""

                    # Check if container is actually running (not just pod phase)
                    cs_list = pod.status.container_statuses or []
                    container_running = any(
                        cs.state and cs.state.running for cs in cs_list
                    )

                    if container_running or phase in ("Succeeded", "Failed"):
                        break

                    if phase in ("Pending", "Running"):
                        detail = None
                        for cs in cs_list:
                            if cs.state and cs.state.waiting:
                                w = cs.state.waiting
                                detail = w.reason or detail
                                if w.message:
                                    detail = f"{w.reason}: {w.message[:80]}"
                        if not detail:
                            detail = next(
                                (c.reason for c in (pod.status.conditions or []) if c.reason),
                                "waiting for PVC to provision…",
                            )
                        msg = f"[jenease] Pod pending — {detail}"
                        loop.call_soon_threadsafe(queue.put_nowait, msg)
                except Exception:
                    pass
                time.sleep(2)

            # Check final pod phase to decide how to stream
            try:
                pod = core.read_namespaced_pod(name=pod_name, namespace=namespace)
                final_phase = pod.status.phase or ""
            except Exception:
                final_phase = ""

            # Stream logs — retry on 400 (container not ready race)
            for attempt in range(5):
                try:
                    follow = final_phase not in ("Succeeded", "Failed")
                    response = core.read_namespaced_pod_log(
                        name=pod_name, namespace=namespace,
                        follow=follow, _preload_content=False,
                    )
                    for chunk in response:
                        for line in chunk.decode("utf-8", errors="replace").splitlines():
                            if line.strip():
                                loop.call_soon_threadsafe(queue.put_nowait, line)
                    break
                except Exception as e:
                    if attempt < 4 and ("400" in str(e) or "ContainerCreating" in str(e)):
                        loop.call_soon_threadsafe(
                            queue.put_nowait, "[jenease] Container starting, retrying log stream…"
                        )
                        time.sleep(3)
                    else:
                        loop.call_soon_threadsafe(queue.put_nowait, f"[error] Log stream: {e}")
                        break

            api_client.close()
        except Exception as e:
            loop.call_soon_threadsafe(queue.put_nowait, f"[error] {e}")
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)  # sentinel

    thread = threading.Thread(target=_reader, daemon=True)
    thread.start()

    while True:
        line = await queue.get()
        if line is None:
            break
        yield line


async def create_and_stream_workload(
    kubeconfig_url: str,
    namespace: str,
    pvc_name: str,
    pod_name: str,
    workload_type: str,
    size_gb: int,
    mode: str,
    pattern: str,
    block_size: str = "1m",
    num_jobs: int = 4,
    iodepth: int = 32,
    duration_sec: int = 0,
    obj_size_mb: int = 64,
    workers: int = 8,
    engine: str = "libaio",
    direct: bool = True,
    synced: bool = False,
    sync_id: str = "",
    node_name: str = "",
    **_extra,  # absorb unknown keys from _PENDING_PARAMS
) -> AsyncGenerator[str, None]:
    """Create k8s resources with per-step status messages, then stream pod logs."""
    loop = asyncio.get_event_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def _run():
        try:
            from kubernetes import client

            def emit(msg: str):
                loop.call_soon_threadsafe(queue.put_nowait, msg)

            # ── Connect ──────────────────────────────────────────────────────
            emit("[jenease] Connecting to cluster…")
            core, _, _, api_client = _sync_load_k8s(kubeconfig_url)
            rbac = client.RbacAuthorizationV1Api(api_client)
            emit("[jenease] ✓ Connected")

            # ── Namespace ────────────────────────────────────────────────────
            emit(f"[jenease] Creating namespace {namespace}…")
            try:
                core.create_namespace(client.V1Namespace(
                    metadata=client.V1ObjectMeta(name=namespace)
                ))
            except Exception:
                pass  # already exists
            emit(f"[jenease] ✓ Namespace {namespace} ready")

            # ── SCC ──────────────────────────────────────────────────────────
            try:
                rbac.create_namespaced_role_binding(
                    namespace,
                    client.V1RoleBinding(
                        metadata=client.V1ObjectMeta(name="jenease-anyuid", namespace=namespace),
                        subjects=[client.V1Subject(kind="ServiceAccount", name="default", namespace=namespace)],
                        role_ref=client.V1RoleRef(
                            api_group="rbac.authorization.k8s.io",
                            kind="ClusterRole",
                            name="system:openshift:scc:anyuid",
                        ),
                    ),
                )
            except Exception:
                pass

            # ── PVC / OBC + Pod ─────────────────────────────────────────────
            if workload_type == "noobaa":
                # OBC
                custom = client.CustomObjectsApi(api_client)
                emit(f"[jenease] Creating OBC {pvc_name} (NooBaa bucket)…")
                custom.create_namespaced_custom_object(
                    group="objectbucket.io", version="v1alpha1",
                    namespace=namespace, plural="objectbucketclaims",
                    body={
                        "apiVersion": "objectbucket.io/v1alpha1",
                        "kind": "ObjectBucketClaim",
                        "metadata": {"name": pvc_name, "namespace": namespace},
                        "spec": {
                            "generateBucketName": "jenease-bucket",
                            "storageClassName": "openshift-storage.noobaa.io",
                        },
                    },
                )
                # Wait for OBC Bound
                emit(f"[jenease] Waiting for OBC {pvc_name} to bind…")
                for _i in range(60):
                    time.sleep(2)
                    try:
                        obc = custom.get_namespaced_custom_object(
                            group="objectbucket.io", version="v1alpha1",
                            namespace=namespace, plural="objectbucketclaims", name=pvc_name,
                        )
                        if obc.get("status", {}).get("phase") == "Bound":
                            break
                    except Exception:
                        pass
                emit(f"[jenease] ✓ OBC {pvc_name} bound — reading credentials…")
                import base64
                def _dec(v): return base64.b64decode(v).decode() if v else ""
                secret = core.read_namespaced_secret(pvc_name, namespace)
                cm     = core.read_namespaced_config_map(pvc_name, namespace)
                access_key  = _dec(secret.data.get("AWS_ACCESS_KEY_ID", ""))
                secret_key  = _dec(secret.data.get("AWS_SECRET_ACCESS_KEY", ""))
                bucket_name = cm.data.get("BUCKET_NAME", "jenease-bucket")
                bucket_host = cm.data.get("BUCKET_HOST", "s3.openshift-storage.svc")
                bucket_port = cm.data.get("BUCKET_PORT", "80")
                protocol    = "https" if bucket_port in ("443", "8443") else "http"
                s3_endpoint = f"{protocol}://{bucket_host}:{bucket_port}"
                script_b64  = __import__("base64").b64encode(_NOOBAA_SCRIPT.encode()).decode()
                raw_io      = f"echo '{script_b64}' | base64 -d | python3"
                script_cmd  = f"pip install boto3 --quiet 2>/dev/null && {raw_io}"
                emit(f"[jenease] Creating pod {pod_name} (NooBaa IO)…")
                if synced:
                    # pip install BEFORE sync wait so NooBaa is truly ready when signal fires
                    final_noobaa_cmd = (
                        "pip install boto3 --quiet 2>/dev/null && "
                        "touch /tmp/noobaa-ready && "
                        "echo '[jenease] boto3 ready — waiting for sync signal…' && "
                        "until [ -f /tmp/jenease-start ]; do sleep 1; done && "
                        f"echo '[jenease] ✓ Starting IO' && {raw_io}"
                    )
                else:
                    final_noobaa_cmd = script_cmd
                core.create_namespaced_pod(namespace, client.V1Pod(
                    metadata=client.V1ObjectMeta(name=pod_name, namespace=namespace),
                    spec=client.V1PodSpec(
                        restart_policy="Never",
                        node_name=node_name or None,
                        containers=[client.V1Container(
                            name="noobaa-io", image=NOOBAA_IMAGE,
                            command=["/bin/bash", "-c", final_noobaa_cmd],
                            env=[
                                client.V1EnvVar(name="S3_ENDPOINT",  value=s3_endpoint),
                                client.V1EnvVar(name="ACCESS_KEY",   value=access_key),
                                client.V1EnvVar(name="SECRET_KEY",   value=secret_key),
                                client.V1EnvVar(name="BUCKET_NAME",  value=bucket_name),
                                client.V1EnvVar(name="SIZE_GB",      value=str(size_gb)),
                                client.V1EnvVar(name="MODE",         value=mode),
                                client.V1EnvVar(name="OBJ_SIZE_MB",  value=str(obj_size_mb)),
                                client.V1EnvVar(name="WORKERS",      value=str(workers)),
                            ],
                        )],
                    ),
                ))
            else:
                sc         = STORAGE_CLASSES[workload_type]
                acc_mode   = ACCESS_MODES[workload_type]
                emit(f"[jenease] Creating PVC {pvc_name} ({size_gb}Gi, {sc})…")
                core.create_namespaced_persistent_volume_claim(
                    namespace,
                    client.V1PersistentVolumeClaim(
                        metadata=client.V1ObjectMeta(name=pvc_name),
                        spec=client.V1PersistentVolumeClaimSpec(
                            access_modes=[acc_mode],
                            storage_class_name=sc,
                            resources=client.V1ResourceRequirements(requests={"storage": f"{size_gb}Gi"}),
                        ),
                    ),
                )
                emit(f"[jenease] ✓ PVC {pvc_name} created — waiting for provisioner…")
                fio_rw      = FIO_RW.get((mode, pattern), "write")
                per_job_gb  = max(1, size_gb // num_jobs)
                duration_desc = f"{duration_sec}s" if duration_sec > 0 else f"{per_job_gb}GB"
                time_flags  = f"--time_based --runtime={duration_sec}" if duration_sec > 0 else ""
                direct_flag = "--direct=1" if direct else ""
                fio_cmd = (
                    f"fio --name=jenease --ioengine={engine} {direct_flag} "
                    f"--bs={block_size} --numjobs={num_jobs} --iodepth={iodepth} --rw={fio_rw} "
                    f"--size={per_job_gb}g {time_flags} "
                    f"--filename=/data/testfile --fallocate=none --status-interval=2 --group_reporting"
                ).strip()
                wrapped_fio = f"script -q -c '{fio_cmd}' /dev/null 2>&1" if direct_flag else f"{fio_cmd} 2>&1"
                prefill = ""
                if mode == "read":
                    mb = size_gb * 1024
                    prefill = (
                        f"echo '[jenease] Pre-filling {size_gb}GB for read workload...' && "
                        f"dd if=/dev/zero of=/data/testfile bs=64M count={mb // 64 + 1} 2>&1 | "
                        f"grep -v '^$' | while IFS= read -r l; do echo \"[PREFILL] $l\"; done && "
                    )
                cmd = (
                    f"echo '[jenease] Starting fio ({fio_rw}, bs={block_size}, {num_jobs} jobs × {duration_desc}, iodepth={iodepth}, engine={engine})...' && "
                    f"{prefill}{wrapped_fio} && echo '[jenease] Workload complete.'"
                )
                emit(f"[jenease] Creating pod {pod_name} ({workload_type.upper()} IO)…")
                core.create_namespaced_pod(namespace, client.V1Pod(
                    metadata=client.V1ObjectMeta(name=pod_name, namespace=namespace),
                    spec=client.V1PodSpec(
                        restart_policy="Never",
                        node_name=node_name or None,
                        security_context=client.V1PodSecurityContext(run_as_user=0, run_as_group=0, fs_group=0),
                        containers=[client.V1Container(
                            name="io", image=IO_IMAGE,
                            command=["/bin/bash", "-c", (SYNC_POLL_CMD + cmd) if synced else cmd],
                            env=[client.V1EnvVar(name="SIZE_GB", value=str(size_gb))],
                            security_context=client.V1SecurityContext(run_as_user=0, allow_privilege_escalation=False),
                            volume_mounts=[client.V1VolumeMount(name="data", mount_path="/data")],
                        )],
                        volumes=[client.V1Volume(
                            name="data",
                            persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(claim_name=pvc_name),
                        )],
                    ),
                ))

            emit(f"[jenease] ✓ Pod {pod_name} created")

            # ── Wait for Running ─────────────────────────────────────────────
            # Use actual write size (per_job_gb * num_jobs), not PVC size (size_gb).
            # Integer division means 10GB / 4 jobs = 2GB/job = 8GB total written.
            if workload_type == "noobaa":
                size_bytes = size_gb * 1024 * 1024 * 1024
            else:
                per_job_gb = max(1, size_gb // num_jobs)
                size_bytes = per_job_gb * num_jobs * 1024 * 1024 * 1024
            fio_state: dict = {}  # tracks prev sectors for delta-based rate extraction
            last_detail = ""
            for _ in range(300):
                try:
                    pod = core.read_namespaced_pod(name=pod_name, namespace=namespace)
                    phase = pod.status.phase or ""
                    cs_list = pod.status.container_statuses or []
                    container_running = any(cs.state and cs.state.running for cs in cs_list)
                    if container_running or phase in ("Succeeded", "Failed"):
                        # For NooBaa in sync mode, wait until pip install is done
                        if synced and workload_type == "noobaa" and container_running:
                            from kubernetes.stream import stream as _ks
                            emit("[jenease] Container running — waiting for boto3 install…")
                            for _ in range(90):
                                try:
                                    out = _ks(core.connect_get_namespaced_pod_exec,
                                              pod_name, namespace,
                                              command=["sh", "-c", "test -f /tmp/noobaa-ready && echo yes"],
                                              stderr=False, stdin=False, stdout=True, tty=False)
                                    if "yes" in (out or ""):
                                        emit("[jenease] ✓ boto3 ready — NooBaa set for sync")
                                        break
                                except Exception:
                                    pass
                                time.sleep(2)
                        break
                    if phase in ("Pending", "Running"):
                        detail = None
                        for cs in cs_list:
                            if cs.state and cs.state.waiting:
                                w = cs.state.waiting
                                detail = w.reason or detail
                                if w.message:
                                    detail = f"{w.reason}: {w.message[:80]}"
                        if not detail:
                            detail = next(
                                (c.reason for c in (pod.status.conditions or []) if c.reason),
                                "initializing…",
                            )
                        if detail != last_detail:
                            emit(f"[jenease] Pod {pod_name} — {detail}")
                            last_detail = detail
                except Exception:
                    pass
                time.sleep(2)

            # Emit which node the pod landed on (always — confirms pin or reveals scheduler choice)
            try:
                actual_node = pod.spec.node_name or ""
                if actual_node:
                    emit(f"[jenease] ↳ Running on {actual_node}")
            except Exception:
                pass

            # ── Sync group signaling ─────────────────────────────────────────
            if synced and sync_id and sync_id in _SYNC_GROUPS:
                group = _SYNC_GROUPS[sync_id]
                with group["lock"]:
                    group["ready"] += 1
                    all_ready = group["ready"] >= group["expected"]
                if all_ready:
                    with group["lock"]:
                        if group.get("fired"):
                            all_ready = False  # backend monitor beat us to it
                        else:
                            group["fired"] = True
                if all_ready:
                    offsets = sorted(set(p[2] for p in group["pods"]))
                    offset_note = ', '.join(f'T+{int(o)}s' for o in offsets if o > 0)
                    msg = "✓ All pods ready — firing sync signal" + (f" (delayed: {offset_note})" if offset_note else "") + "…"
                    emit(f"[jenease] {msg}")
                    _sync_signal_start(kubeconfig_url, group["pods"])
                    _SYNC_GROUPS.pop(sync_id, None)
                else:
                    remaining = group["expected"] - group["ready"]
                    emit(f"[jenease] Pod ready — waiting for {remaining} more pod(s)…")

            # ── Stream logs ──────────────────────────────────────────────────
            try:
                pod = core.read_namespaced_pod(name=pod_name, namespace=namespace)
                final_phase = pod.status.phase or ""
            except Exception:
                final_phase = ""

            for attempt in range(5):
                try:
                    follow = final_phase not in ("Succeeded", "Failed")
                    response = core.read_namespaced_pod_log(
                        name=pod_name, namespace=namespace,
                        follow=follow, _preload_content=False,
                    )
                    for chunk in response:
                        for line in chunk.decode("utf-8", errors="replace").splitlines():
                            if line.strip():
                                parsed = parse_fio_line(line, size_bytes=size_bytes, fio_state=fio_state)
                                loop.call_soon_threadsafe(queue.put_nowait, parsed)
                    break
                except Exception as e:
                    if attempt < 4 and ("400" in str(e) or "ContainerCreating" in str(e)):
                        emit("[jenease] Container starting, retrying log stream…")
                        time.sleep(3)
                    else:
                        emit(f"[error] Log stream: {e}")
                        break

            api_client.close()
        except Exception as e:
            loop.call_soon_threadsafe(queue.put_nowait, f"[error] {e}")
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()

    while True:
        item = await queue.get()
        if item is None:
            break
        # item is either a string (status message) or a dict (parsed fio line)
        if isinstance(item, str):
            yield {"line": item}
        else:
            yield item


def _sync_setup_sync_configmap(core, rbac, client, namespace: str):
    """Create Role+RoleBinding (ConfigMap read) and jenease-sync CM in the workload namespace."""
    try:
        rbac.create_namespaced_role(namespace, client.V1Role(
            metadata=client.V1ObjectMeta(name="jenease-cm-reader", namespace=namespace),
            rules=[client.V1PolicyRule(api_groups=[""], resources=["configmaps"], verbs=["get"])],
        ))
    except Exception:
        pass
    try:
        rbac.create_namespaced_role_binding(namespace, client.V1RoleBinding(
            metadata=client.V1ObjectMeta(name="jenease-cm-reader", namespace=namespace),
            subjects=[client.V1Subject(kind="ServiceAccount", name="default", namespace=namespace)],
            role_ref=client.V1RoleRef(api_group="rbac.authorization.k8s.io", kind="Role", name="jenease-cm-reader"),
        ))
    except Exception:
        pass
    try:
        core.create_namespaced_config_map(namespace, client.V1ConfigMap(
            metadata=client.V1ObjectMeta(name="jenease-sync", namespace=namespace),
            data={"start": "false"},
        ))
    except Exception:
        pass


def _sync_signal_start(kubeconfig_url: str, pods: list):
    """Touch /tmp/jenease-start in each pod at its offset after all-ready.

    pods: list of (namespace, pod_name, offset_sec).
    Groups by offset_sec and spawns one daemon thread per unique offset.
    Offset=0 pods get the signal immediately; T>0 pods wait their delay."""
    from kubernetes.stream import stream as k8s_stream
    from collections import defaultdict
    import time as _time

    by_offset: dict = defaultdict(list)
    for ns, pn, offset in pods:
        by_offset[float(offset or 0)].append((ns, pn))

    def _fire(delay_secs: float, ns_pod_pairs: list):
        try:
            _fire_inner(delay_secs, ns_pod_pairs)
        except Exception as _top:
            print(f"[SYNC-SIGNAL] _fire CRASHED: {type(_top).__name__}: {_top}", flush=True)
            import traceback; traceback.print_exc()

    def _fire_inner(delay_secs: float, ns_pod_pairs: list):
        print(f"[SYNC-SIGNAL] _fire started for {len(ns_pod_pairs)} pods", flush=True)
        if delay_secs > 0:
            _time.sleep(delay_secs)
        core, _, _, api_client = _sync_load_k8s(kubeconfig_url)
        print(f"[SYNC-SIGNAL] k8s client ready", flush=True)
        for ns, pn in ns_pod_pairs:
            success = False
            for attempt in range(3):
                try:
                    k8s_stream(
                        core.connect_get_namespaced_pod_exec,
                        pn, ns,
                        command=["touch", "/tmp/jenease-start"],
                        stderr=True, stdin=False, stdout=True, tty=False,
                    )
                    success = True
                    break
                except Exception as _e:
                    print(f"[SYNC-SIGNAL] touch {pn} attempt {attempt+1}/3 failed: {_e}", flush=True)
                    if attempt < 2:
                        _time.sleep(2)
            print(f"[SYNC-SIGNAL] {pn} → {'✓' if success else '✗ FAILED'}", flush=True)
        api_client.close()

    for offset, pairs in sorted(by_offset.items()):
        t = threading.Thread(target=_fire, args=(offset, list(pairs)), daemon=True)
        t.start()


async def _backend_sync_monitor(sync_id: str, kubeconfig_url: str, pods: list) -> None:
    """Safety-net asyncio task for sync groups.

    SSE streams create pods and increment _SYNC_GROUPS[sync_id]["ready"] as each pod
    reaches Running state. When all pods are accounted for the SSE path fires the signal.

    But browsers cap HTTP/1.1 to ~6 concurrent connections per origin. With health/OSD
    queries consuming slots, only 4-5 workload SSE streams can open simultaneously.
    The remaining workloads never get their ready count incremented, so the signal never
    fires from the SSE path.

    This monitor polls k8s directly — independent of SSE connections — and fires as a
    fallback. The 'fired' flag + lock ensures only one path (SSE or this monitor) signals."""
    loop = asyncio.get_event_loop()

    def _watch():
        import time as _t
        # Give SSE streams time to open and do it themselves (fast path)
        _t.sleep(5)

        # If SSE path already fired while we were sleeping, we're done
        group = _SYNC_GROUPS.get(sync_id)
        if not group or group.get("fired"):
            return

        # Poll k8s until all pods have a running container (up to 10 min)
        with _K8S_LOAD_LOCK:
            from kubernetes import client as _k8s, config as _k8s_cfg
            cached = _KUBECONFIG_CONTENT_CACHE.get(kubeconfig_url)
            if cached and time.time() - cached[1] < _KUBECONFIG_CONTENT_TTL:
                kube_dict = cached[0]
            else:
                import httpx as _httpx
                r = _httpx.get(kubeconfig_url, timeout=10.0)
                kube_dict = __import__("yaml").safe_load(r.text)
                _KUBECONFIG_CONTENT_CACHE[kubeconfig_url] = (kube_dict, time.time())
            _k8s_cfg.load_kube_config_from_dict(kube_dict)
            cfg = _k8s.Configuration.get_default_copy()
        for entry in kube_dict.get("clusters", []):
            proxy = (entry.get("cluster") or {}).get("proxy-url")
            if proxy:
                cfg.proxy = proxy; break
        api_client = _k8s.ApiClient(cfg)
        core = _k8s.CoreV1Api(api_client)

        deadline = _t.monotonic() + 600
        while _t.monotonic() < deadline:
            # Bail early if SSE path already fired
            group = _SYNC_GROUPS.get(sync_id)
            if not group or group.get("fired"):
                api_client.close()
                return
            try:
                if all(
                    any(
                        c.state and c.state.running
                        for c in (core.read_namespaced_pod(pn, ns).status.container_statuses or [])
                    )
                    for ns, pn, _ in pods
                ):
                    break
            except Exception:
                pass
            _t.sleep(3)

        api_client.close()

        # All pods running — fire signal if SSE path hasn't already
        group = _SYNC_GROUPS.get(sync_id)
        if group:
            with group["lock"]:
                if group.get("fired"):
                    return
                group["fired"] = True
            _sync_signal_start(kubeconfig_url, group["pods"])
            _SYNC_GROUPS.pop(sync_id, None)

    await loop.run_in_executor(None, _watch)


async def _backend_sync_orchestrate(
    kubeconfig_url: str,
    wl_specs: list,
    wl_ids: list,
    pods_with_offsets: list,
    pending_params: dict,   # _PENDING_PARAMS from routers/workloads.py (passed by ref)
) -> None:
    """Backend-driven sync: create ALL resources in parallel then poll + signal.

    Runs as an asyncio task — completely independent of frontend SSE connections.
    This solves the browser HTTP/1.1 limit (6 connections per origin) that caused
    sync groups >5 to hang forever because not all log-stream SSEs could open."""
    loop = asyncio.get_event_loop()

    # Create k8s resources sequentially — eliminates all threading races on global
    # k8s config state. Each spec: namespace + RBAC + PVC/OBC + pod (~1s per workload).
    import functools as _functools
    n = len(wl_specs)
    print(f"[SYNC-ORCH] starting — {n} pods to create sequentially", flush=True)
    for i, spec in enumerate(wl_specs):
        try:
            await loop.run_in_executor(
                None, _functools.partial(_sync_create_resources_only, **spec)
            )
            print(f"[SYNC-ORCH] created {i+1}/{n}: {spec.get('pod_name')}", flush=True)
        except Exception as e:
            print(f"[SYNC-ORCH] ERROR {i+1}/{n}: {e}", flush=True)

    for wl_id in wl_ids:
        pending_params.pop(wl_id, None)
    print(f"[SYNC-ORCH] all created — polling for Running", flush=True)

    def _poll():
        import time as _t
        core, _, _, api_client = _sync_load_k8s(kubeconfig_url)
        deadline = _t.monotonic() + 600
        while _t.monotonic() < deadline:
            statuses = []
            for ns, pn, _ in pods_with_offsets:
                try:
                    cs = core.read_namespaced_pod(pn, ns).status.container_statuses or []
                    statuses.append(any(c.state and c.state.running for c in cs))
                except Exception:
                    statuses.append(False)
            ready = sum(statuses)
            print(f"[SYNC-ORCH] {ready}/{len(statuses)} Running", flush=True)
            if ready == len(statuses):
                break
            _t.sleep(3)
        api_client.close()

    await loop.run_in_executor(None, _poll)
    print(f"[SYNC-ORCH] firing signal for {n} pods", flush=True)
    _sync_signal_start(kubeconfig_url, pods_with_offsets)
    print(f"[SYNC-ORCH] done", flush=True)


def _sync_create_resources_only(
    kubeconfig_url: str,
    namespace: str,
    pvc_name: str,
    pod_name: str,
    workload_type: str,
    size_gb: int,
    mode: str,
    pattern: str = "sequential",
    block_size: str = "1m",
    num_jobs: int = 4,
    iodepth: int = 32,
    duration_sec: int = 0,
    obj_size_mb: int = 64,
    workers: int = 8,
    engine: str = "libaio",
    direct: bool = True,
    node_name: str = "",
    **_extra,
):
    """Create k8s resources for a synced workload (sync CM + poll script in pod command)."""
    from kubernetes import client
    core, custom, _, api_client = _sync_load_k8s(kubeconfig_url)
    rbac = client.RbacAuthorizationV1Api(api_client)

    # Namespace
    try:
        core.create_namespace(client.V1Namespace(metadata=client.V1ObjectMeta(name=namespace)))
    except Exception:
        pass

    # anyuid SCC
    try:
        rbac.create_namespaced_role_binding(namespace, client.V1RoleBinding(
            metadata=client.V1ObjectMeta(name="jenease-anyuid", namespace=namespace),
            subjects=[client.V1Subject(kind="ServiceAccount", name="default", namespace=namespace)],
            role_ref=client.V1RoleRef(api_group="rbac.authorization.k8s.io", kind="ClusterRole", name="system:openshift:scc:anyuid"),
        ))
    except Exception:
        pass

    # Sync CM + RBAC
    _sync_setup_sync_configmap(core, rbac, client, namespace)

    if workload_type == "noobaa":
        # OBC
        custom.create_namespaced_custom_object(
            group="objectbucket.io", version="v1alpha1", namespace=namespace, plural="objectbucketclaims",
            body={"apiVersion": "objectbucket.io/v1alpha1", "kind": "ObjectBucketClaim",
                  "metadata": {"name": pvc_name, "namespace": namespace},
                  "spec": {"generateBucketName": "jenease-bucket", "storageClassName": "openshift-storage.noobaa.io"}},
        )
        # Wait for bound
        for _ in range(60):
            time.sleep(2)
            try:
                obc = custom.get_namespaced_custom_object("objectbucket.io", "v1alpha1", namespace, "objectbucketclaims", pvc_name)
                if obc.get("status", {}).get("phase") == "Bound":
                    break
            except Exception:
                pass
        import base64
        def _dec(v): return base64.b64decode(v).decode() if v else ""
        secret = core.read_namespaced_secret(pvc_name, namespace)
        cm = core.read_namespaced_config_map(pvc_name, namespace)
        access_key  = _dec(secret.data.get("AWS_ACCESS_KEY_ID", ""))
        secret_key  = _dec(secret.data.get("AWS_SECRET_ACCESS_KEY", ""))
        bucket_name = cm.data.get("BUCKET_NAME", "jenease-bucket")
        bucket_host = cm.data.get("BUCKET_HOST", "s3.openshift-storage.svc")
        bucket_port = cm.data.get("BUCKET_PORT", "80")
        protocol    = "https" if bucket_port in ("443", "8443") else "http"
        s3_endpoint = f"{protocol}://{bucket_host}:{bucket_port}"
        script_b64  = __import__("base64").b64encode(_NOOBAA_SCRIPT.encode()).decode()
        script_cmd  = f"pip install boto3 --quiet 2>/dev/null && echo '{script_b64}' | base64 -d | python3"
        pod = client.V1Pod(
            metadata=client.V1ObjectMeta(name=pod_name, namespace=namespace),
            spec=client.V1PodSpec(
                restart_policy="Never",
                node_name=node_name or None,
                containers=[client.V1Container(
                    name="noobaa-io", image=NOOBAA_IMAGE,
                    command=["/bin/bash", "-c", SYNC_POLL_CMD + script_cmd],
                    env=[
                        client.V1EnvVar(name="S3_ENDPOINT", value=s3_endpoint),
                        client.V1EnvVar(name="ACCESS_KEY",  value=access_key),
                        client.V1EnvVar(name="SECRET_KEY",  value=secret_key),
                        client.V1EnvVar(name="BUCKET_NAME", value=bucket_name),
                        client.V1EnvVar(name="SIZE_GB",     value=str(size_gb)),
                        client.V1EnvVar(name="MODE",        value=mode),
                        client.V1EnvVar(name="OBJ_SIZE_MB", value=str(obj_size_mb)),
                        client.V1EnvVar(name="WORKERS",     value=str(workers)),
                    ],
                )],
            ),
        )
    else:
        sc = STORAGE_CLASSES[workload_type]
        acc_mode = ACCESS_MODES[workload_type]
        core.create_namespaced_persistent_volume_claim(namespace, client.V1PersistentVolumeClaim(
            metadata=client.V1ObjectMeta(name=pvc_name),
            spec=client.V1PersistentVolumeClaimSpec(
                access_modes=[acc_mode], storage_class_name=sc,
                resources=client.V1ResourceRequirements(requests={"storage": f"{size_gb}Gi"}),
            ),
        ))
        fio_rw     = FIO_RW.get((mode, pattern), "write")
        per_job_gb = max(1, size_gb // num_jobs)
        duration_desc = f"{duration_sec}s" if duration_sec > 0 else f"{per_job_gb}GB"
        time_flags  = f"--time_based --runtime={duration_sec}" if duration_sec > 0 else ""
        direct_flag = "--direct=1" if direct else ""
        fio_cmd = (
            f"fio --name=jenease --ioengine={engine} {direct_flag} "
            f"--bs={block_size} --numjobs={num_jobs} --iodepth={iodepth} --rw={fio_rw} "
            f"--size={per_job_gb}g {time_flags} "
            f"--filename=/data/testfile --fallocate=none --status-interval=2 --group_reporting"
        ).strip()
        wrapped = f"script -q -c '{fio_cmd}' /dev/null 2>&1" if direct_flag else f"{fio_cmd} 2>&1"
        prefill = ""
        if mode == "read":
            mb = size_gb * 1024
            prefill = (f"echo '[jenease] Pre-filling {size_gb}GB...' && "
                       f"dd if=/dev/zero of=/data/testfile bs=64M count={mb // 64 + 1} 2>&1 | "
                       f"grep -v '^$' | while IFS= read -r l; do echo \"[PREFILL] $l\"; done && ")
        cmd = (
            f"echo '[jenease] Starting fio ({fio_rw}, bs={block_size}, {num_jobs} jobs × {duration_desc}, "
            f"iodepth={iodepth}, engine={engine})...' && {prefill}{wrapped} && echo '[jenease] Workload complete.'"
        )
        pod = client.V1Pod(
            metadata=client.V1ObjectMeta(name=pod_name, namespace=namespace),
            spec=client.V1PodSpec(
                restart_policy="Never",
                node_name=node_name or None,
                security_context=client.V1PodSecurityContext(run_as_user=0, run_as_group=0, fs_group=0),
                containers=[client.V1Container(
                    name="io", image=IO_IMAGE,
                    command=["/bin/bash", "-c", SYNC_POLL_CMD + cmd],
                    env=[client.V1EnvVar(name="SIZE_GB", value=str(size_gb))],
                    security_context=client.V1SecurityContext(run_as_user=0, allow_privilege_escalation=False),
                    volume_mounts=[client.V1VolumeMount(name="data", mount_path="/data")],
                )],
                volumes=[client.V1Volume(name="data",
                    persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(claim_name=pvc_name))],
            ),
        )

    core.create_namespaced_pod(namespace, pod)
    api_client.close()


async def sync_create_all_workloads(
    kubeconfig_url: str,
    specs: list[dict],
) -> None:
    """Create all workload resources in parallel, then signal when all pods are Running."""
    loop = asyncio.get_event_loop()

    # Create all resources concurrently
    await asyncio.gather(*[
        loop.run_in_executor(None, _sync_create_resources_only, kubeconfig_url, **s)
        for s in specs
    ])

    namespaces = [s["namespace"] for s in specs]
    pod_names  = [s["pod_name"]  for s in specs]

    # Orchestrate: wait for all pods Running, then signal
    def _orchestrate():
        core, _, _, api_client = _sync_load_k8s(kubeconfig_url)
        # Poll until all pods are Running (up to 10 min)
        for _ in range(300):
            time.sleep(2)
            try:
                ready = True
                for ns, pn in zip(namespaces, pod_names):
                    pod = core.read_namespaced_pod(pn, ns)
                    cs  = pod.status.container_statuses or []
                    if not any(c.state and c.state.running for c in cs):
                        ready = False
                        break
                if ready:
                    break
            except Exception:
                pass

        # Flip all sync CMs to start=true
        for ns in namespaces:
            try:
                core.patch_namespaced_config_map("jenease-sync", ns, {"data": {"start": "true"}})
            except Exception:
                pass
        api_client.close()

    asyncio.create_task(loop.run_in_executor(None, _orchestrate))


def _sync_check_image_status(kubeconfig_url: str) -> dict:
    """Check image cache using imagePullPolicy:Never DaemonSet — accurate, no kubelet delay."""
    from kubernetes import client as _k8s
    core, _, _cfg, api_client = _sync_load_k8s(kubeconfig_url)
    apps_v1 = _k8s.AppsV1Api(api_client)
    ns = "jenease-prepull"
    ds_name = "jenease-imgcheck"

    try:
        core.create_namespace(_k8s.V1Namespace(metadata=_k8s.V1ObjectMeta(name=ns)))
    except Exception:
        pass
    try:
        apps_v1.delete_namespaced_daemon_set(ds_name, ns, body=_k8s.V1DeleteOptions(propagation_policy="Background"))
        time.sleep(3)
    except Exception:
        pass

    ds = _k8s.V1DaemonSet(
        metadata=_k8s.V1ObjectMeta(name=ds_name, namespace=ns),
        spec=_k8s.V1DaemonSetSpec(
            selector=_k8s.V1LabelSelector(match_labels={"app": ds_name}),
            template=_k8s.V1PodTemplateSpec(
                metadata=_k8s.V1ObjectMeta(labels={"app": ds_name}),
                spec=_k8s.V1PodSpec(
                    tolerations=[_k8s.V1Toleration(operator="Exists")],
                    node_selector={"node-role.kubernetes.io/worker": ""},
                    # Two parallel containers with Never pull — ErrImageNeverPull = not cached
                    containers=[
                        _k8s.V1Container(name="check-fio",    image=IO_IMAGE,     command=["sleep", "30"], image_pull_policy="Never"),
                        _k8s.V1Container(name="check-noobaa", image=NOOBAA_IMAGE, command=["sleep", "30"], image_pull_policy="Never"),
                    ],
                ),
            ),
        ),
    )
    apps_v1.create_namespaced_daemon_set(ns, ds)

    # Wait up to 30s for all pod containers to reach a definitive state
    result_by_node: dict[str, dict] = {}
    all_worker_nodes = [n.metadata.name for n in core.list_node(label_selector="node-role.kubernetes.io/worker=").items]
    for _ in range(10):
        time.sleep(3)
        pods = core.list_namespaced_pod(ns, label_selector=f"app={ds_name}")
        for pod in pods.items:
            node = pod.spec.node_name
            if not node:
                continue
            node_result: dict[str, bool | None] = {"fio": None, "noobaa": None}
            for cs in (pod.status.container_statuses or []):
                if cs.state and cs.state.waiting and cs.state.waiting.reason == "ErrImageNeverPull":
                    cached = False
                elif cs.state and (cs.state.running or cs.state.terminated):
                    cached = True
                else:
                    cached = None  # not yet determined
                if cs.name == "check-fio":
                    node_result["fio"] = cached
                elif cs.name == "check-noobaa":
                    node_result["noobaa"] = cached
            if node_result["fio"] is not None and node_result["noobaa"] is not None:
                result_by_node[node] = {"fio": bool(node_result["fio"]), "noobaa": bool(node_result["noobaa"])}
        if all(n in result_by_node for n in all_worker_nodes):
            break

    try:
        apps_v1.delete_namespaced_daemon_set(ds_name, ns, body=_k8s.V1DeleteOptions(propagation_policy="Background"))
    except Exception:
        pass
    api_client.close()

    result = [
        {"name": n, **result_by_node.get(n, {"fio": False, "noobaa": False})}
        for n in all_worker_nodes
    ]
    return {"nodes": result, "all_cached": all(n["fio"] and n["noobaa"] for n in result)}


async def check_image_status(kubeconfig_url: str) -> dict:
    loop = asyncio.get_event_loop()
    return await asyncio.wait_for(
        loop.run_in_executor(None, _sync_check_image_status, kubeconfig_url),
        timeout=60.0,
    )


def _sync_prepull_images(kubeconfig_url: str) -> str:
    """Create a DaemonSet on all workers to pre-pull fio + NooBaa images. Returns status."""
    from kubernetes import client as _k8s
    core, _, _cfg, api_client = _sync_load_k8s(kubeconfig_url)
    apps_v1 = _k8s.AppsV1Api(api_client)
    ns = "jenease-prepull"
    ds_name = "jenease-prepull-images"
    try:
        core.create_namespace(_k8s.V1Namespace(metadata=_k8s.V1ObjectMeta(name=ns)))
    except Exception:
        pass
    try:
        apps_v1.delete_namespaced_daemon_set(ds_name, ns, body=_k8s.V1DeleteOptions(propagation_policy="Background"))
        time.sleep(5)
    except Exception:
        pass
    ds = _k8s.V1DaemonSet(
        metadata=_k8s.V1ObjectMeta(name=ds_name, namespace=ns),
        spec=_k8s.V1DaemonSetSpec(
            selector=_k8s.V1LabelSelector(match_labels={"app": ds_name}),
            template=_k8s.V1PodTemplateSpec(
                metadata=_k8s.V1ObjectMeta(labels={"app": ds_name}),
                spec=_k8s.V1PodSpec(
                    tolerations=[_k8s.V1Toleration(operator="Exists")],
                    # Two init containers pull the images; main container is trivial
                    init_containers=[
                        _k8s.V1Container(name="pull-fio",    image=IO_IMAGE,     command=["echo", "fio ready"],    image_pull_policy="Always"),
                        _k8s.V1Container(name="pull-noobaa", image=NOOBAA_IMAGE, command=["echo", "noobaa ready"], image_pull_policy="Always"),
                    ],
                    containers=[_k8s.V1Container(
                        name="done", image=IO_IMAGE,
                        command=["sh", "-c", "echo images cached && sleep 10"],
                        image_pull_policy="IfNotPresent",
                    )],
                    restart_policy="Always",
                    node_selector={"node-role.kubernetes.io/worker": ""},
                ),
            ),
        ),
    )
    apps_v1.create_namespaced_daemon_set(ns, ds)
    desired = ready = 0
    for _ in range(72):   # up to 6 minutes
        time.sleep(5)
        try:
            status = apps_v1.read_namespaced_daemon_set_status(ds_name, ns)
            desired = status.status.desired_number_scheduled or 0
            ready   = status.status.number_ready or 0
            if desired > 0 and ready >= desired:
                break
        except Exception:
            pass
    try:
        apps_v1.delete_namespaced_daemon_set(ds_name, ns, body=_k8s.V1DeleteOptions(propagation_policy="Background"))
    except Exception:
        pass
    return f"fio + NooBaa images cached on {ready}/{desired} worker nodes"


async def prepull_workload_image(kubeconfig_url: str) -> str:
    loop = asyncio.get_event_loop()
    return await asyncio.wait_for(
        loop.run_in_executor(None, _sync_prepull_images, kubeconfig_url),
        timeout=360.0,
    )


def parse_fio_line(line: str, size_bytes: int = 0, fio_state: dict | None = None) -> dict:
    """Extract progress %, IO rate, and ETA from a fio status line (TTY or non-TTY format)."""
    result: dict = {"line": line}

    # TTY compact line: [W(1)][10.0%][w=234MiB/s][eta 07m:30s]
    m = PROGRESS_RE.search(line)
    if m:
        result["progress"] = float(m.group(1))

    r = RATE_RE.search(line)
    if r:
        result["rate"] = r.group(1)

    e = ETA_RE.search(line)
    if e:
        result["eta"] = e.group(1)

    # Workload completion — always 100%
    if "Workload complete." in line:
        result["progress"] = 100.0

    # Non-TTY summary line: write: IOPS=53, BW=6887KiB/s (7052kB/s)(672MiB/99884msec)
    if "rate" not in result:
        bw = re.search(r'[Bb][Ww]=(\d+(?:\.\d+)?)(KiB|MiB|GiB)/s', line)
        if bw:
            val, unit = float(bw.group(1)), bw.group(2)
            mb = val / 1024 if unit == 'KiB' else val * 1024 if unit == 'GiB' else val
            result["rate"] = f"{mb:.0f}MiB/s"

    # Disk stats line: "rbd3: ios=6/23, sectors=56/36992, ..."
    # Compute instantaneous rate from delta of cumulative write sectors between intervals.
    if fio_state is not None:
        disk_m = re.search(r'sectors=\d+/(\d+)', line)
        if disk_m:
            now = time.time()
            curr_w = int(disk_m.group(1))
            prev_w = fio_state.get("prev_w", 0)
            prev_t = fio_state.get("prev_t", now)
            if curr_w > prev_w:
                delta_bytes = (curr_w - prev_w) * 512
                delta_t = now - prev_t
                # Require at least 0.5s between disk-stats readings.
                # Smaller intervals produce meaningless rates when fio bursts
                # multiple lines rapidly (delta_t near zero → enormous spike).
                if "rate" not in result and delta_t >= 0.5:
                    rate_mb = delta_bytes / delta_t / 1_048_576
                    # Sanity cap: discard anything above 10 GB/s per workload
                    if rate_mb <= 10_000:
                        result["rate"] = f"{rate_mb:.1f}MiB/s"
                fio_state["prev_w"] = curr_w
                fio_state["prev_t"] = now
            if "progress" not in result and size_bytes > 0 and curr_w > 0:
                result["progress"] = min(99.9, (curr_w * 512) / size_bytes * 100)

    # Compute progress from io= in non-TTY summary lines when size_bytes known
    if "progress" not in result and size_bytes > 0:
        # Matches: (672MiB/99884msec) or io=672MiB
        io_m = re.search(r'(?:\(|io=)(\d+(?:\.\d+)?)(KiB|MiB|GiB)(?:/\d+msec\))?', line)
        if io_m and ('msec' in line or 'io=' in line):
            val, unit = float(io_m.group(1)), io_m.group(2)
            multipliers = {'KiB': 1024, 'MiB': 1024**2, 'GiB': 1024**3}
            done_bytes = val * multipliers.get(unit, 1024**2)
            result["progress"] = min(99.9, done_bytes / size_bytes * 100)

    # NooBaa / prefill progress lines [WRITE][45.0%]
    if "progress" not in result:
        m2 = re.search(r"\[(\d+\.?\d*)%\]", line)
        if m2:
            result["progress"] = float(m2.group(1))

    return result
