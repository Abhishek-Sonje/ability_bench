# Archie: second independent-agent integration (offline)

Wrap the existing sibling TypeScript architecture-documentation agent, not a new synthetic research pipeline. Uses only AbilityBench's public SDK; no provider/framework types in core and no new dependencies. Composio work stays parked. See [results and limitations](../../docs/archie-integration-results.md).

```powershell
pnpm.cmd build
node examples/archie-offline/prepare.mjs ../archie examples/archie-offline/.abilitybench
node examples/archie-offline/run.mjs <returned-project-root> none
node examples/archie-offline/run.mjs <returned-project-root> <baseline-id>
node examples/archie-offline/verify.mjs <returned-project-root> <baseline-id>
```

Preparation calls the original file/config/Git readers and `generateArchitecture()` from a type-erased isolated source snapshot. Only the SDK import is replaced with a local response double returning the existing `ARCHITECTURE.md`. The original prompt builders, retry loop and markdown normalization execute unchanged. No `.env` loader, ordinary CLI, hook installer or state writer is imported; no source-checkout files are changed. Existing dirty working-tree files are preserved; provenance says working-tree snapshot, not clean HEAD. Snapshot contents are local ignored data, not safe to publish automatically.

The retained document is **not newly generated**, and may be stale. The single mocked acquisition validates original control flow/prompt inputs/normalization, not present-day Gemini quality or availability. Existing inputs and output become an explicitly selected historical snapshot. Runs never import the provider SDK or silently reacquire anything.

```text
user-config ---+
identity-files +
tree-string ---+--> architecture --> publish (disabled by default)
source-files --+
git-history ---+
```

The five branches correspond to the inputs gathered by the original `init()` flow. Each watches its own snapshot file. `architecture` receives every branch output explicitly and verifies capture/input/output/original-generator implementation hashes. JSON is stored as strings in artifacts where original insertion/array order matters. A changed input or prompt rejects a stale acquisition; it does not silently attach an old answer to a new request.

Publication is non-cacheable and opt-in. `run.mjs ... --publish` calls the original `writeArchitecture()` only under the isolated project's `published/`, never the original repository, Git state or hooks. The verifier opts into that isolated write, checks exact bytes, exercises invalidation and restores its temporary snapshot edits. Tests' destructive corruption/quality cases use disposable fixtures only.

Developer declarations: complete snapshot files, ordered dependency outputs, original generator implementation, typed snapshot-read revision/publish control, publisher implementation, isolated output environment, and evaluation policy. `snapshotReadRevision`/manual invalidation rereads the selected snapshot; it does not refresh AI research. Mutable Git/tree/config acquisition and stochastic generation must not be called pure merely because a snapshot read is cacheable.

Evaluate the original mandatory heading sequence independently of execution. A correct heading sequence is not semantic/source-grounding proof. Evaluation never overwrites the document. Changing evaluation policy reevaluates both immutable runs without requiring generation; missing sections can fail evaluation even when execution completed.

The Node import mapping/type erasure is an example harness for this existing checkout, not a required developer architecture. A normal TypeScript agent can import its already-exported functions directly, explicitly capture volatile/provider results, and declare downstream transforms through the same SDK. No claim of zero integration work or automatic dependency discovery is made.
