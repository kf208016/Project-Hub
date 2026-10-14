"""Loopback-only SSH fixture for native credential migration integration tests.

Reuses the reviewed synthetic password and SSH framing from ssh-vault-server.py.
Only the exact V1 / V2 identity commands are accepted. No command is executed;
no authentication data is written to disk or returned in diagnostics.
"""

import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import socket
import sys


_spec = importlib.util.spec_from_file_location(
    "hub_vault_fixture", Path(__file__).with_name("ssh-vault-server.py")
)
vault = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vault)

BOOT_ID = "3d68605d-fc17-42f4-972b-40a18df72dbc"
PREFIX_V1 = b'python3 -I -c \'import os;print("HUB_SSH_IDENTITY_V1:'
SUFFIX_V1 = b':"+str(os.getuid()))\''
PREFIX_V2 = b'/usr/bin/python3 -I -c \'import os;print("HUB_SSH_IDENTITY_V2:'
SUFFIX_V2 = (
    b':"+str(os.getuid())+":"+open("/proc/sys/kernel/random/boot_id")'
    b'.read().strip())\''
)


def identity(command, v2_uid):
    for version, prefix, suffix in (
        (1, PREFIX_V1, SUFFIX_V1), (2, PREFIX_V2, SUFFIX_V2)
    ):
        match = re.fullmatch(
            re.escape(prefix) + rb"([0-9a-f]{32})" + re.escape(suffix), command
        )
        if match:
            uid = 1000 if version == 1 else v2_uid
            response = b"HUB_SSH_IDENTITY_V" + str(version).encode("ascii")
            response += b":" + match[1] + b":" + str(uid).encode("ascii")
            if version == 2:
                response += b":" + BOOT_ID.encode("ascii")
            return version, response + b"\n"
    raise ValueError("unexpected fixture command")


def fixed_probe(transport, v2_uid):
    request = transport.message()
    if request[0] != 90:
        raise ValueError("expected session channel")
    reader = vault.Reader(request[1:])
    kind = reader.string()
    client_channel, window, packet = reader.number(), reader.number(), reader.number()
    reader.end()
    if kind != b"session" or window < 1024 or packet < 1024:
        raise ValueError("unsupported channel")
    transport.send(
        b"\x5b" + vault.uint32(client_channel) + vault.uint32(0)
        + vault.uint32(1048576) + vault.uint32(32768)
    )
    for _ in range(8):
        request = transport.message()
        if request[0] == 80:
            reader = vault.Reader(request[1:])
            name, want_reply = reader.string(), reader.boolean()
            reader.end()
            if name != b"no-more-sessions@openssh.com":
                raise ValueError("unsupported global request")
            if want_reply:
                transport.send(b"\x52")
            continue
        if request[0] != 98:
            raise ValueError("expected exec request")
        reader = vault.Reader(request[1:])
        recipient, name, want_reply = reader.number(), reader.string(), reader.boolean()
        if recipient != 0:
            raise ValueError("unknown channel")
        if name == b"env":
            reader.string()
            reader.string()
            reader.end()
            if want_reply:
                transport.send(b"\x64" + vault.uint32(client_channel))
            continue
        if name != b"exec":
            raise ValueError("only fixed exec probe is permitted")
        command = reader.string()
        reader.end()
        version, response = identity(command, v2_uid)
        if want_reply:
            transport.send(b"\x63" + vault.uint32(client_channel))
        transport.send(b"\x5e" + vault.uint32(client_channel) + vault.ssh_string(response))
        transport.send(
            b"\x62" + vault.uint32(client_channel) + vault.ssh_string(b"exit-status")
            + b"\0" + vault.uint32(0)
        )
        transport.send(b"\x60" + vault.uint32(client_channel))
        transport.send(b"\x61" + vault.uint32(client_channel))
        for _ in range(8):
            request = transport.message()
            if request[0] in (1, 97):
                return version
            if request[0] not in (93, 96):
                raise ValueError("unexpected terminal channel message")
        raise ValueError("channel close missing")
    raise ValueError("exec request missing")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connections", type=int, default=16, choices=range(1, 129))
    parser.add_argument("--v2-uid", type=int, default=1000, choices=(1000, 1001))
    arguments = parser.parse_args()
    host_key = vault.ed25519.Ed25519PrivateKey.generate()
    host_blob = vault.ssh_string(b"ssh-ed25519") + vault.ssh_string(
        host_key.public_key().public_bytes(vault.Encoding.Raw, vault.PublicFormat.Raw)
    )
    failed = False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(30)
        fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(host_blob).digest()).decode("ascii").rstrip("=")
        print(json.dumps({"port": listener.getsockname()[1], "publicKey": base64.b64encode(host_blob).decode("ascii"), "fingerprint": fingerprint}), flush=True)
        for ordinal in range(arguments.connections):
            try:
                connection, peer = listener.accept()
                with connection:
                    if peer[0] != "127.0.0.1":
                        raise ValueError("non-loopback peer")
                    connection.settimeout(20)
                    transport = vault.Transport(connection)
                    vault.kex(transport, host_key, host_blob)
                    vault.authenticate(transport)
                    version = fixed_probe(transport, arguments.v2_uid)
                    print(json.dumps({"event": "probe", "version": version, "ordinal": ordinal + 1}), flush=True)
            except (ValueError, EOFError, TimeoutError, OSError) as error:
                failed = True
                print(json.dumps({"event": "fixture_rejected", "errorType": type(error).__name__}), file=sys.stderr, flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
