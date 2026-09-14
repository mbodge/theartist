import { join } from 'node:path';
import { exportArchive } from './archive.js';
import type { Store } from './store.js';
import { hash } from './store.js';
import { type DeploymentPolicy, StudioError } from './domain.js';
import type { BuildJob } from './builder.js';
import { buildPublication, catalogPublication } from './publication.js';
import { Deployer } from './deployer.js';
import { CloudflarePublisher } from './cloudflare-publisher.js';
import { browserSmoke, loadBrowserProbe } from './browser-smoke.js';

export async function publishStudio(root: string, store: Store, policy: DeploymentPolicy, includeCatalog = true) {
  if (!policy.enabled || store.paused()) throw new StudioError('Publishing is disabled or studio is paused');
  const transport = new CloudflarePublisher(process.env.CLOUDFLARE_ACCOUNT_ID ?? '', process.env.CLOUDFLARE_API_TOKEN ?? '');
  const deployer = new Deployer(root, store, transport, policy, [process.env.CLOUDFLARE_API_TOKEN ?? '', process.env.OPENAI_API_KEY ?? '']);
  for (const job of deployer.jobs().filter(j => j.status === 'withdrawing')) await deployer.withdraw(job.id, job.error ?? 'Resuming recorded withdrawal');
  const pending = deployer.jobs().filter(j => !['published', 'failed', 'withdrawn'].includes(j.status));
  for (const job of pending) await deployer.tick(job.id);
  const apps = [];
  for (const build of store.builds() as unknown as BuildJob[]) {
    if (build.status !== 'built' || build.visibility !== 'public') continue;
    try {
      const publication = await buildPublication(root, store, build);
      const probe = build.policy.backend === 'docker' ? await loadBrowserProbe(root, build) : undefined;
      const job = await deployer.enqueue(publication);
      const deployed = await deployer.tick(job.id);
      apps.push(deployed);
      const inspectionId = `browser-${job.id}:${store.iso().slice(0, 10)}`;
      if (deployed.status === 'published' && deployed.url && build.policy.backend === 'docker' && !store.memories().some(m => m.id === inspectionId)) {
        let result;
        try { result = await browserSmoke(deployed.url, probe); }
        catch { result = { status: 'failed', reason: 'Live browser acceptance could not execute' }; }
        store.addMemory({ id: inspectionId, kind: 'work', cycleId: build.cycleId, sourceIds: [], visibility: 'public', supersedes: null,
          content: JSON.stringify({ deploymentId: job.id, url: deployed.url, observedAt: store.iso(), ...result }) });
        store.event(build.cycleId, 'publication.browser-inspected', { deploymentId: job.id, status: result.status });
        if (result.status !== 'passed') {
          const withdrawn = await deployer.withdraw(job.id, 'Live browser acceptance failed; preserving the failed probe and withdrawing the app');
          Object.assign(deployed, withdrawn);
        }
      }
    } catch (error) {
      const reason = error instanceof StudioError ? error.message : 'App publication input could not be validated';
      store.addMemory({ id: `publication-note-${build.id}-${hash(reason).slice(0, 16)}`, kind: 'work', cycleId: build.cycleId,
        sourceIds: [], visibility: 'public', supersedes: null,
        content: JSON.stringify({ buildId: build.id, publication: 'not-confirmed', reason }) });
    }
  }
  if (!includeCatalog) return { apps, catalog: null };
  const archive = await exportArchive(store, root, join(root, 'public'));
  const catalog = await catalogPublication(store, root, archive.directory);
  const job = await deployer.enqueue(catalog);
  return { apps, catalog: await deployer.tick(job.id) };
}
