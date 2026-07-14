from fastapi import APIRouter, Depends

from auth import get_session
from jenkins import JenkinsClient

router = APIRouter(prefix="/api/agents", tags=["agents"])


@router.get("")
async def list_agents(session: dict = Depends(get_session)):
    jenkins = JenkinsClient(session["username"], session["token"])
    username = session["username"]
    all_agents = await jenkins.list_agents()

    result = []
    for a in all_agents:
        name = a.get("displayName", "")
        if not name.lower().startswith(username.lower()):
            continue
        result.append({
            "name": name,
            "offline": a.get("offline", True),
            "idle": a.get("idle", True),
            "description": a.get("description", ""),
            "status": "offline" if a.get("offline") else ("idle" if a.get("idle") else "busy"),
        })

    return sorted(result, key=lambda x: x["name"])
