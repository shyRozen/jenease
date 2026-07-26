"""Cluster sharing — grant access to teammates."""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, or_, select

from auth import get_session
from database import engine
from models import ClusterShare, Notification, User
from routers.notifications import push_notification

router = APIRouter(prefix="/api/clusters", tags=["shares"])


class ShareRequest(BaseModel):
    shared_with: str  # username or "*" for all
    # Cluster data snapshot — provided by the frontend from cached cluster info
    kubeconfig_url: str = ""
    console_url: str = ""
    ocp_version: str = ""
    ocs_version: str = ""
    platform_conf: str = ""
    credentials_conf: str = ""
    build_url: str = ""
    build_num: int = 0


def _has_cluster_access(username: str, cluster_name: str) -> bool:
    if cluster_name.lower().startswith(username.lower()):
        return True
    with Session(engine) as db:
        return db.exec(
            select(ClusterShare).where(
                ClusterShare.cluster_name == cluster_name,
                or_(ClusterShare.shared_with == username, ClusterShare.shared_with == "*")
            )
        ).first() is not None


@router.post("/{cluster_name}/share")
async def share_cluster(cluster_name: str, body: ShareRequest, session: dict = Depends(get_session)):
    username = session["username"]

    if not cluster_name.lower().startswith(username.lower()):
        raise HTTPException(403, "Not your cluster")

    shared_with = body.shared_with.strip()
    if not shared_with:
        raise HTTPException(400, "shared_with is required")

    with Session(engine) as db:
        # Avoid duplicate shares
        existing = db.exec(
            select(ClusterShare).where(
                ClusterShare.cluster_name == cluster_name,
                ClusterShare.shared_with == shared_with,
            )
        ).first()
        if existing:
            return {"ok": True, "already_shared": True}

        share = ClusterShare(
            cluster_name=cluster_name,
            shared_by=username,
            shared_with=shared_with,
            kubeconfig_url=body.kubeconfig_url,
            console_url=body.console_url,
            ocp_version=body.ocp_version,
            ocs_version=body.ocs_version,
            platform_conf=body.platform_conf,
            credentials_conf=body.credentials_conf,
            build_url=body.build_url,
            build_num=body.build_num,
        )
        db.add(share)

        # Build recipient list
        if shared_with == "*":
            recipients = [u.username for u in db.exec(select(User)).all() if u.username != username]
            msg = f"{username} shared cluster {cluster_name} with everyone"
        else:
            recipients = [shared_with]
            msg = f"{username} shared cluster {cluster_name} with you"

        notifs = []
        for recipient in recipients:
            n = Notification(
                username=recipient,
                from_user=username,
                cluster_name=cluster_name,
                message=msg,
            )
            db.add(n)
            notifs.append((recipient, n))

        db.commit()
        # Refresh to get IDs
        for recipient, n in notifs:
            db.refresh(n)
            notif_data = {
                "type": "notification",
                "id": n.id,
                "from_user": username,
                "cluster_name": cluster_name,
                "message": msg,
                "read": False,
                "created_at": n.created_at.isoformat() + "Z",
            }
            import asyncio
            asyncio.create_task(push_notification(recipient, notif_data))

    return {"ok": True, "shared_with": shared_with}


@router.get("/{cluster_name}/shares")
def list_shares(cluster_name: str, session: dict = Depends(get_session)):
    username = session["username"]
    if not cluster_name.lower().startswith(username.lower()):
        raise HTTPException(403, "Not your cluster")
    with Session(engine) as db:
        rows = db.exec(
            select(ClusterShare).where(ClusterShare.cluster_name == cluster_name)
        ).all()
    return [
        {"id": s.id, "shared_with": s.shared_with, "created_at": s.created_at.isoformat() + "Z"}
        for s in rows
    ]


@router.delete("/{cluster_name}/share/{shared_with}")
def unshare_cluster(cluster_name: str, shared_with: str, session: dict = Depends(get_session)):
    username = session["username"]
    if not cluster_name.lower().startswith(username.lower()):
        raise HTTPException(403, "Not your cluster")
    with Session(engine) as db:
        s = db.exec(
            select(ClusterShare).where(
                ClusterShare.cluster_name == cluster_name,
                ClusterShare.shared_with == shared_with,
            )
        ).first()
        if s:
            db.delete(s)
            db.commit()
    return {"ok": True}
