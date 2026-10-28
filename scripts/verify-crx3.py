#!/usr/bin/env python3
"""Validate a stable-ID Chrome CRX3 package and write build metadata."""
import hashlib
import io
import json
import os
import pathlib
import struct
import subprocess
import sys
import tempfile
import zipfile

if len(sys.argv) != 5:
    raise SystemExit("usage: verify-crx3.py CRX SOURCE_SHA PUBLIC_KEY_DER BUILD_INFO")

path = pathlib.Path(sys.argv[1])
source_sha = sys.argv[2]
expected_public_key = pathlib.Path(sys.argv[3]).read_bytes()
build_info_path = pathlib.Path(sys.argv[4])
expected_extension_id = os.environ["EXPECTED_EXTENSION_ID"]
data = path.read_bytes()
if len(data) < 12 or data[:4] != b"Cr24":
    raise SystemExit("CRX magic header is invalid")
crx_version = struct.unpack_from("<I", data, 4)[0]
if crx_version != 3:
    raise SystemExit(f"Expected CRX3, got CRX version {crx_version}")
header_size = struct.unpack_from("<I", data, 8)[0]
header_start = 12
header_end = header_start + header_size
if header_size <= 0 or header_end >= len(data):
    raise SystemExit("CRX3 header length is invalid")


def read_varint(buf, pos):
    value = 0
    shift = 0
    while pos < len(buf) and shift < 70:
        byte = buf[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, pos
        shift += 7
    raise SystemExit("Malformed protobuf varint in CRX3 header")


def fields(buf):
    pos = 0
    while pos < len(buf):
        tag, pos = read_varint(buf, pos)
        number, wire_type = tag >> 3, tag & 7
        if number == 0:
            raise SystemExit("Malformed protobuf field in CRX3 header")
        if wire_type == 0:
            value, pos = read_varint(buf, pos)
        elif wire_type == 1:
            value, pos = buf[pos : pos + 8], pos + 8
            if len(value) != 8:
                raise SystemExit("Truncated fixed64 field in CRX3 header")
        elif wire_type == 2:
            length, pos = read_varint(buf, pos)
            value, pos = buf[pos : pos + length], pos + length
            if len(value) != length:
                raise SystemExit("Truncated protobuf field in CRX3 header")
        elif wire_type == 5:
            value, pos = buf[pos : pos + 4], pos + 4
            if len(value) != 4:
                raise SystemExit("Truncated fixed32 field in CRX3 header")
        else:
            raise SystemExit(f"Unsupported protobuf wire type {wire_type}")
        yield number, wire_type, value


header = data[header_start:header_end]
embedded_public_keys = []
for number, wire_type, proof in fields(header):
    if number in (2, 3) and wire_type == 2:
        for proof_number, proof_wire, proof_value in fields(proof):
            if proof_number == 1 and proof_wire == 2:
                embedded_public_keys.append(proof_value)
if expected_public_key not in embedded_public_keys:
    raise SystemExit("CRX public key does not match the configured persistent signing key")

rsa_signature = None
signed_header_data = None
for number, wire_type, value in fields(header):
    if number == 10000 and wire_type == 2:
        signed_header_data = value
    elif number == 2 and wire_type == 2:
        proof_fields = {n: v for n, w, v in fields(value) if w == 2}
        if proof_fields.get(1) == expected_public_key:
            rsa_signature = proof_fields.get(2)
if not rsa_signature or not signed_header_data:
    raise SystemExit("CRX3 is missing the persistent-key RSA proof or signed header")

extension_id_alphabet = "abcdefghijklmnop"
digest = hashlib.sha256(expected_public_key).digest()[:16]
extension_id = "".join(
    extension_id_alphabet[nibble]
    for byte in digest
    for nibble in (byte >> 4, byte & 0x0F)
)
if extension_id != expected_extension_id:
    raise SystemExit("Signing key changed: extension ID does not match the pinned stable ID")
signed_fields = {n: v for n, w, v in fields(signed_header_data) if w == 2}
if signed_fields.get(1) != digest:
    raise SystemExit("CRX3 signed extension ID does not match the persistent signing key")
with tempfile.TemporaryDirectory(prefix="multipass-crx3-verify-") as temporary:
    temporary = pathlib.Path(temporary)
    public_pem = temporary / "public.pem"
    signature_file = temporary / "signature.bin"
    signed_input = temporary / "signed-input.bin"
    signature_file.write_bytes(rsa_signature)
    signed_input.write_bytes(
        b"CRX3 SignedData\x00"
        + struct.pack("<I", len(signed_header_data))
        + signed_header_data
        + data[header_end:]
    )
    subprocess.run(
        ["openssl", "pkey", "-pubin", "-inform", "DER", "-in", sys.argv[3], "-out", str(public_pem)],
        check=True,
    )
    subprocess.run(
        ["openssl", "dgst", "-sha256", "-verify", str(public_pem), "-signature", str(signature_file), str(signed_input)],
        check=True,
    )
print("CRX3 RSA SHA-256 signature verified.")
archive = zipfile.ZipFile(io.BytesIO(data[header_end:]))
bad_member = archive.testzip()
if bad_member:
    raise SystemExit(f"ZIP CRC validation failed for {bad_member}")
members = archive.namelist()
if "manifest.json" not in members or "js/extension.js" not in members:
    raise SystemExit("CRX payload is missing required extension files")
manifest = json.loads(archive.read("manifest.json"))
expected_version = json.loads(pathlib.Path("package.json").read_text(encoding="utf-8"))["version"]
if manifest.get("version") != expected_version:
    raise SystemExit(f"Unexpected manifest version: {manifest.get('version')}")
checksum = hashlib.sha256(data).hexdigest()
print(f"Validated CRX3 package: {path.name} ({len(data)} bytes)")
print(f"Embedded extension version: {manifest['version']}")
print(f"Stable extension ID: {extension_id}")
print(f"Source commit: {source_sha}")
print(f"SHA-256: {checksum}")
build_info_path.parent.mkdir(parents=True, exist_ok=True)
build_info_path.write_text(
    f"source_commit={source_sha}\n"
    f"extension_version={manifest['version']}\n"
    f"extension_id={extension_id}\n"
    f"crx_file={path.name}\n"
    f"crx_sha256={checksum}\n"
    f"crx3_validated=true\n"
    f"crx_signature_validated=true\n",
    encoding="utf-8",
)
summary = pathlib.Path(os.environ.get("GITHUB_STEP_SUMMARY", "artifacts/build-summary.md"))
if summary.exists():
    with summary.open("a", encoding="utf-8") as output:
        output.write(
            f"## Stable-ID CRX built successfully\n\n- Version: `{manifest['version']}`\n"
            f"- Extension ID: `{extension_id}`\n- SHA-256: `{checksum}`\n- Source: `{source_sha}`\n"
        )
