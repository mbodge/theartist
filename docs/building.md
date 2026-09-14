# Coding workshop

**Observed integration limitation:** the [first live trial](trials/astra-build-001.md) built and tested code but stalled before artifact publication. Cancellation was acknowledged without a terminal state; deletion returned HTTP 409. The source was recovered manually, and that job remains unresolved. This backend is not yet proven reliable for unattended use.

Live founders can now turn accepted experiment packages into executable prototypes. The coding agent receives the accepted brief, works in an OpenAI-hosted workspace, creates source files, runs commands, fixes failures, and returns files. The founder retains execution results as durable memory for later decisions.

## Run

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in your local `.env`. The model must support Agents API sessions as well as the founder's Responses calls. The key needs Agents read/write and Responses write permissions.

```sh
# Research, select, plan, review, then build an accepted experiment:
npm run studio -- tick --instance my-founder --provider openai

# Execute or resume an already accepted experiment:
npm run studio -- build CYCLE_ID --instance my-founder --provider openai

# Inspect explicit decisions, command logs, files, and usage:
npm run studio -- show CYCLE_ID --instance my-founder
npm run studio -- export --instance my-founder
```

`run` and `tick` automatically invoke the workshop after accepting a live founder experiment when `builder.enabled` is true. `tick` first resumes an unfinished build or earlier active cycle. Fixture demos never create coding sessions. This remains a one-shot worker; no background scheduler or deployment is installed by these commands.

## Operating limits

New founder policies enable one build per UTC day, a ten-minute worker deadline, thirty output files, and eight million output bytes. Existing policies without a `builder` section keep execution disabled. The builder is separate from the founder's structured-call allowance: one managed coding turn can contain multiple internal model and shell calls. Token usage is recorded when the API reports it. The deadline and daily job allowance are not a dollar spending cap.

The workspace has network access explicitly disabled. It can use installed Python/Node runtimes and standard libraries. It has no studio credentials or access to the host filesystem. Deliverables are downloaded as data, never executed by the harness on your computer. External messaging, purchases, and account creation are not implemented. A separate trusted publisher can deploy completed static browser apps when enabled; see [publishing](cloudflare.md).

The builder can make dependency-free CLIs and browser prototypes. Tasks needing unavailable datasets, dependencies, live integrations, or infrastructure must return a useful executable core with explicit limitations. Synthetic tests do not establish the founder's real-world success criterion.

## Recovery

A SQLite job is reserved before any remote work. Session creation carries the job ID as metadata and contains no model input. The returned session ID is saved before the first input is sent. If creation disconnects, recovery searches for that session instead of blindly creating another one. If submission disconnects, recovery polls the known session instead of submitting again. An unresolved creation stays pending for inspection; a request proven not to have reached the provider is not automatically resubmitted.

Workers claim a fenced ninety-second lease per poll. A completed root turn, executable output, and an observed completed command with no reported nonzero exit code are required for `built`. Idle sessions and model-written reports alone cannot satisfy this gate. `built` means source and completed command execution were observed; it does **not** certify that all tests passed, that the code is production ready, or that customers want it. The live API can return a null process exit code even for completed commands; the harness preserves null and does not invent a zero. Explicit nonzero exits cannot satisfy the execution gate. Inspect the retained logs and test results.

The worker cancels running work when it observes a studio pause or the deadline. Cancellation is confirmed by a terminal remote turn or, after sixty seconds without confirmation, successful deletion of the remote session. If deletion fails, the job remains cancelling and retains its identifiers for retry; no replacement build is admitted. The live provider has refused deletion of a still-active session with HTTP 409, so this is an attempted fallback, not a guaranteed hard kill. If the worker dies, remote work may continue until completion or until a resumed worker cancels it. Pause is therefore effective on the next running worker poll, not an immediate remote kill switch. Completed files are copied before deleting the hosted session. A failed cleanup can be retried by repeating the same `build` command.

## Public record

Each build retains its accepted input and hash, operating limits, session and turn identifiers, observed command output and exit codes, explicit assistant summary, usage, errors, and file hashes. Reasoning items are excluded. A compact result is added to durable memory; later founder cycles receive the previous execution status and file references.

Files are under `.studio/instances/NAME/builds/BUILD_ID/prototype/`. Archive schema version 5 (builds introduced in version 3, boards in version 4, deployments in version 5) includes public build records and hash-verified copies of their files. Private cycles and their builds are excluded. Exporting produces a local snapshot. The separate `publish` command, or an enabled live build/tick, publishes eligible apps and the catalog. It does not push generated code to GitHub.

## Provider references

The adapter uses the [Agents API session lifecycle](https://developers.openai.com/api/docs/guides/agents-api/sessions), [hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted), and [file artifacts](https://developers.openai.com/api/docs/guides/agents-api/environments/files). The studio's durable memory is independent of provider session lifetime.
