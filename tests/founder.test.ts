import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Harness } from '../src/harness.js';
import { FixtureProvider, OpenAIProvider } from '../src/agents.js';
import { founderProfileSchema, profileSchema, policySchema, observationsSchema, BudgetError,
  type AgentRequest, type FounderArtifact } from '../src/domain.js';
import { exportArchive } from '../src/archive.js';
import { createFounder, instancePaths, listFounders } from '../src/instances.js';
import { inspectExperiment } from '../src/founder.js';
import { Store } from '../src/store.js';

const profile = founderProfileSchema.parse(JSON.parse(await readFile(new URL('../config/founder.json', import.meta.url), 'utf8')));
const artist = profileSchema.parse(JSON.parse(await readFile(new URL('../config/artist.json', import.meta.url), 'utf8')));
const policy = policySchema.parse(JSON.parse(await readFile(new URL('../config/founder-policy.json', import.meta.url), 'utf8')));
const observations = observationsSchema.parse(JSON.parse(await readFile(new URL('../examples/founder-observations.json', import.meta.url), 'utf8')));

async function setup(t: { after: (fn: () => Promise<void>) => void }, provider = new FixtureProvider()) {
  const root = await mkdtemp(join(tmpdir(), 'founder-test-'));
  const h = new Harness(root, provider);
  t.after(async () => { if (h.store.db.open) h.store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, h, cycle: h.start('founder-test', profile, policy, observations) };
}

test('founder runs the shared loop and exports an unvalidated experiment package', async t => {
  const { root, h, cycle } = await setup(t);
  assert.equal((await h.run(cycle.id)).status, 'released');
  const release = h.store.releases()[0]!;
  assert.equal(release.validationStatus, 'unvalidated');
  assert.equal(release.launchStatus, 'not-launched');
  const artifact = h.store.checkpoint(cycle.id, 'render') as FounderArtifact;
  const text = await inspectExperiment(root, artifact);
  assert.ok(text.includes('Criterion recorded before execution'));
  const archive = await exportArchive(h.store, root, join(root, 'public'));
  assert.equal(await readFile(join(archive.directory, artifact.document), 'utf8'), text);
  assert.equal(h.store.checkpoint(cycle.id, 'research')?.evidenceLevel, 'hypothesis_only');
});

test('fixture and founder notes cannot become observed customer evidence', async t => {
  class InventsEvidence extends FixtureProvider {
    override async generate(req: AgentRequest) {
      const result = await super.generate(req);
      if (req.stage === 'research') Object.assign(result.output as object, { evidenceLevel: 'source_reports', reportedProblemSourceIds: [observations[0]!.id] });
      return result;
    }
  }
  const { h, cycle } = await setup(t, new InventsEvidence());
  await assert.rejects(h.step(cycle.id), /fixtures and notes are not evidence/);
  assert.equal(h.store.releases().length, 0);
});

test('source reports remain unvalidated even when a reviewer accepts the package', async t => {
  const { h } = await setup(t);
  h.store.closeCycle(h.store.list()[0]!.id, 'Use sourced inputs instead');
  const source = observationsSchema.parse([{ ...observations[0], kind: 'source', id: 'customer-report', url: 'https://example.org/test-fixture-report' }]);
  const cycle = h.start('source-cycle', profile, policy, source);
  await h.run(cycle.id);
  assert.equal(h.store.checkpoint(cycle.id, 'research')?.evidenceLevel, 'source_reports');
  assert.equal(h.store.releases()[0]?.validationStatus, 'unvalidated');
});

test('only one active founder experiment is allowed by default', async t => {
  const { h } = await setup(t);
  assert.throws(() => h.start('another', profile, policy, []), BudgetError);
});

test('founder can abstain without creating an experiment package', async t => {
  class Abstains extends FixtureProvider {
    override async generate(req: AgentRequest) {
      const result = await super.generate(req);
      if (req.stage === 'propose') (result.output as { action: string }).action = 'abstain';
      return result;
    }
  }
  const { h, cycle } = await setup(t, new Abstains());
  assert.equal((await h.run(cycle.id)).status, 'abstained');
  assert.equal(h.store.releases().length, 0);
});

test('reviewer receives the actual rendered experiment document', async t => {
  let reviewed: string | undefined;
  class Reviewer extends FixtureProvider {
    override async generate(req: AgentRequest) {
      if (req.stage === 'critique') { reviewed = String(req.context.artifactDocument); assert.equal(req.image, undefined); }
      return super.generate(req);
    }
  }
  const { h, root, cycle } = await setup(t, new Reviewer());
  await h.run(cycle.id);
  assert.equal(reviewed, await inspectExperiment(root, h.store.checkpoint(cycle.id, 'render') as FounderArtifact));
});

test('editing the packaged experiment after approval prevents release', async t => {
  const { h, root, cycle } = await setup(t);
  await h.run(cycle.id, 6);
  const artifact = h.store.checkpoint(cycle.id, 'render') as FounderArtifact;
  await writeFile(join(root, artifact.document), 'Changed threshold after approval');
  await assert.rejects(h.step(cycle.id), /integrity/);
  assert.equal(h.store.releases().length, 0);
});

test('founder memory survives restart and informs the next experiment', async t => {
  const { h, root, cycle } = await setup(t);
  await h.run(cycle.id);
  h.store.close();
  const resumed = new Harness(root, new FixtureProvider());
  try {
    const next = resumed.start('next', profile, policy, []);
    assert.equal(next.memory[0]?.id, cycle.id);
    assert.ok(next.memory[0]?.concept.includes('pilot'));
    await resumed.run(next.id);
    assert.deepEqual(resumed.store.checkpoint(next.id, 'propose')?.previousWorkIds, [cycle.id]);
  } finally { resumed.store.close(); }
});

test('private founder inputs and the experiment they produce are excluded from public exports', async t => {
  const { h, root, cycle } = await setup(t);
  h.store.closeCycle(cycle.id, 'Replace with private observations');
  const privateInputs = observationsSchema.parse([{ ...observations[0], visibility: 'private', text: 'PRIVATE_FOUNDER_EVIDENCE' }]);
  const next = h.start('private-founder-cycle', profile, policy, privateInputs);
  await h.run(next.id);
  const archive = await exportArchive(h.store, root, join(root, 'public'));
  const serialized = await readFile(join(archive.directory, 'archive.json'), 'utf8');
  assert.ok(!serialized.includes('PRIVATE_FOUNDER_EVIDENCE'));
  assert.equal(JSON.parse(serialized).releases.length, 0);
});

test('one data directory cannot mix artist and founder histories', async t => {
  const { h } = await setup(t);
  assert.throws(() => h.start('artist', artist, policy, []), /different studio/);
});

test('founder initialization accepts arbitrary missions and protects existing configurations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'founder-instances-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config'));
  for (const file of ['founder.json', 'founder-policy.json']) await copyFile(new URL(`../config/${file}`, import.meta.url), join(root, 'config', file));
  const community = await createFounder(root, 'community', { mission: 'Start a neighborhood repair community', audience: 'Local residents', venture: 'Community' });
  const app = await createFounder(root, 'social-ai', { mission: 'Explore a social AI app', audience: 'Small creative groups', venture: 'Software' });
  assert.notEqual(community.data, app.data);
  const cp = founderProfileSchema.parse(JSON.parse(await readFile(community.profile, 'utf8')));
  const ap = founderProfileSchema.parse(JSON.parse(await readFile(app.profile, 'utf8')));
  assert.equal(cp.mandate, 'Start a neighborhood repair community');
  assert.equal(ap.mandate, 'Explore a social AI app');
  await assert.rejects(createFounder(root, 'community', { mission: 'Overwrite' }), /already exists/);
  assert.equal((await listFounders(root)).length, 2);
  assert.throws(() => instancePaths(root, '../escape'), /Founder ID/);
  const ch = new Harness(community.data, new FixtureProvider());
  const ah = new Harness(app.data, new FixtureProvider());
  try {
    const first = ch.start('same-trigger', cp, policy, []);
    await ch.run(first.id);
    const second = ah.start('same-trigger', ap, policy, []);
    assert.equal(second.memory.length, 0);
    assert.equal(second.recalledMemories.length, 0);
    assert.throws(() => ch.start('wrong-data', ap, policy, []), /another founder instance/);
  } finally { ch.store.close(); ah.store.close(); }
});

test('OpenAI founder transport selects founder instructions and schemas', async t => {
  const { cycle } = await setup(t);
  const provider = new OpenAIProvider('test-model', 'fake-test-key');
  let body: Record<string, unknown> | undefined;
  provider.client.responses.parse = (async (input: Record<string, unknown>) => {
    body = input;
    return { id: 'test', status: 'completed', output_parsed: {}, usage: null };
  }) as unknown as typeof provider.client.responses.parse;
  await provider.generate({ stage: 'propose', cycle, context: {} }, new AbortController().signal);
  assert.ok(String(body?.instructions).includes('configured founder'));
  assert.ok(JSON.stringify(body?.text).includes('successCriterion'));
  assert.ok(!JSON.stringify(body?.text).includes('materialReason'));
});

test('CLI founder demo is idempotent across separate processes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'founder-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'demo', '--studio', 'founder', '--data', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const store = new Store(join(root, 'studio.sqlite'));
  try { assert.equal(store.releases().length, 1); assert.equal(store.releases()[0]?.validationStatus, 'unvalidated'); }
  finally { store.close(); }
});
