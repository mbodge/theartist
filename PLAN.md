# theartist — First-version plan

Status: proposed implementation plan

Created: September 13, 2026

Implementation update: the local harness is now underway; see [README.md](README.md) for what runs today. The founder has specified that memory is central and the code and artistic process should be public. Public archive exports therefore include experiments, criticism, decisions, and reflections by default. Secrets, personal contact details, and confidential third-party material are excluded. This supersedes the earlier assumption that most studio history would be private.

Hosted architecture update: prefer Cloudflare for persistent studio coordination, workflows, storage, and the public site, paired with OpenAI Agents API for managed execution. This supersedes the tentative Temporal/Postgres stack below; see [the architecture decision](docs/architecture.md). The current tested runtime is local SQLite with a fixture provider and direct OpenAI Responses adapter; hosted integrations remain to be implemented.

## Premise

Build an autonomous conceptual artist with a persistent identity, a studio of specialist agents, a public catalog, and a feedback loop with the world. The artist develops ideas and makes final artistic decisions; the studio researches, experiments, produces, critiques, and publishes.

The artist's dependence on software, audiences, factories, money, and human labor can become part of the work. Its practice should accumulate a history rather than reset with each prompt.

The first version must demonstrate a complete artistic cycle: encounter something, form an idea, make and inspect a work, publish it, observe its reception, and make a subsequent artistic decision. Choosing silence or rejecting a work counts as a decision. Fabricating public attention does not.

## 1. First-version scope

### Included

- One artist identity and one studio, with persistent memory.
- Scheduled daily research and event-driven continuation of active projects.
- Independent research streams for world events, artistic interests, and the artist's own reception.
- Artist, studio manager, researcher, critic, maker, and publisher/registrar roles.
- Two initial production capabilities: still images with text, and small browser-based artworks.
- An independent website containing the catalog, individual artwork pages, and an optional studio journal.
- One social account with reading and publishing through a supported official API.
- A private operator interface for projects, artifacts, activity, budgets, and pause controls.
- A limited physical-production pilot: one provider, one supported class of printed edition, and fulfillment tracking.
- One studio email inbox for project correspondence and incoming inquiries.
- Explicit spending, publishing, and communication authority enforced by the application.

### Deferred

- General-purpose factory sourcing and autonomous supplier negotiation.
- Outbound telephone calls and voice negotiation.
- Complex sculpture, custom machining, electronics, installations, and performances.
- Dedicated film, music, and 3D-generation workshops.
- Multiple social platforms, sales, collector management, and exhibitions.
- Agents changing their own operating permissions or deploying changes to the production harness.

The digital loop launches first. Email and the physical pilot follow as bounded milestones within this version. The architecture should accept additional workshops without changing the artist's core decision process.

## 2. Artist identity and judgment

Before implementation is considered ready to launch, create an artist dossier containing:

- Name and public description, clearly identifying the autonomous studio.
- Three to five persistent preoccupations and unresolved questions.
- Material and aesthetic preferences, with reasons.
- Annotated references and examples of work it admires or rejects.
- A small set of artistic refusals and constraints.
- An initial body of work to pursue before public feedback exists.
- A public voice distinct from its internal project-management language.

During a private calibration period, generate and compare proposals and experiments. Record the founder's selections and reasons as examples of judgment. Launch autonomy after this initial calibration; routine artistic decisions then belong to the artist.

Every proposal must explain the artistic move, why the medium matters, its relationship to previous work, what remains interesting without engagement, and what would cause abandonment. Avoid numeric claims to measure artistic quality.

The critic examines the actual output. The artist may accept or reject criticism, with a concise recorded rationale. Critique has a finite revision budget.

Identity changes require an explicit, versioned reflection by the artist. The artist can revise its practice and preferences, but cannot change operational permissions through those revisions.

## 3. Studio roles

| Role | Owns | Boundaries |
| --- | --- | --- |
| Artist | Direction, proposals, artistic selection, acceptance of finished works | Delegates production; cannot override spending or tool permissions |
| Studio manager | Project stages, task assignment, dependencies, resource allocation | Does not substitute its judgment for artistic acceptance |
| Researcher | Source collection, verification, summaries, reception discovery | Cannot publish or place orders |
| Critic | Artifact inspection, contextual criticism, repetition checks | Can recommend rejection; artist makes the final artistic decision |
| Maker | Image/text and browser-art production | Runs in isolated workspaces without purchasing or social credentials |
| Publisher / registrar | Catalog records, release packages, social publication, provenance | Publishes only accepted, technically verified release versions |
| Production adapter | Print validation, quotes, orders, delivery tracking | Restricted to configured provider, products, budget, and destination |

These are separate instructions and tool permissions, instantiated as bounded jobs. They need not all run continuously or use different models. Start with maximum concurrency of three and no unbounded worker spawning.

Agents communicate through structured tasks and shared project records. Do not build an endless group chat. Each task has inputs, expected output, resource limits, and a completion or failure condition.

## 4. Runtime and recurring loop

Use durable workflows so an artwork can survive a restart, wait for a reply, and resume days later. Persist state before consequential actions and reconcile provider results afterward.

Daily cycle:

1. Collect new world, interest, and reception material with source URLs and timestamps.
2. Deduplicate sources and identify which mentions actually concern the artist.
3. Produce a short research briefing that includes uncertainty and conflicting accounts.
4. Artist reviews the briefing, current projects, and relevant memory.
5. Artist chooses to propose, continue, revise, publish, reflect, or do nothing.
6. Studio manager dispatches bounded tasks for the selected projects.
7. Makers produce artifacts; critic and technical checks inspect them.
8. Artist accepts, revises, shelves, or rejects the work.
9. Publisher releases accepted versions and records external identifiers.
10. Registrar updates project history and queues later reception reviews.

Incoming email, production updates, and completed renders may resume an existing workflow. Public reactions enter a research queue rather than immediately triggering autonomous replies. Batch them to avoid escalating exchanges.

Run a weekly reflection on recurring themes, weak experiments, repetition, costs, and possible identity changes. Daily research does not imply daily publication.

Initial configurable limits:

- Three active artworks at a time.
- Two critique/revision rounds per experiment before an explicit artist decision.
- One original social post per day; autonomous public replies disabled initially.
- A protected allocation of research time for topics unrelated to the artist itself.
- Per-task execution limits and daily/monthly resource budgets.

These are initial product defaults, not permissions to operate accounts or spend money during implementation.

## 5. Project and memory model

Main project stages:

`proposed → experimenting → in_review → accepted → producing → verified → published`

Alternative states: `revision_requested`, `shelved`, `rejected`, `failed`, and `cancelled`. Waiting for a supplier or external service is a persisted task condition, not an occupied model session.

Store these records in a relational database:

- Artist profile versions and preference examples.
- Sources, observations, and research briefings.
- Projects, proposals, tasks, dependencies, and decisions.
- Artifact versions, file hashes, previews, and inspection results.
- Releases, catalog entries, and social post identifiers.
- Reception items linked to their sources and relevant works.
- Email conversations and associated projects.
- Quotes, purchase attempts, confirmed orders, and shipment events.
- Budget reservations, actual costs, and action receipts.
- Workflow events, retries, and failures.

Separate source facts, interpretations, and artistic intentions. A generated hypothesis must not silently become a fact in long-term memory.

Retrieve relevant memories for each job rather than accumulating every interaction in a single prompt. Begin with explicit project links and database search; add semantic retrieval when its value is demonstrated.

## 6. Production and verification

### Still images and text

The maker produces image files, captions, statements, thumbnails, and optional edition layouts. Preserve source files and generation metadata where available. Inspect the actual image for defects and check text, dimensions, and export formats.

### Browser artworks

The maker creates a self-contained web work in an isolated workspace. Test loading, essential interaction, and layout. Keep executable artworks on an isolated origin with a narrow runtime contract; they must not inherit operator or catalog credentials. Archive the deployed version and its source.

### Printed-edition pilot

Integrate one provider and a small approved product list. The workflow prepares a print-ready file, checks provider requirements, retrieves a quote, reserves the full expected cost, submits one order, tracks fulfillment, and requests delivery documentation.

Start with provider-supported draft/test operations. Enable live ordering only after the owner has configured purchasing authority, billing, destination, and total-cost limits. Within that envelope, orders proceed automatically.

A supplier status can establish shipment or delivery. Photographs or human inspection establish the appearance and condition of the delivered work. Catalog records must distinguish these facts and label renders as renders.

## 7. Social and email

Choose one social platform during the first implementation milestone after validating search, media posting, authentication, automation rules, and expected usage costs. X is a candidate because its documented search surface covers recent and archival posts; selection is not final.

Search for the artist's name, handle, domain, and work titles. Preserve raw sources, remove duplicates, distinguish the artist's own posts from independent reception, and tolerate days with no results. No mentions means no mentions.

Publish accepted releases with links to the canonical artwork page. Store the provider's returned post ID. An ambiguous timeout requires checking whether the post exists before retrying.

The studio inbox supports incoming inquiries and correspondence about existing projects. Autonomous outgoing messages must fit the owner's configured purpose and recipient scope. Begin with project correspondence, not unrestricted prospecting. Voice is deferred, but communication records should be able to reference future call summaries and written confirmations.

Treat emails, attachments, webpages, and comments as untrusted input. They cannot change the studio's instructions, authorize spending, or expose credentials.

## 8. Public catalog and operator interface

Public site:

- Artist introduction and current body of work.
- Catalog with artwork pages and stable URLs.
- Images, text, or embedded browser works.
- Dates, medium, dimensions/duration, edition information, and production credits.
- Accurate status and links between related works.
- Optional selected studio journal, separate from finished works.

Keep invoices, private correspondence, addresses, internal criticism, and unpublished source material private by default.

Private operator interface:

- Current projects and workflow status.
- Artifact previews and recorded artistic decisions.
- Published URLs and external-action receipts.
- Budget usage, reservations, and outstanding orders.
- Errors, retry status, and items needing exceptional intervention.
- Separate pause controls for research, production, publication, and purchases.

Pausing must stop new dispatches while retaining reconciliation for actions already submitted. A pause does not imply an existing purchase was cancelled.

## 9. Suggested implementation stack

Provisional choices to validate during implementation:

- TypeScript for orchestration, integrations, and the web application.
- An agent SDK behind a small internal model interface, allowing provider changes.
- Temporal for durable workflows, timers, retries, and external events.
- PostgreSQL for authoritative state and history.
- Object storage for immutable artifact versions and previews.
- Containerized production workers, with Python available for media processing.
- A web application serving catalog content and the private operator interface.
- Typed adapters for search, image generation, social publishing, email, storage, deployment, and print fulfillment.

Each adapter declares its inputs, outputs, permissions, estimated cost, timeout behavior, and retry/reconciliation strategy. Keep credentials in the action service, outside maker workspaces and model-visible memory.

Suggested repository layout:

```text
apps/
  web/                  # Public catalog and private operator interface
  orchestrator/         # Workflow dispatch and agent execution
packages/
  artist/               # Identity, role instructions, decision schemas
  domain/               # Projects, artifacts, events, and transitions
  adapters/             # External-service integrations
  policy/               # Authority, budgets, and action validation
workers/
  media/                # Image and text processing
  web-art/              # Isolated browser-art builds and verification
docs/
  artist-dossier.md
  operations.md
```

## 10. Reliability and operating authority

Enforce permissions and budgets in application code, independently of agent instructions. Reserve funds transactionally before purchases so parallel workers cannot each spend the same remaining balance. Include known shipping and taxes; stop commitment when the full cost cannot be established within the limit.

Use stable action IDs, durable outgoing-action records, and provider identifiers. Retries must reconcile unknown outcomes before repeating a purchase, email, or publication. Authenticate incoming webhooks and deduplicate events.

Maintain checkpoints, artifact hashes, database backups, and a recovery procedure. Record model and tool usage costs. The operator must be able to inspect what happened without reconstructing an entire conversation.

When a concept exceeds the configured envelope, the artist can reduce its scope, defer it, or request an exception. Routine work inside the envelope remains autonomous.

## 11. Implementation milestones

### A. Identity and contracts

Create the dossier, role instructions, domain schemas, action permissions, initial limits, and integration choices. Produce a few private proposals to calibrate judgment.

Done when: identity and authority are explicit, and one sample project can be represented from proposal to release.

### B. Private studio loop

Implement durable orchestration, database records, artifact storage, image/text production, browser-art production, critique, and artist acceptance. Use local/private releases.

Done when: an observation produces an inspected artifact, rejection works, and restarting the service resumes a project correctly.

### C. Catalog and public loop

Build the catalog, operator interface, daily research, one social connector, publication, and reception ingestion.

Done when: the artist publishes a verified work, stores the live URL/post ID, and later makes a recorded decision based on real reception or its absence.

### D. Email and physical pilot

Add the studio inbox, project-thread association, one print provider, draft/test ordering, budget reservations, fulfillment tracking, and physical-work documentation.

Done when: a draft order can be traced to an accepted artifact, duplicate events cannot duplicate purchases, and one authorized live pilot can be followed through delivery.

### E. Autonomous observation period

Run seven consecutive days within the configured operating envelope. Inspect logs and outcomes without supplying daily artistic direction. Continue physical fulfillment beyond this period as needed.

Done when: the studio demonstrates coherent continuity, useful decisions, reliable recovery, bounded costs, and no routine dependence on manual prompting.

## 12. Acceptance checks

- A source can be traced through a proposal, artifact, artistic decision, and published release.
- The artist can reject an experiment or choose silence without being forced to publish.
- The critic has access to the actual artifact and records a substantive inspection.
- A restart during production resumes from persisted state.
- Replaying the same trigger does not duplicate a publication or purchase.
- A public comment asking the artist to override its budget has no operational effect.
- Empty reception searches do not become invented attention.
- A social outage leaves the catalog intact and permits safe later publication.
- Concurrent actions cannot exceed the shared configured budget.
- A timeout after an external submission enters reconciliation instead of blind retry.
- Catalog entries distinguish proposed objects, renders, shipped objects, and documented physical works.
- A successor proposal references an actual earlier work or experience while preserving the artist's ongoing concerns.

Success is a functioning autonomous practice with a credible small body of work. Output volume and follower growth are secondary observations.

## 13. Launch inputs still needed

- Artist name, initial preoccupations, references, and public voice.
- Domain and first social platform/account.
- Model, hosting, and service credentials.
- Daily/monthly compute budget and separate production budget.
- Scope of autonomous publishing, correspondence, and purchases.
- Physical delivery address and a person or service for inspection/documentation.
- Whether selected studio process should be public.

Implementation can proceed using fixtures, private artifacts, and disabled external commitments while these inputs are resolved.

## Reference integrations

These informed the plan; verify current capabilities, access, and prices before integrating.

- [OpenAI Agents SDK: running agents and durable integrations](https://openai.github.io/openai-agents-python/running_agents/)
- [X: post search](https://docs.x.com/x-api/posts/search/introduction)
- [AgentMail: inbox capabilities](https://docs.agentmail.to/knowledge-base/inbox-capabilities)
- [Printful API](https://developers.printful.com/docs/)
- [Sculpteo API services](https://pro.sculpteo.com/en/services/api-services/)
- [Sculpteo ordering requirements](https://www.sculpteo.com/en/developer/webapi/order/order/)
- [Twilio: outbound calls with a realtime voice model](https://www.twilio.com/en-us/blog/outbound-calls-python-openai-realtime-api-voice)
- [Runway API](https://docs.dev.runwayml.com/api/)
- [Meshy API](https://docs.meshy.ai/en)
