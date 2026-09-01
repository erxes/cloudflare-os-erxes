# erxes agent instructions (deploy source)

Canonical text lives in `packages/workshop-shared/src/erxes-executor-guidance.ts` as `ERXES_INSTANCE_INSTRUCTIONS`.

`deploy-instance.ts` injects it into the backend worker as `INSTANCE_INSTRUCTIONS` unless an admin overrides instance instructions in the UI.
