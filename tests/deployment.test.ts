import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, hash } from '../src/store.js';
import { Deployer } from '../src/deployer.js';
import { CloudflarePublisher, workerModule, receiptPath, type Target, type PublicationTransport } from '../src/cloudflare-publisher.js';
import { buildPublication, catalogPublication, publicFile, validatePublication, verifiedFile, type Publication } from '../src/publication.js';
import { exportArchive } from '../src/archive.js';
import { Harness } from '../src/harness.js';
import { FixtureProvider } from '../src/agents.js';
import { Builder, type BuildTransport, type RemoteBuild } from '../src/builder.js';
import { founderProfileSchema, policySchema, observationsSchema, type AgentProvider } from '../src/domain.js';

const deploymentPolicy = { enabled: true, catalogWorker: 'test-catalog', maxDeploymentsPerDay: 4, maxBytes: 1500000 };
const publication: Publication = { kind: 'catalog', cycleId: null, buildId: null, title: 'Test catalog',
  files: [publicFile('/', '<h1>Test catalog</h1>'), publicFile('/archive.json', '{}', true)], validation: 'Synthetic integration fixture' };
class FakePublisher implements PublicationTransport {
  accountId = 'a'.repeat(32); uploads = 0; enables = 0; verifications = 0; uncertain = false; wrongBytes = false;
  remote: Awaited<ReturnType<PublicationTransport['inspect']>> = { exists: false, owned: false, contentHash: null, versionId: null };
  async inspect() { return this.remote; }
  async upload(target: Target) {
    this.uploads++; this.remote = { exists: true, owned: true, contentHash: target.contentHash, versionId: 'version-test' };
    if (this.uncertain) { this.uncertain = false; throw new Error('network disconnected after upload'); }
    return 'version-test';
  }
  async enable(target: Target) { this.enables++; return `https://${target.worker}.test.workers.dev`; }
  async verify(_target: Target, pub: Publication) {
    this.verifications++; if (this.wrongBytes) throw new Error('wrong bytes');
    return pub.files.map(f => ({ path: f.path, sha256: f.sha256, status: 200 }));
  }
}
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'publication-')); const store = new Store(join(root, 'studio.sqlite'));
  store.bindStudio('founder', 'test-founder');
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const transport = new FakePublisher(); const deployer = new Deployer(root, store, transport, deploymentPolicy);
  return { root, store, transport, deployer };
}

test('catalog publishes idempotently and does not generate an endless archive feedback loop', async t => {
  const { root, store, transport, deployer } = await setup(t);
  const archive1 = await exportArchive(store, root, join(root, 'public'));
  const job = await deployer.enqueue(publication);
  assert.equal((await deployer.tick(job.id)).status, 'published');
  assert.equal((await deployer.enqueue(publication)).id, job.id);
  await deployer.tick(job.id);
  assert.equal(transport.uploads, 1);
  assert.equal((await exportArchive(store, root, join(root, 'public'))).hash, archive1.hash);
});

test('an uncertain upload reconciles from ownership and content tags without another upload', async t => {
  const { root, store, transport, deployer } = await setup(t);
  transport.uncertain = true; const job = await deployer.enqueue(publication);
  await assert.rejects(deployer.tick(job.id));
  assert.equal(deployer.get(job.id)?.status, 'uploading');
  const resumed = new Deployer(root, store, transport, deploymentPolicy);
  const result = await resumed.tick(job.id);
  assert.equal(result.status, 'published'); assert.equal(result.versionId, 'version-test'); assert.equal(transport.uploads, 1);
});

test('a successful upload is not publication until live byte verification succeeds', async t => {
  const { transport, deployer } = await setup(t); transport.wrongBytes = true;
  const job = await deployer.enqueue(publication);
  await assert.rejects(deployer.tick(job.id));
  assert.equal(deployer.get(job.id)?.status, 'verifying');
  transport.wrongBytes = false;
  assert.equal((await deployer.tick(job.id)).status, 'published'); assert.equal(transport.uploads, 1);
});

test('publisher refuses an unrelated Worker and bounds retries', async t => {
  const { transport, deployer } = await setup(t);
  transport.remote = { exists: true, owned: false, contentHash: null, versionId: null };
  const job = await deployer.enqueue(publication);
  for (let n = 0; n < 3; n++) await assert.rejects(deployer.tick(job.id), /not owned/);
  assert.equal(deployer.get(job.id)?.status, 'failed');
  await deployer.tick(job.id); assert.equal(transport.uploads, 0);
});

test('pause, concurrency, policy changes and budget prevent new side effects', async t => {
  const { root, store, transport, deployer } = await setup(t);
  const job = await deployer.enqueue(publication); store.pause(true); await deployer.tick(job.id);
  assert.equal(transport.uploads, 0); store.pause(false);
  store.db.prepare('UPDATE deployment_jobs SET lease_until=? WHERE id=?').run(Date.now() + 60000, job.id);
  await assert.rejects(deployer.tick(job.id), /Another worker/);
  store.db.prepare('UPDATE deployment_jobs SET lease_until=0 WHERE id=?').run(job.id);
  const changed = new Deployer(root, store, transport, { ...deploymentPolicy, catalogWorker: 'other-catalog' });
  await assert.rejects(changed.tick(job.id), /target policy/);
  await deployer.tick(job.id);
  const limited = new Deployer(root, store, transport, { ...deploymentPolicy, maxDeploymentsPerDay: 1 });
  await assert.rejects(limited.enqueue({ ...publication, title: 'Changed' }), /allowance/);
});

test('credential leaks, traversal, oversize, duplicate paths and changed snapshots are rejected', async t => {
  const { root, transport, deployer } = await setup(t);
  assert.throws(() => publicFile('/../secret', 'x'), /Unsafe/);
  assert.throws(() => validatePublication({ ...publication, files: [publicFile('/', 'cfat_' + 'x'.repeat(40))] }, 1000), /credential/);
  assert.throws(() => validatePublication(publication, 1), /limit/);
  assert.throws(() => validatePublication({ ...publication, files: [...publication.files, publication.files[0]!] }, 1000), /Invalid/);
  const job = await deployer.enqueue(publication);
  await writeFile(join(root, 'publications', job.contentHash + '.json'), '{}');
  await assert.rejects(deployer.tick(job.id), /integrity/); assert.equal(transport.uploads, 0);
  await writeFile(join(root, 'real.txt'), 'x'); await symlink(join(root, 'real.txt'), join(root, 'link.txt'));
  await assert.rejects(verifiedFile(root, 'link.txt', hash('x'), 1), /Unsafe/);
});

test('trusted Worker serves exact bytes, blocks mutations and serves source downloads without executing them', async () => {
  const target = { accountId: 'a'.repeat(32), worker: 'test-catalog', owner: 'owner', contentHash: hash(JSON.stringify(publication)) };
  const module = await import('data:text/javascript;base64,' + Buffer.from(workerModule(target, publication)).toString('base64'));
  for (const file of publication.files) {
    const r = module.default.fetch(new Request('https://test.example' + file.path));
    assert.equal(hash(Buffer.from(await r.arrayBuffer())), file.sha256);
    if (file.download) assert.equal(r.headers.get('Content-Disposition'), 'attachment');
    assert.match(r.headers.get('Content-Security-Policy'), /connect-src 'none'/);
  }
  assert.equal(module.default.fetch(new Request('https://test.example/', { method: 'POST' })).status, 405);
  assert.equal(module.default.fetch(new Request('https://test.example/missing')).status, 404);
  assert.equal(module.default.fetch(new Request('https://test.example/__proto__')).status, 404);
});

test('Cloudflare credentials go only to the API, never live checks or Worker contents', async () => {
  const token = 'test-token-only-for-api';
  const target = { accountId: 'a'.repeat(32), worker: 'test-catalog', owner: 'owner', contentHash: hash(JSON.stringify(publication)) };
  let credentialCalls = 0;
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.cloudflare.com/')) {
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token}`); credentialCalls++;
      if (init?.body instanceof FormData) {
        const file = init.body.get('worker.mjs') as Blob;
        assert.ok(!(await file.text()).includes(token));
      }
      return Response.json({ success: true, result: url.endsWith('/workers/subdomain') ? { subdomain: 'test' } : { deployment_id: 'version-test' } });
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    const module = await import('data:text/javascript;base64,' + Buffer.from(workerModule(target, publication)).toString('base64'));
    return module.default.fetch(new Request(url));
  };
  const transport = new CloudflarePublisher(target.accountId, token, request);
  await transport.upload(target, publication); const url = await transport.enable(target);
  assert.equal((await transport.verify(target, publication, url)).length, publication.files.length + 1);
  assert.equal(credentialCalls, 3);
  await assert.rejects(transport.verify(target, publication, 'https://attacker.example'), /Unexpected/);
});

test('edge propagation is retried, but repeated wrong content is never accepted', async () => {
  const target = { accountId: 'a'.repeat(32), worker: 'test-catalog', owner: 'owner', contentHash: hash(JSON.stringify(publication)) };
  const module = await import('data:text/javascript;base64,' + Buffer.from(workerModule(target, publication)).toString('base64'));
  let calls = 0; let sleeps = 0;
  const transport = new CloudflarePublisher(target.accountId, 'test-token', async input => {
    if (++calls === 1) return new Response('old deployment');
    return module.default.fetch(new Request(String(input)));
  }, async () => { sleeps++; });
  await transport.verify(target, publication, 'https://test-catalog.test.workers.dev');
  assert.equal(sleeps, 1);
  const bad = new CloudflarePublisher(target.accountId, 'test-token', async () => new Response('wrong'), async () => {});
  await assert.rejects(bad.verify(target, publication, 'https://test-catalog.test.workers.dev'), /do not match/);
});

test('accepted tested browser build publishes URL to memory and archive; unknown tests and private data cannot publish', async t => {
  const { root, store, transport, deployer } = await setup(t);
  const profile = founderProfileSchema.parse({ ...JSON.parse(await readFile(new URL('../config/founder.json', import.meta.url), 'utf8')), instanceId: 'test-founder' });
  const policy = policySchema.parse({ ...JSON.parse(await readFile(new URL('../config/founder-policy.json', import.meta.url), 'utf8')), maxWebCallsPerAttempt: 0 });
  const inputs = observationsSchema.parse(JSON.parse(await readFile(new URL('../examples/founder-observations.json', import.meta.url), 'utf8')));
  const fixture = new FixtureProvider(); const provider: AgentProvider = { name: 'openai', model: 'test-only', generate: req => fixture.generate(req) };
  const harness = new Harness(root, provider, store); const cycle = harness.start('test-build', profile, policy, inputs); await harness.run(cycle.id);
  const sources = new Map([
    ['prototype/site/index.html', Buffer.from('<h1>Clearly synthetic test app</h1>')],
    ['prototype/deployment.json', Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'static', root: 'prototype/site', testCommand: 'python tests.py' }))],
  ]);
  const builderTransport: BuildTransport = {
    async create() { return 'session'; }, async find() { return 'session'; }, async submit() {},
    async inspect(): Promise<RemoteBuild> { return { status: 'completed', turnId: 'turn', summary: 'Synthetic fixture', usage: null,
      commands: [{ command: 'python tests.py', exitCode: 0, output: 'synthetic tests passed', status: 'completed' }] }; },
    async files() { return [...sources].map(([path, b]) => ({ id: path, path: '/workspace/outputs/' + path, sizeBytes: b.length })); },
    async download(_job, id) { return sources.get(id)!; }, async cancel() {}, async cleanup() {},
  };
  const builder = new Builder(root, store, builderTransport); await builder.enqueue(cycle.id, policy.builder!);
  const build = await builder.tick(cycle.id); const pub = await buildPublication(root, store, build);
  await assert.rejects(buildPublication(root, store, { ...build, visibility: 'private' }), /public build/);
  await assert.rejects(buildPublication(root, store, { ...build, commands: build.commands.map(c => ({ ...c, exitCode: null })) }), /zero exit/);
  await assert.rejects(deployer.enqueue({ ...pub, title: 'tampered' }), /eligible stored build/);
  const job = await deployer.enqueue(pub); const result = await deployer.tick(job.id);
  assert.equal(result.status, 'published'); assert.notEqual(job.worker, deploymentPolicy.catalogWorker);
  assert.ok(store.memories().some(m => m.content.includes(result.url!)));
  assert.ok(JSON.stringify(store.recentMemory()).includes(result.url!));
  const archive = await exportArchive(store, root, join(root, 'public'));
  const manifest = JSON.parse(await readFile(join(archive.directory, 'archive.json'), 'utf8'));
  assert.equal(manifest.deployments[0].url, result.url); assert.ok(store.verifyEvents());
  const catalog = await catalogPublication(store, root, archive.directory);
  const html = Buffer.from(catalog.files.find(f => f.path === '/')!.data, 'base64').toString('utf8');
  assert.ok(html.includes(result.url!));
  assert.ok(catalog.files.filter(f => f.path.startsWith('/files/')).every(f => f.download));
});
