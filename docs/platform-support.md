# Platform Support

Phase 0 has a deliberately narrow runtime contract.

## Runtime

| Component | Phase 0 contract |
| --- | --- |
| Node.js | 24.20.0 or newer within the Node 24 release line |
| Package manager | pnpm 12.5.1, pinned by `packageManager` and the lockfile |
| Module format | ESM |
| Workflow/config source | JavaScript, or TypeScript syntax that Node.js can erase without transformation |
| Text encoding | UTF-8 |
| Hashing | SHA-256 from Node.js `crypto` |

The package is not yet claiming compatibility with Node.js 25 or later. A later major Node release
must pass the full conformance suite before the engine range is widened.

Native TypeScript workflow loading does not transpile TypeScript features that require generated
JavaScript. Workflow and config files should avoid enums, parameter properties, namespaces, and
other transform-dependent syntax. The compiled AbilityBench package itself is ordinary ESM
JavaScript.

## Operating systems

| Platform | Status | Notes |
| --- | --- | --- |
| Windows 11 x64 | Verified locally | Primary Phase 0 development platform; junction containment is covered |
| Linux x64 | Provisional | Code paths and POSIX permission regression exist, but release CI is not established |
| macOS arm64/x64 | Provisional | Expected to work; not yet part of a release gate |
| Network filesystems | Unsupported | Hard-link atomicity and consistency semantics vary |

“Provisional” means the design is intended to be portable, not that a release guarantee exists.
Before package publication, Linux and macOS must run the same `pnpm check` gate in clean
environments.

## Filesystem requirements

The workflow root and storage directory must be on a local filesystem that supports exclusive file
creation and hard links. Immutable publication creates a temporary file and hard-links it to its
content-addressed final name. The storage directory must remain on one filesystem volume.

AbilityBench hashes exact bytes. Line-ending conversion, generated-file differences, case
sensitivity, and Unicode filename normalization can therefore produce different fingerprints
across machines. This is conservative and intentional.

The engine resolves existing symbolic links and junctions before accepting watched or storage
paths. It does not promise safe operation if another process races by replacing path components
while containment checks or writes are in progress.
