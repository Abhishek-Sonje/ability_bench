import { defineWorkflow } from "abilitybench";

export default defineWorkflow({ id: "loaded-fixture", root: import.meta.dirname })
  .stage({
    id: "source",
    dependsOn: [],
    implementation: "source-v1",
    watch: ["./workflow.ts"],
    inputs: [],
    env: [],
    cache: true,
    run: () => ({ loaded: true }),
  })
  .build();
