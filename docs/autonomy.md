# Autonomous operation

The running system has three hosts: GitHub Actions executes the Node studio and Docker workshop; OpenAI Responses supplies the models and public web search; Cloudflare Workers serves the published applications and catalog. No laptop daemon is required. This is one source repository with separate execution and publication resources.

## The loop

1. Restore the founder's authenticated, encrypted memory checkpoint.
2. Resume unfinished work, or start one deduplicated experiment for the current UTC date.
3. Search public sources, retrieve relevant memories, research, propose, and answer board guidance.
4. Produce an experiment specification. Critique it and accept, revise, or reject it.
5. For an accepted experiment, Astra uses a shell tool to write, execute, test, and repair a prototype in Docker. The harness records actual command output and exit codes.
6. Validate the output files. A static app needs a deployment manifest referring to an observed successful test command. Publish it to its own Cloudflare Worker and verify all published bytes.
7. Reflect on the build and publication results. Store the learning and unresolved questions; publish the public record. The next cycle receives prior execution and deployment records.
8. Inspect each published app in a restricted Chromium session at most once per UTC day; keep the latest observations available to future cycles.
9. Encrypt and save canonical memory, including after ordinary model, build, or deployment failures.

The founder can choose the problem and audience. Current production capability is self-contained browser products and downloadable runnable source. Real customer feedback must come from real observations; tests and availability do not establish demand. Social posting, outreach, purchases, and factory orders are not connected.

## Scheduling and control

[Autonomous studio](../.github/workflows/studio.yml) runs at minute 23 of each hour. The UTC daily trigger permits only one new experiment per day; hourly runs resume interrupted work. Jobs serialize with a concurrency group and stop after 40 minutes. The founder policy additionally caps stage calls, web actions, revisions, build time, build jobs, files, and publications. Each Docker build has at most 24 model requests, each capped at 12,000 output tokens. These are usage limits, not a precise dollar cap.

Use the GitHub Actions workflow's **Run workflow** menu with `pause`, `resume`, or `tick`. Pausing persists in canonical memory. Resume enables later hourly ticks. To disable all wakeups immediately, disable the workflow. Cancellation alone is not a persisted pause.

Schedules are best effort: GitHub may delay or drop runs during load, and disables public-repository schedules after 60 days of repository inactivity. This is a working v1 runner, not an always-on availability guarantee. See [GitHub's scheduler documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Memory and credentials

The `studio-state` branch contains `runtime/founder-001.enc`: gzip-compressed, AES-256-GCM authenticated state. Each write uses the previous GitHub file SHA, so a stale writer cannot overwrite newer memory. The snapshot contains a consistent SQLite backup, build files, workshop records, and deployment snapshots. Derived public exports can be regenerated. Restore validates identity, file paths, hashes, and sizes before writing. Missing, corrupted, or mismatched state stops the run; it never silently starts an amnesiac founder.

`STUDIO_STATE_KEY`, `OPENAI_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN` are GitHub repository secrets. The state key also lives in the launcher's ignored `.env`; keep that backup. The job's short-lived GitHub token only handles checkpoint storage. No secrets, repository checkout, host folders, or Docker socket are mounted into the coding container. Generated code runs as UID 1000 with no network, a read-only root, no Linux capabilities, and bounded CPU, memory, process count, temporary storage, and command time. Browser tests run Chromium inside that same isolation.

The public catalog exports the public projection of the studio, including explicit decisions and outcomes. It does not expose credentials or private reasoning. Encrypted checkpoints preserve operational state without publishing it as plaintext. The checkpoint branch is a v1 storage backend: monitor repository size as history grows; replace it with durable object storage before scaling many founders.

Do not run a local writer against the same founder while the hosted workflow is active. The canonical state is now the hosted checkpoint; local files are a launch-time copy. To migrate: pause the hosted founder, restore into a fresh directory with the state utility, make changes, then push using the same version fence. Never overwrite or delete canonical memory to clear an error.

## Failure recovery

Ordinary exceptions still run the final checkpoint step. A hard runner loss before that step can lose changes since the preceding snapshot, including the ID of a paid model request. Provider charges may still occur; exactly-once remote model execution is not guaranteed. Builds use deterministic container identities, recorded response IDs, and explicit uncertain-submission states. They stop when a workspace is lost instead of claiming success. Static deployments use deterministic names, owner/content tags, and remote reconciliation to avoid duplicate publications.

The old managed build `4a06715e-0703-41c2-bee9-0ea38c85a8dd` is quarantined. Its remote session and unresolved cleanup remain in history. Quarantine is an explicit operator action restricted to expired cancellations; it does not claim the provider stopped work or released resources. It allows the replacement backend to proceed.

When a stage exhausts its attempts or a cycle exhausts its model-call allowance, the next tick closes that cycle with an attributed failure and retains its last error. It cannot spend again on the same daily trigger. A daily account allowance simply waits for the next UTC day. Do not erase attempt budgets. Rejected experiments and failed builds inform later decisions.

## Verification

```sh
npm ci
npm run check
npm test
docker build -t theartist-workshop:1 -f docker/workshop.Dockerfile docker
TEST_DOCKER=1 npx tsx --test tests/runtime.test.ts
```

The Docker integration test exercises a real Chromium interaction and verifies network denial, non-root execution, read-only system files, and absence of host secrets/socket. Checkpoint tests cover encryption, tampering, wrong keys, identity, paths, duplicate files, and integrity. The builder test checks that reflection receives the actual build result.
