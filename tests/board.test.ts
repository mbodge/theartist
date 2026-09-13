import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, copyFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Board, boardContext } from '../src/board.js';
import { Store } from '../src/store.js';
import { Harness } from '../src/harness.js';
import { FixtureProvider, OpenAIProvider } from '../src/agents.js';
import { profileSchema, policySchema, type AgentRequest, type AgentResponse, type Result } from '../src/domain.js';
import { exportArchive } from '../src/archive.js';
import { createFounder } from '../src/instances.js';

const founder = profileSchema.parse(JSON.parse(await readFile(new URL('../config/founder.json', import.meta.url), 'utf8')));
const artist = profileSchema.parse(JSON.parse(await readFile(new URL('../config/artist.json', import.meta.url), 'utf8')));
const policy = policySchema.parse(JSON.parse(await readFile(new URL('../config/founder-policy.json', import.meta.url), 'utf8')));
async function setup(t: { after: (fn: () => Promise<void>) => void }, provider = new FixtureProvider()) {
  const root = await mkdtemp(join(tmpdir(), 'board-test-'));
  const store = new Store(join(root, 'studio.sqlite'));
  const board = new Board(store);
  board.initialize({ id: 'owner', name: 'The launcher' });
  const h = new Harness(root, provider, store);
  t.after(async () => { if (store.db.open) store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, board, h };
}

test('launcher appointment, removal, author attribution, and immutable nudge history', async t => {
  const { board, store } = await setup(t);
  board.addMember('owner', { id: 'director', name: 'A director' });
  assert.throws(() => board.addMember('director', { id: 'other', name: 'Other' }), /Only the launcher/);
  assert.throws(() => board.nudge('outsider', 'hello', 'key'), /active board member/);
  const nudge = board.nudge('director', 'Make something useful this week.', 'focus');
  assert.equal(board.nudge('director', nudge.text, 'focus').id, nudge.id);
  assert.throws(() => board.nudge('director', 'Changed text', 'focus'), /different text/);
  board.removeMember('owner', 'director');
  assert.equal(board.nudges()[0]?.withdrawalReason, 'Author removed from board');
  assert.throws(() => board.nudge('director', 'again', 'new'), /active board member/);
  assert.throws(() => board.addMember('owner', { id: 'director', name: 'New person' }), /cannot be reused/);
  assert.throws(() => board.removeMember('owner', 'owner'), /cannot be removed/);
  assert.throws(() => board.initialize({ id: 'impostor', name: 'Other' }), /already has a launcher/);
  assert.ok(store.memories().some(m => m.content.includes('Make something useful')));
  assert.ok(store.verifyEvents());
});

test('only author or launcher may withdraw; active nudge context is bounded', async t => {
  const { board } = await setup(t);
  board.addMember('owner', { id: 'director', name: 'Director' });
  const first = board.nudge('owner', 'Focus', '0');
  assert.throws(() => board.withdraw('director', first.id, 'No'), /author or launcher/);
  for (let i = 1; i < 8; i++) board.nudge('owner', `Priority ${i}`, `${i}`);
  assert.throws(() => board.nudge('owner', 'Overflow', '8'), /Eight nudges/);
  board.withdraw('owner', first.id, 'Replace direction');
  board.nudge('owner', 'Replacement', '8');
  assert.equal(board.nudges().filter(n => !n.withdrawnAt).length, 8);
  assert.equal(board.nudges().length, 9);
});

for (const profile of [founder, artist]) {
  test(`${'studio' in profile ? 'founder' : 'artist'} supervisor receives and answers board guidance, preserved across restart`, async t => {
    const seen: AgentRequest[] = [];
    class Supervisor extends FixtureProvider {
      override async generate(req: AgentRequest): Promise<AgentResponse> {
        seen.push(req);
        const value = await super.generate(req);
        if (req.stage === 'propose') {
          const envelope = value.output as { result: Result; boardResponses: Array<Record<string, unknown>> };
          envelope.result.rationale = 'Adopt the board focus by making a small executable experiment.';
          envelope.boardResponses[0] = { nudgeId: boardContext(req)!.pendingNudgeIds[0], disposition: 'adopt', rationale: 'Narrowing the scope makes the next result reviewable.' };
        }
        return value;
      }
    }
    const { root, board, h, store } = await setup(t, new Supervisor());
    const nudge = board.nudge('owner', 'Prefer small, reviewable work.', 'scope');
    const cycle = h.start('one', profile, policy, []);
    await h.run(cycle.id);
    assert.equal(board.responses().length, 1);
    assert.equal(board.responses()[0]?.disposition, 'adopt');
    assert.equal(store.checkpoint(cycle.id, 'propose')?.rationale, 'Adopt the board focus by making a small executable experiment.');
    assert.equal(boardContext(seen.find(r => r.stage === 'decide')!)?.pendingNudgeIds.length, 0);
    assert.equal(boardContext(seen.find(r => r.stage === 'decide')!)?.nudges[0]?.id, nudge.id);
    const savedPolicy = store.get(cycle.id).policy;
    assert.deepEqual(savedPolicy, policy);
    store.close();
    const restarted = new Store(join(root, 'studio.sqlite'));
    try {
      const nextHarness = new Harness(root, new FixtureProvider(), restarted);
      const next = nextHarness.start('two', profile, policy, []);
      await nextHarness.run(next.id);
      assert.equal(new Board(restarted).responses().length, 2);
      assert.equal(new Board(restarted).responses()[1]?.disposition, 'defer');
      assert.ok(restarted.verifyEvents());
    } finally { restarted.close(); }
  });
}

test('a nudge added after proposal reaches the next decision without rewriting the proposal', async t => {
  const { board, h, store } = await setup(t);
  const cycle = h.start('mid-cycle', founder, policy, []);
  await h.run(cycle.id, 2);
  const proposal = JSON.stringify(store.checkpoint(cycle.id, 'propose'));
  const nudge = board.nudge('owner', 'Keep the outcome tangible.', 'mid-cycle');
  await h.run(cycle.id);
  assert.equal(board.responses()[0]?.stage, 'decide');
  assert.equal(board.responses()[0]?.nudgeId, nudge.id);
  assert.equal(JSON.stringify(store.checkpoint(cycle.id, 'propose')), proposal);
});

test('nudge arriving during a call is delivered next time; withdrawn in-flight guidance retains its exact snapshot', async t => {
  let during: (() => void) | undefined;
  class Delayed extends FixtureProvider {
    override async generate(req: AgentRequest) {
      if (req.stage === 'propose') during?.();
      return super.generate(req);
    }
  }
  const { board, h, store } = await setup(t, new Delayed());
  const first = board.nudge('owner', 'Initial direction', 'initial');
  let laterId = '';
  during = () => { board.withdraw('owner', first.id, 'Updated during request'); laterId = board.nudge('owner', 'New direction', 'new').id; };
  const cycle = h.start('overlap', founder, policy, []);
  await h.run(cycle.id);
  assert.deepEqual(board.responses().map(r => [r.nudgeId, r.stage]), [[first.id, 'propose'], [laterId, 'decide']]);
  const deliveries = board.publicRecord(new Set([cycle.id])).deliveries;
  assert.equal(deliveries.find(d => d.stage === 'propose')?.snapshot.nudges[0]?.withdrawnAt, null);
  assert.deepEqual(deliveries.find(d => d.stage === 'decide')?.snapshot.nudges.map(n => n.id), [laterId]);
  assert.equal(board.executionBrief(cycle.id).find(item => item.nudge.id === first.id)?.activeAtAcceptance, false);
  assert.equal(board.executionBrief(cycle.id).find(item => item.nudge.id === laterId)?.activeAtAcceptance, true);
  assert.ok(store.verifyEvents());
});

test('invalid or invented responses roll back the entire decision and cannot acknowledge the nudge', async t => {
  class Invalid extends FixtureProvider {
    override async generate(req: AgentRequest) {
      const response = await super.generate(req);
      if (req.stage === 'propose') (response.output as { boardResponses: unknown[] }).boardResponses = [{ nudgeId: 'made-up', disposition: 'adopt', rationale: 'Pretend' }];
      return response;
    }
  }
  const { board, h, store } = await setup(t, new Invalid());
  board.nudge('owner', 'Ship an experiment.', 'ship');
  const cycle = h.start('invalid', founder, policy, []);
  await h.step(cycle.id);
  await assert.rejects(h.step(cycle.id), /each delivered pending board nudge exactly once/);
  assert.equal(board.responses().length, 0);
  assert.equal(store.get(cycle.id).stage, 'propose');
  assert.equal(store.checkpoint(cycle.id, 'propose'), undefined);
  assert.ok(!store.memories().some(m => m.id.startsWith('board:response:')));
});

test('public board exports include deliberations but withhold private-cycle replies and snapshots', async t => {
  class PrivateSupervisor extends FixtureProvider {
    override async generate(req: AgentRequest) {
      const result = await super.generate(req);
      if (req.stage === 'propose') (result.output as { boardResponses: Array<{ rationale: string }> }).boardResponses[0]!.rationale = 'PRIVATE_BOARD_RESPONSE';
      return result;
    }
  }
  const { board, h, store, root } = await setup(t, new PrivateSupervisor());
  board.nudge('owner', 'A public nudge', 'public');
  const cycle = h.start('private', founder, policy, [{ id: 'private', stream: 'world', kind: 'studio_note', title: 'Private', text: 'PRIVATE_INPUT', visibility: 'private', url: null, observedAt: '2026-09-13T00:00:00Z' }]);
  await h.run(cycle.id);
  assert.equal(board.responses()[0]?.visibility, 'private');
  const exported = await exportArchive(store, root, join(root, 'public'));
  const text = await readFile(join(exported.directory, 'archive.json'), 'utf8');
  assert.ok(text.includes('A public nudge'));
  assert.ok(!text.includes('PRIVATE_BOARD_RESPONSE'));
  assert.equal(JSON.parse(text).board.deliveries.length, 0);
  assert.equal(JSON.parse(text).board.responses.length, 0);
});

test('a fresh founder provisions its launching board and another instance gets no nudges', async t => {
  const root = await mkdtemp(join(tmpdir(), 'board-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config'));
  for (const file of ['founder.json', 'founder-policy.json']) await copyFile(new URL(`../config/${file}`, import.meta.url), join(root, 'config', file));
  await assert.rejects(createFounder(root, 'bad-owner', { launcher: { id: '../bad', name: 'Invalid' } }));
  await assert.rejects(access(join(root, 'studios/bad-owner')));
  const first = await createFounder(root, 'first', { launcher: { id: 'mike', name: 'Mike' } });
  const second = await createFounder(root, 'second');
  const a = new Store(join(first.data, 'studio.sqlite')), b = new Store(join(second.data, 'studio.sqlite'));
  try {
    new Board(a).nudge('mike', 'Only for the first studio', 'only');
    assert.equal(new Board(a).members()[0]?.role, 'launcher');
    assert.equal(new Board(b).nudges().length, 0);
  } finally { a.close(); b.close(); }
});

test('OpenAI transport requires structured board replies on supervisor calls', async t => {
  const { board, h, store } = await setup(t);
  board.nudge('owner', 'Build visibly.', 'visible');
  const cycle = h.start('transport', founder, policy, []);
  await h.step(cycle.id);
  const lease = store.claim(cycle.id);
  const request: AgentRequest = { stage: 'propose', cycle: lease.cycle, context: { board: board.deliver(lease) } };
  const provider = new OpenAIProvider('test-model', 'fake-test-key');
  let body: Record<string, unknown> | undefined;
  provider.client.responses.parse = (async (input: Record<string, unknown>) => {
    body = input; return { id: 'fake', status: 'completed', output_parsed: {}, usage: null };
  }) as unknown as typeof provider.client.responses.parse;
  await provider.generate(request, new AbortController().signal);
  assert.ok(String(body?.instructions).includes('supervisor retains judgment'));
  assert.ok(JSON.stringify(body?.text).includes('boardResponses'));
  assert.ok(JSON.stringify(body?.input).includes('Build visibly.'));
});

test('board CLI attributes and deduplicates nudges across processes without API credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'board-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  function run(args: string[]) { return spawnSync(process.execPath, ['--import', 'tsx', cli, 'board', ...args, '--data', root], { encoding: 'utf8' }); }
  assert.equal(run(['init', '--as', 'owner', '--name', 'Owner']).status, 0);
  for (let n = 0; n < 2; n++) assert.equal(run(['nudge', '--as', 'owner', '--key', 'one', '--text', 'Make one small thing']).status, 0);
  const shown = run([]); assert.equal(JSON.parse(shown.stdout).nudges.length, 1);
  assert.notEqual(run(['nudge', '--as', 'outsider', '--text', 'no']).status, 0);
  assert.notEqual(run(['nudge', '--as', 'owner', '--private', '--text', 'secret']).status, 0);
});

test('expired workers cannot commit board replies and a subsequent attempt can answer once', async t => {
  let expire: (() => void) | undefined;
  class Expiring extends FixtureProvider {
    override async generate(req: AgentRequest) {
      if (req.stage === 'propose') { expire?.(); expire = undefined; }
      return super.generate(req);
    }
  }
  const { board, h, store } = await setup(t, new Expiring());
  board.nudge('owner', 'Preserve the decision history.', 'history');
  const cycle = h.start('lease', founder, policy, []);
  expire = () => { store.db.prepare('UPDATE cycles SET lease_until=0 WHERE id=?').run(cycle.id); };
  await h.step(cycle.id);
  await assert.rejects(h.step(cycle.id), /Lease expired/);
  assert.equal(board.responses().length, 0);
  await h.step(cycle.id);
  assert.equal(board.responses().length, 1);
  assert.equal(board.publicRecord(new Set([cycle.id])).deliveries.filter(d => d.stage === 'propose').length, 2);
});

for (const fault of ['missing', 'duplicate']) {
  test(`${fault} replies cannot silently drop a director's nudge`, async t => {
    class Invalid extends FixtureProvider {
      override async generate(req: AgentRequest) {
        const result = await super.generate(req);
        if (req.stage === 'propose') {
          const envelope = result.output as { boardResponses: unknown[] };
          envelope.boardResponses = fault === 'missing' ? [envelope.boardResponses[0]] : [envelope.boardResponses[0], envelope.boardResponses[0]];
        }
        return result;
      }
    }
    const { board, h } = await setup(t, new Invalid());
    board.nudge('owner', 'First priority.', 'first'); board.nudge('owner', 'Second priority.', 'second');
    const cycle = h.start('missing', founder, policy, []);
    await h.step(cycle.id);
    await assert.rejects(h.step(cycle.id), /each delivered pending board nudge exactly once/);
    assert.equal(board.responses().length, 0);
  });
}
