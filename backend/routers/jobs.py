"""Deploy tab — job catalog, param schemas, and job triggering."""
import asyncio
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import get_session
from jenkins import JenkinsClient
from job_parser import parse_job

router = APIRouter(prefix="/api/jobs", tags=["jobs"])

# ── in-memory job catalog cache ─────────────────────────────────────────────
_catalog: list[dict] = []
_catalog_ts: float = 0.0
CACHE_TTL = 3600  # refresh hourly

DEPLOY_JOB_PATTERN = "deployment"
FULL_DEPLOY_JOB = "qe-deploy-ocs-cluster"  # the underlying job with all 100+ params

# For all manual deploys via Jenease we always call the base deploy job,
# never the production trigger jobs (which have production locks, ReportPortal, etc.)
MANUAL_DEPLOY_TARGET = "qe-deploy-ocs-cluster"

# Defaults overridden for non-production team usage
NON_PROD_DEFAULTS = {
    "RUN_TEST": "false",
    "LOCK_PRIORITY": "3",
    "REPORT_PORTAL": "false",
    "COLLECT_LOGS_ON_SUCCESS": "false",
    "PRODUCTION_RUN": "false",
    "CLUSTER_PREFIX": "",
}

# Credentials to enforce for vsphere jobs — production creds use ECO, we want CP
VSPHERE_CREDS = "vSphere8-DC-CP_VC1"
VSPHERE_CREDS_IPV6 = "vSphere8-DC-IPv6-CP_VC1"


def _make_client(session: dict) -> JenkinsClient:
    return JenkinsClient(session["username"], session["token"])


def _normalize_params(raw: list) -> list[dict]:
    result = []
    for p in raw:
        raw_type = p.get("type", "")
        norm_type = raw_type.replace("ParameterDefinition", "").lower()
        if "separator" in norm_type or "separator" in raw_type.lower():
            continue
        result.append({
            "name": p.get("name"),
            "type": norm_type,
            "default": (p.get("defaultParameterValue") or {}).get("value", ""),
            "choices": p.get("choices", []),
            "description": (p.get("description") or "").strip(),
        })
    return result


async def _build_catalog(jenkins: JenkinsClient) -> list[dict]:
    """Fetch all qe-trigger-*-deployment jobs, parse names, and merge with full deploy params."""
    all_jobs = await jenkins.get_all_jobs()
    trigger_jobs = [
        j["name"] for j in all_jobs
        if j["name"].startswith("qe-trigger-") and j["name"].endswith("-deployment")
    ]
    trigger_jobs.sort()

    # Parse job names (fast, no API calls)
    parsed = [parse_job(name) for name in trigger_jobs]

    # Fetch full deploy job params ONCE — same schema for all trigger jobs
    try:
        full_raw = await jenkins.get_job_params_schema(FULL_DEPLOY_JOB)
        full_params = _normalize_params(full_raw)
    except Exception:
        full_params = []

    full_params_by_name = {p["name"]: p for p in full_params}

    # Fetch trigger job params in batches
    BATCH = 20
    for i in range(0, len(parsed), BATCH):
        batch = parsed[i:i+BATCH]
        results = await asyncio.gather(
            *[jenkins.get_job_params_schema(j["job_name"]) for j in batch],
            return_exceptions=True,
        )
        for job_meta, trigger_raw in zip(batch, results):
            if isinstance(trigger_raw, Exception):
                job_meta["params"] = full_params[:]
                continue

            trigger_params = _normalize_params(trigger_raw)
            trigger_defaults = {
                p["name"]: p["default"]
                for p in trigger_params
                if p["default"] not in ("", None)
            }

            # Merge: full deploy params with trigger defaults applied
            merged = []
            for p in full_params:
                overridden = dict(p)
                if p["name"] in trigger_defaults:
                    overridden["default"] = trigger_defaults[p["name"]]
                merged.append(overridden)

            # Add trigger-only params (e.g. CLUSTER_CONF preset)
            full_names = {p["name"] for p in full_params}
            for p in trigger_params:
                if p["name"] not in full_names:
                    merged.append(p)

            job_meta["params"] = merged

    return parsed


# ── endpoints ────────────────────────────────────────────────────────────────

@router.get("/deployments")
async def list_deployments(session: dict = Depends(get_session)):
    """Return the cached job catalog (lazy-built on first call)."""
    global _catalog, _catalog_ts

    if _catalog and (time.time() - _catalog_ts) < CACHE_TTL:
        return _catalog

    jenkins = _make_client(session)
    _catalog = await _build_catalog(jenkins)
    _catalog_ts = time.time()
    return _catalog


@router.get("/deployments/{job_name}/params")
async def job_params(job_name: str, session: dict = Depends(get_session)):
    """
    Full param schema for the Modify drawer.
    Returns the complete qe-deploy-ocs-cluster params (100+), with defaults
    overridden by the trigger job's values where they exist.
    """
    jenkins = _make_client(session)

    def _normalize(params: list) -> list[dict]:
        result = []
        for p in params:
            raw_type = p.get("type", "")
            norm_type = raw_type.replace("ParameterDefinition", "").lower()
            # Skip Jenkins section separator/divider params — they're UI-only
            if "separator" in norm_type or "separator" in raw_type.lower():
                continue
            result.append({
                "name": p.get("name"),
                "type": norm_type,
                "default": (p.get("defaultParameterValue") or {}).get("value", ""),
                "choices": p.get("choices", []),
                "description": (p.get("description") or "").strip(),
            })
        return result

    # Fetch full deploy params + trigger job params in parallel
    try:
        full_raw, trigger_raw = await asyncio.gather(
            jenkins.get_job_params_schema(FULL_DEPLOY_JOB),
            jenkins.get_job_params_schema(job_name),
            return_exceptions=True,
        )
    except Exception:
        raise HTTPException(502, "Could not fetch parameters")

    full_params = _normalize(full_raw if not isinstance(full_raw, Exception) else [])
    trigger_params = _normalize(trigger_raw if not isinstance(trigger_raw, Exception) else [])

    # Build override map from trigger job
    trigger_defaults = {p["name"]: p["default"] for p in trigger_params if p["default"] not in ("", None)}

    # Merge: apply trigger defaults onto full param list
    merged = []
    for p in full_params:
        overridden = dict(p)
        if p["name"] in trigger_defaults:
            overridden["default"] = trigger_defaults[p["name"]]
        merged.append(overridden)

    # Also add trigger-only params not in full deploy job (e.g. CLUSTER_CONF presets)
    full_names = {p["name"] for p in full_params}
    for p in trigger_params:
        if p["name"] not in full_names:
            merged.append(p)

    return merged


class TriggerRequest(BaseModel):
    job_name: str
    params: dict
    cluster_name: str


@router.post("/trigger")
async def trigger_job(body: TriggerRequest, session: dict = Depends(get_session)):
    """Trigger a Jenkins deployment job."""
    import logging
    log = logging.getLogger("jenease.trigger")

    jenkins = _make_client(session)
    username = session["username"]

    # Enforce cluster name starts with username
    if not body.cluster_name.lower().startswith(username.lower()):
        raise HTTPException(400, f"Cluster name must start with your username ({username})")

    # Always deploy via the base job, never production trigger jobs
    target_job = MANUAL_DEPLOY_TARGET

    # Apply user params, then enforce non-prod overrides (can't be bypassed)
    params = {**body.params, **NON_PROD_DEFAULTS}
    params["CLUSTER_NAME"] = body.cluster_name

    # Enforce DC-CP credentials for vsphere jobs (production uses ECO)
    full_platform = params.get("FULL_PLATFORM_CONF", "") or params.get("CLUSTER_CONF", "")
    if "vsphere" in body.job_name.lower() or "vsphere" in full_platform.lower():
        if "ipv6" in body.job_name.lower() or "ipv6" in full_platform.lower():
            params["CREDENTIALS_CONF"] = VSPHERE_CREDS_IPV6
        else:
            params["CREDENTIALS_CONF"] = VSPHERE_CREDS

    # Remove empty/None values but keep explicit "false" strings
    params = {k: v for k, v in params.items() if v not in (None, "")}

    log.info(f"TRIGGER user={username} job={target_job} cluster={body.cluster_name} (from {body.job_name})")
    print(f"[TRIGGER] user={username} → {target_job} cluster={body.cluster_name} (trigger job: {body.job_name})", flush=True)

    try:
        queue_item = await jenkins.trigger_job(target_job, params)
    except Exception as e:
        print(f"[TRIGGER ERROR] {e}", flush=True)
        raise HTTPException(502, f"Jenkins trigger failed: {e}")

    print(f"[TRIGGER OK] queue_item={queue_item} cluster={body.cluster_name}", flush=True)
    return {"queue_item": queue_item, "job": target_job, "cluster_name": body.cluster_name}
