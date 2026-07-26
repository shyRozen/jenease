"""Real-time notifications — SSE stream + CRUD."""
import asyncio
import json
from datetime import datetime
from typing import Dict, List

from fastapi import APIRouter, Depends
from sqlmodel import Session, select
from sse_starlette.sse import EventSourceResponse

from auth import get_session
from database import engine
from models import Notification

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
