# Publishing apps and the public catalog

The harness publishes eligible static browser apps to separate Cloudflare Workers,
verifies every served file, and retains the URL, version, hashes, and check results
in the founder's memory and public archive. A separate catalog shows experiments,
build status, decisions, board records, and recent memory. Source files and
experiment documents are downloads.

The first catalog is live at <https://theartist.mike-3cd.workers.dev>. `/health`
describes this website, not studio liveness. The Node/SQLite studio still runs
locally. Publishing neither installs a scheduler nor migrates it to Cloudflare.

## Configure a studio

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the ignored `.env` file.
Use a dedicated account token with **Workers Scripts Edit**. It can edit Workers
across the account; the trusted publisher further restricts target names. The
credential never goes to generated code or live-site verification requests. Local
process separation is not a security boundary for untrusted hosted tenants.

Add a deployment section to the studio's policy, choosing a unique catalog name:

```json
{
  "deployment": {
    "enabled": true,
    "catalogWorker": "my-founder-catalog",
    "maxDeploymentsPerDay": 4,
    "maxBytes": 1500000
  }
}
```

`founder-001` is enabled with catalog `theartist`. New studios keep publication
disabled until the launcher configures it. The allowance counts new app jobs and
new catalog snapshots separately per UTC day. It is not a dollar spending cap.

```sh
npm run studio -- publish --instance founder-001
# Equivalent:
npm run cloudflare:deploy -- --instance founder-001

# Research/build, then publish eligible output and refresh the catalog:
npm run studio -- tick --instance founder-001 --provider openai
npm run studio -- status --instance founder-001
```

`build`, and live founder `run`/`tick` after acceptance, invoke publication when
enabled. Unsuccessful builds can still refresh the catalog with their actual
status. `publish` makes no model calls. Pause blocks new uploads; it does not take
existing websites offline or undo uploads already in flight.

## Eligible apps

The first target supports self-contained HTML, CSS, JavaScript, and images.
The maker creates `prototype/site/index.html` and `prototype/deployment.json`:

```json
{
  "schemaVersion": 1,
  "kind": "static",
  "root": "prototype/site",
  "testCommand": "python tests.py"
}
```

The exact test command must have observed completed execution with exit code
zero. Unknown/null exits, model claims, and generated reports cannot satisfy this
gate. The cycle must be an accepted live founder experiment, and its inputs and
build must be public. Files are verified against stored sizes and SHA-256 hashes.
Traversal, symlinks, duplicate or reserved routes, oversize bundles, and detected
credentials are rejected before upload.

Only a trusted static file server runs server-side. Generated code is served to
the browser as data, with no model/deployment secrets or database bindings. The
browser policy blocks external connections, forms, frames, and remote assets.
APIs, authentication, server-side Python, CDNs, and persistent server data require
another target. CLI builds remain downloadable source, not running web apps.

Recorded tests establish software checks. Live verification proves expected
files are served. Neither establishes browser usability, security review, the
business benchmark, or customer demand.

## Recovery and ownership

Publication content is immutable under each studio's `publications` directory.
SQLite reserves a job before external calls. App names combine studio identity
and content hash; an app cannot replace the catalog. Worker ownership/content
tags reconcile uncertain uploads. Unowned or differently owned existing Workers
are refused. The original bootstrap was explicitly adopted after verifying its
known version; ordinary publication cannot adopt arbitrary existing Workers.

Jobs move through queued, uploading, verifying, and published. An interrupted
upload resumes the same target and payload. Verification retries brief edge
propagation delays. Three unsuccessful job attempts stop automatic retries.
Fenced leases and heartbeats reject stale local commits. `publish` resumes pending
jobs first; failed jobs require operator inspection. Changed content creates a
new job within the allowance. Identical published content is not uploaded again.

Archive schema 5 includes app deployments and their result memories. Catalog
receipts remain local operational records, preventing publication from changing
its own archive and triggering an endless republish loop. The catalog is a
snapshot, not continuous uptime monitoring; it changes when publishing runs again.

The original `cloudflare/worker.ts` bootstrap remains for reference. Deploying it
directly would replace the catalog; use `publish` for normal operation.

## Current provider limitation

The first live coding session still reports itself in progress and refuses
deletion. Its build remains cancelling. The catalog shows that status and the
accepted experiment; it has not been promoted to a completed or deployed app.
The app pipeline has synthetic transport coverage, and catalog publication has
been exercised against Cloudflare. A reliable model-to-app unattended run still
needs the provider to finish and deliver its artifacts.

References: [account tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
[Worker module upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/).
