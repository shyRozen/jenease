import html as _html_mod
import re
from typing import Optional

import httpx
from fastapi import APIRouter, Depends

from auth import get_session

router = APIRouter(prefix="/api/rlocker", tags=["rlocker"])

LOCKER_RESOURCES_URL = (
    "https://odf-resourcelocker.apps.int.spoke.prod.us-east-1.aws.paas.redhat.com"
    "/lockable_resource/"
)


@router.get("/resources")
async def locker_resources(session: dict = Depends(get_session)):
    """Scrape RLocker lockable resources and return parsed list."""
    try:
        async with httpx.AsyncClient(timeout=12, verify=False) as c:
            r = await c.get(LOCKER_RESOURCES_URL)
        if not r.is_success:
            return []
    except Exception:
        return []

    results = []
    rows = re.findall(r'<tr id="row-(\d+)">(.*?)</tr>', r.text, re.DOTALL)
    for rid, row in rows:
        tds = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
        if len(tds) < 6:
            continue

        provider = re.sub(r'<[^>]+>', '', tds[1]).strip()

        name_m = re.search(r'<a href="/lockable_resource/\d+/">\s*([^<]+?)\s*</a>', tds[2])
        name = name_m.group(1).strip() if name_m else re.sub(r'<[^>]+>', '', tds[2]).strip()

        # Sign-off: LOCKED resources wrap it in <b>; FREE resources show plain "None"
        sign_off_html = tds[4]
        bold_m = re.search(r'<b>\s*([^<]+?)\s*</b>', sign_off_html)
        if bold_m:
            sign_off: Optional[str] = bold_m.group(1).strip()
        else:
            raw = re.sub(r'<[^>]+>', '', sign_off_html).strip()
            sign_off = raw if raw and raw.lower() != 'none' else None

        status_html = tds[5]
        status_text = re.sub(r'<[^>]+>', ' ', status_html)
        status_text = ' '.join(status_text.split())
        if 'LOCKED' in status_text:
            status = 'LOCKED'
        elif 'MAINTENANCE' in status_text:
            status = 'MAINTENANCE'
        else:
            status = 'FREE'

        # Duration e.g. "4h", "1d, 2h", "<1h"
        dur_m = re.search(r'(<?\d+[dh][^<\n]*)', status_text)
        duration = dur_m.group(1).strip() if dur_m else None

        results.append({
            "id": rid,
            "provider": _html_mod.unescape(provider),
            "name": _html_mod.unescape(name),
            "sign_off": _html_mod.unescape(sign_off) if sign_off else None,
            "status": status,
            "duration": duration,
        })

    return results
