import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { FixtureProvider, OpenAIProvider } from './agents.js';
import { Harness } from './harness.js';
import { observationsSchema, profileSchema, policySchema, studioKind, isFounder, StudioError } from './domain.js';
import { exportArchive } from './archive.js';
import { Store } from './store.js';
import { createFounder, instancePaths, listFounders } from './instances.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const help = `theartist — local studio harness

  npm run demo                            Offline fixture cycle + public archive
  npm run demo:founder                    Offline founder experiment package
  npm run studio -- init <name>           Create a configurable founder instance
  npm run studio -- founders              List founder instances
  npm run studio -- start --key <key>      Persist a new cycle; does not execute it
  npm run studio -- run <id>               Run/resume a cycle to completion
  npm run studio -- step <id>              Execute one checkpointed stage
  npm run studio -- tick                  One idempotent UTC daily cycle
  npm run studio -- status               List cycles, pause state, and call attempts
  npm run studio -- show <id>             Inspect a cycle and its explicit outputs
  npm run studio -- close <id> --text ...  Close a failed/stuck cycle with a reason
  npm run studio -- memory [query]         Retrieve durable studio memories
  npm run studio -- note --text <text>     Append a studio note (public by default)
  npm run studio -- export                Export public memory, history, and artifacts
  npm run studio -- pause | resume         Control new stage dispatches

Options:
  --studio artist|founder     Studio role bundle (artist by default)
  --instance <name>           Founder configuration and isolated memory directory
  --mission <text>            Initial founder mandate (init only)
  --audience <text>           Intended audience (init only)
  --venture <text>            Venture type, freely described (init only)
  --provider fixture|openai    Fixture is offline and deterministic (default)
  --observations <file>        JSON input observations; empty by default
  --profile <file>             Artist dossier (default config/artist.json)
  --policy <file>              Execution limits (default config/policy.json)
  --data <directory>           Studio state (default .studio)
  --out <directory>            Public exports (default .studio/public)
  --key <key>                  Idempotency key for start
  --steps <n>                  Maximum stages for run (default 32)
  --private                   Keep an appended note out of public exports/retrieval
  --supersedes <memory-id>     Correct an earlier note without erasing it

OpenAI mode requires OPENAI_API_KEY and OPENAI_MODEL in environment or .env.
This version has no social posting, email sending, or purchasing tools.
tick is a one-shot scheduler entrypoint; it does not install a background job.
`;

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    provider: { type: 'string', default: 'fixture' }, observations: { type: 'string' },
    studio: { type: 'string' }, instance: { type: 'string' },
    mission: { type: 'string' }, audience: { type: 'string' }, venture: { type: 'string' },
    profile: { type: 'string' }, policy: { type: 'string' },
    data: { type: 'string' }, out: { type: 'string' },
    key: { type: 'string' }, steps: { type: 'string', default: '32' },
    text: { type: 'string' }, private: { type: 'boolean', default: false }, supersedes: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { console.log(help); return; }
  const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (command === 'init') {
    const id = positionals[1]; if (!id) throw new StudioError('init needs a founder name');
    json(await createFounder(projectRoot, id, { mission: values.mission, audience: values.audience, venture: values.venture })); return;
  }
  if (command === 'founders') { json(await listFounders(projectRoot)); return; }
  const mode = values.studio ?? (values.instance ? 'founder' : 'artist');
  if (!['artist', 'founder'].includes(mode)) throw new StudioError('Unknown studio mode');
  if (values.instance && mode !== 'founder') throw new StudioError('--instance selects a founder studio');
  const instance = values.instance ? instancePaths(projectRoot, values.instance) : undefined;
  // Reading an instance never silently creates a new founder or new identity.
  if (instance) await readFile(instance.profile, 'utf8');
  const data = resolve(values.data ?? instance?.data ?? join(projectRoot, '.studio', ...(mode === 'founder' ? ['founder'] : [])));
  const profilePath = values.profile ?? instance?.profile ?? join(projectRoot, 'config', mode === 'founder' ? 'founder.json' : 'artist.json');
  const policyPath = values.policy ?? instance?.policy ?? join(projectRoot, 'config', mode === 'founder' ? 'founder-policy.json' : 'policy.json');
  const store = new Store(join(data, 'studio.sqlite'));
  try {
    store.bindStudio(mode as 'artist' | 'founder', values.instance ?? null);
    if (command === 'status') { json({ paused: store.paused(), cycles: store.list().map(c => ({ id: c.id, stage: c.stage, status: c.status, provider: c.provider, revision: c.revision, lastError: c.lastError })), attempts: store.attempts(), eventChainValid: store.verifyEvents() }); return; }
    if (command === 'memory') { json(store.memories(positionals.slice(1).join(' ') || undefined)); return; }
    if (command === 'note') {
      if (!values.text?.trim() || values.text.length > 8000) throw new StudioError('note needs --text between 1 and 8000 characters');
      json(store.addMemory({ id: `note-${randomUUID()}`, kind: 'note', content: values.text, cycleId: null,
        sourceIds: [], visibility: values.private ? 'private' : 'public', supersedes: values.supersedes ?? null })); return;
    }
    if (command === 'show') {
      const id = positionals[1]; if (!id) throw new StudioError('show needs a cycle ID');
      json({ cycle: store.get(id), memories: store.memories().filter(m => m.cycleId === id) }); return;
    }
    if (command === 'close') {
      const id = positionals[1]; if (!id) throw new StudioError('close needs a cycle ID');
      json(store.closeCycle(id, values.text ?? '')); return;
    }
    if (command === 'pause' || command === 'resume') { store.pause(command === 'pause'); json({ paused: store.paused() }); return; }
    if (command === 'export') { json(await exportArchive(store, data, resolve(values.out ?? join(data, 'public')))); return; }
    if (!['demo', 'start', 'run', 'step', 'tick'].includes(command)) throw new StudioError(`Unknown command ${command}`);
    if (!['fixture', 'openai'].includes(values.provider)) throw new StudioError('Unknown provider');
    if (command === 'demo' && values.provider !== 'fixture') throw new StudioError('demo is always offline; use start/run for live models');
    if (values.provider === 'openai' && existsSync(join(projectRoot, '.env'))) process.loadEnvFile(join(projectRoot, '.env'));
    const provider = values.provider === 'openai'
      ? new OpenAIProvider(process.env.OPENAI_MODEL ?? '', process.env.OPENAI_API_KEY ?? '')
      : new FixtureProvider();
    const harness = new Harness(data, provider, store);
    let id = positionals[1];
    if (['demo', 'start', 'tick'].includes(command)) {
      const profile = profileSchema.parse(JSON.parse(await readFile(profilePath, 'utf8')));
      if (studioKind(profile) !== mode) throw new StudioError('Profile does not match selected studio mode');
      if (isFounder(profile) && profile.instanceId !== (values.instance ?? null)) throw new StudioError('Profile does not match selected founder instance');
      const policy = policySchema.parse(JSON.parse(await readFile(policyPath, 'utf8')));
      const instanceObservations = instance && existsSync(instance.observations) ? instance.observations : undefined;
      const observationFile = values.observations ?? (command === 'demo'
        ? join(projectRoot, 'examples', mode === 'founder' ? 'founder-observations.json' : 'observations.json')
        : instanceObservations);
      const observations = observationsSchema.parse(observationFile ? JSON.parse(await readFile(observationFile, 'utf8')) : []);
      const key = command === 'demo' ? 'demo:v1' : command === 'tick' ? `daily:${new Date().toISOString().slice(0, 10)}` : values.key;
      if (!key) throw new StudioError('start needs --key so repeated triggers can be deduplicated');
      const cycle = harness.start(key, profile, policy, observations);
      id = cycle.id;
      if (command === 'start') { json(cycle); return; }
    }
    if (!id) throw new StudioError(`${command} needs a cycle ID`);
    const steps = Number(values.steps);
    if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new StudioError('--steps must be 1–100');
    const result = command === 'step' ? await harness.step(id) : await harness.run(id, steps,
      c => console.error(`[${c.id.slice(0, 8)}] ${c.stage} · revision ${c.revision} · ${c.status}`));
    json({ id: result.id, stage: result.stage, status: result.status, outcome: result.outcome,
      release: store.checkpoint(result.id, 'release', result.revision) ?? null });
    if (command === 'demo' || command === 'tick') json(await exportArchive(store, data, resolve(values.out ?? join(data, 'public'))));
  } finally { store.close(); }
}

main().catch(error => {
  console.error(error instanceof StudioError ? error.message : 'Studio command failed. Check configuration and input schemas; raw provider errors are omitted.');
  process.exitCode = 1;
});
