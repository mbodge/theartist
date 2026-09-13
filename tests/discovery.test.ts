import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type OpenAI from 'openai';
import { FixtureProvider, OpenAIProvider, agentInput } from '../src/agents.js';
import { discoveryRecord } from '../src/discovery.js';
import { Harness } from '../src/harness.js';
import { Store } from '../src/store.js';
import { exportArchive } from '../src/archive.js';
import { founderProfileSchema, policySchema, observationsSchema, type AgentRequest, type FounderArtifact } from '../src/domain.js';
import { inspectExperiment } from '../src/founder.js';

const profile = founderProfileSchema.parse(JSON.parse(await readFile(new URL('../config/founder.json', import.meta.url), 'utf8')));
const policy = policySchema.parse({ ...JSON.parse(await readFile(new URL('../config/founder-policy.json', import.meta.url), 'utf8')), maxWebCallsPerAttempt: 4 });
const url = 'https://example.org/primary-report';
const summary = 'A source reports a recurring coordination problem. ';
const response = () => ({
  id: 'response-test', status: 'completed', usage: { input_tokens: 120, output_tokens: 50 },
  output: [
    { type: 'reasoning', id: 'hidden', summary: [], content: 'DO_NOT_EXPORT_INTERNAL_REASONING' },
    { type: 'web_search_call', id: 'search-one', status: 'completed', action: { type: 'search', queries: ['recurring coordination problem'], sources: [{ type: 'url', url }] } },
    { type: 'web_search_call', id: 'read-one', status: 'completed', action: { type: 'open_page', url } },
    { type: 'message', id: 'message-one', status: 'completed', role: 'assistant', content: [{ type: 'output_text',
      text: summary + '[source]. An uncited URL https://invented.example/fake must not become a source.',
      annotations: [{ type: 'url_citation', url, title: 'Primary report', start_index: summary.length, end_index: summary.length + 8 }] }] },
  ],
}) as unknown as OpenAI.Responses.Response;

class ResearchProvider extends OpenAIProvider {
  searches = 0;
  inputs: AgentRequest[] = [];
  body: Record<string, unknown> | undefined;
  fixture = new FixtureProvider();
  constructor() {
    super('test-model', 'fake-test-key');
    this.client.responses.create = (async (body: Record<string, unknown>) => {
      this.body = body; this.searches++; return response();
    }) as unknown as typeof this.client.responses.create;
  }
  override async generate(req: AgentRequest, signal: AbortSignal) {
    this.inputs.push(req);
    if (req.stage === 'discover') return super.generate(req, signal);
    const result = await this.fixture.generate(req);
    if (req.stage === 'propose') Object.assign(result.output as object, { sourceIds: req.cycle.discoveredObservations?.map(o => o.id) ?? [] });
    return result;
  }
}

async function setup(t: { after: (fn: () => Promise<void>) => void }, provider = new ResearchProvider(), privateInput = false) {
  const root = await mkdtemp(join(tmpdir(), 'discovery-test-'));
  const store = new Store(join(root, 'studio.sqlite'));
  const harness = new Harness(root, provider, store);
  t.after(async () => { if (store.db.open) store.close(); await rm(root, { recursive: true, force: true }); });
  const observations = privateInput ? observationsSchema.parse([{ id: 'private-note', stream: 'interest', kind: 'studio_note',
    visibility: 'private', title: 'Private note', text: 'PRIVATE_CUSTOMER_SECRET', url: null, observedAt: new Date().toISOString() }]) : [];
  return { root, store, harness, provider, cycle: harness.start('trial', profile, policy, observations) };
}

test('discovery uses bounded web tools, retains only annotated sources, and excludes internal reasoning', async t => {
  const { harness, provider, cycle } = await setup(t);
  assert.equal(cycle.stage, 'discover');
  const next = await harness.step(cycle.id);
  assert.equal(next.stage, 'research');
  assert.deepEqual(provider.body?.tools, [{ type: 'web_search', search_context_size: 'medium', external_web_access: true }]);
  assert.equal(provider.body?.max_tool_calls, 4);
  assert.equal(provider.body?.tool_choice, 'required');
  assert.deepEqual(provider.body?.include, ['web_search_call.action.sources']);
  assert.equal(provider.body?.store, false);
  assert.equal(next.discoveredObservations?.length, 1);
  assert.equal(next.discoveredObservations?.[0]?.url, url);
  assert.equal(next.discoveredObservations?.[0]?.stream, 'world');
  const checkpoint = harness.store.checkpoint(cycle.id, 'discover');
  assert.ok(!JSON.stringify(checkpoint).includes('DO_NOT_EXPORT_INTERNAL_REASONING'));
  assert.equal((checkpoint?.toolCalls as unknown[]).length, 2);
  assert.equal((harness.store.attempts()[0] as Record<string, unknown>).input_tokens, 120);
});

test('discovery survives restart, is not repeated, and its sources reach production, memory, and export', async t => {
  const { harness, provider, cycle, root, store } = await setup(t);
  const first = await harness.step(cycle.id);
  store.close();
  const resumed = new Harness(root, provider);
  try {
    assert.equal((await resumed.run(cycle.id)).status, 'released');
    assert.equal(provider.searches, 1);
    const research = provider.inputs.find(input => input.stage === 'research')!;
    assert.ok(research.context.discovery);
    assert.equal(agentInput(research).observations[0]?.url, url);
    assert.equal(resumed.start('trial', profile, policy, []).id, cycle.id);
    assert.equal(provider.searches, 1);
    const artifact = resumed.store.checkpoint(cycle.id, 'render') as FounderArtifact;
    assert.ok((await inspectExperiment(root, artifact)).includes(`](<${url}>)`));
    const archive = await exportArchive(resumed.store, root, join(root, 'public'));
    const raw = await readFile(join(archive.directory, 'archive.json'), 'utf8');
    assert.ok(raw.includes(url));
    assert.ok(!raw.includes('DO_NOT_EXPORT_INTERNAL_REASONING'));
    const next = resumed.start('next', profile, policy, []);
    assert.ok(next.memory.some(item => item.id === cycle.id));
    assert.ok(resumed.store.memories().some(memory => memory.kind === 'observation' && memory.sourceIds.includes(first.discoveredObservations![0]!.id)));
  } finally { resumed.store.close(); }
});

test('private inputs are not sent to discovery and private-cycle findings stay out of public export', async t => {
  const { harness, provider, cycle, root } = await setup(t, new ResearchProvider(), true);
  const next = await harness.step(cycle.id);
  assert.ok(!String(provider.body?.input).includes('PRIVATE_CUSTOMER_SECRET'));
  assert.equal(next.discoveredObservations?.[0]?.visibility, 'private');
  await harness.run(cycle.id);
  const archive = await exportArchive(harness.store, root, join(root, 'public'));
  const raw = await readFile(join(archive.directory, 'archive.json'), 'utf8');
  assert.ok(!raw.includes('PRIVATE_CUSTOMER_SECRET'));
  assert.ok(!raw.includes(url));
});

test('web summaries cannot be promoted to verified customer observations', async t => {
  class PromotesEvidence extends ResearchProvider {
    override async generate(req: AgentRequest, signal: AbortSignal) {
      const result = await super.generate(req, signal);
      if (req.stage === 'research') Object.assign(result.output as object, { evidenceLevel: 'source_reports', reportedProblemSourceIds: req.cycle.discoveredObservations!.map(o => o.id) });
      return result;
    }
  }
  const { harness, cycle } = await setup(t, new PromotesEvidence());
  await harness.step(cycle.id);
  await assert.rejects(harness.step(cycle.id), /Customer evidence must reference/);
});

test('missing tool execution, incomplete responses, and excess tool calls are rejected', () => {
  const empty = response(); empty.output = empty.output.filter(item => item.type !== 'web_search_call');
  assert.throws(() => discoveryRecord(empty, 4), /completed web tool call/);
  const incomplete = response(); incomplete.status = 'incomplete';
  assert.throws(() => discoveryRecord(incomplete, 4), /did not complete/);
  assert.throws(() => discoveryRecord(response(), 1), /allowance/);
  const unsafe = response();
  for (const item of unsafe.output) if (item.type === 'message') for (const part of item.content) if (part.type === 'output_text') {
    for (const annotation of part.annotations) if (annotation.type === 'url_citation') annotation.url = 'javascript:alert(1)';
  }
  assert.equal(discoveryRecord(unsafe, 4).sources.length, 0);
});

test('citation context stops at the prior citation rather than attributing the whole paragraph to a source', () => {
  const sample = response();
  const first = 'First source statement. ', second = ' Second source statement. ';
  for (const item of sample.output) if (item.type === 'message') {
    item.content = [{ type: 'output_text', logprobs: [], text: first + '[one]' + second + '[two]', annotations: [
      { type: 'url_citation', url, title: 'First', start_index: first.length, end_index: first.length + 5 },
      { type: 'url_citation', url: 'https://example.org/second', title: 'Second',
        start_index: first.length + 5 + second.length, end_index: first.length + 5 + second.length + 5 },
    ] }];
  }
  const record = discoveryRecord(sample, 4);
  assert.equal(record.sources[1]?.summary, second.trim());
});

test('discovery failures retain attempt reservations and do not import sources', async t => {
  const { harness, provider, cycle } = await setup(t);
  provider.client.responses.create = (async () => { throw new Error('Network unavailable'); }) as unknown as typeof provider.client.responses.create;
  await assert.rejects(harness.step(cycle.id), /Network unavailable/);
  assert.equal(harness.store.get(cycle.id).stage, 'discover');
  assert.equal(harness.store.get(cycle.id).discoveredObservations, undefined);
  assert.equal((harness.store.attempts()[0] as Record<string, unknown>).status, 'failed');
  assert.equal((harness.store.attempts()[0] as Record<string, unknown>).model_call, 1);
});

test('disabled and fixture research never dispatch web discovery', async t => {
  const { harness, cycle, provider, root } = await setup(t);
  harness.store.closeCycle(cycle.id, 'Test disabled discovery');
  assert.equal(harness.start('disabled', profile, { ...policy, maxWebCallsPerAttempt: 0 }, []).stage, 'research');
  assert.equal(provider.searches, 0);
  const fixture = new Harness(join(root, 'offline'), new FixtureProvider());
  try { assert.equal(fixture.start('offline', profile, policy, []).stage, 'research'); }
  finally { fixture.store.close(); }
});

test('pause and daily model-call reservations also govern discovery', async t => {
  const { harness, provider, cycle } = await setup(t);
  harness.store.pause(true);
  await assert.rejects(harness.step(cycle.id), /paused/);
  assert.equal(provider.searches, 0);
  harness.store.pause(false);
  harness.store.closeCycle(cycle.id, 'Use one-call daily limit');
  const limited = harness.start('limited', profile, { ...policy, maxCallsPerDay: 1 }, []);
  await harness.step(limited.id);
  await assert.rejects(harness.step(limited.id), /allowance|limit|budget/i);
  assert.equal(provider.searches, 1);
  assert.equal(harness.store.get(limited.id).stage, 'research');
});
