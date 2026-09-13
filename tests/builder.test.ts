import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Builder, artifactPath, type BuildJob, type BuildTransport, type RemoteBuild } from '../src/builder.js';
import { Board } from '../src/board.js';
import { executionLog } from '../src/managed-builder.js';
import { Harness } from '../src/harness.js';
import { FixtureProvider } from '../src/agents.js';
import { founderProfileSchema, policySchema, observationsSchema, type AgentProvider } from '../src/domain.js';
import { exportArchive } from '../src/archive.js';
import type { AgentSessionItem } from 'openai/resources/beta/agents/agents';

const profile = founderProfileSchema.parse(JSON.parse(await readFile(new URL('../config/founder.json', import.meta.url), 'utf8')));
const policy = policySchema.parse({ ...JSON.parse(await readFile(new URL('../config/founder-policy.json', import.meta.url), 'utf8')), maxWebCallsPerAttempt: 0 });
const inputs = observationsSchema.parse(JSON.parse(await readFile(new URL('../examples/founder-observations.json', import.meta.url), 'utf8')));
class FakeTransport implements BuildTransport {
  creates = 0; submits = 0; cancels = 0; deletes = 0;
  uncertainCreate = false; uncertainSubmit = false;
  status: RemoteBuild['status'] = 'completed';
  path = '/workspace/outputs/prototype/app.py';
  bytes = Buffer.from('print("synthetic prototype")\n');
  async create() { this.creates++; if (this.uncertainCreate) throw new Error('disconnect'); return 'session-test'; }
  async find() { return 'session-test'; }
  async submit() { this.submits++; if (this.uncertainSubmit) throw new Error('disconnect'); }
  async inspect(): Promise<RemoteBuild> { return { status: this.status, turnId: this.status === 'pending' ? null : 'turn-test',
    commands: [{ command: 'python app.py', exitCode: 0, output: 'synthetic prototype', status: 'completed' }], summary: 'Synthetic execution only.', usage: null }; }
  async files() { return [{ id: 'file-test', path: this.path, sizeBytes: this.bytes.length }]; }
  async download() { return this.bytes; }
  async cancel() { this.cancels++; }
  async cleanup() { this.deletes++; }
}
async function setup(t: { after: (fn: () => Promise<void>) => void }, privateInput = false, governance = false) {
  const root = await mkdtemp(join(tmpdir(), 'builder-test-'));
  const fixture = new FixtureProvider();
  // Mock live provider so the acceptance path is tested without any network calls.
  const provider: AgentProvider = { name: 'openai', model: 'test-only', generate: req => fixture.generate(req) };
  const h = new Harness(root, provider);
  t.after(async () => { h.store.close(); await rm(root, { recursive: true, force: true }); });
  const observations = privateInput ? inputs.map(o => ({ ...o, visibility: 'private' as const, text: 'SECRET_BUILD_INPUT' })) : inputs;
  const cycle = h.start('build-test', profile, policy, observations);
  if (governance) new Board(h.store).nudge('launcher', 'Build one inspectable prototype.', 'prototype');
  await h.run(cycle.id);
  const transport = new FakeTransport();
  const builder = new Builder(root, h.store, transport);
  return { root, h, cycle, transport, builder };
}

test('accepted experiment builds, persists execution memory, exports verified code, and does not rebuild', async t => {
  const { root, h, cycle, builder, transport } = await setup(t);
  await builder.enqueue(cycle.id, policy.builder!);
  const job = await builder.tick(cycle.id);
  assert.equal(job.status, 'built');
  assert.equal(job.cleanup, 'deleted');
  assert.equal(await readFile(join(root, job.artifacts[0]!.file), 'utf8'), transport.bytes.toString());
  assert.equal(h.store.recentMemory()[0]?.execution?.status, 'built');
  const archive = await exportArchive(h.store, root, join(root, 'public'));
  assert.equal(await readFile(join(archive.directory, job.artifacts[0]!.file), 'utf8'), transport.bytes.toString());
  await builder.enqueue(cycle.id, policy.builder!); await builder.tick(cycle.id);
  assert.equal(transport.creates, 1); assert.equal(transport.submits, 1);
  assert.ok(h.store.verifyEvents());
  await writeFile(join(root, job.artifacts[0]!.file), 'tampered');
  await assert.rejects(exportArchive(h.store, root, join(root, 'public')), /integrity/);
});

test('uncertain session creation is reconciled on restart without duplicate creation', async t => {
  const { root, h, cycle, builder, transport } = await setup(t);
  transport.uncertainCreate = true;
  await builder.enqueue(cycle.id, policy.builder!);
  await assert.rejects(builder.tick(cycle.id), /disconnect/);
  assert.equal(builder.get(cycle.id)?.status, 'creating');
  const resumed = new Builder(root, h.store, transport);
  assert.equal((await resumed.tick(cycle.id)).status, 'built');
  assert.equal(transport.creates, 1); assert.equal(transport.submits, 1);
});

test('uncertain input submission is only polled and pending is not success', async t => {
  const { cycle, builder, transport } = await setup(t);
  transport.uncertainSubmit = true; transport.status = 'pending';
  await builder.enqueue(cycle.id, policy.builder!);
  await assert.rejects(builder.tick(cycle.id), /disconnect/);
  assert.equal((await builder.tick(cycle.id)).status, 'dispatching');
  transport.status = 'completed';
  assert.equal((await builder.tick(cycle.id)).status, 'built');
  assert.equal(transport.submits, 1);
});

test('pause cancels a running turn and waits for explicit remote completion', async t => {
  const { h, cycle, builder, transport } = await setup(t);
  transport.status = 'running'; await builder.enqueue(cycle.id, policy.builder!);
  await builder.tick(cycle.id); h.store.pause(true);
  assert.equal((await builder.tick(cycle.id)).status, 'cancelling');
  transport.status = 'cancelled';
  const job = await builder.tick(cycle.id);
  assert.equal(job.status, 'cancelled'); assert.equal(job.artifacts.length, 0);
  assert.equal(transport.cancels, 1); assert.equal(transport.deletes, 1);
});

test('daily build allowance is enforced separately from founder model calls', async t => {
  const { h, cycle, builder } = await setup(t);
  await builder.enqueue(cycle.id, policy.builder!); await builder.tick(cycle.id);
  const next = h.start('next-build', profile, { ...policy, maxCallsPerDay: 60 }, inputs); await h.run(next.id);
  await assert.rejects(builder.enqueue(next.id, policy.builder!), /Daily build-job/);
});

test('artifact traversal is rejected and private builds are withheld', async t => {
  for (const path of ['/tmp/code.py', '/workspace/outputs/../code.py', '/workspace/outputs/a\\b.py']) assert.throws(() => artifactPath(path));
  const { root, h, cycle, builder, transport } = await setup(t, true);
  await builder.enqueue(cycle.id, policy.builder!); await builder.tick(cycle.id);
  const archive = await exportArchive(h.store, root, join(root, 'public'));
  const manifest = await readFile(join(archive.directory, 'archive.json'), 'utf8');
  assert.ok(!manifest.includes('SECRET_BUILD_INPUT')); assert.equal(JSON.parse(manifest).builds.length, 0);
});

test('unsafe remote files fail the job without writing outside its directory', async t => {
  const { cycle, builder, transport } = await setup(t);
  transport.path = '/workspace/outputs/../../bad.py';
  await builder.enqueue(cycle.id, policy.builder!);
  await assert.rejects(builder.tick(cycle.id), /Unsafe/);
  assert.equal(builder.get(cycle.id)?.status, 'failed'); assert.equal(transport.deletes, 1);
});

test('execution log excludes reasoning items and captures actual exit codes', () => {
  const items = [
    { type: 'reasoning', summary: [{ text: 'PRIVATE_REASONING' }] },
    { type: 'command_execution', command: 'python tests.py', exit_code: 1, output: 'FAILED', status: 'completed' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests failed.' }] },
  ] as unknown as AgentSessionItem[];
  const log = executionLog(items);
  assert.equal(log.commands[0]?.exitCode, 1); assert.equal(log.summary, 'Tests failed.');
  assert.ok(!JSON.stringify(log).includes('PRIVATE_REASONING'));
});

test('another worker cannot dispatch while a build poll holds its lease', async t => {
  const { root, h, cycle, builder, transport } = await setup(t);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const inspect = transport.inspect.bind(transport);
  transport.inspect = async () => { entered(); await wait; return inspect(); };
  await builder.enqueue(cycle.id, policy.builder!);
  const first = builder.tick(cycle.id); await started;
  const other = new Builder(root, h.store, transport);
  await assert.rejects(other.tick(cycle.id), /Another worker/);
  release(); await first;
  assert.equal(transport.submits, 1);
});

test('expired queued builds never create remote sessions', async t => {
  const { h, cycle, builder, transport } = await setup(t);
  const job = await builder.enqueue(cycle.id, policy.builder!);
  h.store.db.prepare('UPDATE build_jobs SET payload=? WHERE cycle_id=?').run(JSON.stringify({ ...job, deadline: 0 }), cycle.id);
  assert.equal((await builder.tick(cycle.id)).status, 'cancelled');
  assert.equal(transport.creates, 0); assert.equal(transport.submits, 0);
});

test('failed remote turns cannot become built', async t => {
  const { cycle, builder, transport } = await setup(t);
  transport.status = 'failed'; await builder.enqueue(cycle.id, policy.builder!);
  const job = await builder.tick(cycle.id);
  assert.equal(job.status, 'failed'); assert.equal(job.artifacts.length, 0);
  assert.equal(transport.deletes, 1);
});

test('managed adapter disables network and separates session creation from model dispatch', async () => {
  const { ManagedBuilder } = await import('../src/managed-builder.js');
  const transport = new ManagedBuilder('test-only-key');
  let created: Record<string, unknown> | undefined;
  let sent: Record<string, unknown> | undefined;
  transport.client.beta.agents.sessions.create = (async (body: Record<string, unknown>) => {
    created = body; return { id: 'test-session' };
  }) as unknown as typeof transport.client.beta.agents.sessions.create;
  transport.client.beta.agents.sessions.events.create = (async (_id: string, body: Record<string, unknown>) => {
    sent = body; return {};
  }) as unknown as typeof transport.client.beta.agents.sessions.events.create;
  const job = { id: 'build-test', cycleId: 'cycle-test', model: 'test-model', brief: 'accepted public brief', sessionId: 'test-session' } as BuildJob;
  assert.equal(await transport.create(job), 'test-session');
  assert.equal(created?.input, undefined); assert.equal(sent, undefined);
  const environment = created?.environment as { network: { access: string }; files: unknown[] };
  assert.equal(environment.network.access, 'disabled');
  assert.ok(!JSON.stringify(created).includes('test-only-key'));
  await transport.submit(job); assert.ok(JSON.stringify(sent).includes('agent.session.input.message'));
});

test('API null exit codes remain unknown while completed execution can produce a prototype', async t => {
  const { cycle, builder, transport } = await setup(t);
  const inspect = transport.inspect.bind(transport);
  transport.inspect = async () => { const result = await inspect(); result.commands[0]!.exitCode = null; return result; };
  await builder.enqueue(cycle.id, policy.builder!);
  const job = await builder.tick(cycle.id);
  assert.equal(job.status, 'built'); assert.equal(job.commands[0]?.exitCode, null);
});

test('explicit nonzero exits cannot satisfy the execution gate', async t => {
  const { cycle, builder, transport } = await setup(t);
  const inspect = transport.inspect.bind(transport);
  transport.inspect = async () => { const result = await inspect(); result.commands[0]!.exitCode = 1; return result; };
  await builder.enqueue(cycle.id, policy.builder!);
  assert.equal((await builder.tick(cycle.id)).status, 'failed');
});

test('unresponsive cancellation deletes the session after grace rather than leaving paid work active', async t => {
  const { h, cycle, builder, transport } = await setup(t);
  transport.status = 'running'; await builder.enqueue(cycle.id, policy.builder!);
  await builder.tick(cycle.id);
  const job = builder.get(cycle.id)!;
  h.store.db.prepare('UPDATE build_jobs SET payload=? WHERE cycle_id=?').run(JSON.stringify({ ...job, status: 'cancelling', cancelRequestedAt: 0 }), cycle.id);
  const result = await builder.tick(cycle.id);
  assert.equal(result.status, 'cancelled'); assert.equal(result.cleanup, 'deleted');
  assert.equal(transport.deletes, 1);
  assert.match(result.error!, /did not confirm cancellation/);
});

test('rejected session deletion keeps cancellation unresolved and preserves the active-job limit', async t => {
  const { h, cycle, builder, transport } = await setup(t);
  const { StudioError } = await import('../src/domain.js');
  transport.status = 'running'; await builder.enqueue(cycle.id, policy.builder!); await builder.tick(cycle.id);
  const job = builder.get(cycle.id)!;
  h.store.db.prepare('UPDATE build_jobs SET payload=? WHERE cycle_id=?').run(JSON.stringify({ ...job, status: 'cancelling', cancelRequestedAt: 0 }), cycle.id);
  transport.cleanup = async () => { throw new StudioError('Provider refused deletion'); };
  await assert.rejects(builder.tick(cycle.id), /refused deletion/);
  assert.equal(builder.get(cycle.id)?.status, 'cancelling');
  const next = h.start('blocked-build', profile, { ...policy, maxCallsPerDay: 60 }, inputs); await h.run(next.id);
  await assert.rejects(builder.enqueue(next.id, { ...policy.builder!, maxJobsPerDay: 2 }), /Another build is still active/);
});


test('build briefs retain the supervisor board decision and frozen guidance across later withdrawals', async t => {
  const { h, cycle, builder } = await setup(t, false, true);
  const job = await builder.enqueue(cycle.id, policy.builder!);
  const brief = JSON.parse(job.brief);
  assert.equal(brief.boardResponses[0].nudge.text, 'Build one inspectable prototype.');
  assert.equal(brief.boardResponses[0].response.disposition, 'defer');
  assert.equal(brief.supervisorDecision.action, 'accept');
  const board = new Board(h.store);
  board.withdraw('launcher', board.nudges()[0]!.id, 'Later priorities');
  assert.equal((await builder.enqueue(cycle.id, policy.builder!)).briefHash, job.briefHash);
});
