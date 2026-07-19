"""Workload session recording — CRUD + throughput append."""
import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from auth import get_session
from database import engine
from models import Workload, WorkloadSession

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


def _get_session_or_404(session_id: int, db: Session) -> WorkloadSession:
    ws = db.get(WorkloadSession, session_id)
    if not ws:
        raise HTTPException(404, "Session not found")
    return ws


def _summary(ws: WorkloadSession) -> dict:
    events = json.loads(ws.events)
    duration_ms = 0
    if ws.ended_at and ws.started_at:
        duration_ms = int((ws.ended_at - ws.started_at).total_seconds() * 1000)
    elif events:
        duration_ms = max(e.get("offset_ms", 0) for e in events)
    return {
        "id": ws.id,
        "name": ws.name,
        "cluster_name": ws.cluster_name,
        "username": ws.username,
        "status": ws.status,
        "started_at": ws.started_at.isoformat() + "Z",
        "ended_at": (ws.ended_at.isoformat() + "Z") if ws.ended_at else None,
        "event_count": len(events),
        "duration_ms": duration_ms,
    }


class StartRequest(BaseModel):
    cluster_name: str


class RenameRequest(BaseModel):
    name: str


class ThroughputSample(BaseModel):
    offset_ms: int
    rbd: float
    cephfs: float
    noobaa: float
    total: float


@router.get("/ping")
def ping():
    return {"ok": True, "router": "sessions"}


@router.post("/")
def start_session(body: StartRequest, auth: dict = Depends(get_session)):
    name = body.cluster_name if hasattr(body, 'name') and getattr(body, 'name', None) else \
        f"{body.cluster_name} {datetime.utcnow().strftime('%b %d %H:%M')}"
    with Session(engine) as db:
        # Snapshot any workloads already running for this cluster/user at offset_ms=0
        running = db.exec(
            select(Workload).where(
                Workload.cluster_name == body.cluster_name,
                Workload.username == auth["username"],
            )
        ).all()
        events = [
            {
                "offset_ms": 0,
                "type": "launch",
                "workload_type": w.workload_type,
                "size_gb": w.size_gb,
                "mode": w.mode,
                "pattern": w.pattern,
                "block_size": "1m",
                "num_jobs": 4,
                "iodepth": 32,
                "duration_sec": 0,
                "obj_size_mb": 64,
                "workers": 8,
                "node_name": "",
            }
            for w in running
        ]
        ws = WorkloadSession(
            name=name,
            cluster_name=body.cluster_name,
            username=auth["username"],
            events=json.dumps(events),
        )
        db.add(ws)
        db.commit()
        db.refresh(ws)
    return {"id": ws.id, "name": ws.name}


@router.post("/{session_id}/stop")
def stop_session(session_id: int, auth: dict = Depends(get_session)):
    with Session(engine) as db:
        ws = _get_session_or_404(session_id, db)
        if ws.username != auth["username"]:
            raise HTTPException(403, "Not your session")
        ws.status = "stopped"
        ws.ended_at = datetime.utcnow()
        db.add(ws)
        db.commit()
    return {"ok": True}


@router.post("/{session_id}/throughput")
def append_throughput(
    session_id: int,
    samples: list[ThroughputSample],
    auth: dict = Depends(get_session),
):
    with Session(engine) as db:
        ws = _get_session_or_404(session_id, db)
        existing = json.loads(ws.throughput)
        existing.extend([s.model_dump() for s in samples])
        ws.throughput = json.dumps(existing)
        db.add(ws)
        db.commit()
    return {"ok": True}


@router.patch("/{session_id}")
def rename_session(session_id: int, body: RenameRequest, auth: dict = Depends(get_session)):
    with Session(engine) as db:
        ws = _get_session_or_404(session_id, db)
        if ws.username != auth["username"]:
            raise HTTPException(403, "Not your session")
        ws.name = body.name.strip() or ws.name
        db.add(ws)
        db.commit()
    return {"ok": True}


@router.get("/")
def list_sessions(auth: dict = Depends(get_session)):
    with Session(engine) as db:
        rows = db.exec(
            select(WorkloadSession).order_by(WorkloadSession.started_at.desc()).limit(50)
        ).all()
    return [_summary(ws) for ws in rows]


@router.get("/{session_id}")
def get_session(session_id: int, auth: dict = Depends(get_session)):
    with Session(engine) as db:
        ws = _get_session_or_404(session_id, db)
        summary = _summary(ws)
        summary["events"] = json.loads(ws.events)
        summary["throughput"] = json.loads(ws.throughput)
        summary["started_at_ms"] = int(ws.started_at.timestamp() * 1000)
        return summary


@router.delete("/{session_id}")
def delete_session(session_id: int, auth: dict = Depends(get_session)):
    with Session(engine) as db:
        ws = _get_session_or_404(session_id, db)
        if ws.username != auth["username"]:
            raise HTTPException(403, "Not your session")
        db.delete(ws)
        db.commit()
    return {"ok": True}
