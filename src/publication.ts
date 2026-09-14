import { readFile, lstat, realpath, mkdir } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { z } from 'zod';
import { artifactPath, type BuildJob } from './builder.js';
import { hash, type Store } from './store.js';
import { immutableWrite } from './artifacts.js';
import { isFounder, StudioError } from './domain.js';

export type PublicFile = { path: string; mime: string; data: string; sha256: string; download: boolean };
export type Publication = {
  kind: 'app' | 'catalog'; cycleId: string | null; buildId: string | null;
  title: string; files: PublicFile[]; validation: string;
};
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('static'),
  root: z.literal('prototype/site'), testCommand: z.string().min(1).max(32000),
});
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
export const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function publicFile(path: string, bytes: Buffer | string, download = false): PublicFile {
  if (!/^\/[a-zA-Z0-9_./-]*$/.test(path) || path.includes('//') || path.split('/').some(p => p === '..' || p === '.')) throw new StudioError('Unsafe public path');
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return { path, mime: download ? 'application/octet-stream' : (path === '/' ? 'text/html; charset=utf-8' : (mime[extname(path)] ?? 'application/octet-stream')),
    data: buffer.toString('base64'), sha256: hash(buffer), download };
}
export async function verifiedFile(root: string, path: string, sha256: string, size: number) {
  const base = await realpath(root);
  const absolute = resolve(base, path);
  if (!absolute.startsWith(base + sep) || !(await lstat(absolute)).isFile() || (await realpath(absolute)) !== absolute) throw new StudioError('Unsafe publication file');
  const bytes = await readFile(absolute);
  if (bytes.length !== size || hash(bytes) !== sha256) throw new StudioError('Publication artifact integrity check failed');
  return bytes;
}
export async function buildPublication(root: string, store: Store, build: BuildJob): Promise<Publication> {
  const cycle = store.get(build.cycleId);
  if (build.status !== 'built' || build.visibility !== 'public' || cycle.provider !== 'openai' || cycle.outcome !== 'released' ||
      cycle.observations.some(o => o.visibility !== 'public') || !isFounder(cycle.profile)) throw new StudioError('Publishing requires a completed public build from an accepted live founder cycle');
  const files = new Map<string, Buffer>();
  for (const item of build.artifacts) {
    const path = artifactPath(`/workspace/outputs/${item.path}`);
    if (!/^[a-f0-9-]{36}$/.test(build.id) || item.file !== join('builds', build.id, path) || files.has(path)) throw new StudioError('Unsafe or duplicate build artifact');
    files.set(path, await verifiedFile(root, item.file, item.sha256, item.sizeBytes));
  }
  const raw = files.get('prototype/deployment.json');
  if (!raw) throw new StudioError('Build has no static deployment manifest; retained as downloadable work');
  const manifest = manifestSchema.parse(JSON.parse(raw.toString('utf8')));
  if (!build.commands.some(c => c.command === manifest.testCommand && c.status === 'completed' && c.exitCode === 0)) {
    throw new StudioError('Deployment requires an observed zero exit code for the manifest test command; unknown exits are not a pass');
  }
  const output: PublicFile[] = [];
  for (const [path, bytes] of files) {
    if (!path.startsWith(manifest.root + '/')) continue;
    const route = '/' + path.slice(manifest.root.length + 1);
    if (!mime[extname(route)]) throw new StudioError('Unsupported static application file type');
    output.push(publicFile(route, bytes));
    if (route === '/index.html') output.push(publicFile('/', bytes));
  }
  if (!output.some(f => f.path === '/')) throw new StudioError('Static build needs prototype/site/index.html');
  return { kind: 'app', cycleId: cycle.id, buildId: build.id,
    title: String(store.checkpoint(cycle.id, 'propose')?.title ?? cycle.profile.name), files: output,
    validation: 'Recorded test command exited zero. HTTP publication checks are separate from browser behavior and customer validation.' };
}

// An ink-blue index with generous lavender margins; the work and its provenance are the content.
export function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light;font-family:Arial,Helvetica,sans-serif;color:#162956;background:#e7e8f2}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:56px 32px 100px}header{margin-bottom:64px}h1{font-size:clamp(48px,9vw,110px);letter-spacing:-.065em;line-height:.95;font-weight:500;margin:30px 0}h2{font-size:28px;font-weight:500;letter-spacing:-.03em}h3{font-size:22px;font-weight:500;margin:0 0 12px}p{max-width:68ch;line-height:1.65}a{color:inherit;text-underline-offset:4px}a:focus-visible,summary:focus-visible{outline:3px solid #9b2a62;outline-offset:5px}.lead{font-size:21px;max-width:48ch}.work{padding:28px;background:#fff;margin:20px 0}.status{color:#8b2859;font-size:14px}.meta{font-size:14px;color:#49577a}nav{display:flex;gap:24px;flex-wrap:wrap}details{margin:16px 0}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;font-size:13px}footer{margin-top:56px}.empty{padding:28px;background:#d8ddef}ul{padding-left:20px;line-height:1.8}@media(max-width:600px){main{padding:28px 20px 60px}.work{padding:20px}header{margin-bottom:40px}}</style>
<main>${body}<footer><a href="https://github.com/mbodge/theartist">Open-source code</a><p class="meta">Explicit decisions and recorded outcomes. Software tests and deployment checks do not establish customer demand.</p></footer></main></html>`;
}
export async function catalogPublication(store: Store, root: string, archiveDirectory: string): Promise<Publication> {
  const serialized = await readFile(join(archiveDirectory, 'archive.json'));
  const archive = JSON.parse(serialized.toString('utf8'));
  const cycles = store.list().filter(c => c.observations.every(o => o.visibility === 'public'));
  const title = cycles[0]?.profile.name ?? 'Theartist';
  const files = [publicFile('/archive.json', serialized, true),
    { ...publicFile('/health', JSON.stringify({ service: 'theartist', status: 'ok', studioRuntime: process.env.STUDIO_RUNTIME === 'github-actions' ? 'github-actions' : 'local', catalog: 'published-snapshot' })), mime: 'application/json; charset=utf-8' }];
  let body = `<header><nav><a href="/">Theartist</a><a href="/archive.json">Download public record</a></nav><h1>${escapeHtml(title)}</h1><p class="lead">A studio in public. Follow the work, the decisions, and what happened next.</p><p class="meta">Published snapshot. The studio runs separately from this website.</p></header><h2>Work & experiments</h2>`;
  for (const cycle of [...cycles].reverse()) {
    const proposal = store.checkpoint(cycle.id, 'propose');
    const build = (store.builds() as unknown as BuildJob[]).find(b => b.cycleId === cycle.id);
    const deployments = store.deployments().filter(d => d.cycleId === cycle.id && d.status === 'published');
    const outcome = cycle.outcome === 'released' ? 'Experiment accepted' : cycle.outcome === 'abstained' ? 'No experiment selected' : cycle.outcome ?? cycle.status;
    body += `<article class="work"><p class="status">${cycle.provider === 'fixture' ? 'Synthetic fixture · ' : ''}${escapeHtml(outcome)}${build ? ' · Build ' + escapeHtml(build.status) : ''}</p><h3>${escapeHtml(proposal?.title ?? 'Work in progress')}</h3><p>${proposal?.hypothesis ? 'Hypothesis: ' : ''}${escapeHtml(proposal?.hypothesis ?? proposal?.concept ?? '')}</p>`;
    for (const d of deployments) if (/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(String(d.url))) body += `<p><a href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer">Open published app</a></p>`;
    const artifact = store.checkpoint(cycle.id, 'render', cycle.revision);
    if (artifact) {
      for (const key of ['document', 'spec', 'png', 'svg']) {
        const path = artifact[key];
        if (typeof path !== 'string') continue;
        const absolute = resolve(archiveDirectory, path);
        if (!absolute.startsWith(resolve(archiveDirectory) + sep)) throw new StudioError('Unsafe catalog artifact');
        const route = '/files/' + path;
        files.push(publicFile(route, await readFile(absolute), true));
        body += `<p><a href="${route}">Download ${escapeHtml(key === 'document' ? 'experiment' : key)}</a></p>`;
      }
    }
    if (build?.error) body += `<p class="status">${escapeHtml(build.error)}</p>`;
    if (build?.artifacts.length) {
      body += '<details><summary>Source files & test records</summary><ul>';
      for (const file of build.artifacts) {
        const bytes = await verifiedFile(root, file.file, file.sha256, file.sizeBytes);
        const route = '/files/' + file.file;
        files.push(publicFile(route, bytes, true));
        body += `<li><a href="${route}">${escapeHtml(file.path)}</a></li>`;
      }
      body += '</ul></details>';
    }
    const decision = store.checkpoint(cycle.id, 'decide', cycle.revision);
    if (decision) body += `<details><summary>Supervisor decision</summary><pre>${escapeHtml(JSON.stringify(decision, null, 2))}</pre></details>`;
    body += `<p class="meta">${escapeHtml(cycle.createdAt.slice(0, 10))} · ${escapeHtml(cycle.id)}</p></article>`;
  }
  if (!cycles.length) body += '<p class="empty">No public work has been recorded yet.</p>';
  const board = archive.board;
  if (board) body += `<h2>Board record</h2><details><summary>Members, guidance & replies</summary><pre>${escapeHtml(JSON.stringify(board, null, 2))}</pre></details>`;
  body += '<h2>Recent memory</h2>';
  for (const m of archive.memories.slice(-8)) body += `<details><summary>${escapeHtml(m.kind)} · ${escapeHtml(m.createdAt.slice(0, 10))}</summary><pre>${escapeHtml(m.content)}</pre></details>`;
  files.push(publicFile('/', page(title, body)));
  // Operational catalog receipts are excluded from archive content to prevent a republish feedback loop.
  return { kind: 'catalog', cycleId: null, buildId: null, title, files, validation: 'Public archive snapshot; all source files are served as downloads.' };
}
export function validatePublication(publication: Publication, maxBytes: number, secrets: string[] = []) {
  const routes = new Set<string>(); let total = 0;
  if (publication.files.length > 200) throw new StudioError('Publication file count exceeds limit');
  for (const file of publication.files) {
    if (file.path.startsWith('/_studio/')) throw new StudioError('Reserved publication route');
    const bytes = Buffer.from(file.data, 'base64');
    if (hash(bytes) !== file.sha256 || bytes.toString('base64') !== file.data || routes.has(file.path)) throw new StudioError('Invalid publication content');
    publicFile(file.path, bytes, file.download); routes.add(file.path); total += bytes.length;
    const text = bytes.toString('utf8');
    if (secrets.filter(s => s.length >= 12).some(s => text.includes(s)) || /\b(?:cfat_[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,})/.test(text)) throw new StudioError('Publication contains a credential; nothing was uploaded');
  }
  if (total > maxBytes || !routes.has('/')) throw new StudioError('Publication exceeds size limit or lacks an index');
}
export async function snapshotPublication(root: string, publication: Publication) {
  const text = JSON.stringify(publication); const digest = hash(text);
  await mkdir(join(root, 'publications'), { recursive: true });
  await immutableWrite(join(root, 'publications', `${digest}.json`), text);
  return digest;
}
