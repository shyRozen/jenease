"""Unit tests for job_parser.parse_job() — covers all real job name patterns."""
import pytest
from job_parser import parse_job


def test_vsphere_upi_vsan():
    r = parse_job("qe-trigger-vsphere-upi-1az-rhcos-multus-public-vsan-3m-3w-deployment")
    assert r["platform"] == "vsphere"
    assert r["installer"] == "upi"
    assert r["storage"] == "vsan"
    assert r["masters"] == 3
    assert r["workers"] == 3
    assert "multus" in r["features"]


def test_aws_ipi_fips():
    r = parse_job("qe-trigger-aws-ipi-2az-rhcos-3m-3w-fips-deployment")
    assert r["platform"] == "aws"
    assert r["installer"] == "ipi"
    assert r["az"] == "2az"
    assert "fips" in r["features"]
    assert r["workers"] == 3


def test_ibmcloud_ipv6():
    r = parse_job("qe-trigger-ibmcloud-ipi-1az-rhcos-3m-3w-ipv6-deployment")
    assert r["platform"] == "ibmcloud"
    assert "ipv6" in r["features"]


def test_compact_mode_0_workers():
    r = parse_job("qe-trigger-vsphere-ipi-1az-rhcos-vsan-3m-0w-deployment")
    assert r["workers"] == 0


def test_lso_storage():
    r = parse_job("qe-trigger-aws-ipi-1az-rhcos-lso-3m-3w-deployment")
    assert r["storage"] == "lso"


def test_lso_rdm_multitoke():
    r = parse_job("qe-trigger-vsphere-upi-1az-rhcos-lso-rdm-3m-3w-deployment")
    assert r["storage"] == "lso-rdm"


def test_kms_vault_feature():
    r = parse_job("qe-trigger-aws-ipi-1az-rhcos-3m-3w-kms-vault-v1-deployment")
    assert "kms-vault-v1" in r["features"]


def test_multiple_features():
    r = parse_job("qe-trigger-aws-ipi-1az-rhcos-3m-3w-fips-encryption-deployment")
    assert "fips" in r["features"]
    assert "encryption" in r["features"]


def test_no_suffix_stripped():
    # job_name is preserved as-is
    name = "qe-trigger-aws-ipi-1az-rhcos-3m-3w-deployment"
    r = parse_job(name)
    assert r["job_name"] == name


def test_title_non_empty():
    r = parse_job("qe-trigger-vsphere-upi-1az-rhcos-vsan-3m-3w-deployment")
    assert r["title"]
    assert "vSphere" in r["title"]


def test_masters_workers_parsed():
    r = parse_job("qe-trigger-aws-ipi-1az-rhcos-5m-6w-deployment")
    assert r["masters"] == 5
    assert r["workers"] == 6


def test_unknown_platform_falls_through():
    r = parse_job("qe-trigger-unknown-ipi-1az-rhcos-3m-3w-deployment")
    assert r["platform"] is None


def test_baremetal():
    r = parse_job("qe-trigger-baremetal-ipi-1az-rhcos-3m-3w-deployment")
    assert r["platform"] == "baremetal"


def test_dedup_features():
    # Should not have duplicate features even if matched twice
    r = parse_job("qe-trigger-aws-ipi-1az-rhcos-3m-3w-fips-fips-deployment")
    assert r["features"].count("fips") == 1
