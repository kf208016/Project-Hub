"""Real Linux refusal checks in a fresh, private deployment subdirectory."""
import base64
import errno
import hashlib
import io
import os
import stat
from stage_protocol import StageError, canonical_bytes, require, write_frame


def run_checks(root, nonce, helpers):
    name = "checks-" + nonce[:16]
    os.mkdir(name, 0o700, dir_fd=root)
    os.fsync(root)
    directory = helpers["open_child_directory"](root, name, private=True)
    initial = helpers["identity"](os.fstat(directory))
    owned = {}
    completed = []
    def remember(filename, expected_bytes=None):
        metadata = os.stat(filename, dir_fd=directory, follow_symlinks=False)
        owned[filename] = (helpers["identity"](metadata), expected_bytes)

    try:
        sample = canonical_bytes({"id": 1})
        helpers["write_new"](directory, "sample.json", sample)
        remember("sample.json", sample)
        try:
            helpers["write_new"](directory, "sample.json", b"replacement")
            raise StageError("CREATE_ONLY_CHECK_FAILED")
        except FileExistsError:
            require(helpers["read_small"](directory, "sample.json") == {"id": 1}, "CREATE_ONLY_CHECK_FAILED")
        completed.append("create-only-preserves-existing")

        os.symlink("/etc/passwd", "external-link", dir_fd=directory)
        remember("external-link")
        try:
            helpers["read_small"](directory, "external-link")
            raise StageError("NOFOLLOW_CHECK_FAILED")
        except OSError as error:
            require(error.errno in (errno.ELOOP, errno.ENOTDIR), "NOFOLLOW_CHECK_FAILED")
        completed.append("symlink-read-refused")

        os.link("sample.json", "sample.link", src_dir_fd=directory, dst_dir_fd=directory,
                follow_symlinks=False)
        remember("sample.link", sample)
        try:
            helpers["read_small"](directory, "sample.link")
            raise StageError("HARDLINK_CHECK_FAILED")
        except StageError as error:
            require(error.code == "OWNERSHIP_RECEIPT_INVALID", "HARDLINK_CHECK_FAILED")
        completed.append("hardlink-receipt-refused")

        try:
            helpers["open_child_directory"](directory, "..")
            raise StageError("TRAVERSAL_CHECK_FAILED")
        except StageError as error:
            require(error.code == "DIRECTORY_NAME_REJECTED", "TRAVERSAL_CHECK_FAILED")
        completed.append("parent-traversal-refused")

        incoming = io.BytesIO()
        write_frame(incoming, {"protocol": 1, "nonce": nonce, "sequence": 3,
                               "op": "file-begin", "path": "bin/claude"})
        write_frame(incoming, {"protocol": 1, "nonce": nonce, "sequence": 4,
                               "op": "file-chunk", "data": base64.b64encode(b"bad!").decode("ascii")})
        incoming.seek(0)
        try:
            helpers["receive_asset"](incoming, io.BytesIO(), directory,
                    {"path": "bin/claude", "bytes": 4, "sha256": hashlib.sha256(b"good").hexdigest(), "mode": 0o555},
                    nonce, 3, "/")
            raise StageError("DIGEST_REFUSAL_CHECK_FAILED")
        except StageError as error:
            require(error.code == "ASSET_DIGEST_REJECTED", "DIGEST_REFUSAL_CHECK_FAILED")
        remember("claude", b"bad!")
        require(stat.S_IMODE(os.stat("claude", dir_fd=directory, follow_symlinks=False).st_mode) == 0o600,
                "REJECTED_FILE_MODE_CHECK_FAILED")
        completed.append("wrong-digest-remains-unexecutable")
        return {"passed": True, "cases": completed, "testDirectoryRemoved": True}
    finally:
        try:
            require(set(os.listdir(directory)) == set(owned), "CHECK_CLEANUP_UNKNOWN_FILE")
            for filename, (expected_identity, expected_bytes) in owned.items():
                metadata = os.stat(filename, dir_fd=directory, follow_symlinks=False)
                require(helpers["identity"](metadata) == expected_identity, "CHECK_CLEANUP_IDENTITY_CHANGED")
                if expected_bytes is not None:
                    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
                    try:
                        require(os.read(descriptor, len(expected_bytes) + 1) == expected_bytes,
                                "CHECK_CLEANUP_CONTENT_CHANGED")
                    finally:
                        os.close(descriptor)
            require(helpers["identity"](os.stat(name, dir_fd=root, follow_symlinks=False)) == initial,
                    "CHECK_DIRECTORY_IDENTITY_CHANGED")
            for filename in owned:
                os.unlink(filename, dir_fd=directory)
            os.fsync(directory)
            os.rmdir(name, dir_fd=root)
            os.fsync(root)
        finally:
            os.close(directory)
