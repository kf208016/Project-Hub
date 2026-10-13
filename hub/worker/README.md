# Linux private CLI stage

This first worker component receives only the fixed native Claude 2.1.295,
Grok 1.0.50, socat 1.8.1.1-1ubuntu0.1 and libwrap0 artifacts and their notices.
It uses bounded, ordered JSON frames, exact digests, directory descriptors,
create-only files and a private ownership receipt under the SSH user's
`~/.local/share/project-hub-worker`.

It does not execute a binary, log in a provider, invoke a model or make a
provider ready. `stageComplete` means the staged file bytes and receipt were
flushed and verified. Grok's official HTTPS distribution consistency remains
distinct from a publisher signature or source-build attestation.

Each attempt receives a separate release directory identified by the bundle
digest and request nonce. Partial attempts remain for inspection and count
towards the 8 GiB private storage admission limit. Existing unknown ownership,
links, path changes, resource shortfall or digest failures are rejected.

`private_stage.py` requires nonroot x86_64 Linux, glibc >= 2.42, root-owned
OpenSSL runtime libraries, available RAM >= 10 GiB and disk >= 20 GiB. It has
a 540-second remote deadline and no arbitrary command or path operation.
The operator's SSH transport remains responsible for authentication, exact
host pin and its own independent deadline; an unconfirmed disconnect is not
proof of remote completion or cleanup.

The Windows operator uses `../lib/worker-bootstrap.js`: a Python loader command
bounded to 1024 UTF-8 bytes, followed by a four-byte length and compressed source
on SSH stdin. Fixed length/digests, bounded decompression and the same buffered
stdin preserve subsequent typed frames. This avoids observed truncation of long
quoted argv by Git/MSYS when launched from native Windows Node. Dynamic source
bootstrap belongs only to the approved owner deployment password channel; it
must not be accepted by a future restricted connection-key entrypoint.

`stage-request.example.json` uses the exact digest of this fixed artifact set.
Its example nonce must be replaced with a fresh cryptographic nonce for a real
connection. Runtime input must also satisfy `../windows/worker-stage.schema.json`
and the stricter ordered protocol state checks.

Portable protocol validation:

```powershell
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
```

Linux filesystem containment, resource limits, offline CLI protocol and Hub
integration require their separate real validation gates described in the
approved SSH worker design and implementation plan.
