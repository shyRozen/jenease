import asyncio
import html as _html_mod
import re
from datetime import datetime
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import get_session
from cluster_health import _parse_topology, fetch_cluster_details, fetch_cluster_health
from jenkins import JenkinsClient
from config import settings

router = APIRouter(prefix="/api/clusters", tags=["clusters"])

DEPLOY_JOB  = "qe-deploy-ocs-cluster"
DESTROY_JOB = "qe-destroy-ocs-cluster"

LOCKER_URL = "https://odf-resourcelocker.apps.int.spoke.prod.us-east-1.aws.paas.redhat.com/pendingrequests/"

STAGE_SHORT: dict[str, str] = {
    "Initialization":                   "init",
    "Prepare Temporary Jenkins Slave":  "prepare_jslave",
    "Install_OCP":                      "install_ocp",
    "Install_OCS":                      "install_ocs",
    "External RHCS":                    "rhcs",
    "Upgrade":                          "upgrade",
    "Test":                             "test",
    "Declarative: Post Actions":        "teardown",
}

DESTROY_STAGE_SHORT: dict[str, str] = {
    "Initialization":           "init",
    "Cluster Destroy":          "cluster_destroy",
    "teardown":                 "teardown",
    "Declarative: Post Actions":"post_actions",
}


async def _fetch_locker_queue() -> dict[str, Optional[str]]:
    """Scrape the locker pending requests page.
    Returns {build_url_stripped: iso_queue_since_or_None}."""
    try:
        async with httpx.AsyncClient(timeout=8, verify=False) as c:
            r = await c.get(LOCKER_URL)
        if not r.is_success:
            return {}
    except Exception:
        return {}

    queue: dict[str, Optional[str]] = {}
    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', r.text, re.DOTALL)
    for row in rows[1:]:
        text = re.sub(r'<[^>]+>', ' ', row).strip()
        text = ' '.join(text.split())
        text = _html_mod.unescape(text)

        link_m = re.search(r"'link':\s*'([^']+)'", text)
        if not link_m:
            continue
        link = link_m.group(1).rstrip('/')

        # Parse "July 16, 2026, 5:41 a.m." → ISO string
        queue_since: Optional[str] = None
        time_m = re.search(r'(\w+ \d+, \d{4}, \d+:\d+ [ap]\.m\.)', text)
        if time_m:
            try:
                ts = time_m.group(1).replace('a.m.', 'AM').replace('p.m.', 'PM')
                queue_since = datetime.strptime(ts, "%B %d, %Y, %I:%M %p").isoformat()
            except Exception:
                pass

        queue[link] = queue_since
    return queue


def _make_client(session: dict) -> JenkinsClient:
    return JenkinsClient(session["username"], session["token"])


def _cluster_name_from_desc(description: str) -> Optional[str]:
    m = re.search(r'/openshift-clusters/([^/]+)/', description or "")
    return m.group(1) if m else None


async def _get_build_params_safe(jenkins: JenkinsClient, job: str, build_num: int) -> dict:
    try:
        return await jenkins.get_build_params(job, build_num)
    except Exception:
        return {}


@router.get("/active")
async def active_clusters(session: dict = Depends(get_session)):
    jenkins = _make_client(session)
    username = session["username"]

    # Fetch deploy + destroy builds concurrently
    deploy_builds, destroy_builds = await asyncio.gather(
        jenkins.get_job_builds(DEPLOY_JOB, limit=200),
        jenkins.get_job_builds(DESTROY_JOB, limit=100),
    )

    # Classify destroy builds into three buckets:
    # running → show DESTROYING badge; success → hide cluster; failed → show DESTROY FAILED badge.
    destroy_no_desc = [
        b for b in destroy_builds
        if not _cluster_name_from_desc(b.get("description", "") or "")
    ]
    if destroy_no_desc:
        destroy_param_names = await asyncio.gather(*[
            _get_build_params_safe(jenkins, DESTROY_JOB, b["number"])
            for b in destroy_no_desc
        ])
        for build, params in zip(destroy_no_desc, destroy_param_names):
            name = params.get("CLUSTER_NAME", "")
            if name:
                build["_param_cluster_name"] = name

    running_destroys:    dict[str, dict] = {}  # cluster → {build_num, build_url, timestamp}
    successful_destroys: dict[str, int]  = {}  # cluster → timestamp
    failed_destroys:     dict[str, dict] = {}  # cluster → {build_num, build_url, timestamp}

    for b in destroy_builds:
        name = _cluster_name_from_desc(b.get("description", "") or "") or b.get("_param_cluster_name")
        if not name:
            continue
        ts = b.get("timestamp", 0)
        build_url = f"{settings.jenkins_url}/job/{DESTROY_JOB}/{b['number']}/"
        if b.get("building"):
            if ts > running_destroys.get(name, {}).get("timestamp", 0):
                running_destroys[name] = {"build_num": b["number"], "build_url": build_url, "timestamp": ts}
        elif b.get("result") == "SUCCESS":
            if ts > successful_destroys.get(name, 0):
                successful_destroys[name] = ts
        elif b.get("result") in ("FAILURE", "ABORTED"):
            if ts > failed_destroys.get(name, {}).get("timestamp", 0):
                failed_destroys[name] = {"build_num": b["number"], "build_url": build_url, "timestamp": ts}

    # For actively building jobs with no description yet, fetch CLUSTER_NAME from params
    async def _get_cluster_name_from_params(build: dict) -> Optional[str]:
        try:
            params = await _get_build_params_safe(jenkins, DEPLOY_JOB, build["number"])
            name = params.get("CLUSTER_NAME", "")
            return name if name and name.lower().startswith(username.lower()) else None
        except Exception:
            return None

    # Enrich building builds that have no description yet
    building_no_desc = [
        b for b in deploy_builds
        if b.get("building") and not _cluster_name_from_desc(b.get("description", "") or "")
    ]
    if building_no_desc:
        names = await asyncio.gather(*[_get_cluster_name_from_params(b) for b in building_no_desc])
        for build, name in zip(building_no_desc, names):
            if name:
                build["_param_cluster_name"] = name

    # Find user's deploy builds, deduplicate by cluster name (keep latest)
    seen: dict[str, dict] = {}
    for build in deploy_builds:
        desc = build.get("description", "") or ""
        cluster_name = _cluster_name_from_desc(desc) or build.get("_param_cluster_name")
        if not cluster_name:
            continue
        if not cluster_name.lower().startswith(username.lower()):
            continue
        deploy_ts = build.get("timestamp", 0)
        # Skip only if a successful destroy started after this deploy
        if not build.get("building") and successful_destroys.get(cluster_name, 0) > deploy_ts:
            continue
        # Keep the most recent deploy build per cluster
        if cluster_name not in seen or build["number"] > seen[cluster_name]["number"]:
            parsed = JenkinsClient.parse_build_description(desc)
            seen[cluster_name] = {**build, **parsed, "cluster_name": cluster_name}

    if not seen:
        return []

    # Fetch params for each active cluster in parallel (small N)
    async def enrich(info: dict) -> dict:
        params = await _get_build_params_safe(jenkins, DEPLOY_JOB, info["number"])
        cname = info["cluster_name"]
        platform_conf = params.get("FULL_PLATFORM_CONF") or params.get("CLUSTER_CONF") or ""
        masters, workers = _parse_topology(platform_conf)
        deploy_ts = info.get("timestamp", 0)
        result: dict = {
            "cluster_name": cname,
            "build_num": info["number"],
            "build_url": f"{settings.jenkins_url}/job/{DEPLOY_JOB}/{info['number']}/",
            "building": info.get("building", False),
            "result": info.get("result"),
            "timestamp": info.get("timestamp"),
            "duration": info.get("duration"),
            "kubeconfig_url": info.get("kubeconfig_url"),
            "console_url": info.get("console_url"),
            "logs_url": info.get("logs_url"),
            "kubeadmin_password": info.get("kubeadmin_password"),
            "agent_ip": info.get("agent_ip"),
            "ocp_version": params.get("OCP_VERSION", ""),
            "ocs_version": params.get("OCS_VERSION", ""),
            "credentials_conf": params.get("CREDENTIALS_CONF", ""),
            "platform_conf": platform_conf,
            "osd_size": params.get("OSD_SIZE", ""),
            "topology": {"masters": masters, "workers": workers},
        }
        if cname in running_destroys and running_destroys[cname]["timestamp"] > deploy_ts:
            result["destroying"] = True
            result["destroy_build_url"] = running_destroys[cname]["build_url"]
            result["destroy_build_num"] = running_destroys[cname]["build_num"]
        elif cname in failed_destroys and failed_destroys[cname]["timestamp"] > deploy_ts:
            result["destroy_failed"] = True
            result["destroy_build_url"] = failed_destroys[cname]["build_url"]
            result["destroy_build_num"] = failed_destroys[cname]["build_num"]
        return result

    results = await asyncio.gather(*[enrich(info) for info in seen.values()])
    return sorted(results, key=lambda x: x.get("timestamp") or 0, reverse=True)


@router.get("/all")
async def all_clusters(session: dict = Depends(get_session)):
    """All active clusters across all users (no username filter)."""
    jenkins = _make_client(session)

    deploy_builds, destroy_builds = await asyncio.gather(
        jenkins.get_job_builds(DEPLOY_JOB, limit=200),
        jenkins.get_job_builds(DESTROY_JOB, limit=100),
    )

    # Classify destroy builds (same logic as active_clusters)
    destroy_no_desc = [
        b for b in destroy_builds
        if not _cluster_name_from_desc(b.get("description", "") or "")
    ]
    if destroy_no_desc:
        d_params = await asyncio.gather(*[
            _get_build_params_safe(jenkins, DESTROY_JOB, b["number"])
            for b in destroy_no_desc
        ])
        for build, params in zip(destroy_no_desc, d_params):
            name = params.get("CLUSTER_NAME", "")
            if name:
                build["_param_cluster_name"] = name

    running_destroys:    dict[str, dict] = {}
    successful_destroys: dict[str, int]  = {}
    failed_destroys:     dict[str, dict] = {}

    for b in destroy_builds:
        name = _cluster_name_from_desc(b.get("description", "") or "") or b.get("_param_cluster_name")
        if not name:
            continue
        ts = b.get("timestamp", 0)
        build_url = f"{settings.jenkins_url}/job/{DESTROY_JOB}/{b['number']}/"
        if b.get("building"):
            if ts > running_destroys.get(name, {}).get("timestamp", 0):
                running_destroys[name] = {"build_num": b["number"], "build_url": build_url, "timestamp": ts}
        elif b.get("result") == "SUCCESS":
            if ts > successful_destroys.get(name, 0):
                successful_destroys[name] = ts
        elif b.get("result") in ("FAILURE", "ABORTED"):
            if ts > failed_destroys.get(name, {}).get("timestamp", 0):
                failed_destroys[name] = {"build_num": b["number"], "build_url": build_url, "timestamp": ts}

    # Enrich building builds with no description (all users)
    building_no_desc = [
        b for b in deploy_builds
        if b.get("building") and not _cluster_name_from_desc(b.get("description", "") or "")
    ]
    if building_no_desc:
        names_params = await asyncio.gather(*[
            _get_build_params_safe(jenkins, DEPLOY_JOB, b["number"])
            for b in building_no_desc
        ])
        for build, params in zip(building_no_desc, names_params):
            name = params.get("CLUSTER_NAME", "")
            if name:
                build["_param_cluster_name"] = name

    # Collect all clusters (no username filter)
    seen: dict[str, dict] = {}
    for build in deploy_builds:
        desc = build.get("description", "") or ""
        cluster_name = _cluster_name_from_desc(desc) or build.get("_param_cluster_name")
        if not cluster_name:
            continue
        deploy_ts = build.get("timestamp", 0)
        if not build.get("building") and successful_destroys.get(cluster_name, 0) > deploy_ts:
            continue
        if cluster_name not in seen or build["number"] > seen[cluster_name]["number"]:
            parsed = JenkinsClient.parse_build_description(desc)
            seen[cluster_name] = {**build, **parsed, "cluster_name": cluster_name}

    if not seen:
        return []

    import re as _re

    async def enrich_all(info: dict) -> dict:
        params = await _get_build_params_safe(jenkins, DEPLOY_JOB, info["number"])
        cname = info["cluster_name"]
        platform_conf = params.get("FULL_PLATFORM_CONF") or params.get("CLUSTER_CONF") or ""
        masters, workers = _parse_topology(platform_conf)
        m = _re.match(r'^([a-zA-Z]+)', cname)
        owner = m.group(1) if m else cname
        deploy_ts = info.get("timestamp", 0)
        result: dict = {
            "cluster_name": cname,
            "owner": owner,
            "build_num": info["number"],
            "build_url": f"{settings.jenkins_url}/job/{DEPLOY_JOB}/{info['number']}/",
            "building": info.get("building", False),
            "result": info.get("result"),
            "timestamp": info.get("timestamp"),
            "kubeconfig_url": info.get("kubeconfig_url"),
            "console_url": info.get("console_url"),
            "logs_url": info.get("logs_url"),
            "kubeadmin_password": info.get("kubeadmin_password"),
            "ocp_version": params.get("OCP_VERSION", ""),
            "ocs_version": params.get("OCS_VERSION", ""),
            "credentials_conf": params.get("CREDENTIALS_CONF", ""),
            "platform_conf": platform_conf,
            "osd_size": params.get("OSD_SIZE", ""),
            "topology": {"masters": masters, "workers": workers},
        }
        if cname in running_destroys and running_destroys[cname]["timestamp"] > deploy_ts:
            result["destroying"] = True
            result["destroy_build_url"] = running_destroys[cname]["build_url"]
            result["destroy_build_num"] = running_destroys[cname]["build_num"]
        elif cname in failed_destroys and failed_destroys[cname]["timestamp"] > deploy_ts:
            result["destroy_failed"] = True
            result["destroy_build_url"] = failed_destroys[cname]["build_url"]
            result["destroy_build_num"] = failed_destroys[cname]["build_num"]
        return result

    results = await asyncio.gather(*[enrich_all(info) for info in seen.values()])
    return sorted(results, key=lambda x: x.get("timestamp") or 0, reverse=True)


@router.get("/{cluster_name}/health")
async def cluster_health(cluster_name: str, session: dict = Depends(get_session)):
    """Level 1 health: nodes + ODF status via kubeconfig. May take 10-30s."""
    jenkins = _make_client(session)
    username = session["username"]

    builds = await jenkins.get_job_builds(DEPLOY_JOB, limit=200)
    target = None
    for b in builds:
        name = _cluster_name_from_desc(b.get("description", "") or "")
        if name == cluster_name:
            target = b
            break

    if not target:
        return {"status": "NOT_FOUND"}

    if target.get("building"):
        return {"status": "BUILDING"}

    parsed = JenkinsClient.parse_build_description(target.get("description", "") or "")

    health = await fetch_cluster_health(
        console_url=parsed.get("console_url"),
        kubeadmin_password=parsed.get("kubeadmin_password"),
        kubeconfig_url=parsed.get("kubeconfig_url"),
    )
    if not health:
        return {"status": "UNREACHABLE"}

    nodes = health.get("nodes", [])
    odf = health.get("odf", {})

    all_ready = all(n["ready"] for n in nodes)
    odf_phase = odf.get("phase", "Unknown")
    odf_ok = odf_phase == "Ready"
    osd_up = health.get("osd_up") or 0
    osd_in = health.get("osd_in") or 0
    osd_count = health.get("osd_count", 0)
    ceph_health = (health.get("ceph_capacity") or {}).get("health", "")

    if all_ready and odf_ok:
        status = "HEALTHY"
        degraded_reason = None
    elif not nodes:
        status = "UNREACHABLE"
        degraded_reason = None
    else:
        status = "DEGRADED"
        # Priority: osd_down > ceph_err > node_not_ready > odf_error >
        #           node_pressure > ceph_warn > odf_progressing > node_unschedulable
        if osd_count > 0 and osd_up < osd_count:
            degraded_reason = "osd_down"
        elif ceph_health == "HEALTH_ERR":
            degraded_reason = "ceph_err"
        elif any(not n["ready"] for n in nodes):
            degraded_reason = "node_not_ready"
        elif odf_phase in ("Error", "Failed"):
            degraded_reason = "odf_error"
        elif any(
            c in str(n.get("conditions", {}))
            for n in nodes
            for c in ("DiskPressure=True", "MemoryPressure=True", "PIDPressure=True")
        ):
            degraded_reason = "node_pressure"
        elif ceph_health == "HEALTH_WARN":
            degraded_reason = "ceph_warn"
        elif odf_phase in ("Progressing", "Initializing", "Updating"):
            degraded_reason = "odf_progressing"
        elif osd_count > 0 and osd_in < osd_count:
            degraded_reason = "osd_not_in"
        elif any(n.get("unschedulable") for n in nodes):
            degraded_reason = "node_unschedulable"
        elif not odf or odf_phase in ("Unknown", "", None):
            degraded_reason = "odf_not_found"
        else:
            degraded_reason = None

    return {
        "status": status,
        "degraded_reason": degraded_reason,
        "nodes": nodes,
        "odf": odf,
        "osd_count": osd_count,
        "osd_up": health.get("osd_up"),
        "osd_in": health.get("osd_in"),
        "ceph_capacity": health.get("ceph_capacity"),
        "ocp_full_version": health.get("ocp_full_version"),
        "odf_full_version": health.get("odf_full_version"),
        "osd_iops": health.get("osd_iops"),
    }


@router.get("/{cluster_name}/stage")
async def cluster_stage(cluster_name: str, session: dict = Depends(get_session)):
    """Current Jenkins pipeline stage for a building cluster.
    Checks locker queue if in Initialization."""
    jenkins = _make_client(session)

    # Find the building build for this cluster
    builds = await jenkins.get_job_builds(DEPLOY_JOB, limit=200)

    # For building builds with no description yet, fetch CLUSTER_NAME from params
    no_desc = [
        b for b in builds
        if b.get("building") and not _cluster_name_from_desc(b.get("description", "") or "")
    ]
    if no_desc:
        param_results = await asyncio.gather(*[
            _get_build_params_safe(jenkins, DEPLOY_JOB, b["number"])
            for b in no_desc
        ])
        for build, params in zip(no_desc, param_results):
            name = params.get("CLUSTER_NAME", "")
            if name:
                build["_param_cluster_name"] = name

    build_num: Optional[int] = None
    build_url: Optional[str] = None
    for b in builds:
        name = _cluster_name_from_desc(b.get("description", "") or "") or b.get("_param_cluster_name")
        if name == cluster_name and b.get("building"):
            build_num = b["number"]
            build_url = f"{settings.jenkins_url}/job/{DEPLOY_JOB}/{build_num}"
            break

    if not build_num:
        return {"stage": None}

    # Query wfapi/describe for stage info
    try:
        async with httpx.AsyncClient(timeout=10, verify=False) as c:
            r = await c.get(
                f"{settings.jenkins_url}/job/{DEPLOY_JOB}/{build_num}/wfapi/describe",
                auth=(session["username"], session["token"]),
            )
            wf = r.json()
    except Exception:
        return {"stage": None}

    # Check for paused-pending-input at the overall or stage level
    paused_at: Optional[str] = None
    if wf.get("status") == "PAUSED_PENDING_INPUT":
        for s in wf.get("stages", []):
            if s.get("status") == "PAUSED_PENDING_INPUT":
                paused_at = STAGE_SHORT.get(s["name"], s["name"].lower().replace(" ", "_"))
                break

    if paused_at is not None:
        result: dict = {"stage": "paused_input", "paused_at": paused_at}
        return result

    # Find the currently in-progress stage
    current: Optional[str] = None
    for s in wf.get("stages", []):
        if s.get("status") == "IN_PROGRESS":
            current = s["name"]
            break
    # Fall back to last SUCCESS stage if nothing in progress yet
    if not current:
        for s in reversed(wf.get("stages", [])):
            if s.get("status") == "SUCCESS":
                current = s["name"]
                break

    if not current:
        return {"stage": None}

    short = STAGE_SHORT.get(current, current.lower().replace(" ", "_"))

    # If in Initialization check if blocked on locker queue
    queue_since: Optional[str] = None
    if current == "Initialization" and build_url:
        locker = await _fetch_locker_queue()
        build_clean = build_url.rstrip('/')
        for url, ts in locker.items():
            if url.rstrip('/') == build_clean:
                short = "locker_queue"
                queue_since = ts
                break

    result: dict = {"stage": short}
    if queue_since:
        result["queue_since"] = queue_since
    return result


@router.get("/{cluster_name}/destroy-stage")
async def cluster_destroy_stage(cluster_name: str, build_num: int, session: dict = Depends(get_session)):
    """Current Jenkins pipeline stage for a running destroy job."""
    try:
        async with httpx.AsyncClient(timeout=10, verify=False) as c:
            r = await c.get(
                f"{settings.jenkins_url}/job/{DESTROY_JOB}/{build_num}/wfapi/describe",
                auth=(session["username"], session["token"]),
            )
            wf = r.json()
    except Exception:
        return {"stage": None}

    current: Optional[str] = None
    for s in wf.get("stages", []):
        if s.get("status") == "IN_PROGRESS":
            current = s["name"]
            break
    if not current:
        for s in reversed(wf.get("stages", [])):
            if s.get("status") == "SUCCESS":
                current = s["name"]
                break

    if not current:
        return {"stage": None}

    return {"stage": DESTROY_STAGE_SHORT.get(current, current.lower().replace(" ", "_"))}


@router.get("/{cluster_name}/kubeconfig")
async def download_kubeconfig(cluster_name: str, session: dict = Depends(get_session)):
    """Proxy the kubeconfig from magna002 to the browser as a file download."""
    import httpx
    from fastapi.responses import Response

    jenkins = _make_client(session)
    username = session["username"]

    if not cluster_name.lower().startswith(username.lower()):
        from fastapi import HTTPException
        raise HTTPException(403, "Not your cluster")

    builds = await jenkins.get_job_builds(DEPLOY_JOB, limit=200)
    for b in builds:
        if _cluster_name_from_desc(b.get("description", "") or "") == cluster_name:
            parsed = JenkinsClient.parse_build_description(b.get("description", "") or "")
            kubeconfig_url = parsed.get("kubeconfig_url")
            if kubeconfig_url:
                async with httpx.AsyncClient(timeout=10.0) as c:
                    r = await c.get(kubeconfig_url)
                    if r.is_success:
                        return Response(
                            content=r.content,
                            media_type="application/x-yaml",
                            headers={"Content-Disposition": f'attachment; filename="kubeconfig-{cluster_name}"'},
                        )
    from fastapi import HTTPException
    raise HTTPException(404, "Kubeconfig not found")


@router.get("/{cluster_name}/details")
async def cluster_details(cluster_name: str, session: dict = Depends(get_session)):
    """Level 2: pods, PVCs, node detail for the cluster detail view."""
    jenkins = _make_client(session)
    username = session["username"]

    builds = await jenkins.get_job_builds(DEPLOY_JOB, limit=200)
    target = None
    for b in builds:
        if _cluster_name_from_desc(b.get("description", "") or "") == cluster_name:
            target = b
            break

    if not target or target.get("building"):
        return {"error": "Not available while building"}

    parsed = JenkinsClient.parse_build_description(target.get("description", "") or "")

    details = await fetch_cluster_details(
        console_url=parsed.get("console_url"),
        kubeadmin_password=parsed.get("kubeadmin_password"),
        kubeconfig_url=parsed.get("kubeconfig_url"),
    )
    return details or {}


@router.post("/{cluster_name}/abort")
async def abort_cluster_build(cluster_name: str, session: dict = Depends(get_session)):
    """Abort the currently running deploy build for this cluster."""
    jenkins = _make_client(session)
    username = session["username"]

    if not cluster_name.lower().startswith(username.lower()):
        from fastapi import HTTPException
        raise HTTPException(403, "Not your cluster")

    # Find the building build for this cluster — check description AND params
    builds = await jenkins.get_job_builds(DEPLOY_JOB, limit=200)
    building = [b for b in builds if b.get("building")]

    for b in building:
        desc_name = _cluster_name_from_desc(b.get("description", "") or "")
        if desc_name == cluster_name:
            await jenkins.abort_build(DEPLOY_JOB, b["number"])
            return {"ok": True, "build_num": b["number"]}

    # Description not written yet — fall back to checking CLUSTER_NAME param
    for b in building:
        if _cluster_name_from_desc(b.get("description", "") or ""):
            continue  # already matched or mismatched above
        params = await _get_build_params_safe(jenkins, DEPLOY_JOB, b["number"])
        if params.get("CLUSTER_NAME") == cluster_name:
            await jenkins.abort_build(DEPLOY_JOB, b["number"])
            return {"ok": True, "build_num": b["number"]}

    raise HTTPException(404, "No building deploy found for this cluster")


class DestroyRequest(BaseModel):
    force_jslave_destroy: bool = False
    longevity_cluster: bool = False
    do_not_release_lock: bool = False


@router.post("/{cluster_name}/destroy")
async def destroy_cluster(cluster_name: str, body: DestroyRequest, session: dict = Depends(get_session)):
    """Trigger qe-destroy-ocs-cluster, carrying over params from the original deploy build."""
    jenkins = _make_client(session)
    username = session["username"]

    if not cluster_name.lower().startswith(username.lower()):
        raise HTTPException(403, "Not your cluster")

    # Find the deploy build to carry over platform params
    builds = await jenkins.get_job_builds(DEPLOY_JOB, limit=200)
    deploy_params: dict = {}
    for b in builds:
        if _cluster_name_from_desc(b.get("description", "") or "") == cluster_name:
            deploy_params = await _get_build_params_safe(jenkins, DEPLOY_JOB, b["number"])
            break

    params: dict = {
        "CLUSTER_NAME": cluster_name,
        "OCS_VERSION": deploy_params.get("OCS_VERSION", ""),
        "OCP_VERSION": deploy_params.get("OCP_VERSION", ""),
        "CREDENTIALS_CONF": deploy_params.get("CREDENTIALS_CONF", ""),
        "FULL_PLATFORM_CONF": deploy_params.get("FULL_PLATFORM_CONF", ""),
        "PLATFORM_CONF": deploy_params.get("PLATFORM_CONF", ""),
        "CLUSTER_CONF": deploy_params.get("CLUSTER_CONF", ""),
        "FORCE_JSLAVE_DESTROY": str(body.force_jslave_destroy).lower(),
        "LONGEVITY_CLUSTER": str(body.longevity_cluster).lower(),
        "DO_NOT_RELEASE_LOCK": str(body.do_not_release_lock).lower(),
        "PRODUCTION_RUN": "false",
    }
    params = {k: v for k, v in params.items() if v not in (None, "")}

    print(f"[DESTROY] user={username} → {DESTROY_JOB} cluster={cluster_name}", flush=True)

    try:
        queue_item = await jenkins.trigger_job(DESTROY_JOB, params)
    except Exception as e:
        print(f"[DESTROY ERROR] {e}", flush=True)
        raise HTTPException(502, f"Jenkins destroy failed: {e}")

    print(f"[DESTROY OK] queue_item={queue_item} cluster={cluster_name}", flush=True)
    return {"queue_item": queue_item, "job": DESTROY_JOB, "cluster_name": cluster_name}
