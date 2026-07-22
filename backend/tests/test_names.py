"""Unit tests for name suggestion flavor logic (mirrors frontend jobFlavor)."""
import pytest

# The flavor abbreviation logic lives in the frontend (Deploy.tsx jobFlavor).
# The backend suggest_name endpoint receives the pre-built flavor string and
# appends it to the username. We test the name construction logic here.

PLAT_SHORT = {
    "aws": "a", "vsphere": "v", "azure": "az", "ibmcloud": "ib",
    "baremetal": "bm", "gcp": "g", "rhv": "r",
}
STOR_SHORT = {
    "vsan": "vs", "vmfs": "vm", "lso-rdm": "lr", "lso-vmdk": "lv",
    "nvme-intel": "nv", "lso": "ls", "nvme": "nv", "sts": "st",
}


def job_flavor(platform: str, storage: str, features: list[str]) -> str:
    """Python mirror of the frontend jobFlavor() function."""
    plat = PLAT_SHORT.get(platform, platform[:2] if platform else "")
    stor = STOR_SHORT.get(storage, storage[:2] if storage else "")
    v6   = "v6" if "ipv6" in features else ""
    fips = "f"  if "fips" in features else ""
    return "-".join(p for p in [plat, stor, v6, fips] if p)


def suggest_name(username: str, flavor: str, taken: set[str] | None = None) -> str:
    """Mirror of the suggest_name slot logic (without Jenkins calls)."""
    taken = taken or set()
    slots = [""] + [str(i) for i in range(1, 10)]
    free = next((s for s in slots if s not in taken), "9")
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
                break
        name = prefix + ("-" + "-".join(chosen) if chosen else "")
    else:
        name = prefix
    return name


# ── jobFlavor ─────────────────────────────────────────────────────────────────

def test_flavor_vsphere_vsan():
    assert job_flavor("vsphere", "vsan", []) == "v-vs"


def test_flavor_aws_no_storage():
    assert job_flavor("aws", "", []) == "a"


def test_flavor_ibmcloud_ipv6():
    assert job_flavor("ibmcloud", "", ["ipv6"]) == "ib-v6"


def test_flavor_vsphere_vsan_fips():
    assert job_flavor("vsphere", "vsan", ["fips"]) == "v-vs-f"


def test_flavor_aws_ipv6_fips():
    assert job_flavor("aws", "", ["ipv6", "fips"]) == "a-v6-f"


def test_flavor_unknown_platform():
    # falls back to first 2 chars
    f = job_flavor("gcp", "", [])
    assert f == "g"


def test_flavor_lso_rdm():
    assert job_flavor("vsphere", "lso-rdm", []) == "v-lr"


# ── suggest_name ──────────────────────────────────────────────────────────────

def test_name_starts_with_username():
    name = suggest_name("srozen", "v-vs")
    assert name.startswith("srozen")


def test_name_contains_flavor():
    name = suggest_name("srozen", "v-vs")
    assert "v-vs" in name


def test_name_no_flavor():
    name = suggest_name("srozen", "")
    assert name == "srozen"


def test_name_slot_collision():
    # Slot "" is taken, should use "1"
    name = suggest_name("srozen", "v-vs", taken={""})
    assert name.startswith("srozen1")


def test_name_max_length():
    # Long flavor should be trimmed at token boundary, never exceed 15 chars
    name = suggest_name("srozen", "v-vs-f-extra-long-token")
    assert len(name) <= 15


def test_name_all_slots_taken():
    taken = {"", "1", "2", "3", "4", "5", "6", "7", "8"}
    name = suggest_name("srozen", "v-vs", taken=taken)
    assert name.startswith("srozen9")
