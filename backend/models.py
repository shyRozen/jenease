from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


class Workload(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    cluster_name: str = Field(index=True)
    username: str
    workload_type: str        # rbd, cephfs, noobaa
    namespace: str
    pod_name: str
    pvc_name: str
    size_gb: int
    mode: str                 # read, write, readwrite
    pattern: str              # sequential, random
    kubeconfig_url: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


class WorkloadSession(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    cluster_name: str              # where recorded (informational)
    username: str
    status: str = "recording"      # "recording" | "stopped"
    started_at: datetime = Field(default_factory=datetime.utcnow)
    ended_at: Optional[datetime] = None
    events: str = "[]"             # JSON: [{offset_ms, workload_type, params...}]
    throughput: str = "[]"         # JSON: [{offset_ms, rbd, cephfs, noobaa, total}]


class Preset(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True)
    name: str
    job: str
    params: str  # JSON blob
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


# --- API response shapes (Pydantic only, not DB) ---

class UserInfo(SQLModel):
    username: str
    full_name: str = ""


class LoginRequest(SQLModel):
    username: str
    token: str
    remember: bool = True


class PresetCreate(SQLModel):
    name: str
    job: str
    params: dict


class PresetRead(SQLModel):
    id: int
    name: str
    job: str
    params: dict
    created_at: datetime
    updated_at: datetime
