"""Bounded JSON frames for the private CLI deployment transport.

This protocol installs fixed artifacts only. It has no command execution,
provider login, model invocation, or run-approval operation.
"""
import json
import struct

MAX_FRAME = 1024 * 1024


class StageError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def require(condition, code):
    if not condition:
        raise StageError(code)


def _object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _unsupported_number(_):
    raise StageError("JSON_NUMBER_INVALID")


def _validate_tree(value, depth=0, budget=None):
    if budget is None:
        budget = [16384]
    budget[0] -= 1
    require(depth <= 16 and budget[0] >= 0, "JSON_COMPLEXITY_BOUND")
    if isinstance(value, str):
        try:
            value.encode("utf-8", errors="strict")
        except UnicodeError as error:
            raise StageError("JSON_UNICODE_INVALID") from error
        require("\0" not in value, "JSON_NUL_REJECTED")
    elif type(value) is int:
        require(-(2**53 - 1) <= value <= 2**53 - 1, "JSON_NUMBER_INVALID")
    elif type(value) is dict:
        for key, child in value.items():
            require(isinstance(key, str), "JSON_KEY_INVALID")
            _validate_tree(key, depth + 1, budget)
            _validate_tree(child, depth + 1, budget)
    elif type(value) is list:
        for child in value:
            _validate_tree(child, depth + 1, budget)
    else:
        require(value is None or type(value) is bool, "JSON_TYPE_INVALID")


def canonical_bytes(value):
    _validate_tree(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def decode_json(data):
    require(type(data) is bytes and 1 <= len(data) <= MAX_FRAME, "FRAME_SIZE_BOUND")
    try:
        value = json.loads(data.decode("utf-8", errors="strict"), object_pairs_hook=_object,
                           parse_float=_unsupported_number, parse_constant=_unsupported_number)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise StageError("FRAME_ENCODING_INVALID") from error
    require(type(value) is dict, "FRAME_OBJECT_REQUIRED")
    _validate_tree(value)
    return value


def read_exact(stream, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        require(type(chunk) is bytes and 0 < len(chunk) <= remaining, "FRAME_TRUNCATED")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(stream):
    length = struct.unpack("!I", read_exact(stream, 4))[0]
    require(1 <= length <= MAX_FRAME, "FRAME_SIZE_BOUND")
    return decode_json(read_exact(stream, length))


def write_frame(stream, value):
    data = canonical_bytes(value)
    require(1 <= len(data) <= MAX_FRAME, "FRAME_SIZE_BOUND")
    stream.write(struct.pack("!I", len(data)))
    stream.write(data)
    stream.flush()


def envelope(message, *, nonce, sequence, operation, fields=()):
    require(type(message) is dict and set(message) == {"protocol", "nonce", "sequence", "op", *fields},
            "FRAME_FIELDS_INVALID")
    require(type(message["protocol"]) is int and message["protocol"] == 1,
            "PROTOCOL_VERSION_REJECTED")
    require(type(message["sequence"]) is int and message["sequence"] == sequence,
            "FRAME_SEQUENCE_REJECTED")
    require(type(message["nonce"]) is str and message["nonce"] == nonce,
            "FRAME_NONCE_REJECTED")
    require(type(message["op"]) is str and message["op"] == operation,
            "FRAME_OPERATION_REJECTED")
