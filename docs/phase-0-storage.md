# Phase 0 Storage

Phase 0 uses a local content-addressed filesystem store. It deliberately does not use SQLite or a
mutable index.

## Layout

```text
.abilitybench/
  objects/
    sha256/
      <64-character digest>
  runs/
    run_<64-character digest>.json
```

Artifact files contain canonical JSON bytes. Their expected digest comes from the filename and is
verified whenever the artifact is read.

Run files contain canonical finalized manifests. The manifest hash is embedded in both the run ID
and filename. Loading a run verifies the manifest body, run ID, exact supported fields, timestamps,
and nested stage records before returning a deeply frozen value.

## Write protocol

Writes follow an immutable publication protocol:

1. Validate and encode the complete value.
2. Create a uniquely named temporary file in the destination directory.
3. Publish it with an atomic, exclusive hard link.
4. If content already exists, compare its bytes instead of overwriting it.
5. Remove the temporary file in a `finally` block.

Temporary files are never treated as committed content. A process interruption can leave a temp
file, but it cannot create a partially committed object or run manifest.

## Security boundary

Artifact hashes and run IDs must match strict lowercase SHA-256 formats before a path is created.
User-provided path fragments are never joined into storage paths. This prevents traversal outside
the configured storage root.

Local content addressing detects corruption and accidental replacement. It is not authentication
against an attacker who can rewrite both data and every reference to it.

