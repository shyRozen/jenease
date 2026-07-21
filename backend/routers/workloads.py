"""Workload management — create, list, delete, and stream logs."""
import json
import re
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select
from sse_starlette.sse import EventSourceResponse

from auth import get_session
from database import engine
from jenkins import JenkinsClient
from datetime import datetime
from models import Workload, WorkloadSession
from workload_runner import (
    create_and_stream_workload,
    delete_workload_namespace,
    get_pod_phase,
    parse_fio_line,
    stream_cleanup,
)
from config import settings

router = APIRouter(prefix="/api/clusters", tags=["workloads"])

DEPLOY_JOB = "qe-deploy-ocs-cluster"
_KUBECONFIG_CACHE: dict[str, tuple[str, float]] = {}  # cluster_name -> (url, timestamp)
_KUBECONFIG_TTL = 3600  # 1 hour
# Creation params stored per workload_id so the log stream can run the full creation
_PENDING_PARAMS: dict[int, dict] = {}


def _make_jenkins(session: dict) -> JenkinsClient:
    return JenkinsClient(session["username"], session["token"])


def _cluster_name_from_desc(description: str) -> Optional[str]:
    m = re.search(r"/openshift-clusters/([^/]+)/", description or "")
    return m.group(1) if m else None


async def _get_kubeconfig_url(jenkins: JenkinsClient, cluster_name: str) -> Optional[str]:
    """Find the kubeconfig URL for a cluster — cached 1h to avoid rescanning 200 builds."""
    cached = _KUBECONFIG_CACHE.get(cluster_name)
    if cached:
        url, ts = cached
        if time.time() - ts < _KUBECONFIG_TTL:
            return url
    builds = await jenkins.get_job_builds(DEPLOY_JOB, limit=200)
    for b in builds:
        if _cluster_name_from_desc(b.get("description", "") or "") == cluster_name:
            parsed = JenkinsClient.parse_build_description(b.get("description", "") or "")
            url = parsed.get("kubeconfig_url")
            if url:
                _KUBECONFIG_CACHE[cluster_name] = (url, time.time())
            return url
    return None


# ── request/response models ───────────────────────────────────────────────────

class CreateWorkloadRequest(BaseModel):
    workload_type: str          # rbd | cephfs | noobaa
    size_gb: int                # 1 | 10 | 50 | 100
    mode: str                   # read | write | readwrite
    pattern: str = "sequential" # sequential | random (ignored for noobaa)
    # RBD / CephFS fio options
    block_size: str = "1m"      # 4k | 64k | 512k | 1m | 4m
    num_jobs: int = 4           # 1 | 2 | 4 | 8
    iodepth: int = 32           # 1 | 8 | 32 | 64 | 128
    duration_sec: int = 0       # 0 = size-based; else time_based run
    # NooBaa options
    obj_size_mb: int = 64       # 1 | 16 | 64 | 256
    workers: int = 8            # 1 | 4 | 8 | 16 | 32
    # fio IO engine (rbd/cephfs only)
    engine: str = "libaio"      # psync | posixaio | io_uring | libaio
    direct: bool = True         # --direct=1 (bypass page cache)
    # Node pin (empty = let scheduler decide)
    node_name: Optional[str] = None
    # Recording
    session_id: Optional[int] = None
    # Pass kubeconfig_url from the frontend to skip scanning 200 Jenkins builds
    kubeconfig_url: Optional[str] = None


class SyncLaunchItem(BaseModel):
    workload_type: str
    size_gb: int
    mode: str
    pattern: str = "sequential"
    block_size: str = "1m"
    num_jobs: int = 4
    iodepth: int = 32
    duration_sec: int = 0
    obj_size_mb: int = 64
    workers: int = 8
    engine: str = "libaio"
    direct: bool = True
    node_name: Optional[str] = None
    offset_sec: float = 0  # delay after all pods ready before this pod gets the start signal

class SyncLaunchRequest(BaseModel):
    workloads: list[SyncLaunchItem]
    session_id: Optional[int] = None
    kubeconfig_url: Optional[str] = None


# ── endpoints ─────────────────────────────────────────────────────────────────

@router.post("/{cluster_name}/workloads")
async def create(
    cluster_name: str,
    body: CreateWorkloadRequest,
    session: dict = Depends(get_session),
):
    username = session["username"]
    if not cluster_name.lower().startswith(username.lower()):
        raise HTTPException(403, "Not your cluster")

    if body.kubeconfig_url:
        kubeconfig_url = body.kubeconfig_url
    else:
        jenkins = _make_jenkins(session)
        kubeconfig_url = await _get_kubeconfig_url(jenkins, cluster_name)
        if not kubeconfig_url:
            raise HTTPException(404, "Kubeconfig not found for this cluster")

    # Generate unique IDs
    import uuid as _uuid
    wl_uid = _uuid.uuid4().hex[:8]
    namespace = f"jenease-wl-{wl_uid}"
    pvc_name  = f"wl-pvc-{wl_uid}"
    pod_name  = f"wl-pod-{wl_uid}"

    workload = Workload(
        cluster_name=cluster_name,
        username=username,
        workload_type=body.workload_type,
        namespace=namespace,
        pod_name=pod_name,
        pvc_name=pvc_name,
        size_gb=body.size_gb,
        mode=body.mode,
        pattern=body.pattern,
        kubeconfig_url=kubeconfig_url,
    )
    with Session(engine) as db:
        db.add(workload)
        db.commit()
        db.refresh(workload)
        wid = workload.id

    # Record event in active session (fail silently)
    if body.session_id:
        try:
            with Session(engine) as db:
                ws = db.get(WorkloadSession, body.session_id)
                if ws and ws.status == "recording":
                    offset_ms = int((datetime.utcnow() - ws.started_at).total_seconds() * 1000)
                    events = json.loads(ws.events)
                    events.append({
                        "offset_ms": offset_ms,
                        "workload_type": body.workload_type,
                        "size_gb": body.size_gb,
                        "mode": body.mode,
                        "pattern": body.pattern,
                        "block_size": body.block_size,
                        "num_jobs": body.num_jobs,
                        "iodepth": body.iodepth,
                        "duration_sec": body.duration_sec,
                        "obj_size_mb": body.obj_size_mb,
                        "workers": body.workers,
                        "node_name": body.node_name or "",
                    })
                    ws.events = json.dumps(events)
                    db.add(ws)
                    db.commit()
        except Exception:
            pass

    # Store creation params — the log stream SSE will do the actual k8s work
    # with per-step status messages. POST returns instantly so the card appears immediately.
    _PENDING_PARAMS[wid] = {
        "kubeconfig_url": kubeconfig_url,
        "namespace":      namespace,
        "pvc_name":       pvc_name,
        "pod_name":       pod_name,
        "workload_type":  body.workload_type,
        "size_gb":        body.size_gb,
        "mode":           body.mode,
        "pattern":        body.pattern,
        "block_size":     body.block_size,
        "num_jobs":       body.num_jobs,
        "iodepth":        body.iodepth,
        "duration_sec":   body.duration_sec,
        "obj_size_mb":    body.obj_size_mb,
        "workers":        body.workers,
        "engine":         body.engine,
        "direct":         body.direct,
        "node_name":      body.node_name or "",
    }

    return {"id": wid, "namespace": namespace, "pod_name": pod_name}


@router.post("/{cluster_name}/workloads/sync-launch")
async def sync_launch(
    cluster_name: str,
    body: SyncLaunchRequest,
    session: dict = Depends(get_session),
):
    """Launch multiple workloads with synchronized IO start — all pods created first, then IO fires simultaneously."""
    from workload_runner import _SYNC_GROUPS
    import uuid as _uuid, threading as _threading

    username = session["username"]
    if not cluster_name.lower().startswith(username.lower()):
        raise HTTPException(403, "Not your cluster")
    if not body.workloads:
        raise HTTPException(400, "No workloads specified")

    if body.kubeconfig_url:
        kubeconfig_url = body.kubeconfig_url
    else:
        jenkins = _make_jenkins(session)
        kubeconfig_url = await _get_kubeconfig_url(jenkins, cluster_name)
        if not kubeconfig_url:
            raise HTTPException(404, "Kubeconfig not found for this cluster")

    sync_id      = _uuid.uuid4().hex[:8]
    workload_ids = []
    pods         = []   # (namespace, pod_name, offset_sec)

    with Session(engine) as db:
        for item in body.workloads:
            wl_uid    = _uuid.uuid4().hex[:8]
            namespace = f"jenease-wl-{wl_uid}"
            pvc_name  = f"wl-pvc-{wl_uid}"
            pod_name  = f"wl-pod-{wl_uid}"
            w = Workload(
                cluster_name=cluster_name, username=username,
                workload_type=item.workload_type, namespace=namespace,
                pod_name=pod_name, pvc_name=pvc_name,
                size_gb=item.size_gb, mode=item.mode, pattern=item.pattern,
                kubeconfig_url=kubeconfig_url,
            )
            db.add(w)
            db.flush()
            _PENDING_PARAMS[w.id] = {
                "kubeconfig_url": kubeconfig_url, "namespace": namespace,
                "pvc_name": pvc_name, "pod_name": pod_name,
                "workload_type": item.workload_type, "size_gb": item.size_gb,
                "mode": item.mode, "pattern": item.pattern, "block_size": item.block_size,
                "num_jobs": item.num_jobs, "iodepth": item.iodepth,
                "duration_sec": item.duration_sec, "obj_size_mb": item.obj_size_mb,
                "workers": item.workers, "engine": item.engine, "direct": item.direct,
                "node_name": item.node_name or "",
                "synced": True, "sync_id": sync_id,
            }
            workload_ids.append(w.id)
            pods.append((namespace, pod_name, float(item.offset_sec or 0)))
        db.commit()

    # Register sync group — each pod's log stream increments ready count;
    # when all are ready, _sync_signal_start fires each offset group.
    _SYNC_GROUPS[sync_id] = {
        "expected": len(body.workloads),
        "ready":    0,
        "lock":     _threading.Lock(),
        "pods":     pods,
        "kubeconfig_url": kubeconfig_url,
    }

    # Record all workload events in the session (all at offset 0 — sync fires simultaneously)
    if body.session_id:
        try:
            with Session(engine) as db:
                ws = db.get(WorkloadSession, body.session_id)
                if ws and ws.status == "recording":
                    offset_ms = int((datetime.utcnow() - ws.started_at).total_seconds() * 1000)
                    events = json.loads(ws.events)
                    for item in body.workloads:
                        events.append({
                            "offset_ms": offset_ms,
                            "workload_type": item.workload_type,
                            "size_gb": item.size_gb,
                            "mode": item.mode,
                            "pattern": item.pattern,
                            "block_size": item.block_size,
                            "num_jobs": item.num_jobs,
                            "iodepth": item.iodepth,
                            "duration_sec": item.duration_sec,
                            "obj_size_mb": item.obj_size_mb,
                            "workers": item.workers,
                            "node_name": item.node_name or "",
                            "synced": True,
                        })
                    ws.events = json.dumps(events)
                    db.add(ws)
                    db.commit()
        except Exception:
            pass

    return {"workload_ids": workload_ids}


@router.get("/{cluster_name}/workloads")
async def list_workloads(
    cluster_name: str,
    session: dict = Depends(get_session),
):
    username = session["username"]
    with Session(engine) as db:
        workloads = db.exec(
            select(Workload).where(
                Workload.cluster_name == cluster_name,
                Workload.username == username,
            )
        ).all()

    import asyncio as _aio
    # Skip k8s phase lookup for workloads pending creation — they're always 'Pending'
    async def _phase(w):
        if w.id in _PENDING_PARAMS:
            return "Pending"
        return await get_pod_phase(w.kubeconfig_url, w.namespace, w.pod_name)
    phases = await _aio.gather(*[_phase(w) for w in workloads])

    return [
        {
            "id": w.id,
            "workload_type": w.workload_type,
            "size_gb": w.size_gb,
            "mode": w.mode,
            "pattern": w.pattern,
            "namespace": w.namespace,
            "pod_name": w.pod_name,
            "created_at": w.created_at.isoformat() + "Z",
            "phase": phase,
        }
        for w, phase in zip(workloads, phases)
    ]


@router.delete("/{cluster_name}/workloads/{workload_id}")
async def delete(
    cluster_name: str,
    workload_id: int,
    session: dict = Depends(get_session),
):
    username = session["username"]
    with Session(engine) as db:
        workload = db.get(Workload, workload_id)
        if not workload or workload.username != username or workload.cluster_name != cluster_name:
            raise HTTPException(404, "Workload not found")
        db.delete(workload)
        db.commit()
    return {"ok": True}


@router.get("/{cluster_name}/workloads/{workload_id}/cleanup")
async def cleanup_stream(
    cluster_name: str,
    workload_id: int,
    session: dict = Depends(get_session),
):
    """SSE stream: performs k8s cleanup, deletes DB record, then sends done."""
    username = session["username"]
    with Session(engine) as db:
        workload = db.get(Workload, workload_id)
        if not workload or workload.username != username or workload.cluster_name != cluster_name:
            raise HTTPException(404, "Workload not found")
        kubeconfig_url = workload.kubeconfig_url
        namespace      = workload.namespace
        pod_name       = workload.pod_name
        pvc_name       = workload.pvc_name
        # Record delete event in any active recording session for this cluster/user
        from models import WorkloadSession as WS
        active = db.exec(
            select(WS).where(
                WS.cluster_name == cluster_name,
                WS.username == username,
                WS.status == "recording",
            )
        ).all()
        for ws in active:
            try:
                offset_ms = int((datetime.utcnow() - ws.started_at).total_seconds() * 1000)
                events = json.loads(ws.events)
                events.append({
                    "offset_ms": offset_ms,
                    "type": "delete",
                    "workload_type": workload.workload_type,
                    "size_gb": workload.size_gb,
                    "mode": workload.mode,
                    "pattern": workload.pattern,
                })
                ws.events = json.dumps(events)
                db.add(ws)
            except Exception:
                pass
        db.commit()

    async def generate():
        async for line in stream_cleanup(kubeconfig_url, namespace, pod_name, pvc_name):
            yield {"data": json.dumps({"line": line, "done": False})}
        # Always delete DB record and signal done — regardless of what k8s returned
        with Session(engine) as db:
            w = db.get(Workload, workload_id)
            if w:
                db.delete(w)
                db.commit()
        yield {"data": json.dumps({"line": "[jenease] Done.", "done": True})}

    return EventSourceResponse(generate(), headers={"Content-Encoding": "identity"})


@router.post("/{cluster_name}/workloads/purge")
async def purge_orphaned(
    cluster_name: str,
    session: dict = Depends(get_session),
):
    """Find and delete all jenease-wl-* namespaces in the cluster (orphan cleanup)."""
    username = session["username"]
    if not cluster_name.lower().startswith(username.lower()):
        raise HTTPException(403, "Not your cluster")

    jenkins = _make_jenkins(session)
    kubeconfig_url = await _get_kubeconfig_url(jenkins, cluster_name)
    if not kubeconfig_url:
        raise HTTPException(404, "Kubeconfig not found")

    import asyncio as _aio

    async def _do_purge():
        from workload_runner import _sync_load_k8s, _sync_delete_namespace
        import asyncio as _aio2

        loop = _aio2.get_event_loop()

        def _find_and_delete():
            core, _, _, api_client = _sync_load_k8s(kubeconfig_url)
            ns_list = core.list_namespace()
            jenease_ns = [
                ns.metadata.name for ns in ns_list.items
                if ns.metadata.name.startswith("jenease-wl-")
            ]
            api_client.close()
            return jenease_ns

        namespaces = await loop.run_in_executor(None, _find_and_delete)

        results = []
        for ns in namespaces:
            try:
                await _aio2.wait_for(
                    loop.run_in_executor(None, _sync_delete_namespace, kubeconfig_url, ns),
                    timeout=30.0,
                )
                results.append({"namespace": ns, "deleted": True})
            except Exception as e:
                results.append({"namespace": ns, "deleted": False, "error": str(e)})

        # Also clear DB records for this cluster
        with Session(engine) as db:
            workloads = db.exec(
                select(Workload).where(Workload.cluster_name == cluster_name)
            ).all()
            for w in workloads:
                db.delete(w)
            db.commit()

        return results

    results = await _do_purge()
    return {"purged": results}


@router.get("/{cluster_name}/workloads/{workload_id}/logs")
async def stream_logs(
    cluster_name: str,
    workload_id: int,
    session: dict = Depends(get_session),
):
    username = session["username"]
    with Session(engine) as db:
        workload = db.get(Workload, workload_id)
        if not workload or workload.username != username or workload.cluster_name != cluster_name:
            raise HTTPException(404, "Workload not found")

    params = _PENDING_PARAMS.pop(workload_id, None)

    async def generate():
        size_bytes = workload.size_gb * 1024 * 1024 * 1024
        fio_state: dict = {}
        from workload_runner import stream_pod_logs
        if params:
            # Full creation with per-step status messages (synced=True adds sync CM + poll script)
            async for item in create_and_stream_workload(**params):
                yield {"data": json.dumps(item)}
        else:
            # Pod already exists (page reload) — just stream existing logs
            yield {"data": json.dumps({"line": "[jenease] Connecting to cluster…"})}
            async for line in stream_pod_logs(workload.kubeconfig_url, workload.namespace, workload.pod_name):
                yield {"data": json.dumps(parse_fio_line(line, size_bytes=size_bytes, fio_state=fio_state))}

    return EventSourceResponse(generate(), headers={"Content-Encoding": "identity"})
