from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


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
