# Architecture decision: public memory, Cloudflare studio, OpenAI execution

Date: September 13, 2026

Status: recommended hosted architecture; local foundation implemented

## Decision

Use Cloudflare to operate the persistent studio and public archive. Use OpenAI's new Agents API as the managed execution option for agent work, particularly makers that need a sandbox. Keep artistic memory, identity, work relationships, decisions, and artifacts in an application-owned, exportable format.

The initial local CLI implements the contracts and a tested studio loop before hosted infrastructure is provisioned. It currently uses SQLite and local files, with an offline fixture provider and an OpenAI Responses provider. It does **not** yet use Cloudflare or the managed Agents API.

This replaces the original plan's tentative Temporal/Postgres recommendation for the first hosted deployment. Do not introduce both workflow platforms to operate the same studio.

## Why the two platforms fit together

OpenAI's current documentation distinguishes the managed Agents API from the application-hosted Agents SDK and direct Responses calls. The managed API supplies a Codex harness, saved sessions, compaction, multi-agent orchestration, and optional hosted or self-hosted sandboxes. Its quickstart uses the beta `agents=v1` surface and requires application-key permissions. Account access must be verified before a live integration.

Sources: [runtime comparison](https://developers.openai.com/api/docs/guides/agents), [Agents API architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture), [quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart).

Cloudflare's documentation describes agents as durable identities that wake for events. Durable state survives eviction; in-memory work and open connections do not. Workflows suit multi-step jobs and external waits. That maps to the studio's daily rhythm and long production projects.

Sources: [long-running agents](https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/), [Durable Objects](https://developers.cloudflare.com/durable-objects/).

## Proposed ownership

| Concern | Owner |
| --- | --- |
| Artist identity and active studio coordination | Cloudflare Agent / Durable Object |
| Multi-stage project orchestration and waiting | Cloudflare Workflows |
| Canonical memories, decisions, relationships | Application-owned SQL records; exact DO/D1 partition decided with query needs |
| Large artifacts and portable public snapshots | R2 |
| Public catalog, journal, and read API | Worker-hosted application |
| Managed tool-using agent jobs | OpenAI Agents API |
| Compute/file workspace for a maker | OpenAI-hosted sandbox initially; specialized workers when required |
| Role prompts, schemas, policies, adapters | This open-source repository |

Cloudflare and OpenAI should not both own the career history. The application owns it. Provider sessions are linked working contexts with recoverable identifiers.

The local `better-sqlite3` adapter and native `sharp` renderer are Node components; they cannot simply be uploaded unchanged to Workers. The hosted migration needs a Cloudflare storage adapter and sandbox/remote rendering adapter. Domain schemas, role instructions, memory records, and validation contracts can remain stable. Factor a shared asynchronous store interface as that second storage adapter is implemented rather than claiming the current synchronous store is already portable.

## Managed execution integration requirements

1. Persist a job intent and stable local ID before creating an OpenAI session/turn.
2. Store returned session and turn IDs immediately; link them to the cycle and stage.
3. Consume stream events or authenticated webhooks and persist a cursor.
4. Confirm explicit turn completion and validate artifact output; idle alone is not success.
5. On a disconnect, retrieve saved session state and items before resubmission.
6. Import explicit outputs and artifact hashes into canonical memory before cleaning up remote resources.
7. Keep application credentials outside maker sandboxes. Give each role only its intended tools.
8. Enforce configured resource authority, deadlines, cancellation, and reconciliation. A dropped local HTTP connection must not be interpreted as cancellation of remote work.

The existing call/attempt allowances govern direct model calls. They are not sufficient for a managed session that can make multiple model and tool calls. The managed adapter must account for session/turn usage and resource lifecycle before being enabled for unattended runs.

## Open-source boundary

The harness, schemas, role instructions, memory format, and included fixtures are MIT licensed. A public archive exposes the studio's explicit decisions and history. Hosted model inference and vendor-managed infrastructure remain external dependencies; this does not make their implementation or model weights open source.

The offline fixture makes the workflow testable without paid services. It tests orchestration and provenance, not artistic ability. Provider adapters should remain replaceable so the practice can continue on another execution service.

## Next implementation slice

Implement the durable managed-job adapter and a local transport simulator together; test disconnect recovery, delayed completion, duplicate webhooks, failures, and cancellation before making live calls. Then add a Cloudflare studio coordinator and public memory API, with deployment configuration and export/recovery commands.
