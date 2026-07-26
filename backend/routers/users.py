"""User registry — auto-populated from logins, used for share search."""
from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from auth import get_session
from database import engine
from models import User

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("/search")
def search_users(q: str = "", session: dict = Depends(get_session)):
    """Search users by username or full name (case-insensitive prefix/substring)."""
    me = session["username"]
    with Session(engine) as db:
        all_users = db.exec(select(User).order_by(User.username)).all()
    q_lower = q.strip().lower()
    results = []
    for u in all_users:
        if u.username == me:
            continue  # don't show self
        if not q_lower or q_lower in u.username.lower() or q_lower in u.full_name.lower():
            results.append({"username": u.username, "full_name": u.full_name})
    return results[:20]
