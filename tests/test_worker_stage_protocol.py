import io
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub" / "worker"))
from stage_protocol import StageError, MAX_FRAME, canonical_bytes, decode_json, envelope, read_frame, write_frame


class StageProtocolTests(unittest.TestCase):
    def test_exact_utf8_round_trip(self):
        original = {"op": "合成測試", "sequence": 1, "items": [True, None, "繁體中文"]}
        stream = io.BytesIO()
        write_frame(stream, original)
        stream.seek(0)
        self.assertEqual(read_frame(stream), original)

    def test_duplicate_keys_are_not_silently_replaced(self):
        with self.assertRaisesRegex(StageError, "DUPLICATE_JSON_KEY"):
            decode_json(b'{"op":"commit","op":"run"}')

    def test_non_unicode_and_nul_are_rejected(self):
        for data in (b'{"x":"\\ud800"}', b'{"x":"\\u0000"}', b'{"x":"\xff"}'):
            with self.subTest(data=data), self.assertRaises(StageError):
                decode_json(data)

    def test_numbers_cannot_be_nonfinite_fractional_or_rounded(self):
        for text in ('{"x":NaN}', '{"x":Infinity}', '{"x":1.1}', '{"x":9007199254740992}'):
            with self.subTest(text=text), self.assertRaises(StageError):
                decode_json(text.encode())

    def test_frame_bound_before_body_read(self):
        for length in (0, MAX_FRAME + 1, 2**32 - 1):
            with self.subTest(length=length), self.assertRaisesRegex(StageError, "FRAME_SIZE_BOUND"):
                read_frame(io.BytesIO(struct.pack("!I", length)))

    def test_truncated_prefix_or_body(self):
        for data in (b"", b"\x00\x00", struct.pack("!I", 8) + b"{}"):
            with self.subTest(data=data), self.assertRaisesRegex(StageError, "FRAME_TRUNCATED"):
                read_frame(io.BytesIO(data))

    def test_unknown_operation_sequence_nonce_fields_fail_closed(self):
        nonce = "a" * 64
        valid = {"protocol": 1, "nonce": nonce, "sequence": 2, "op": "begin", "bundleSHA256": "b" * 64}
        envelope(valid, nonce=nonce, sequence=2, operation="begin", fields=("bundleSHA256",))
        changed = [dict(valid, op="run"), dict(valid, sequence=1), dict(valid, sequence=True),
                   dict(valid, nonce="c" * 64), dict(valid, path="/etc/passwd"), dict(valid, protocol=True)]
        for message in changed:
            with self.subTest(message=message), self.assertRaises(StageError):
                envelope(message, nonce=nonce, sequence=2, operation="begin", fields=("bundleSHA256",))

    def test_canonical_serialization_and_nesting_bound(self):
        self.assertEqual(canonical_bytes({"b": 2, "a": 1}), canonical_bytes({"a": 1, "b": 2}))
        value = "x"
        for _ in range(18):
            value = [value]
        with self.assertRaisesRegex(StageError, "JSON_COMPLEXITY_BOUND"):
            canonical_bytes({"nested": value})


if __name__ == "__main__":
    unittest.main()
