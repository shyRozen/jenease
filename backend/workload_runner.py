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

def _sync_load_k8s(kubeconfig_url: str):
    """Download kubeconfig and return (CoreV1Api, CustomObjectsApi, cfg)."""
    from kubernetes import client, config as k8s_config

    r = httpx.get(kubeconfig_url, timeout=10.0)
    r.raise_for_status()
    kube_dict = yaml.safe_load(r.text)

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
                    _put(f"[jenease] PVC: {e}")

            # 4. Delete namespace
            _put(f"[jenease] Deleting namespace {namespace}…")
            try:
                core.delete_namespace(namespace, body=_k8s.V1DeleteOptions(grace_period_seconds=0))
                _put("[jenease] Cleanup complete.")
            except Exception as e:
                _put(f"[jenease] Namespace: {e}")

            api_client.close()
        except Exception as e:
            _put(f"[error] Cleanup failed: {e}")
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
                        if detail in ("ContainerCreating", "ContainersNotReady"):
                            msg += " (pulling image, may take a few minutes on first run)"
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


def parse_fio_line(line: str, size_bytes: int = 0) -> dict:
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

    # Non-TTY summary line: write: IOPS=53, BW=6887KiB/s (7052kB/s)(672MiB/99884msec)
    if "rate" not in result:
        bw = re.search(r'[Bb][Ww]=(\d+(?:\.\d+)?)(KiB|MiB|GiB)/s', line)
        if bw:
            val, unit = float(bw.group(1)), bw.group(2)
            mb = val / 1024 if unit == 'KiB' else val * 1024 if unit == 'GiB' else val
            result["rate"] = f"{mb:.0f}MiB/s"

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
