import asyncio
import re

from fastapi import APIRouter, Depends, Query

from auth import get_session
from jenkins import JenkinsClient

router = APIRouter(prefix="/api", tags=["names"])

DEPLOY_JOB = "qe-deploy-ocs-cluster"


@router.get("/suggest-name")
async def suggest_name(
    flavor: str = Query(default="", description="Short suffix, e.g. 'ipv6' or 'vsphere-vsan'"),
    session: dict = Depends(get_session),
):
    jenkins = JenkinsClient(session["username"], session["token"])
    username = session["username"]

    agents, builds = await asyncio.gather(
        jenkins.list_agents(),
        jenkins.get_job_builds(DEPLOY_JOB, limit=200),
    )

    # Collect taken numbers from agents
    taken: set[str] = set()
    for a in agents:
        name = a.get("displayName", "")
        if name.lower().startswith(username.lower()):
            m = re.match(rf"^{re.escape(username)}(\d?)", name, re.IGNORECASE)
            if m:
                taken.add(m.group(1))  # "" or "1"-"9"

    # Also collect from active (non-destroyed) build descriptions
    for b in builds:
        if b.get("building") or b.get("result") == "SUCCESS":
            desc = b.get("description", "") or ""
            m = re.search(r'/openshift-clusters/([^/]+)/', desc)
            if m:
                cname = m.group(1)
                if cname.lower().startswith(username.lower()):
                    nm = re.match(rf"^{re.escape(username)}(\d?)", cname, re.IGNORECASE)
                    if nm:
                        taken.add(nm.group(1))

    # Find the lowest free slot: "" first, then "1"-"9"
    slots = [""] + [str(i) for i in range(1, 10)]
    free = next((s for s in slots if s not in taken), "9")

    # Build name, hard-capped at 17 chars (Jenkins CLUSTER_NAME max)
    # Trim at dash boundaries — never cut a token in half
    MAX = 15
    prefix = f"{username}{free}"
    if flavor:
        tokens = flavor.split("-")
        chosen: list[str] = []
        for token in tokens:
            candidate = prefix + "-" + "-".join(chosen + [token])
            if len(candidate) <= MAX:
                chosen.append(token)
            else:
                break  # this token doesn't fit, stop here
        name = prefix + ("-" + "-".join(chosen) if chosen else "")
    else:
        name = prefix

    return {"name": name, "taken": sorted(taken)}
