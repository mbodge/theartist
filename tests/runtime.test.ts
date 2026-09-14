import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { containerArgs, docker, DockerBuilder } from '../src/docker-builder.js';
import type { BuildJob } from '../src/builder.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The portable state utility intentionally runs as plain Node in hosted workflows.
// @ts-expect-error JavaScript utility is tested at runtime.
import { seal, unseal, validateSnapshot } from '../scripts/state.mjs';

test('encrypted memory is authenticated; tampering and wrong keys fail closed', () => {
  const key = randomBytes(32).toString('hex'), data = Buffer.from('private durable memory');
  const a = seal(data, key), b = seal(data, key);
  assert.notDeepEqual(a, b); assert.deepEqual(unseal(a, key), data);
  assert.ok(!a.includes(data)); a[a.length - 1] ^= 1;
  assert.throws(() => unseal(a, key)); assert.throws(() => unseal(b, randomBytes(32).toString('hex')));
});
test('checkpoint identity, paths, duplicates and contents are verified before restore', () => {
  const data = Buffer.from('database'), file = { path: 'studio.sqlite', data: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex') };
  const snapshot = { version: 1, instance: 'test', files: [file] };
  assert.equal(validateSnapshot(snapshot, 'test'), snapshot);
  assert.throws(() => validateSnapshot(snapshot, 'wrong'));
  for (const path of ['../escape', '/absolute', 'dir//file', 'dir/./file']) assert.throws(() => validateSnapshot({ ...snapshot, files: [file, { ...file, path }] }, 'test'));
  assert.throws(() => validateSnapshot({ ...snapshot, files: [file, file] }, 'test'));
  assert.throws(() => validateSnapshot({ ...snapshot, files: [{ ...file, data: 'dGFtcGVy' }] }, 'test'));
});
test('workshop has no host mounts, credentials, network, root or capabilities', () => {
  const args = containerArgs({ id: '11111111-1111-4111-8111-111111111111' } as BuildJob);
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args[args.indexOf('--user') + 1], '1000:1000');
  assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  assert.ok(args.includes('--read-only'));
  for (const flag of ['--volume', '-v', '--mount', '--env', '-e', '--privileged']) assert.ok(!args.includes(flag));
});
test('real Docker workshop executes Node, Python and Chromium without host secrets or network', { skip: process.env.TEST_DOCKER !== '1' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'workshop-integration-'));
  const job = { id: '11111111-1111-4111-8111-111111111112', brief: 'fixture', policy: { maxFiles: 30, maxBytes: 8000000 } } as BuildJob;
  const transport = new DockerBuilder(root, 'test-only-no-api-call');
  t.after(async () => { await transport.cleanup(job); await rm(root, { recursive: true, force: true }); });
  const name = await transport.create(job);
  await transport.cleanup(job);
  assert.equal(await transport.find(job), name, 'empty workspace creation can reconcile after Docker startup failure');
  const result = await docker(['exec', name, 'node', '-e', `
    const assert=require('node:assert/strict');
    assert.equal(process.getuid(),1000); assert.equal(process.env.OPENAI_API_KEY,undefined);
    assert.equal(require('node:fs').existsSync('/var/run/docker.sock'),false);
    assert.throws(()=>require('node:fs').writeFileSync('/etc/should-not-write','x'));
    const {chromium}=require('/opt/tools/node_modules/playwright-core');
    (async()=>{const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();await page.setContent('<button onclick="this.textContent=123">Test</button>');
    await page.getByRole('button').click(); assert.equal(await page.getByRole('button').textContent(),'123');
    await browser.close(); console.log('Browser interaction passed');})().catch(error=>{console.error(error.message);process.exit(1)});`]);
  assert.equal(result.code, 0, result.output); assert.match(result.output, /Browser interaction passed/);
  const network = await docker(['exec', name, 'python3', '-c', "import socket;s=socket.socket();s.settimeout(2);s.connect(('1.1.1.1',443))"]);
  assert.notEqual(network.code, 0);
});
