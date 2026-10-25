"""Test-only, loopback SSH2 password fixture. Never use as a real SSH server.

Requires the test environment's cryptography package; no installation or network
fetch occurs here. It implements only the algorithms and fixed probe below,
executes no processes, writes no files, and emits no received authentication data.
SSH framing/KEX follow RFC 4253 and RFC 8731. Host keys are ephemeral per run.

Startup stdout: {"port": N, "publicKey": "<base64 SSH host-key blob>",
                 "fingerprint": "SHA256:<base64>"}.
Invoke with --connections N (default 1). Each connection has a 20-second timeout.
The synthetic test password, never a user's credential, is fixed in this file.
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import socket
import struct
import sys

from cryptography.hazmat.primitives.asymmetric import ed25519, x25519
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


SYNTHETIC_PASSWORD = " Hub fixture 密碼 🔐 42 ".encode("utf-8")
SERVER_VERSION = b"SSH-2.0-ProjectHubVaultTestFixture_1"
MAX_PACKET = 65536


def uint32(value):
    return struct.pack(">I", value)


def ssh_string(value):
    return uint32(len(value)) + value


def mpint(raw):
    raw = raw.lstrip(b"\0")
    if raw and raw[0] & 0x80:
        raw = b"\0" + raw
    return ssh_string(raw)


class Reader:
    def __init__(self, payload):
        self.payload = payload
        self.offset = 0

    def take(self, length):
        if length < 0 or self.offset + length > len(self.payload):
            raise ValueError("truncated message")
        value = self.payload[self.offset:self.offset + length]
        self.offset += length
        return value

    def number(self):
        return struct.unpack(">I", self.take(4))[0]

    def string(self):
        return self.take(self.number())

    def boolean(self):
        value = self.take(1)
        if value not in (b"\0", b"\1"):
            raise ValueError("invalid boolean")
        return value == b"\1"

    def end(self):
        if self.offset != len(self.payload):
            raise ValueError("unexpected trailing bytes")


class Transport:
    def __init__(self, connection):
        self.connection = connection
        self.send_sequence = 0
        self.receive_sequence = 0
        self.encryptor = None
        self.decryptor = None
        self.send_mac = None
        self.receive_mac = None

    def exact(self, length):
        data = bytearray()
        while len(data) < length:
            chunk = self.connection.recv(length - len(data))
            if not chunk:
                raise EOFError("connection closed")
            data.extend(chunk)
        return bytes(data)

    def send(self, payload):
        block = 16 if self.encryptor else 8
        padding = block - ((len(payload) + 5) % block)
        if padding < 4:
            padding += block
        packet = uint32(len(payload) + padding + 1) + bytes([padding]) + payload + os.urandom(padding)
        if self.encryptor:
            mac = hmac.digest(self.send_mac, uint32(self.send_sequence) + packet, "sha256")
            self.connection.sendall(self.encryptor.update(packet) + mac)
        else:
            self.connection.sendall(packet)
        self.send_sequence += 1

    def receive(self):
        block = 16 if self.decryptor else 8
        first = self.exact(block)
        if self.decryptor:
            first = self.decryptor.update(first)
        length = struct.unpack(">I", first[:4])[0]
        if not 5 <= length <= MAX_PACKET or (length + 4) % block:
            raise ValueError("invalid packet length")
        rest = self.exact(length + 4 - block)
        if self.decryptor:
            rest = self.decryptor.update(rest)
        packet = first + rest
        if self.decryptor:
            expected = hmac.digest(self.receive_mac, uint32(self.receive_sequence) + packet, "sha256")
            if not hmac.compare_digest(self.exact(32), expected):
                raise ValueError("invalid packet MAC")
        self.receive_sequence += 1
        padding = packet[4]
        if padding < 4 or padding >= length - 1:
            raise ValueError("invalid padding")
        return packet[5:-padding]

    def message(self):
        for _ in range(8):
            payload = self.receive()
            if payload[0] not in (2, 4):  # bounded SSH IGNORE/DEBUG
                return payload
        raise ValueError("too many ignored messages")


def kex(transport, host_key, host_blob):
    transport.connection.sendall(SERVER_VERSION + b"\r\n")
    client_version = bytearray()
    while not client_version.endswith(b"\n"):
        if len(client_version) >= 255:
            raise ValueError("invalid SSH version")
        client_version.extend(transport.exact(1))
    client_version = bytes(client_version).rstrip(b"\r\n")
    if not client_version.startswith(b"SSH-2.0-"):
        raise ValueError("invalid SSH version")

    names = [b"curve25519-sha256", b"ssh-ed25519", b"aes128-ctr", b"aes128-ctr",
             b"hmac-sha2-256", b"hmac-sha2-256", b"none", b"none", b"", b""]
    server_kex = b"\x14" + os.urandom(16) + b"".join(ssh_string(n) for n in names) + b"\0" + uint32(0)
    transport.send(server_kex)
    client_kex = transport.message()
    if client_kex[0] != 20:
        raise ValueError("expected KEXINIT")
    reader = Reader(client_kex[1:])
    reader.take(16)
    offered = [reader.string().split(b",") for _ in range(10)]
    follows = reader.boolean()
    if reader.number() != 0:
        raise ValueError("invalid KEXINIT reserved value")
    reader.end()
    if follows or any(names[i] not in offered[i] for i in range(8)):
        raise ValueError("unsupported SSH algorithm")

    init = transport.message()
    if init[0] != 30:
        raise ValueError("expected ECDH init")
    reader = Reader(init[1:])
    client_public = reader.string()
    reader.end()
    if len(client_public) != 32:
        raise ValueError("invalid ECDH public key")
    ephemeral = x25519.X25519PrivateKey.generate()
    server_public = ephemeral.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    shared = ephemeral.exchange(x25519.X25519PublicKey.from_public_bytes(client_public))
    encoded_shared = mpint(shared)
    exchange_hash = hashlib.sha256(b"".join(ssh_string(p) for p in (
        client_version, SERVER_VERSION, client_kex, server_kex, host_blob, client_public, server_public
    )) + encoded_shared).digest()
    signature = ssh_string(b"ssh-ed25519") + ssh_string(host_key.sign(exchange_hash))
    transport.send(b"\x1f" + ssh_string(host_blob) + ssh_string(server_public) + ssh_string(signature))
    transport.send(b"\x15")
    if transport.message() != b"\x15":
        raise ValueError("expected NEWKEYS")

    def key(letter):
        return hashlib.sha256(encoded_shared + exchange_hash + letter + exchange_hash).digest()

    transport.decryptor = Cipher(algorithms.AES(key(b"C")[:16]), modes.CTR(key(b"A")[:16])).decryptor()
    transport.encryptor = Cipher(algorithms.AES(key(b"D")[:16]), modes.CTR(key(b"B")[:16])).encryptor()
    transport.receive_mac = key(b"E")
    transport.send_mac = key(b"F")


def authenticate(transport):
    request = transport.message()
    if request != b"\x05" + ssh_string(b"ssh-userauth"):
        raise ValueError("expected userauth service")
    transport.send(b"\x06" + ssh_string(b"ssh-userauth"))
    for _ in range(3):
        request = transport.message()
        if request[0] != 50:
            raise ValueError("expected userauth request")
        reader = Reader(request[1:])
        username, service, method = reader.string(), reader.string(), reader.string()
        if username != b"fixture" or service != b"ssh-connection":
            raise ValueError("unexpected auth identity")
        if method == b"none":
            reader.end()
            transport.send(b"\x33" + ssh_string(b"password") + b"\0")
        elif method == b"password":
            changing = reader.boolean()
            supplied = reader.string()
            reader.end()
            accepted = not changing and hmac.compare_digest(supplied, SYNTHETIC_PASSWORD)
            del supplied
            if accepted:
                transport.send(b"\x34")
                return
            transport.send(b"\x33" + ssh_string(b"password") + b"\0")
            raise ValueError("synthetic password rejected")
        else:
            raise ValueError("unsupported authentication method")
    raise ValueError("authentication limit exceeded")


def fixed_probe(transport):
    request = transport.message()
    if request[0] != 90:
        raise ValueError("expected session channel")
    reader = Reader(request[1:])
    kind = reader.string()
    client_channel, window, packet = reader.number(), reader.number(), reader.number()
    reader.end()
    if kind != b"session" or window < 1024 or packet < 1024:
        raise ValueError("unsupported channel")
    transport.send(b"\x5b" + uint32(client_channel) + uint32(0) + uint32(1048576) + uint32(32768))
    for _ in range(8):
        request = transport.message()
        if request[0] == 80:  # OpenSSH no-more-sessions global request
            reader = Reader(request[1:])
            name, want_reply = reader.string(), reader.boolean()
            reader.end()
            if name != b"no-more-sessions@openssh.com":
                raise ValueError("unsupported global request")
            if want_reply:
                transport.send(b"\x52")
            continue
        if request[0] != 98:
            raise ValueError("expected exec request")
        reader = Reader(request[1:])
        recipient, name, want_reply = reader.number(), reader.string(), reader.boolean()
        if recipient != 0:
            raise ValueError("unknown channel")
        if name == b"env":
            reader.string()
            reader.string()
            reader.end()
            if want_reply:
                transport.send(b"\x64" + uint32(client_channel))
            continue
        if name != b"exec":
            raise ValueError("only fixed exec probe is permitted")
        command = reader.string()
        reader.end()
        command_prefix = b"python3 -I -c 'import os;print(\"HUB_SSH_IDENTITY_V1:"
        command_suffix = b":\"+str(os.getuid()))'"
        match = re.fullmatch(re.escape(command_prefix) + rb"([0-9a-f]{32})" + re.escape(command_suffix), command)
        if not match:
            raise ValueError("unexpected fixture command")
        if want_reply:
            transport.send(b"\x63" + uint32(client_channel))
        response = b"HUB_SSH_IDENTITY_V1:" + match[1] + b":1000\n"
        transport.send(b"\x5e" + uint32(client_channel) + ssh_string(response))
        transport.send(b"\x62" + uint32(client_channel) + ssh_string(b"exit-status") + b"\0" + uint32(0))
        transport.send(b"\x60" + uint32(client_channel))
        transport.send(b"\x61" + uint32(client_channel))
        # Drain the peer's channel close, ensuring preceding data is received.
        for _ in range(8):
            request = transport.message()
            if request[0] in (1, 97):
                return
            if request[0] not in (93, 96):
                raise ValueError("unexpected terminal channel message")
        raise ValueError("channel close missing")
    raise ValueError("exec request missing")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connections", type=int, default=1, choices=range(1, 17))
    arguments = parser.parse_args()
    host_key = ed25519.Ed25519PrivateKey.generate()
    host_blob = ssh_string(b"ssh-ed25519") + ssh_string(host_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))
    failed = False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(30)
        fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(host_blob).digest()).decode("ascii").rstrip("=")
        print(json.dumps({"port": listener.getsockname()[1], "publicKey": base64.b64encode(host_blob).decode("ascii"), "fingerprint": fingerprint}), flush=True)
        for _ in range(arguments.connections):
            try:
                connection, peer = listener.accept()
                with connection:
                    if peer[0] != "127.0.0.1":
                        raise ValueError("non-loopback peer")
                    connection.settimeout(20)
                    transport = Transport(connection)
                    kex(transport, host_key, host_blob)
                    authenticate(transport)
                    fixed_probe(transport)
            except (ValueError, EOFError, TimeoutError, OSError) as error:
                failed = True
                # Fixed internal error codes only; never print peer data/password.
                print(json.dumps({"event": "fixture_rejected", "errorType": type(error).__name__}), file=sys.stderr, flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
