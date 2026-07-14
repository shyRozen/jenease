"""Parse qe-trigger-*-deployment job names into structured metadata."""
import re
from typing import Optional

PLATFORMS = {
    'aws': 'AWS', 'vsphere': 'vSphere', 'azure': 'Azure',
    'ibmcloud': 'IBM Cloud', 'baremetal': 'Bare Metal',
    'gcp': 'GCP', 'rhv': 'RHV',
}
INSTALLERS = {'ipi': 'IPI', 'upi': 'UPI'}
OS_TYPES = ['rhcos10', 'rhcos', 'rhel']  # order matters
STORAGE_TYPES = {
    'vsan': 'vSAN', 'vmfs': 'VMFS', 'nvme-intel': 'NVMe',
    'lso-rdm': 'LSO RDM', 'lso-vmdk': 'LSO VMDK',
    'lso': 'LSO', 'nvme': 'NVMe', 'sts': 'STS',
    'lvmo': 'LVMO',
}
FEATURE_LABELS = {
    'fips': 'FIPS', 'encryption': 'Encryption',
    'kms-vault-v1': 'KMS Vault v1', 'kms-vault-v2': 'KMS Vault v2',
    'kms-thales': 'KMS Thales', 'multus': 'Multus',
    'ipv6': 'IPv6', 'disconnected': 'Disconnected',
    'external': 'External', 'arbiter': 'Arbiter',
    'proxy': 'Proxy', 'graviton': 'Graviton',
    'mcg-only': 'MCG Only', 'intransit-encryption': 'In-Transit Enc.',
    'pgdb': 'pgDB', 'sno': 'SNO', 'lowerreq': 'Lower Req',
    'perfplus': 'Perf+', 'privatelink': 'PrivateLink',
    'aro': 'ARO', 'rosa-hcp': 'ROSA HCP',
    'compact-mode': 'Compact', 'live': 'Live',
    'stage': 'Stage', 'providermode': 'Provider',
    'multi-storagecluster': 'Multi-SC',
    'encryption-key-vault': 'KMS Key Vault',
}
# Features that also appear as filter chips
FILTER_FEATURES = {
    'fips', 'encryption', 'kms-vault-v1', 'kms-vault-v2', 'kms-thales',
    'multus', 'ipv6', 'disconnected', 'external', 'arbiter', 'proxy',
    'graviton', 'mcg-only', 'intransit-encryption', 'compact-mode',
}


def parse_job(job_name: str) -> dict:
    """Parse a qe-trigger-*-deployment job name into structured metadata."""
    # Strip known prefix/suffix
    core = job_name
    for prefix in ['qe-trigger-fdf-', 'qe-trigger-ms-nightly-', 'qe-trigger-ms-rq-', 'qe-trigger-']:
        if core.startswith(prefix):
            core = core[len(prefix):]
            break
    if core.endswith('-deployment'):
        core = core[:-len('-deployment')]

    tokens = core.split('-')
    idx = 0

    def consume(*options) -> Optional[str]:
        nonlocal idx
        for opt in options:
            parts = opt.split('-')
            n = len(parts)
            if tokens[idx:idx+n] == parts:
                idx += n
                return opt
        return None

    def peek(n=1) -> str:
        return '-'.join(tokens[idx:idx+n])

    result: dict = {
        'job_name': job_name,
        'platform': None,
        'installer': None,
        'az': None,
        'os': None,
        'storage': None,
        'masters': 3,
        'workers': 3,
        'features': [],
        'search_string': core.replace('-', ' '),
    }

    # Platform
    for p in ['aws', 'vsphere', 'azure', 'ibmcloud', 'baremetal', 'gcp', 'rhv']:
        if idx < len(tokens) and tokens[idx] == p:
            result['platform'] = p
            idx += 1
            break

    # Installer
    for ins in ['ipi', 'upi']:
        if idx < len(tokens) and tokens[idx] == ins:
            result['installer'] = ins
            idx += 1
            break

    # Scan remaining tokens for known types
    features = []
    while idx < len(tokens):
        t = tokens[idx]

        # AZ: 1az, 2az, 3az
        if re.match(r'^\d+az$', t):
            result['az'] = t
            idx += 1
            continue

        # OS (check 2-token variants first)
        matched_os = False
        for os in OS_TYPES:
            parts = os.split('-')
            if tokens[idx:idx+len(parts)] == parts:
                result['os'] = os
                idx += len(parts)
                matched_os = True
                break
        if matched_os:
            continue

        # Storage (check multi-token variants first)
        matched_storage = False
        for st in ['nvme-intel', 'lso-rdm', 'lso-vmdk', 'vsan', 'vmfs', 'lso', 'nvme', 'sts']:
            parts = st.split('-')
            if tokens[idx:idx+len(parts)] == parts:
                result['storage'] = st
                idx += len(parts)
                matched_storage = True
                break
        if matched_storage:
            continue

        # Node topology: Nm, Nw, compact-mode
        node_match = re.match(r'^(\d+)m$', t)
        if node_match:
            result['masters'] = int(node_match.group(1))
            idx += 1
            # Check for Nw next
            if idx < len(tokens):
                w_match = re.match(r'^(\d+)w$', tokens[idx])
                if w_match:
                    result['workers'] = int(w_match.group(1))
                    idx += 1
            continue

        # Standalone Nw (e.g. 3w without preceding Nm)
        if re.match(r'^\d+w$', t):
            result['workers'] = int(t[:-1])
            idx += 1
            continue

        # Multi-token features (check longest first)
        matched_feature = False
        for feat in ['kms-vault-v1', 'kms-vault-v2', 'kms-thales', 'intransit-encryption',
                     'compact-mode', 'mcg-only', 'encryption-key-vault', 'lso-vmdk',
                     'multi-storagecluster', 'pvdk', 'pgdb', 'sno-lvmo', 'rosa-hcp']:
            parts = feat.split('-')
            if tokens[idx:idx+len(parts)] == parts:
                features.append(feat)
                idx += len(parts)
                matched_feature = True
                break
        if matched_feature:
            continue

        # Single-token features
        if t in FILTER_FEATURES or t in FEATURE_LABELS:
            features.append(t)
            idx += 1
            continue

        # Unrecognized token — just add to features as-is
        if t and t not in ('', 'sno', 'lvmo'):
            features.append(t)
        idx += 1

    result['features'] = list(dict.fromkeys(features))  # dedupe preserving order
    result['title'] = _make_title(result)
    result['search_string'] = f"{job_name} {' '.join(result['features'])}"
    return result


def _make_title(r: dict) -> str:
    parts = []
    if r['platform']:
        p = PLATFORMS.get(r['platform'], r['platform'].upper())
        ins = r['installer'].upper() if r['installer'] else ''
        parts.append(f"{p} {ins}".strip())
    if r['az'] and r['az'] != '1az':
        parts.append(r['az'].upper())
    if r['storage']:
        parts.append(STORAGE_TYPES.get(r['storage'], r['storage'].upper()))
    nodes = f"{r['masters']}M"
    if r['workers'] == 0:
        nodes += ' Compact'
    else:
        nodes += f"+{r['workers']}W"
    parts.append(nodes)
    feat_labels = [FEATURE_LABELS.get(f, f.upper()) for f in r['features']
                   if f in FILTER_FEATURES or f in FEATURE_LABELS]
    if feat_labels:
        parts.append(' · '.join(feat_labels[:3]))  # cap at 3 for readability
    return ' · '.join(parts)
