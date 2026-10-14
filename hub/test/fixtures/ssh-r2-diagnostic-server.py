"""Loopback SSH fixture: exact identity probes or a fixed diagnostic byte stream.

No received command or Python payload is executed. Configuration and responses
are test-owned synthetic bytes. Password handling comes from the frozen fixture.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import socket
import stat
import sys

_spec = importlib.util.spec_from_file_location(
    "hub_maintenance_fixture", Path(__file__).with_name("ssh-maintenance-server.py")
)
maintenance = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(maintenance)
vault = maintenance.vault


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def case_file(path):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 65536:
        raise ValueError("fixture case file rejected")
    value = json.loads(path.read_bytes())
    if set(value) != {"command", "payloadSHA256", "payloadLength", "request", "response", "responseMode"}:
        raise ValueError("fixture case fields rejected")
    if value["responseMode"] not in ("framed", "malformed", "oversize", "valid-prefix-overflow", "wrong-exit"):
        raise ValueError("fixture response mode rejected")
    if not isinstance(value["command"], str) or not 1 <= len(value["command"].encode()) <= 1024:
        raise ValueError("fixture command bound")
    if type(value["payloadLength"]) is not int or not 1 <= value["payloadLength"] <= 1048576:
        raise ValueError("fixture payload bound")
    if not re.fullmatch("[a-f0-9]{64}", value["payloadSHA256"]):
        raise ValueError("fixture payload digest")
    return value


def send_result(transport, channel, response, exit_code):
    for start in range(0, len(response), 16384):
        transport.send(b"\x5e" + vault.uint32(channel) + vault.ssh_string(response[start:start + 16384]))
    transport.send(b"\x62" + vault.uint32(channel) + vault.ssh_string(b"exit-status") + b"\0" + vault.uint32(exit_code))
    transport.send(b"\x60" + vault.uint32(channel))
    transport.send(b"\x61" + vault.uint32(channel))
    for _ in range(16):
        packet = transport.message()
        if packet[0] in (1, 97):
            return
        if packet[0] not in (93, 96):
            raise ValueError("unexpected terminal channel message")
    raise ValueError("channel close missing")


def receive_input(transport, expected):
    data = bytearray()
    for _ in range(128):
        packet = transport.message()
        reader = vault.Reader(packet[1:])
        if packet[0] == 94:
            if reader.number() != 0:
                raise ValueError("unknown stdin channel")
            data.extend(reader.string())
            reader.end()
            if len(data) > expected["payloadLength"] + 4100:
                raise ValueError("fixture stdin bound")
        elif packet[0] == 96:
            if reader.number() != 0:
                raise ValueError("unknown stdin EOF channel")
            reader.end()
            break
        elif packet[0] != 93:
            raise ValueError("unexpected stdin packet")
    else:
        raise ValueError("stdin EOF missing")
    split = expected["payloadLength"]
    if len(data) < split + 4 or hashlib.sha256(data[:split]).hexdigest() != expected["payloadSHA256"]:
        raise ValueError("fixture payload mismatch")
    length = int.from_bytes(data[split:split + 4], "big")
    if not 1 <= length <= 4096 or len(data) != split + 4 + length:
        raise ValueError("fixture request frame rejected")
    request_bytes = bytes(data[split + 4:])
    request = json.loads(request_bytes)
    if canonical(request) != request_bytes or request != expected["request"]:
        raise ValueError("fixture request binding rejected")


def session(transport, configuration):
    packet = transport.message()
    if packet[0] != 90:
        raise ValueError("expected session channel")
    reader = vault.Reader(packet[1:])
    kind = reader.string()
    channel, window, maximum = reader.number(), reader.number(), reader.number()
    reader.end()
    if kind != b"session" or window < 1048576 or maximum < 16384:
        raise ValueError("unsupported session window")
    transport.send(b"\x5b" + vault.uint32(channel) + vault.uint32(0) + vault.uint32(1048576) + vault.uint32(32768))
    for _ in range(8):
        packet = transport.message()
        reader = vault.Reader(packet[1:])
        if packet[0] == 80:
            name, reply = reader.string(), reader.boolean()
            reader.end()
            if name != b"no-more-sessions@openssh.com":
                raise ValueError("unsupported global request")
            if reply:
                transport.send(b"\x52")
            continue
        if packet[0] != 98 or reader.number() != 0:
            raise ValueError("expected exec request")
        name, reply = reader.string(), reader.boolean()
        if name == b"env":
            reader.string(); reader.string(); reader.end()
            if reply:
                transport.send(b"\x64" + vault.uint32(channel))
            continue
        if name != b"exec":
            raise ValueError("only fixed exec permitted")
        command = reader.string(); reader.end()
        try:
            version, response = maintenance.identity(command, 1000)
        except ValueError:
            expected = case_file(configuration)
            if command != expected["command"].encode("utf-8"):
                raise ValueError("diagnostic command mismatch")
            if reply:
                transport.send(b"\x63" + vault.uint32(channel))
            receive_input(transport, expected)
            body = canonical(expected["response"])
            response = vault.uint32(len(body)) + body
            if expected["responseMode"] == "malformed":
                response = b"\x00\x00\x00\x10{}"
            elif expected["responseMode"] == "oversize":
                response = b"x" * (128 * 1024 + 1)
            elif expected["responseMode"] == "valid-prefix-overflow":
                response += b"x" * (128 * 1024 + 1)
            exit_code = 0 if expected["response"]["ok"] else 1
            if expected["responseMode"] == "wrong-exit":
                exit_code = 1 - exit_code
            send_result(transport, channel, response, exit_code)
            return {"event": "diagnostic", "inputMatched": True}
        if reply:
            transport.send(b"\x63" + vault.uint32(channel))
        send_result(transport, channel, response, 0)
        return {"event": "probe", "version": version}
    raise ValueError("exec request missing")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-file", required=True, type=Path)
    args = parser.parse_args()
    configuration = args.case_file
    if not configuration.is_absolute() or configuration.name != "diagnostic-case.json" or not re.fullmatch(r"vault-diagnostic-[a-f0-9]{12}-g", configuration.parent.name):
        raise ValueError("fixture configuration location rejected")
    key = vault.ed25519.Ed25519PrivateKey.generate()
    blob = vault.ssh_string(b"ssh-ed25519") + vault.ssh_string(key.public_key().public_bytes(vault.Encoding.Raw, vault.PublicFormat.Raw))
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0)); listener.listen(1); listener.settimeout(30)
        fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode("ascii").rstrip("=")
        print(json.dumps({"port": listener.getsockname()[1], "publicKey": base64.b64encode(blob).decode("ascii"), "fingerprint": fingerprint}), flush=True)
        for ordinal in range(32):
            try:
                connection, peer = listener.accept()
                with connection:
                    if peer[0] != "127.0.0.1":
                        raise ValueError("non-loopback peer")
                    print(json.dumps({"event": "accepted", "ordinal": ordinal + 1}), flush=True)
                    connection.settimeout(15)
                    transport = vault.Transport(connection)
                    vault.kex(transport, key, blob); vault.authenticate(transport)
                    print(json.dumps(session(transport, configuration)), flush=True)
            except (ValueError, EOFError, TimeoutError, OSError) as error:
                print(json.dumps({"event": "fixture_rejected", "errorType": type(error).__name__}), file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
