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


class WorkloadSequence(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    username: str
    items: str = "[]"  # JSON: [{offset_sec, workload_type, size_gb, mode, ...}]
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class Preset(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True)
    name: str
    job: str
    params: str  # JSON blob
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(unique=True, index=True)
    full_name: str = ""
    last_seen: datetime = Field(default_factory=datetime.utcnow)


class ClusterShare(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    cluster_name: str = Field(index=True)
    shared_by: str
    shared_with: str  # username or "*" for all
    # Snapshot of cluster at share time so recipient can access without extra Jenkins calls
    kubeconfig_url: str = ""
    console_url: str = ""
    ocp_version: str = ""
    ocs_version: str = ""
    platform_conf: str = ""
    credentials_conf: str = ""
    build_url: str = ""
    build_num: int = 0
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Notification(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True)  # recipient
    from_user: str
    cluster_name: str
    message: str
    read: bool = Field(default=False)
    created_at: datetime = Field(default_factory=datetime.utcnow)


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
