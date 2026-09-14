import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, readFile, readdir, writeFile, lstat, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const limit = 64 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function seal(bytes, key) {
  if (!/^[a-f0-9]{64}$/.test(key ?? '')) throw new Error('STUDIO_STATE_KEY must be 32 random bytes in hex');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce);
  cipher.setAAD(Buffer.from('theartist-state-v1'));
  const ciphertext = Buffer.concat([cipher.update(gzipSync(bytes)), cipher.final()]);
  return Buffer.concat([Buffer.from('TAS1'), nonce, cipher.getAuthTag(), ciphertext]);
}
export function unseal(bytes, key) {
  if (bytes.subarray(0, 4).toString() !== 'TAS1') throw new Error('Invalid checkpoint header');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), bytes.subarray(4, 16));
  decipher.setAAD(Buffer.from('theartist-state-v1')); decipher.setAuthTag(bytes.subarray(16, 32));
  return gunzipSync(Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]), { maxOutputLength: limit });
}
export function validateSnapshot(snapshot, instance) {
  if (snapshot.version !== 1 || snapshot.instance !== instance || !Array.isArray(snapshot.files)) throw new Error('Checkpoint identity mismatch');
  const names = new Set(); let bytes = 0;
  for (const file of snapshot.files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').some(p => !p || p === '.' || p === '..') || names.has(file.path)) throw new Error('Unsafe checkpoint path');
    names.add(file.path);
    const data = Buffer.from(file.data, 'base64'); bytes += data.length;
    if (bytes > limit || digest(data) !== file.sha256) throw new Error('Checkpoint integrity error');
  }
  if (!names.has('studio.sqlite')) throw new Error('Checkpoint has no memory database');
  return snapshot;
}
async function main() {
  const command = process.argv[2], instance = process.env.STUDIO_INSTANCE ?? 'founder-001';
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(instance)) throw new Error('Invalid studio identity');
  const repo = process.env.GITHUB_REPOSITORY ?? 'mbodge/theartist';
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) throw new Error('Invalid repository');
  const root = resolve('.studio/instances', instance), versionPath = resolve('.studio', `state-version-${instance}.json`);
  const endpoint = `https://api.github.com/repos/${repo}/contents/runtime/${instance}.enc`;
  const key = process.env.STUDIO_STATE_KEY;
  const api = async (url, init = {}) => {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...init.headers } });
    if (!response.ok) throw new Error(`Checkpoint API returned ${response.status}; memory was not reset`);
    return response;
  };
  if (command === 'pull') {
    const meta = await (await api(`${endpoint}?ref=studio-state`)).json();
    const encrypted = meta.content ? Buffer.from(meta.content, 'base64') : Buffer.from(await (await api(`${endpoint}?ref=studio-state`, { headers: { Accept: 'application/vnd.github.raw+json' } })).arrayBuffer());
    const plaintext = unseal(encrypted, key);
    const snapshot = validateSnapshot(JSON.parse(plaintext), instance);
    // A hosted run always restores into an empty directory. Never overwrite an active local database.
    try { await lstat(join(root, 'studio.sqlite')); throw new Error('Local memory exists; restore requires an empty instance data directory'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const file of snapshot.files) {
      const path = join(root, file.path); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(file.data, 'base64'), { mode: 0o600, flag: 'wx' });
    }
    await writeFile(versionPath, JSON.stringify({ sha: meta.sha, digest: digest(plaintext) }), { mode: 0o600 });
    console.log(`Restored ${snapshot.files.length} files and founder memory from authenticated checkpoint`);
  } else if (command === 'push' || command === 'seed') {
    const files = []; let size = 0;
    const backup = resolve('.studio', `backup-${instance}.sqlite`);
    const db = new Database(join(root, 'studio.sqlite'), { readonly: true });
    try { await db.backup(backup); } finally { db.close(); }
    const visit = async (directory, prefix = '') => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = prefix + entry.name;
        if ((!prefix && entry.name === 'public') || /(?:-wal|-shm|\.tmp)$/.test(path)) continue;
        if (entry.isSymbolicLink()) throw new Error('Symlink in state directory');
        if (entry.isDirectory()) await visit(join(directory, entry.name), path + '/');
        else if (entry.isFile()) {
          const data = await readFile(path === 'studio.sqlite' ? backup : join(directory, entry.name)); size += data.length;
          if (size > limit / 2) throw new Error('Checkpoint size limit reached');
          files.push({ path, data: data.toString('base64'), sha256: digest(data) });
        } else throw new Error('Non-regular state file');
      }
    };
    // Deployment snapshots are included for reconciling uncertain uploads.
    await visit(root);
    await rm(backup, { force: true });
    const plaintext = Buffer.from(JSON.stringify(validateSnapshot({ version: 1, instance, files }, instance)));
    let previous;
    try { previous = JSON.parse(await readFile(versionPath, 'utf8')); }
    catch (error) { if (command !== 'seed') throw new Error('Missing checkpoint version; refusing an unfenced overwrite'); }
    if (previous?.digest === digest(plaintext)) { console.log('Memory unchanged; checkpoint already current'); return; }
    const response = await (await api(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      message: `Checkpoint ${instance}`, branch: 'studio-state', ...(previous ? { sha: previous.sha } : {}),
      content: seal(plaintext, key).toString('base64'),
    }) })).json();
    await writeFile(versionPath, JSON.stringify({ sha: response.content.sha, digest: digest(plaintext) }), { mode: 0o600 });
    console.log(`Saved encrypted, version-fenced checkpoint for ${instance}`);
  } else throw new Error('Use pull, push, or seed');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
