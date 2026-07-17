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
    create_workload,
    delete_workload_namespace,
    get_pod_phase,
    parse_fio_line,
    stream_cleanup,
    stream_pod_logs,
)
from config import settings

router = APIRouter(prefix="/api/clusters", tags=["workloads"])

DEPLOY_JOB = "qe-deploy-ocs-cluster"


def _make_jenkins(session: dict) -> JenkinsClient:
    return JenkinsClient(session["username"], session["token"])


def _cluster_name_from_desc(description: str) -> Optional[str]:
    m = re.search(r"/openshift-clusters/([^/]+)/", description or "")
    return m.group(1) if m else None


async def _get_kubeconfig_url(jenkins: JenkinsClient, cluster_name: str) -> Optional[str]:
    """Find the kubeconfig URL for a cluster by scanning deploy builds."""
    builds = await jenkins.get_job_builds(DEPLOY_JOB, limit=200)
    for b in builds:
        if _cluster_name_from_desc(b.get("description", "") or "") == cluster_name:
            parsed = JenkinsClient.parse_build_description(b.get("description", "") or "")
            return parsed.get("kubeconfig_url")
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
    # Recording
    session_id: Optional[int] = None


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

    jenkins = _make_jenkins(session)
    kubeconfig_url = await _get_kubeconfig_url(jenkins, cluster_name)
    if not kubeconfig_url:
        raise HTTPException(404, "Kubeconfig not found for this cluster")

    # Generate unique IDs
    import uuid as _uuid
    wl_uid = _uuid.uuid4().hex[:8]   # 8-char hex — unique even for concurrent launches
    namespace = f"jenease-wl-{wl_uid}"
    pvc_name  = f"wl-pvc-{wl_uid}"
    pod_name  = f"wl-pod-{wl_uid}"

    try:
        await create_workload(
            kubeconfig_url=kubeconfig_url,
            namespace=namespace,
            pvc_name=pvc_name,
            pod_name=pod_name,
            workload_type=body.workload_type,
            size_gb=body.size_gb,
            mode=body.mode,
            pattern=body.pattern,
            block_size=body.block_size,
            num_jobs=body.num_jobs,
            iodepth=body.iodepth,
            duration_sec=body.duration_sec,
            obj_size_mb=body.obj_size_mb,
            workers=body.workers,
            engine=body.engine,
            direct=body.direct,
        )
    except Exception as e:
        raise HTTPException(502, f"Failed to create workload: {e}")

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
                    })
                    ws.events = json.dumps(events)
                    db.add(ws)
                    db.commit()
        except Exception:
            pass

    return {"id": wid, "namespace": namespace, "pod_name": pod_name}


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
    phases = await _aio.gather(*[
        get_pod_phase(w.kubeconfig_url, w.namespace, w.pod_name)
        for w in workloads
    ])

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

    async def generate():
        async for line in stream_cleanup(kubeconfig_url, namespace, pod_name, pvc_name):
            done = "complete" in line.lower() or "failed" in line.lower()
            if done:
                # Delete DB record now that k8s is clean
                with Session(engine) as db:
                    w = db.get(Workload, workload_id)
                    if w:
                        db.delete(w)
                        db.commit()
            yield {"data": json.dumps({"line": line, "done": done})}

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
        kubeconfig_url = workload.kubeconfig_url
        namespace = workload.namespace
        pod_name = workload.pod_name
        size_bytes = workload.size_gb * 1024 * 1024 * 1024

    async def generate():
        yield {"data": json.dumps({"line": "[jenease] Connecting to cluster…"})}
        async for line in stream_pod_logs(kubeconfig_url, namespace, pod_name):
            parsed = parse_fio_line(line, size_bytes=size_bytes)
            yield {"data": json.dumps(parsed)}

    # Content-Encoding: identity prevents GZipMiddleware from buffering the SSE stream
    return EventSourceResponse(generate(), headers={"Content-Encoding": "identity"})
