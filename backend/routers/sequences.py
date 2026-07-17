"""Workload sequences — saved multi-step workload plans with timing offsets."""
import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from auth import get_session
from database import engine
from models import WorkloadSequence

router = APIRouter(prefix="/api/sequences", tags=["sequences"])


class SequenceItem(BaseModel):
    offset_sec: float = 0
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


class CreateSequenceRequest(BaseModel):
    name: str
    items: list[SequenceItem]


class UpdateSequenceRequest(BaseModel):
    name: Optional[str] = None
    items: Optional[list[SequenceItem]] = None


def _to_dict(ws: WorkloadSequence) -> dict:
    return {
        "id": ws.id,
        "name": ws.name,
        "username": ws.username,
        "items": json.loads(ws.items),
        "created_at": ws.created_at.isoformat() + "Z",
        "updated_at": ws.updated_at.isoformat() + "Z",
    }


@router.get("/")
def list_sequences(auth: dict = Depends(get_session)):
    with Session(engine) as db:
        rows = db.exec(select(WorkloadSequence).order_by(WorkloadSequence.updated_at.desc())).all()
    return [_to_dict(ws) for ws in rows]


@router.post("/")
def create_sequence(body: CreateSequenceRequest, auth: dict = Depends(get_session)):
    ws = WorkloadSequence(
        name=body.name.strip() or "Untitled sequence",
        username=auth["username"],
        items=json.dumps([i.model_dump() for i in body.items]),
    )
    with Session(engine) as db:
        db.add(ws)
        db.commit()
        db.refresh(ws)
    return _to_dict(ws)


@router.patch("/{seq_id}")
def update_sequence(seq_id: int, body: UpdateSequenceRequest, auth: dict = Depends(get_session)):
    with Session(engine) as db:
        ws = db.get(WorkloadSequence, seq_id)
        if not ws:
            raise HTTPException(404, "Sequence not found")
        if ws.username != auth["username"]:
            raise HTTPException(403, "Not your sequence")
        if body.name is not None:
            ws.name = body.name.strip() or ws.name
        if body.items is not None:
            ws.items = json.dumps([i.model_dump() for i in body.items])
        ws.updated_at = datetime.utcnow()
        db.add(ws)
        db.commit()
        db.refresh(ws)
    return _to_dict(ws)


@router.delete("/{seq_id}")
def delete_sequence(seq_id: int, auth: dict = Depends(get_session)):
    with Session(engine) as db:
        ws = db.get(WorkloadSequence, seq_id)
        if not ws:
            raise HTTPException(404, "Sequence not found")
        if ws.username != auth["username"]:
            raise HTTPException(403, "Not your sequence")
        db.delete(ws)
        db.commit()
    return {"ok": True}
