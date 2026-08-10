"""Real-time notifications — SSE stream + CRUD + cluster health alerts."""
import asyncio
import json
import re
from datetime import datetime, timedelta
from typing import Dict, List

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session, select, or_
from sse_starlette.sse import EventSourceResponse

from auth import get_session
from database import engine
from models import ClusterShare, Notification, User

router = APIRouter(prefix="/api/notifications", tags=["notifications"])

# username → list of asyncio Queues (one per active SSE connection)
_listeners: Dict[str, List[asyncio.Queue]] = {}


async def push_notification(username: str, data: dict) -> None:
    """Fan out a notification event to all connected SSE clients for this user."""
    for q in _listeners.get(username, []):
        await q.put(data)


def _to_dict(n: Notification) -> dict:
    return {
        "id": n.id,
        "from_user": n.from_user,
        "cluster_name": n.cluster_name,
        "message": n.message,
        "read": n.read,
        "created_at": n.created_at.isoformat() + "Z",
    }


@router.get("/stream")
async def notification_stream(session: dict = Depends(get_session)):
    """SSE stream — yields notifications for the current user in real time."""
    username = session["username"]
    queue: asyncio.Queue = asyncio.Queue()
    _listeners.setdefault(username, []).append(queue)

    async def generate():
        try:
            # Send unread count on connect so the bell is immediately correct
            with Session(engine) as db:
                unread = len(db.exec(
                    select(Notification).where(
                        Notification.username == username, Notification.read == False
                    )
                ).all())
            yield {"data": json.dumps({"type": "init", "unread": unread})}
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=30)
                    yield {"data": json.dumps(item)}
                except asyncio.TimeoutError:
                    yield {"data": json.dumps({"type": "ping"})}
        except asyncio.CancelledError:
            pass
        finally:
            try:
                _listeners[username].remove(queue)
                if not _listeners[username]:
                    del _listeners[username]
            except (KeyError, ValueError):
                pass

    return EventSourceResponse(generate(), headers={"Content-Encoding": "identity"})


@router.get("/")
def list_notifications(session: dict = Depends(get_session)):
    username = session["username"]
    with Session(engine) as db:
        rows = db.exec(
            select(Notification)
            .where(Notification.username == username)
            .order_by(Notification.created_at.desc())
        ).all()
    return [_to_dict(n) for n in rows]


@router.post("/{notif_id}/read")
def mark_read(notif_id: int, session: dict = Depends(get_session)):
    username = session["username"]
    with Session(engine) as db:
        n = db.get(Notification, notif_id)
        if n and n.username == username:
            n.read = True
            db.add(n)
            db.commit()
    return {"ok": True}


@router.post("/{notif_id}/unread")
def mark_unread(notif_id: int, session: dict = Depends(get_session)):
    username = session["username"]
    with Session(engine) as db:
        n = db.get(Notification, notif_id)
        if n and n.username == username:
            n.read = False
            db.add(n)
            db.commit()
    return {"ok": True}


@router.post("/read-all")
def mark_all_read(session: dict = Depends(get_session)):
    username = session["username"]
    with Session(engine) as db:
        rows = db.exec(
            select(Notification).where(Notification.username == username, Notification.read == False)
        ).all()
        for n in rows:
            n.read = True
            db.add(n)
        db.commit()
    return {"ok": True}


class AlertRequest(BaseModel):
    cluster_name: str
    message: str


def _owner_from_cluster(cluster_name: str) -> str:
    m = re.match(r'^([a-zA-Z]+)', cluster_name)
    return m.group(1).lower() if m else ""


@router.post("/alert")
async def cluster_alert(body: AlertRequest, session: dict = Depends(get_session)):
    """
    Health-alert notification: creates notifications for the cluster owner
    and all users the cluster is shared with. Deduplicates within 5 minutes
    so polling at 8s doesn't spam the DB.
    """
    cluster_name = body.cluster_name

    with Session(engine) as db:
        # Dedup: skip if same message was sent for this cluster in the last 5 min
        recent = db.exec(
            select(Notification).where(
                Notification.cluster_name == cluster_name,
                Notification.message == body.message,
                Notification.created_at >= datetime.utcnow() - timedelta(minutes=5),
            )
        ).first()
        if recent:
            return {"ok": True, "duplicate": True}

        # Build recipient set: owner + shared users
        owner = _owner_from_cluster(cluster_name)
        recipients: set[str] = set()
        if owner:
            recipients.add(owner)

        shares = db.exec(
            select(ClusterShare).where(ClusterShare.cluster_name == cluster_name)
        ).all()
        for s in shares:
            if s.shared_with == "*":
                for u in db.exec(select(User)).all():
                    recipients.add(u.username)
            else:
                recipients.add(s.shared_with)

        # Create notification rows
        created: list[Notification] = []
        for recipient in recipients:
            n = Notification(
                username=recipient,
                from_user="system",
                cluster_name=cluster_name,
                message=body.message,
            )
            db.add(n)
            created.append(n)
        db.commit()
        for n in created:
            db.refresh(n)

        # Fan out via SSE
        for n in created:
            notif_data = {
                "type": "notification",
                "id": n.id,
                "from_user": "system",
                "cluster_name": cluster_name,
                "message": body.message,
                "read": False,
                "created_at": n.created_at.isoformat() + "Z",
            }
            asyncio.create_task(push_notification(n.username, notif_data))

    return {"ok": True, "recipients": list(recipients)}
