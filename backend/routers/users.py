"""User registry — auto-populated from logins and Jenkins build history."""
import re
import time
from datetime import datetime

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from auth import get_session
from database import engine
from models import User

router = APIRouter(prefix="/api/users", tags=["users"])

THREE_WEEKS_MS = 21 * 24 * 3600 * 1000


def _username_from_cluster(cluster_name: str) -> str:
    """Extract username prefix from a cluster name (letters before the first digit)."""
    m = re.match(r'^([a-zA-Z]+)', cluster_name)
    return m.group(1).lower() if m else ""


def _upsert_username(db: Session, username: str) -> None:
    existing = db.exec(select(User).where(User.username == username)).first()
    if not existing:
        db.add(User(username=username, full_name="", last_seen=datetime.utcnow()))


async def scan_jenkins_users(jenkins_client) -> int:
    """
    Scan the last 3 weeks of Jenkins deploy builds across all three deploy jobs,
    extract unique username prefixes from cluster names, and upsert into the User table.
    Returns the number of new users added.
    """
    from routers.clusters import DEPLOY_JOB, PROD_DEPLOY_JOB, FDF_DEPLOY_JOB
    from routers.clusters import _cluster_name_from_desc
    import asyncio

    cutoff_ms = int(time.time() * 1000) - THREE_WEEKS_MS

    try:
        all_builds = await asyncio.gather(
            jenkins_client.get_job_builds(DEPLOY_JOB, limit=500),
            jenkins_client.get_job_builds(PROD_DEPLOY_JOB, limit=200),
            jenkins_client.get_job_builds(FDF_DEPLOY_JOB, limit=200),
            return_exceptions=True,
        )
    except Exception:
        return 0

    usernames: set[str] = set()
    for builds in all_builds:
        if isinstance(builds, Exception):
            continue
        for b in builds:
            if (b.get("timestamp") or 0) < cutoff_ms:
                continue
            cluster_name = _cluster_name_from_desc(b.get("description", "") or "")
            if not cluster_name:
                continue
            uname = _username_from_cluster(cluster_name)
            if uname and len(uname) >= 2:
                usernames.add(uname)

    added = 0
    with Session(engine) as db:
        for uname in usernames:
            existing = db.exec(select(User).where(User.username == uname)).first()
            if not existing:
                db.add(User(username=uname, full_name=""))
                added += 1
        db.commit()

    print(f"[USERS] Jenkins scan: found {len(usernames)} usernames, added {added} new", flush=True)
    return added


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
            continue
        if not q_lower or q_lower in u.username.lower() or q_lower in u.full_name.lower():
            results.append({"username": u.username, "full_name": u.full_name})
    return results[:20]


@router.post("/scan-jenkins")
async def trigger_scan(session: dict = Depends(get_session)):
    """Manually trigger a Jenkins build scan to populate the user registry."""
    from jenkins import JenkinsClient
    jenkins = JenkinsClient(session["username"], session["token"])
    added = await scan_jenkins_users(jenkins)
    with Session(engine) as db:
        total = len(db.exec(select(User)).all())
    return {"added": added, "total_users": total}
