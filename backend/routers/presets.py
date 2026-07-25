"""Deploy presets (favorites) — saved job parameter configurations."""
import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from auth import get_session
from database import engine
from models import Preset

router = APIRouter(prefix="/api/presets", tags=["presets"])


class PresetCreate(BaseModel):
    name: str
    job: str
    params: dict  # all job params + optional _cluster_name key


def _to_dict(p: Preset) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "job": p.job,
        "params": json.loads(p.params),
        "created_at": p.created_at.isoformat() + "Z",
        "updated_at": p.updated_at.isoformat() + "Z",
    }


@router.get("/")
def list_presets(auth: dict = Depends(get_session)):
    with Session(engine) as db:
        rows = db.exec(
            select(Preset)
            .where(Preset.username == auth["username"])
            .order_by(Preset.updated_at.desc())
        ).all()
    return [_to_dict(p) for p in rows]


@router.post("/", status_code=201)
def create_preset(body: PresetCreate, auth: dict = Depends(get_session)):
    p = Preset(
        name=body.name.strip() or "Untitled",
        job=body.job,
        params=json.dumps(body.params),
        username=auth["username"],
    )
    with Session(engine) as db:
        db.add(p)
        db.commit()
        db.refresh(p)
    return _to_dict(p)


@router.patch("/{preset_id}")
def update_preset(preset_id: int, body: PresetCreate, auth: dict = Depends(get_session)):
    with Session(engine) as db:
        p = db.get(Preset, preset_id)
        if not p:
            raise HTTPException(404, "Preset not found")
        if p.username != auth["username"]:
            raise HTTPException(403, "Not your preset")
        p.name = body.name.strip() or p.name
        p.job = body.job
        p.params = json.dumps(body.params)
        p.updated_at = datetime.utcnow()
        db.add(p)
        db.commit()
        db.refresh(p)
    return _to_dict(p)


@router.delete("/{preset_id}")
def delete_preset(preset_id: int, auth: dict = Depends(get_session)):
    with Session(engine) as db:
        p = db.get(Preset, preset_id)
        if not p:
            raise HTTPException(404, "Preset not found")
        if p.username != auth["username"]:
            raise HTTPException(403, "Not your preset")
        db.delete(p)
        db.commit()
    return {"ok": True}
