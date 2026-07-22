"""Unit tests for JenkinsClient.parse_build_description() and _parse_topology()."""
import pytest
from jenkins import JenkinsClient
from cluster_health import _parse_topology


# ── parse_build_description ──────────────────────────────────────────────────

# Jenkins description format: label text precedes the href attribute
SAMPLE_DESC = """
<b>Status:</b> deployed<br/>
<b>Password:</b> abc123XYZ<br/>
<b>Jenkins slave IP:</b> 10.1.2.3<br/>
Web Console <a href="https://console-openshift-console.apps.srozen-v-vs.qe.rh-ocs.com">open</a>
kubeconfig <a href="http://magna002.ceph.redhat.com/ocsci-jenkins/openshift-clusters/srozen-v-vs/auth/kubeconfig">download</a>
Logs <a href="http://magna002.ceph.redhat.com/ocsci-jenkins/openshift-clusters/srozen-v-vs/logs">view</a>
"""


def test_parse_kubeconfig_url():
    r = JenkinsClient.parse_build_description(SAMPLE_DESC)
    assert "kubeconfig_url" in r
    assert "auth/kubeconfig" in r["kubeconfig_url"]


def test_parse_console_url():
    r = JenkinsClient.parse_build_description(SAMPLE_DESC)
    assert "console_url" in r
    assert "console-openshift" in r["console_url"]


def test_parse_password():
    r = JenkinsClient.parse_build_description(SAMPLE_DESC)
    assert r.get("kubeadmin_password") == "abc123XYZ"


def test_parse_agent_ip():
    r = JenkinsClient.parse_build_description(SAMPLE_DESC)
    assert r.get("agent_ip") == "10.1.2.3"


def test_parse_empty_description():
    assert JenkinsClient.parse_build_description("") == {}


def test_parse_none_description():
    assert JenkinsClient.parse_build_description(None) == {}


def test_parse_no_kubeconfig():
    r = JenkinsClient.parse_build_description("<b>Status:</b> building")
    assert "kubeconfig_url" not in r


# ── _parse_topology ───────────────────────────────────────────────────────────

def test_topology_3m_3w():
    assert _parse_topology("conf/deployment/vsphere/upi_1az_rhcos_vsan_3m_3w.yaml") == (3, 3)


def test_topology_3m_0w_compact():
    assert _parse_topology("conf/deployment/vsphere/ipi_1az_rhcos_vsan_3m_0w.yaml") == (3, 0)


def test_topology_5m_6w():
    assert _parse_topology("some/path/5m-6w-config.yaml") == (5, 6)


def test_topology_default_fallback():
    assert _parse_topology("") == (3, 3)
    assert _parse_topology("no-topology-here") == (3, 3)


def test_topology_dash_separator():
    assert _parse_topology("conf/3m-3w.yaml") == (3, 3)
