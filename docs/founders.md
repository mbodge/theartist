# Configurable founders

A founder is a persistent instance with a mission, audience, point of view, operating limits, and its own memory. It can pursue a software product, service, community, publication, or another venture. The runtime must not replace the configured mission with a particular business idea.

The artist and founder share the durable studio engine. Their profiles, role instructions, output schemas, workshops, and definitions of acceptance differ.

## Spin up a founder locally

```sh
npm run studio -- init my-founder
```

This creates:

```text
studios/my-founder/
  founder.json          # Mission, audience, thesis, principles, identity
  policy.json           # Execution limits, outside model authority
  observations.json     # Input records; excluded from Git by default

.studio/instances/my-founder/
  studio.sqlite         # Created on first run; isolated memory and history
  artifacts/            # Created as experiments are rendered
  releases/
  public/               # Portable exports
```

Or provide a mission:

```sh
npm run studio -- init social-lab \
  --mission "Explore a social AI app for small creative groups" \
  --audience "Small creative groups" --venture "Software"

npm run studio -- init neighborhood \
  --mission "Build a local repair community" \
  --audience "Neighborhood residents" --venture "Community"
```

These are example briefs, not selected business recommendations. A founder created without overrides keeps an open provisional mandate. Edit its `founder.json` to refine the mission, thesis, success signals, or principles. Increase the profile version when changing its identity; old cycles retain their original profile snapshots.

```sh
npm run studio -- founders
npm run studio -- demo --instance my-founder
npm run studio -- tick --instance my-founder
npm run studio -- memory --instance my-founder
npm run studio -- note --instance my-founder --text "A useful constraint to retain."
npm run studio -- export --instance my-founder
```

`demo` uses synthetic observations and deterministic role fixtures. `tick` uses the instance's observation file and creates/resumes the current UTC day's cycle. Both default to the offline fixture provider. The demo does not demonstrate an autonomous business.

The repository includes an `example-founder` configuration and a [public fixture archive](../examples/public-founder/latest.json). If an ignored observation file is absent after cloning, the instance starts with no observations.

To use live model calls, configure `.env` as described in the main README and pass `--provider openai` to `start`, `tick`, `run`, or `step`. Live mode uses the founder's mission and schemas. The [first live Astra trial](trials/astra-001.md) records a fresh generic founder abstaining without supplied evidence. The [second trial](trials/astra-discovery-001.md) adds web discovery and an explicit independent-selection mandate: it researched alternatives and produced a reviewed experiment package. Both original decision records and token usage are checked in for inspection.

The command line checks the instance ID stored in the data directory. Pointing one founder at another founder's directory produces an error. Artist and founder stores cannot be mixed. Each founder has its own limits and logs; these are per-instance allowances, not yet an account-wide billing limit.

## The first founder workshop

The implemented loop is:

`discover → synthesize observations → choose provisional direction → design experiment → render package → review → decide → local release → reflect`

The optional discovery stage is enabled for live founders by a positive `maxWebCallsPerAttempt` policy value. It uses hosted web search, page reading, and finding text within pages, within one bounded Responses request. The generic founder may compare candidate directions and choose its own provisional audience; a custom mission still constrains that choice. The template allows six web actions per attempt. Old policies without this setting and all offline fixture runs skip discovery. Existing in-flight cycles keep their original stages and limits.

Discovery records the explicit research report and web tool metadata, then atomically imports up to eight cited sources into memory with its checkpoint. A restart continues at synthesis without repeating successful web calls. URLs found only in model-written text are not imported as sources. The search tool's citation metadata establishes provenance, not factual correctness. The experiment document includes clickable links for cited observations.

The package includes:

- Intended audience and the observed or hypothesized problem.
- A falsifiable hypothesis and the smallest proposed test.
- Metric, target, unit, and time window recorded before execution.
- A stop condition and ongoing maintenance commitment.
- Intended prototype/pilot behavior, test procedure, acceptance checks, recruitment and measurement plans.
- Known limitations.

The reviewer receives the actual generated Markdown document and its content hash. Local release verifies the document and specification against their recorded hashes. Maker revisions cannot rewrite the founder's threshold in the canonical proposal. A changed criterion should be a new experiment linked to the earlier one.

When abstaining, the founder should set `successCriterion` to null. A proposal to make an experiment must include a criterion. Older records with a criterion attached to abstention remain readable, including the unsuitable fractional target preserved in the first live trial.

Acceptance means an experiment package is ready to consider executing. Every release is labeled `validationStatus: unvalidated` and `launchStatus: not-launched`. The harness cannot convert founder confidence into measured outcomes.

This workshop plans experiments. Coding, deployment, outreach, payments, support, and measured feedback loops are future adapters with their own operating authority.

## Evidence and memory

Input observations can use `customer` and `usage` streams in addition to the existing studio streams. Only externally sourced records in those streams can support `source_reports` in a founder research briefing. Fixtures and founder notes remain hypotheses. A supplied source is not independently verified merely because it has a URL. Automated web discoveries enter the `world` stream and cannot be promoted into customer/usage evidence by the model. Their text is citation context from the model's research synthesis; original page content is not archived.

Proposals, experiment versions, critiques, decisions, local releases, and reflections persist across restarts. Later cycles receive the founder's prior practice and relevant memories. A new founder starts without another founder's history.

Public exports include the founder's explicit process and experiment documents. Private observations cause derived records to remain private. Raw observation files are ignored by Git; share public process through the export projection.

## Becoming a product anyone can use

The local `init` command is the first provisioning interface. A hosted product needs additional layers before offering shared infrastructure to untrusted users:

1. **Founder creation:** choose a name, mission, audience, principles, resource allowance, and visibility. Templates prefill these fields while keeping the founder configurable.
2. **Account and instance ownership:** authenticate the owner and enforce authorization on every read, write, tool connection, and export. Local directory separation is not a multi-tenant security boundary.
3. **Persistent instance runtime:** a distinct Cloudflare identity/coordinator for each founder, with isolated memory and artifact access. Managed OpenAI jobs link back to the correct founder and cycle.
4. **Capabilities:** the owner enables specific workshops and external actions. Credentials stay in scoped service bindings; role prompts cannot grant new authority.
5. **Operating view:** show active experiments, commitments, costs, decisions, and memory. Support pause, export, profile revisions, and exceptional intervention.
6. **Public presence:** each founder can have a catalog of initiatives and an explicit process journal. Public observation does not grant permission to steer the founder or spend its resources.
7. **Maintenance:** track ongoing obligations before admitting more work. A founder must be able to support, change, or discontinue an initiative instead of only creating new ones.

The open-source runtime and portable memory format should remain usable independently of that hosted product. A hosted service can provide provisioning, execution, tool connections, and operations without holding the only copy of a founder's history.
