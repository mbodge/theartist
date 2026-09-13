import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FixtureProvider, OpenAIProvider } from '../src/agents.js';
import { Harness } from '../src/harness.js';
import { Store } from '../src/store.js';
import { exportArchive } from '../src/archive.js';
import { renderArtwork, inspectArtifact } from '../src/artifacts.js';
import {
  policySchema, profileSchema, observationsSchema, BudgetError, BusyError, PausedError,
  AttemptLimitError, type AgentRequest, type AgentResponse, type Artifact, type Policy,
} from '../src/domain.js';

const profile = profileSchema.parse(JSON.parse(await readFile(new URL('../config/artist.json', import.meta.url), 'utf8')));
const policy = policySchema.parse(JSON.parse(await readFile(new URL('../config/policy.json', import.meta.url), 'utf8')));
const observations = observationsSchema.parse(JSON.parse(await readFile(new URL('../examples/observations.json', import.meta.url), 'utf8')));

async function setup(t: { after: (fn: () => Promise<void>) => void }, provider = new FixtureProvider(), overrides: Partial<Policy> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'theartist-test-'));
  const h = new Harness(root, provider);
  t.after(async () => { if (h.store.db.open) h.store.close(); await rm(root, { recursive: true, force: true }); });
  const cycle = h.start('test:one', profile, { ...policy, ...overrides }, observations);
  return { root, h, cycle };
}

test('complete cycle exports actual files, structured memories and a valid event chain', async t => {
  const { root, h, cycle } = await setup(t);
  const result = await h.run(cycle.id);
  assert.equal(result.status, 'released');
  assert.equal(result.stage, 'done');
  assert.equal(h.store.releases().length, 1);
  const artifact = h.store.checkpoint(cycle.id, 'render') as Artifact;
  assert.ok((await inspectArtifact(root, artifact)).length > 1000);
  const archive = await exportArchive(h.store, root, join(root, 'public'));
  const parsed = JSON.parse(await readFile(join(archive.directory, 'archive.json'), 'utf8'));
  assert.equal(parsed.cycles[0].fixture, true);
  assert.ok(parsed.memories.some((m: { kind: string }) => m.kind === 'reflection'));
  assert.ok(parsed.memories.some((m: { content: string }) => m.content.includes('Synthetic fixture criticism')));
  assert.ok(h.store.verifyEvents());
  assert.ok(await readFile(join(archive.directory, artifact.png)));
});

test('same trigger and rerun do not spend again or duplicate the release', async t => {
  const { root, h, cycle } = await setup(t);
  await h.run(cycle.id);
  const n = h.store.attempts().length;
  assert.equal(h.start('test:one', profile, policy, observations).id, cycle.id);
  await h.run(cycle.id);
  assert.equal(h.store.attempts().length, n);
  assert.equal(h.store.releases().length, 1);
  const first = await exportArchive(h.store, root, join(root, 'public'));
  const second = await exportArchive(h.store, root, join(root, 'public'));
  assert.equal(first.hash, second.hash);
  assert.throws(() => h.start('test:one', profile, policy, []), /different inputs/);
});

test('restart after a checkpoint resumes without rerunning completed roles', async t => {
  const { root, h, cycle } = await setup(t);
  await h.run(cycle.id, 3);
  assert.equal(h.store.get(cycle.id).stage, 'render');
  h.store.close();
  const resumed = new Harness(root, new FixtureProvider());
  try {
    assert.equal((await resumed.run(cycle.id)).status, 'released');
    assert.equal((resumed.store.attempts() as { stage: string }[]).filter(a => a.stage === 'research').length, 1);
  } finally { resumed.store.close(); }
});

test('later cycles retrieve prior work and reflection from disk', async t => {
  const { root, h, cycle } = await setup(t);
  await h.run(cycle.id);
  h.store.close();
  const second = new Harness(root, new FixtureProvider());
  try {
    const next = second.start('test:two', profile, policy, []);
    assert.equal(next.memory[0]?.id, cycle.id);
    assert.ok(next.memory[0]?.reflection?.learning);
    assert.ok(next.recalledMemories.length > 0);
    await second.run(next.id);
    assert.deepEqual(second.store.checkpoint(next.id, 'propose')?.previousWorkIds, [cycle.id]);
  } finally { second.store.close(); }
});

test('the artist can abstain without making or releasing a work', async t => {
  class Abstaining extends FixtureProvider {
    override async generate(req: AgentRequest) {
      const response = await super.generate(req);
      if (req.stage === 'propose') (response.output as { action: string }).action = 'abstain';
      return response;
    }
  }
  const { h, cycle } = await setup(t, new Abstaining());
  assert.equal((await h.run(cycle.id)).status, 'abstained');
  assert.equal(h.store.checkpoint(cycle.id, 'make'), undefined);
  assert.equal(h.store.releases().length, 0);
});

test('revision loops are bounded and all revisions remain in memory', async t => {
  class Revising extends FixtureProvider {
    override async generate(req: AgentRequest) {
      const response = await super.generate(req);
      if (req.stage === 'decide') (response.output as { action: string }).action = 'revise';
      return response;
    }
  }
  const { h, cycle } = await setup(t, new Revising(), { maxRevisions: 1 });
  const result = await h.run(cycle.id);
  assert.equal(result.status, 'rejected');
  assert.equal(result.revision, 1);
  assert.equal(h.store.releases().length, 0);
  assert.ok(h.store.checkpoint(cycle.id, 'make', 0));
  assert.ok(h.store.checkpoint(cycle.id, 'make', 1));
});

test('critic cannot accept the wrong artifact version', async t => {
  class WrongArtifact extends FixtureProvider {
    override async generate(req: AgentRequest) {
      const response = await super.generate(req);
      if (req.stage === 'critique') (response.output as { inspectedArtifactHash: string }).inspectedArtifactHash = 'wrong';
      return response;
    }
  }
  const { h, cycle } = await setup(t, new WrongArtifact());
  await assert.rejects(h.run(cycle.id), /wrong artifact/);
  assert.equal(h.store.get(cycle.id).stage, 'critique');
  assert.equal(h.store.releases().length, 0);
});

test('missing reception cannot become a fabricated public response', async t => {
  class FakeReception extends FixtureProvider {
    override async generate(req: AgentRequest) {
      const response = await super.generate(req);
      if (req.stage === 'research') (response.output as { reception: string }).reception = 'observed';
      return response;
    }
  }
  const { h, cycle } = await setup(t, new FakeReception());
  await assert.rejects(h.step(cycle.id), /without an external reception source/);
  assert.equal(h.store.checkpoint(cycle.id, 'research'), undefined);
});

test('tampered artifacts cannot reach release', async t => {
  const { h, root, cycle } = await setup(t);
  await h.run(cycle.id, 6);
  assert.equal(h.store.get(cycle.id).stage, 'release');
  const artifact = h.store.checkpoint(cycle.id, 'render') as Artifact;
  await writeFile(join(root, artifact.png), 'tampered');
  await assert.rejects(h.step(cycle.id), /integrity/);
  assert.equal(h.store.releases().length, 0);
});

test('pause prevents dispatch and resume retains progress', async t => {
  const { h, cycle } = await setup(t);
  h.store.pause(true);
  await assert.rejects(h.step(cycle.id), PausedError);
  assert.equal(h.store.attempts().length, 0);
  h.store.pause(false);
  assert.equal((await h.step(cycle.id)).stage, 'propose');
});

test('shared daily allowance is reserved across independent database connections', async t => {
  const { h, root, cycle } = await setup(t, new FixtureProvider(), { maxCallsPerDay: 1 });
  const other = new Store(join(root, 'studio.sqlite'));
  try {
    const second = h.start('test:second', profile, { ...policy, maxCallsPerDay: 1 }, []);
    h.store.claim(cycle.id);
    assert.throws(() => other.claim(second.id), BudgetError);
    assert.equal(other.attempts().length, 1);
  } finally { other.close(); }
});

test('lease expiry permits recovery and fences a stale worker result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'theartist-lease-'));
  let now = Date.now();
  const store = new Store(join(root, 'studio.sqlite'), () => now);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const h = new Harness(root, new FixtureProvider(), store);
  const cycle = h.start('lease', profile, policy, []);
  const first = store.claim(cycle.id);
  assert.throws(() => store.claim(cycle.id), BusyError);
  now += policy.leaseMs + 1;
  const second = store.claim(cycle.id);
  const next = { stage: 'propose' as const, revision: 0, status: 'active' as const, outcome: null };
  assert.throws(() => store.complete(first, {}, next), BusyError);
  store.complete(second, { summary: 'recovered' }, next);
  assert.equal(store.get(cycle.id).stage, 'propose');
  assert.equal((store.attempts()[0] as { status: string }).status, 'interrupted');
});

test('failures consume attempts and cannot retry forever', async t => {
  class Broken extends FixtureProvider {
    override async generate(): Promise<AgentResponse> { throw new Error('private-provider-message'); }
  }
  const { h, cycle } = await setup(t, new Broken());
  await assert.rejects(h.step(cycle.id));
  await assert.rejects(h.step(cycle.id));
  await assert.rejects(h.step(cycle.id), AttemptLimitError);
  assert.equal(h.store.attempts().length, 2);
  assert.ok(!JSON.stringify(h.store.events()).includes('private-provider-message'));
  const closed = h.store.closeCycle(cycle.id, 'Closed after the fixture exhausted its attempts.');
  assert.equal(closed.status, 'failed');
  assert.ok(h.store.memories().some(m => m.id === `${cycle.id}:closed`));
});

test('a provider timeout releases the lease and preserves the call reservation', async t => {
  class Hanging extends FixtureProvider {
    override async generate(): Promise<AgentResponse> { return new Promise(() => {}); }
  }
  const { h, cycle } = await setup(t, new Hanging(), { callTimeoutMs: 100, leaseMs: 500 });
  await assert.rejects(h.step(cycle.id), /timed out/);
  assert.equal(h.store.get(cycle.id).stage, 'research');
  assert.equal((h.store.attempts()[0] as { status: string }).status, 'failed');
  assert.equal(h.store.closeCycle(cycle.id, 'Closed timed-out test').status, 'failed');
});

test('a crash between writing release files and checkpointing can be safely retried', async t => {
  const { h, cycle } = await setup(t);
  await h.run(cycle.id, 6);
  const complete = h.store.complete.bind(h.store);
  let failOnce = true;
  h.store.complete = (...args: Parameters<Store['complete']>) => {
    if (args[0].cycle.stage === 'release' && failOnce) { failOnce = false; throw new Error('simulated-checkpoint-failure'); }
    return complete(...args);
  };
  await assert.rejects(h.step(cycle.id));
  assert.equal(h.store.releases().length, 0);
  assert.equal((await h.run(cycle.id)).status, 'released');
  assert.equal(h.store.releases().length, 1);
});

test('public archive excludes private notes and private-source derived work', async t => {
  const { h, root } = await setup(t);
  h.store.addMemory({ id: 'private-note', kind: 'note', content: 'PRIVATE_SENTINEL', cycleId: null,
    sourceIds: [], visibility: 'private', supersedes: null });
  const cycle = h.start('private-cycle', profile, policy,
    observationsSchema.parse([{ ...observations[0], text: 'PRIVATE_SENTINEL', visibility: 'private' }]));
  await h.run(cycle.id);
  const next = h.start('after-private', profile, policy, []);
  assert.ok(!JSON.stringify(next.memory).includes(cycle.id));
  assert.ok(!JSON.stringify(next.recalledMemories).includes('PRIVATE_SENTINEL'));
  const archive = await exportArchive(h.store, root, join(root, 'public'));
  const raw = await readFile(join(archive.directory, 'archive.json'), 'utf8');
  assert.ok(!raw.includes('PRIVATE_SENTINEL'));
  assert.ok(JSON.parse(raw).withheldMemoryCount > 0);
});

test('corrections preserve old memory but exclude it from future active retrieval', async t => {
  const { h } = await setup(t);
  const base = { kind: 'note' as const, cycleId: null, sourceIds: [], visibility: 'public' as const };
  h.store.addMemory({ ...base, id: 'old', content: 'audience old claim', supersedes: null });
  h.store.addMemory({ ...base, id: 'new', content: 'audience corrected claim', supersedes: 'old' });
  assert.equal(h.store.memories('audience').filter(m => m.id === 'old' || m.id === 'new').length, 2);
  const next = h.start('correction', profile, policy, []);
  assert.ok(!next.recalledMemories.some(m => m.id === 'old'));
});

test('model-supplied markup is escaped rather than executed', async t => {
  const { h, root, cycle } = await setup(t);
  const response = await new FixtureProvider().generate({ stage: 'make', cycle, context: {} });
  const output = response.output as Record<string, unknown>;
  output.lines = [{ text: '<script>alert(1)</script>', emphasis: 'normal' }];
  const artifact = await renderArtwork(root, output);
  const svg = await readFile(join(root, artifact.svg), 'utf8');
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
});

test('OpenAI transport sends schema, real image and disabled retries without real credentials', async t => {
  const { cycle } = await setup(t);
  const provider = new OpenAIProvider('test-model', 'fake-test-key');
  let captured: Record<string, unknown> | undefined;
  provider.client.responses.parse = (async (body: Record<string, unknown>, options: { maxRetries: number }) => {
    captured = body;
    assert.equal(options.maxRetries, 0);
    return { id: 'test-response', status: 'completed', output_parsed: { ok: true }, usage: { input_tokens: 11, output_tokens: 7 } };
  }) as typeof provider.client.responses.parse;
  const response = await provider.generate({ stage: 'critique', cycle, context: {}, image: { base64: 'encoded-test-image', hash: 'test-hash' } }, new AbortController().signal);
  assert.equal(response.inputTokens, 11);
  assert.equal(captured?.store, false);
  assert.ok(JSON.stringify(captured).includes('data:image/png;base64,encoded-test-image'));
  assert.ok(JSON.stringify(captured).includes('studio_critique'));
});

test('CLI demo works across separate processes and reruns idempotently', async t => {
  const root = await mkdtemp(join(tmpdir(), 'theartist-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'demo', '--data', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const store = new Store(join(root, 'studio.sqlite'));
  try { assert.equal(store.list().length, 1); assert.equal(store.releases().length, 1); }
  finally { store.close(); }
});
