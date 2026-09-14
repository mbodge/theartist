# theartist

A persistent conceptual artist and its studio. The artist develops an agenda; specialized roles research, make, critique, decide, and reflect. The studio remembers what happened and exposes an inspectable public record.

**Status: autonomous founder loop, version 0.3.** OpenAI Responses drives research, decisions, and a Docker coding workshop. Accepted work is built and tested, eligible browser apps are published to Cloudflare, and the founder reflects on the execution and deployment results. GitHub Actions runs the bounded loop hourly, with one new experiment per UTC day and encrypted, versioned memory between runs. The [public catalog](https://theartist.mike-3cd.workers.dev) exposes work, decisions, source files, tests, and outcomes. See [autonomous operation](docs/autonomy.md).

The offline demos are deterministic fixtures. The older managed Agents backend remains available for historical jobs; its stalled first session is quarantined with cleanup still unresolved.

The [hosted founder trial](docs/trials/hosted-founder-001.md) produced a [live CSV checker](https://theartist-app-824fa148-ee8062b9d11d42e57b6a.mike-3cd.workers.dev): 105 local acceptance gates and 29 actual-URL interaction checks passed, followed by a recorded founder reflection. The trial record includes the failures and checkpoint recoveries.

## Spin up a founder

A founder can pursue any configured mission: an app, service, community, publication, or another venture. Each instance has its own identity, operating limits, and memory. A social AI app is one possible brief.

```sh
npm run studio -- init my-founder
npm run studio -- demo --instance my-founder
npm run studio -- memory --instance my-founder
```

Edit `studios/my-founder/founder.json` to set the mission, audience, thesis, and principles. Or provide them at creation:

```sh
npm run studio -- init community-builder \
  --mission "Explore a neighborhood repair community" \
  --audience "Local residents" --venture "Community"
```

The founder produces a reviewed **experiment package** with a hypothesis, success threshold, stop condition, test procedure, and maintenance plan. Enabled live founders then hand it to a coding workshop that builds runnable source, executes commands, and saves the files and results. Prototype execution remains distinct from customer validation. See [the coding workshop](docs/building.md).

`npm run demo:founder` runs a standalone founder fixture without creating a named instance. See [configurable founders](docs/founders.md) for instance commands, evidence rules, and the path to a hosted product anyone can use.

## A board that can nudge the supervisor

The launcher gets a founding board seat and can appoint directors. Members submit persistent, attributed guidance; the artist or founder answers **adopt**, **defer**, or **decline** at its next proposal or decision. Guidance, replies, and the exact context delivered to the supervisor are retained in the public archive.

```sh
npm run studio -- init my-studio --launcher mike --name "Mike Bodge"
npm run studio -- board nudge --instance my-studio --as mike \
  --text "Prioritize one small, runnable deliverable before expanding scope."
npm run studio -- board --instance my-studio
```

The board works for artists and founders. It does not require a vote before each action. This version uses local operator IDs, not authenticated accounts. See [the board guide](docs/board.md) for membership, withdrawal, delivery timing, and public records.

## Run it

Requires Node.js 22+ and npm.

```sh
npm ci
npm run demo
```

The demo needs no API key and makes no network calls. It runs research → proposal → making → rendering → critique → artist decision → local release → reflection. It writes a real PNG/SVG typographic score, a SQLite history, and a portable public archive beneath `.studio/`.

Run the demo again: the same trigger resolves to the existing cycle and creates no duplicate release.

```sh
npm run studio -- status
npm run studio -- memory audience
npm run studio -- export
```

The export command prints the archive directory. `.studio/public/latest.json` points to the latest immutable snapshot; each snapshot contains `archive.json`, `memory.jsonl`, and artifact files. These are local files; no website or repository is published automatically.

An included [sample public studio archive](examples/public-studio/latest.json) shows the fixture's complete history and rendered artifact. It is a synthetic development example, not a live artist release.

## A new studio cycle

```sh
npm run studio -- start --key experiment:two --observations examples/observations.json
# Copy the returned cycle ID into these commands:
npm run studio -- step CYCLE_ID
npm run studio -- run CYCLE_ID
npm run studio -- show CYCLE_ID
```

Omit `--observations` for an empty observation set. No reception is invented to fill the gap. Input observations carry IDs, dates, provenance type, stream, and visibility. External-source records require source URLs. Importing a source does not independently verify it. Live founders can now start with a bounded web discovery stage; artist research still summarizes supplied inputs.

The initial workshop makes **typographic posters and instruction scores** from bounded declarative specifications. It renders an actual PNG for the critic and final artist review. It does not yet generate photographs, arbitrary websites, video, or physical objects.

## Use a live model

Copy `.env.example` to `.env` and supply `OPENAI_API_KEY` and `OPENAI_MODEL` locally. Choose a model available to your account that supports structured outputs and image inputs. Do not commit credentials.

```sh
npm run studio -- start --provider openai --key live:one
npm run studio -- run CYCLE_ID --provider openai
```

Live runs incur provider charges. Execution limits live in `config/policy.json`: daily/cycle call allowances, maximum output tokens, input size, retries, timeouts, and revision limits. Failed and interrupted calls retain their allowance reservation. The SDK's automatic retries are disabled. These are resource limits, **not a dollar-denominated spending guarantee**. No purchasing, outbound email, or social tools are connected.

The live adapter completed a [first Astra founder trial](docs/trials/astra-001.md) that abstained without supplied evidence. A [second live trial with web discovery](docs/trials/astra-discovery-001.md) completed the full loop: seven model calls, six web actions, seven cited sources, and a reviewed experiment package. These are two observed runs, not a general quality evaluation. Those research trials did not execute an experiment or launch a product; the coding workshop now provides the next execution phase. Abstention can use a null success criterion, while making an experiment requires one.

The [first live coding trial](docs/trials/astra-build-001.md) produced a [runnable RFP review prototype](examples/rfp-prototype/README.md) with 26 passing tests. Its managed artifact handoff stalled; the source was recovered from recorded commands and independently rerun locally. The unresolved provider session is quarantined, with its identifier and pending cleanup preserved.

### Autonomous founder discovery

New founders are authorized to research public information and select a provisional audience and direction. Their live loop starts with web search and page reading using OpenAI's hosted `web_search` tool, then synthesizes cited findings before proposing an experiment. No owner-selected industry is required. The founder explains its choice, keeps assumptions explicit, and may still abstain when it cannot justify a useful bounded test.

`maxWebCallsPerAttempt` in the founder policy enables and bounds discovery: the template allows six web tool calls per discovery attempt, including searches and page reads. Set it to zero to disable web access. A missing field keeps older policies offline. Fixture runs always skip web discovery. The ordinary call, retry, timeout, and pause limits still apply; each retry can spend another web allowance. These are per-attempt tool limits, not a dollar budget.

The harness imports only URL citations from API response metadata as source observations. URLs merely written in the report do not become sources. Original input observations stay unchanged; discoveries persist separately with the discovery checkpoint in the same transaction. The public record includes search queries, page URLs, citations, a research report, and subsequent decisions. Source summaries are model interpretations, not page snapshots or verified customer evidence. Private observation text is withheld from the discovery request.

Existing founders must explicitly enable discovery in their policy. `founder-001` has been configured for the live trial; `example-founder` retains its original policy. See [founder documentation](docs/founders.md).

## Memory belongs to the artist

- The profile is versioned and snapshotted per cycle.
- Observations, explicit decisions, critiques, artifact versions, and reflections are append-only through the application API.
- Later cycles receive recent practice plus relevant full-text-retrieved memories.
- A correction points at an older memory instead of erasing it.
- Sources and interpretations remain distinguishable.
- Rejected and revised experiments remain in the archive.
- The public record consists of explicit studio outputs and concise rationales, not hidden model reasoning.

```sh
npm run studio -- note --text "An absent audience is a constraint, not a failure metric."
npm run studio -- memory audience
npm run studio -- note --text "Updated observation about audience." --supersedes MEMORY_ID
```

Notes default to public. Use `--private` for operational material that must stay local. Private observations cause all derived records for that cycle to remain private, and private cycles are excluded from later public-memory retrieval. Do not put credentials in notes or observations.

See [the memory design](docs/memory.md) for the record model, retrieval limits, and public export contract.

## Execution and recovery

Every stage claims a lease and atomically reserves its model-call allowance. Successful output and the next stage are committed in one database transaction. A second worker cannot claim the same live lease. An expired worker cannot commit a stale result.

Restart the CLI with `run CYCLE_ID` to continue a checkpointed project. If the process died during a call, wait for its lease to expire (90 seconds by default). The call may have incurred provider usage; recovery may issue a new call but cannot duplicate a local release. The current adapter cannot reconcile an unknown Responses request after a hard process loss.

```sh
npm run studio -- pause
npm run studio -- resume
npm run studio -- run CYCLE_ID --steps 3
npm run studio -- tick
```

Pause blocks new stage dispatches; an already-started planning stage can checkpoint its result. A running builder cancels on its next worker poll. `tick` resumes unfinished builds or older active cycles before starting the current UTC date’s cycle, and automatically builds accepted live founder experiments. When deployment is enabled, it publishes eligible apps and refreshes the catalog, including after build failures. It then exports the archive. The CLI is a one-shot worker; the [hosted workflow](.github/workflows/studio.yml) invokes it hourly. See [autonomous operation and recovery](docs/autonomy.md).

Failed steps can be retried within their configured attempt allowance. When exhausted, inspect the record and close the failed cycle with `close CYCLE_ID --text "reason"`; a fresh trigger creates a new attempt with its own provenance. Daily allowance exhaustion can be resumed on a later UTC day.

## Architecture

```text
CLI / future scheduler
        │
        ▼
Persistent studio state machine ───► Role provider
        │                            ├─ offline fixture
        │                            └─ OpenAI Responses
        ▼
SQLite checkpoints + memory + events
        │
        ├─► bounded typographic renderer ─► PNG / SVG
        ├─► isolated Docker workshop ─► source + tests + command logs
        └─► public JSON / JSONL archive + artifacts
```

The current hosted split is **GitHub Actions for the Node studio and isolated Docker execution; OpenAI Responses for model calls; Cloudflare Workers for published apps and the catalog**. Application-owned SQLite memory is encrypted into a separate checkpoint branch between runs. A Cloudflare-native orchestration migration remains a future option, not a dependency of this loop. See [autonomous operation](docs/autonomy.md).

## Development

```sh
npm run check
npm test
```

Tests exercise restart recovery, cross-run memory, corrections, abstention, revision limits, call allowances across connections, stale-worker fencing, artifact integrity, public/private exports, structured model requests, and idempotent CLI runs.

Source map:

| File | Responsibility |
| --- | --- |
| `src/domain.ts` | Schemas and role contracts |
| `src/store.ts` | Checkpoints, leases, allowances, memory and events |
| `src/harness.ts` | Studio stage transitions and validation |
| `src/agents.ts` | Public role instructions and provider adapters |
| `src/founder.ts` | Founder roles, fixtures, and experiment packages |
| `src/builder.ts` | Durable coding jobs, recovery, execution memory and file verification |
| `src/managed-builder.ts` | OpenAI Agents sandbox, commands and artifacts |
| `src/board.ts` | Launcher/director membership, nudges, delivery snapshots and supervisor replies |
| `src/instances.ts` | Founder creation and isolated instance paths |
| `src/artifacts.ts` | Bounded rendering and local release preparation |
| `src/archive.ts` | Portable public archive projection |
| `src/publication.ts` | Verified build bundles and public catalog |
| `src/deployer.ts` | Durable publication, recovery, leases and result memory |
| `src/cloudflare-publisher.ts` | API upload and live byte verification |
| `src/publish.ts` | Eligible app publication and catalog refresh |
| `src/cli.ts` | Local operations |

## Open source and public process

The code, documentation, role instructions, and included fixtures are MIT licensed. Anyone can run or modify the harness. The external model services and their weights are not included or open-sourced by this project.

Studio observations, experiments, criticism, decisions, and reflections are public by default in exports. Credentials, personal contact details, and confidential supplier material belong outside that public dataset. A public source URL is not permission to relicense the source article or photograph. Generated works and third-party material should carry their own rights metadata when public publishing is added; the code license does not claim rights over third-party content.

See [PLAN.md](PLAN.md) for the broader vision and [CONTRIBUTING.md](CONTRIBUTING.md) for contributions.
