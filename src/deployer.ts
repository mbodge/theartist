import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, Store } from './store.js';
import { BusyError, BudgetError, StudioError, deploymentPolicySchema, type DeploymentPolicy } from './domain.js';
import { snapshotPublication, validatePublication, buildPublication, type Publication } from './publication.js';
import type { BuildJob } from './builder.js';
import type { PublicationTransport, Target } from './cloudflare-publisher.js';

export type DeploymentJob = Target & {
  id: string; kind: Publication['kind']; cycleId: string | null; buildId: string | null; title: string;
  status: 'queued' | 'uploading' | 'verifying' | 'published' | 'failed' | 'withdrawing' | 'withdrawn';
  createdAt: string; updatedAt: string; url: string | null; versionId: string | null;
  attempts: number; error: string | null; checks: Array<{ path: string; sha256: string; status: number }>;
  validation: string;
};
export class Deployer {
  constructor(readonly root: string, readonly store: Store, readonly transport: PublicationTransport,
    readonly policy: DeploymentPolicy, readonly secrets: string[] = []) { deploymentPolicySchema.parse(policy); }
  jobs(): DeploymentJob[] { return this.store.deployments() as unknown as DeploymentJob[]; }
  get(id: string) { return this.jobs().find(j => j.id === id); }
  async withdraw(id: string, reason: string) {
    if (!reason.trim() || !this.transport.disable) throw new StudioError('Withdrawal needs a reason and transport support');
    const token = randomUUID();
    const job = this.store.db.transaction(() => {
      const job = this.get(id);
      if (!job || job.kind !== 'app' || job.accountId !== this.transport.accountId) throw new StudioError('Unknown studio app publication');
      const identity = this.store.db.prepare("SELECT value FROM settings WHERE key='founder_instance_id'").get() as { value: string } | undefined;
      if (job.owner !== hash(`${identity?.value ?? 'artist'}:${this.policy.catalogWorker}`).slice(0, 24)) throw new StudioError('Withdrawal is outside this studio policy');
      const lock = this.store.db.prepare('SELECT lease_until FROM deployment_jobs WHERE id=?').get(id) as { lease_until: number };
      if (lock.lease_until > this.store.now()) throw new BusyError('Publication is leased');
      if (job.status !== 'withdrawn') { job.status = 'withdrawing'; job.error = reason; job.updatedAt = this.store.iso(); }
      this.store.db.prepare('UPDATE deployment_jobs SET payload=?,lease_token=?,lease_until=? WHERE id=?').run(JSON.stringify(job), token, this.store.now() + 90000, id);
      return job;
    }).immediate();
    try {
      if (job.status === 'withdrawn') return job;
      await this.transport.disable(job);
      job.status = 'withdrawn'; job.updatedAt = this.store.iso();
      this.store.db.transaction(() => {
        const saved = this.store.db.prepare('UPDATE deployment_jobs SET payload=? WHERE id=? AND lease_token=? AND lease_until>?').run(JSON.stringify(job), id, token, this.store.now());
        if (!saved.changes) throw new BusyError('Withdrawal lease expired');
        this.store.addMemory({ id: `withdrawal-${id}`, kind: 'work', cycleId: job.cycleId, visibility: 'public', sourceIds: [], supersedes: null,
          content: JSON.stringify({ status: job.status, url: job.url, reason, at: job.updatedAt }) });
        this.store.event(job.cycleId, 'deployment.withdrawn', { id, worker: job.worker });
      }).immediate();
      return job;
    } finally { this.store.db.prepare('UPDATE deployment_jobs SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?').run(id, token); }
  }
  async enqueue(publication: Publication) {
    if (!this.policy.enabled || this.store.paused()) throw new StudioError('Publishing is disabled or studio is paused');
    validatePublication(publication, this.policy.maxBytes, this.secrets);
    if (publication.kind === 'app') {
      const build = (this.store.builds() as unknown as BuildJob[]).find(b => b.id === publication.buildId && b.cycleId === publication.cycleId);
      if (!build || JSON.stringify(await buildPublication(this.root, this.store, build)) !== JSON.stringify(publication)) throw new StudioError('App publication does not match an eligible stored build');
    }
    const identity = this.store.db.prepare("SELECT value FROM settings WHERE key='founder_instance_id'").get() as { value: string } | undefined;
    const owner = hash(`${identity?.value ?? 'artist'}:${this.policy.catalogWorker}`).slice(0, 24);
    const contentHash = await snapshotPublication(this.root, publication);
    const worker = publication.kind === 'catalog' ? this.policy.catalogWorker : `theartist-app-${owner.slice(0, 8)}-${contentHash.slice(0, 20)}`;
    if (publication.kind === 'app' && worker === this.policy.catalogWorker) throw new StudioError('App cannot replace its catalog');
    const id = hash(`${this.transport.accountId}:${worker}:${contentHash}`);
    return this.store.db.transaction(() => {
      const existing = this.get(id); if (existing) return existing;
      const jobs = this.jobs();
      if (jobs.some(j => j.worker === worker && !['published', 'failed'].includes(j.status))) throw new BusyError('An earlier publication for this Worker must finish first');
      if (jobs.filter(j => j.kind === publication.kind && j.createdAt.slice(0, 10) === this.store.iso().slice(0, 10)).length >= this.policy.maxDeploymentsPerDay) throw new BudgetError('Daily publication allowance exhausted');
      const job: DeploymentJob = { id, accountId: this.transport.accountId, worker, owner, contentHash,
        kind: publication.kind, cycleId: publication.cycleId, buildId: publication.buildId, title: publication.title,
        status: 'queued', createdAt: this.store.iso(), updatedAt: this.store.iso(), url: null, versionId: null,
        attempts: 0, error: null, checks: [], validation: publication.validation };
      this.store.db.prepare('INSERT INTO deployment_jobs(id,payload) VALUES(?,?)').run(id, JSON.stringify(job));
      return job;
    }).immediate();
  }
  async tick(id: string) {
    const token = randomUUID();
    const job = this.store.db.transaction(() => {
      const job = this.get(id); if (!job) throw new StudioError('Publication not found');
      if (job.accountId !== this.transport.accountId) throw new StudioError('Publication belongs to another Cloudflare account');
      const identity = this.store.db.prepare("SELECT value FROM settings WHERE key='founder_instance_id'").get() as { value: string } | undefined;
      const owner = hash(`${identity?.value ?? 'artist'}:${this.policy.catalogWorker}`).slice(0, 24);
      if (job.owner !== owner || (job.kind === 'catalog' && job.worker !== this.policy.catalogWorker)) throw new StudioError('Publication is outside the current studio target policy');
      const row = this.store.db.prepare('SELECT lease_until FROM deployment_jobs WHERE id=?').get(id) as { lease_until: number };
      if (row.lease_until > this.store.now()) throw new BusyError('Another worker owns this publication');
      this.store.db.prepare('UPDATE deployment_jobs SET lease_token=?,lease_until=? WHERE id=?').run(token, this.store.now() + 60000, id);
      return job;
    }).immediate();
    const save = () => {
      job.updatedAt = this.store.iso();
      const r = this.store.db.prepare('UPDATE deployment_jobs SET payload=?,lease_until=? WHERE id=? AND lease_token=? AND lease_until>?')
        .run(JSON.stringify(job), this.store.now() + 60000, id, token, this.store.now());
      if (!r.changes) throw new BusyError('Publication lease expired; stale result cannot commit');
    };
    // Verification can span many bounded HTTP requests. Renew ownership while awaiting I/O.
    const heartbeat = setInterval(() => {
      this.store.db.prepare('UPDATE deployment_jobs SET lease_until=? WHERE id=? AND lease_token=? AND lease_until>?')
        .run(this.store.now() + 60000, id, token, this.store.now());
    }, 15000);
    try {
      if (job.status === 'published' || job.status === 'failed' || job.status === 'withdrawn') return job;
      if (job.status === 'withdrawing') throw new StudioError('Resume withdrawal before any publication');
      if (!this.policy.enabled || this.store.paused()) return job;
      if (job.attempts >= 3) { job.status = 'failed'; job.error = 'Publication retry limit reached; inspect the saved record'; save(); return job; }
      job.attempts++; save();
      const text = await readFile(join(this.root, 'publications', `${job.contentHash}.json`), 'utf8');
      if (hash(text) !== job.contentHash) throw new StudioError('Publication snapshot integrity check failed');
      const publication: Publication = JSON.parse(text);
      validatePublication(publication, this.policy.maxBytes, this.secrets);
      const remote = await this.transport.inspect(job);
      if (remote.exists && !remote.owned) throw new StudioError('Worker is not owned by this publisher; refusing to overwrite it');
      if (job.status !== 'verifying' && remote.contentHash !== job.contentHash) {
        job.status = 'uploading'; save(); // Same immutable payload and deterministic target on every retry.
        if (this.store.paused()) return job;
        job.versionId = await this.transport.upload(job, publication); save();
      } else if (remote.contentHash === job.contentHash) job.versionId = remote.versionId;
      if (this.store.paused()) { save(); return job; }
      job.status = 'verifying'; save();
      job.url = await this.transport.enable(job); save();
      job.checks = await this.transport.verify(job, publication, job.url);
      job.status = 'published'; job.error = null;
      this.store.db.transaction(() => {
        save();
        if (job.kind === 'app') {
          this.store.addMemory({ id: `deployment-${job.id}`, kind: 'work', cycleId: job.cycleId, sourceIds: [],
            visibility: 'public', supersedes: null, content: JSON.stringify({ title: job.title, status: job.status,
              url: job.url, versionId: job.versionId, buildId: job.buildId, contentHash: job.contentHash,
              checks: job.checks, validation: job.validation }) });
          this.store.event(job.cycleId, 'deployment.published', { id: job.id, worker: job.worker, contentHash: job.contentHash });
        }
      }).immediate();
      return job;
    } catch (error) {
      job.error = error instanceof StudioError ? error.message : 'Publication failed; inspect configuration and resume the saved job';
      if (job.attempts >= 3) job.status = 'failed';
      try { save(); } catch { /* An expired lease cannot overwrite a newer worker. */ }
      throw error;
    } finally {
      clearInterval(heartbeat);
      this.store.db.prepare('UPDATE deployment_jobs SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?').run(id, token);
    }
  }
}
