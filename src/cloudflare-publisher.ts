import { StudioError } from './domain.js';
import { hash } from './store.js';
import type { Publication } from './publication.js';
import { gunzipSync } from 'node:zlib';

export type Target = { accountId: string; worker: string; owner: string; contentHash: string };
export interface PublicationTransport {
  accountId: string;
  inspect(target: Target): Promise<{ exists: boolean; owned: boolean; contentHash: string | null; versionId: string | null }>;
  upload(target: Target, publication: Publication): Promise<string | null>;
  enable(target: Target): Promise<string>;
  disable?(target: Target): Promise<void>;
  verify(target: Target, publication: Publication, url: string): Promise<Array<{ path: string; sha256: string; status: number }>>;
}
export const receiptPath = '/_studio/receipt';
export const receipt = (target: Target) => ({ owner: target.owner, contentHash: target.contentHash });
export function workerModule(target: Target, publication: Publication) {
  // Generated work is data. Only this trusted file server runs with Worker privileges.
  const assets = Object.fromEntries(publication.files.map(f => [f.path, f]));
  return `const files = JSON.parse(${JSON.stringify(JSON.stringify(assets))});
const receipt = ${JSON.stringify(receipt(target))};
export default { fetch(request) {
 const headers = {"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Cache-Control":"no-store",
 "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"};
 if (!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405,headers:{...headers,Allow:'GET, HEAD'}});
 const path = new URL(request.url).pathname;
 if(path===${JSON.stringify(receiptPath)}) return new Response(request.method==='HEAD'?null:JSON.stringify(receipt),{headers:{...headers,'Content-Type':'application/json'}});
 const file = Object.hasOwn(files,path) ? files[path] : undefined;
 if(!file) return new Response(null,{status:404,headers});
 if(file.download) headers['Content-Disposition']='attachment';
 if(file.contentEncoding) headers['Content-Encoding']=file.contentEncoding;
 headers['Content-Type']=file.mime;
 return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(file.data),c=>c.charCodeAt(0)),{headers});
}};`;
}
export class CloudflarePublisher implements PublicationTransport {
  constructor(readonly accountId: string, private readonly token: string, private readonly request: typeof fetch = fetch,
    private readonly sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) {
    if (!/^[a-f0-9]{32}$/.test(accountId) || !token.trim()) throw new StudioError('Cloudflare publishing needs an account ID and API token');
  }
  private assertTarget(target: Target) {
    if (target.accountId !== this.accountId || !/^[a-z][a-z0-9-]{2,62}$/.test(target.worker) || !/^[a-f0-9]{64}$/.test(target.contentHash)) throw new StudioError('Invalid Cloudflare publication target');
  }
  private async api(path: string, method = 'GET', body?: FormData | string, allowMissing = false): Promise<Record<string, unknown> | null> {
    let response: Response;
    try { response = await this.request(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}${path}`, {
      method, body, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${this.token}`, ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
    }); } catch { throw new StudioError('Cloudflare request was interrupted; the saved deployment can be resumed'); }
    if (allowMissing && response.status === 404) { await response.body?.cancel(); return null; }
    const raw = await readBounded(response, 1000000);
    let envelope: { success?: boolean; result?: Record<string, unknown>; errors?: Array<{ code?: number }> };
    try { envelope = JSON.parse(raw.toString('utf8')); } catch { throw new StudioError('Cloudflare returned an invalid response'); }
    if (allowMissing && envelope.errors?.some(e => e.code === 10007)) return null;
    if (!response.ok || !envelope.success || !envelope.result) throw new StudioError(`Cloudflare request failed (HTTP ${response.status}); check token permissions and deployment status`);
    return envelope.result;
  }
  async inspect(target: Target) {
    this.assertTarget(target);
    const settings = await this.api(`/workers/scripts/${target.worker}/settings`, 'GET', undefined, true);
    if (!settings) return { exists: false, owned: false, contentHash: null, versionId: null };
    const tags = Array.isArray(settings.tags) ? settings.tags as string[] : [];
    const versions = await this.api(`/workers/scripts/${target.worker}/deployments`);
    const deployments = (versions?.deployments ?? []) as Array<{ versions?: Array<{ version_id?: string }> }>;
    return { exists: true, owned: tags.includes(`theartist-owner:${target.owner}`),
      contentHash: tags.find(t => t.startsWith('theartist-content:'))?.slice('theartist-content:'.length) ?? null,
      versionId: deployments[0]?.versions?.[0]?.version_id ?? null };
  }
  async upload(target: Target, publication: Publication) {
    this.assertTarget(target);
    const data = new FormData();
    data.set('metadata', JSON.stringify({ main_module: 'worker.mjs', compatibility_date: '2026-09-13',
      bindings: [], tags: [`theartist-owner:${target.owner}`, `theartist-content:${target.contentHash}`],
      observability: { enabled: true, head_sampling_rate: 1 } }));
    data.set('worker.mjs', new Blob([workerModule(target, publication)], { type: 'application/javascript+module' }), 'worker.mjs');
    const result = await this.api(`/workers/scripts/${target.worker}`, 'PUT', data);
    return typeof result?.deployment_id === 'string' ? result.deployment_id : null;
  }
  async enable(target: Target) {
    this.assertTarget(target);
    await this.api(`/workers/scripts/${target.worker}/subdomain`, 'POST', JSON.stringify({ enabled: true, previews_enabled: false }));
    const result = await this.api('/workers/subdomain');
    if (typeof result?.subdomain !== 'string' || !/^[a-z0-9-]+$/.test(result.subdomain)) throw new StudioError('Cloudflare account has no workers.dev subdomain');
    return `https://${target.worker}.${result.subdomain}.workers.dev`;
  }
  async disable(target: Target) {
    this.assertTarget(target);
    const remote = await this.inspect(target);
    if (!remote.exists || !remote.owned || remote.contentHash !== target.contentHash) throw new StudioError('Withdrawal target does not match this studio publication');
    await this.api(`/workers/scripts/${target.worker}/subdomain`, 'POST', JSON.stringify({ enabled: false, previews_enabled: false }));
  }
  async verify(target: Target, publication: Publication, url: string) {
    this.assertTarget(target);
    if (!new RegExp(`^https://${target.worker.replace(/-/g, '\\-')}\\.[a-z0-9-]+\\.workers\\.dev$`).test(url)) throw new StudioError('Unexpected deployment URL');
    const checks = [ { path: receiptPath, sha256: hash(JSON.stringify(receipt(target))) }, ...publication.files.map(file =>
      file.contentEncoding === 'gzip' ? { ...file, sha256: hash(gunzipSync(Buffer.from(file.data, 'base64'), { maxOutputLength: 20000000 })) } : file) ];
    const results = [];
    for (const file of checks) {
      let verified = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const response = await this.request(url + file.path, { redirect: 'error', signal: AbortSignal.timeout(10000) });
          const bytes = await readBounded(response, 20000000);
          if (response.status === 200 && hash(bytes) === file.sha256) {
            results.push({ path: file.path, sha256: file.sha256, status: response.status }); verified = true; break;
          }
        } catch { /* DNS and edge propagation can lag a successful upload. */ }
        if (attempt < 5) await this.sleep(1000 * 2 ** attempt);
      }
      if (!verified) throw new StudioError('Deployed bytes do not match the accepted publication; resume verification');
    }
    return results;
  }
}
export async function readBounded(response: Response, limit: number) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break;
    total += value.length; if (total > limit) throw new StudioError('Publication response exceeded its byte limit'); chunks.push(value);
  } } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
