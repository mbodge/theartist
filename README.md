# theartist

A persistent conceptual artist and its studio. The artist develops an agenda; specialized roles research, make, critique, decide, and reflect. The studio remembers what happened and exposes an inspectable public record.

**Status: working local harness, version 0.2.** Artist and configurable-founder modes share the durable engine. The offline demos are deterministic fixtures, not evidence of autonomous artistic or business judgment. A live OpenAI Responses adapter is implemented but requires your own credentials and model choice. OpenAI Agents API and Cloudflare deployment are the next integration milestone; neither is wired into this local runtime yet.

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

The first founder workshop produces a reviewed **experiment package** with a hypothesis, success threshold, stop condition, test procedure, and maintenance plan. It does not yet build or launch an arbitrary business. Every release remains labeled unvalidated until a future measured-outcomes integration can establish otherwise.

`npm run demo:founder` runs a standalone founder fixture without creating a named instance. See [configurable founders](docs/founders.md) for instance commands, evidence rules, and the path to a hosted product anyone can use.

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

Omit `--observations` for an empty observation set. No reception is invented to fill the gap. Input observations carry IDs, dates, provenance type, stream, and visibility. External-source records require source URLs. Importing a source does not independently verify it, and the researcher has no live browsing tool in this version.

The initial workshop makes **typographic posters and instruction scores** from bounded declarative specifications. It renders an actual PNG for the critic and final artist review. It does not yet generate photographs, arbitrary websites, video, or physical objects.

## Use a live model

Copy `.env.example` to `.env` and supply `OPENAI_API_KEY` and `OPENAI_MODEL` locally. Choose a model available to your account that supports structured outputs and image inputs. Do not commit credentials.

```sh
npm run studio -- start --provider openai --key live:one
npm run studio -- run CYCLE_ID --provider openai
```

Live runs incur provider charges. Execution limits live in `config/policy.json`: daily/cycle call allowances, maximum output tokens, input size, retries, timeouts, and revision limits. Failed and interrupted calls retain their allowance reservation. The SDK's automatic retries are disabled. These are resource limits, **not a dollar-denominated spending guarantee**. No purchasing, outbound email, or social tools are connected.

The live adapter has completed a [first Astra founder trial](docs/trials/astra-001.md): three paid model calls, persisted research/proposal/reflection, and an abstention with no supplied evidence. Live production and review stages remain untested. The trial also exposed a schema issue, now regression-tested: abstention can use a null success criterion, while making an experiment still requires one.

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

Pause blocks new stage dispatches; an already-started stage can checkpoint its result. `tick` starts or resumes one cycle for the current UTC date, then exports the archive. It is a one-shot command, not an installed scheduler. Earlier active cycles can be resumed with `run`; multi-day queue scheduling is part of the hosted-runtime milestone.

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
        └─► public JSON / JSONL archive + artifacts
```

The intended hosted split is **Cloudflare for the persistent studio, workflow coordination, public archive, and site; OpenAI Agents API for managed agent execution and maker sandboxes**. The canonical memory remains ours and exportable. See [the architecture decision](docs/architecture.md).

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
| `src/instances.ts` | Founder creation and isolated instance paths |
| `src/artifacts.ts` | Bounded rendering and local release preparation |
| `src/archive.ts` | Portable public archive projection |
| `src/cli.ts` | Local operations |

## Open source and public process

The code, documentation, role instructions, and included fixtures are MIT licensed. Anyone can run or modify the harness. The external model services and their weights are not included or open-sourced by this project.

Studio observations, experiments, criticism, decisions, and reflections are public by default in exports. Credentials, personal contact details, and confidential supplier material belong outside that public dataset. A public source URL is not permission to relicense the source article or photograph. Generated works and third-party material should carry their own rights metadata when public publishing is added; the code license does not claim rights over third-party content.

See [PLAN.md](PLAN.md) for the broader vision and [CONTRIBUTING.md](CONTRIBUTING.md) for contributions.
