import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AttemptLimitError, BudgetError, BusyError, PausedError, StudioError,
  agentSchemas, studioKind, isFounder,
  type Cycle, type Memory, type Observation, type Result, type Stage, type StudioKind,
} from './domain.js';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export type MemoryEntry = {
  id: string; kind: 'identity' | 'observation' | 'decision' | 'reflection' | 'work' | 'note';
  content: string; cycleId: string | null; sourceIds: string[];
  visibility: 'public' | 'private'; supersedes: string | null; createdAt: string;
};
type Event = { sequence: number; cycleId: string | null; type: string; data: unknown; at: string; previousHash: string; hash: string };
export type Lease = { token: string; attemptId: string; cycle: Cycle };

/** Local storage adapter. All claims, budget reservations and checkpoints are atomic. */
export class Store {
  readonly db: Database.Database;
  constructor(file: string, readonly now: () => number = Date.now) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    const version = this.db.pragma('user_version', { simple: true });
    if (version !== 0 && version !== 1) throw new StudioError('Unsupported database schema version');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cycles (
        id TEXT PRIMARY KEY, trigger_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
        lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        cycle_id TEXT NOT NULL REFERENCES cycles(id), stage TEXT NOT NULL,
        revision INTEGER NOT NULL, output TEXT NOT NULL,
        PRIMARY KEY(cycle_id, stage, revision)
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES cycles(id),
        stage TEXT NOT NULL, revision INTEGER NOT NULL, day TEXT NOT NULL,
        model_call INTEGER NOT NULL, status TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, response_id TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id TEXT,
        type TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL,
        previous_hash TEXT NOT NULL, hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
        cycle_id TEXT, source_ids TEXT NOT NULL, visibility TEXT NOT NULL,
        supersedes TEXT REFERENCES memories(id), created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED, content);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS releases (
        cycle_id TEXT PRIMARY KEY REFERENCES cycles(id), manifest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS build_jobs (
        cycle_id TEXT PRIMARY KEY REFERENCES cycles(id), payload TEXT NOT NULL,
        lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS attempts_by_day ON attempts(day, model_call);
      CREATE INDEX IF NOT EXISTS memories_by_cycle ON memories(cycle_id);
      PRAGMA user_version = 1;
    `);
  }
  close() { this.db.close(); }
  bindStudio(kind: StudioKind, instanceId: string | null = null) {
    this.db.transaction(() => {
      const saved = this.db.prepare("SELECT value FROM settings WHERE key='studio_kind'").get() as { value: string } | undefined;
      const prior = saved?.value ?? (this.list()[0] ? studioKind(this.list()[0]!.profile) : undefined);
      if (prior && prior !== kind) throw new StudioError('This data directory belongs to a different studio; use a separate instance directory');
      const instance = this.db.prepare("SELECT value FROM settings WHERE key='founder_instance_id'").get() as { value: string } | undefined;
      if (kind === 'founder' && instance && instance.value !== (instanceId ?? 'default')) throw new StudioError('This data directory belongs to another founder instance');
      this.db.prepare("INSERT OR IGNORE INTO settings VALUES('studio_kind',?)").run(kind);
      if (kind === 'founder') this.db.prepare("INSERT OR IGNORE INTO settings VALUES('founder_instance_id',?)").run(instanceId ?? 'default');
    }).immediate();
  }
  iso() { return new Date(this.now()).toISOString(); }
  private decode(row: unknown): Cycle {
    if (!row) throw new StudioError('Cycle not found');
    return JSON.parse((row as { payload: string }).payload) as Cycle;
  }
  get(id: string) { return this.decode(this.db.prepare('SELECT payload FROM cycles WHERE id=?').get(id)); }
  list(): Cycle[] { return this.db.prepare('SELECT payload FROM cycles ORDER BY rowid').all().map(row => this.decode(row)); }
  byTrigger(key: string): Cycle | undefined {
    const row = this.db.prepare('SELECT payload FROM cycles WHERE trigger_key=?').get(key);
    return row ? this.decode(row) : undefined;
  }
  create(cycle: Cycle): Cycle {
    return this.db.transaction(() => {
      this.bindStudio(studioKind(cycle.profile), isFounder(cycle.profile) ? cycle.profile.instanceId : null);
      const existing = this.byTrigger(cycle.triggerKey);
      if (existing) {
        // Same trigger with a different payload is a caller error, not a new project.
        if (existing.provider !== cycle.provider || existing.model !== cycle.model ||
            JSON.stringify(existing.observations) !== JSON.stringify(cycle.observations) ||
            JSON.stringify(existing.profile) !== JSON.stringify(cycle.profile) ||
            JSON.stringify(existing.policy) !== JSON.stringify(cycle.policy)) {
          throw new StudioError('Trigger already exists with different inputs; use a new trigger key');
        }
        return existing;
      }
      this.assertRunning();
      if (this.list().filter(c => c.status === 'active').length >= cycle.policy.maxActiveCycles) {
        throw new BudgetError('Active project limit reached');
      }
      this.db.prepare('INSERT INTO cycles(id,trigger_key,payload) VALUES(?,?,?)')
        .run(cycle.id, cycle.triggerKey, JSON.stringify(cycle));
      this.addMemory({ id: `identity-${hash(JSON.stringify(cycle.profile))}`, kind: 'identity',
        content: JSON.stringify(cycle.profile), cycleId: null, sourceIds: [], visibility: 'public', supersedes: null });
      for (const observation of cycle.observations) {
        this.addMemory({ id: `${cycle.id}:source:${observation.id}`, kind: 'observation',
          content: JSON.stringify(observation), cycleId: cycle.id, sourceIds: [observation.id],
          visibility: observation.visibility, supersedes: null });
      }
      this.event(cycle.id, 'cycle.created', { provider: cycle.provider });
      return cycle;
    }).immediate();
  }
  paused(): boolean { return !!this.db.prepare("SELECT 1 FROM settings WHERE key='paused' AND value='true'").get(); }
  private assertRunning() { if (this.paused()) throw new PausedError('Studio is paused'); }
  pause(value: boolean) {
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO settings VALUES('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(value));
      this.event(null, value ? 'studio.paused' : 'studio.resumed', {});
    }).immediate();
  }
  closeCycle(id: string, reason: string) {
    if (!reason.trim() || reason.length > 2400) throw new StudioError('Closing a cycle requires a reason of 1–2400 characters');
    return this.db.transaction(() => {
      const cycle = this.get(id);
      if (cycle.status !== 'active') throw new StudioError('Only active cycles can be closed');
      const lock = this.db.prepare('SELECT lease_until FROM cycles WHERE id=?').get(id) as { lease_until: number };
      if (lock.lease_until > this.now()) throw new BusyError('Wait for the active worker to finish or its lease to expire');
      const updated: Cycle = { ...cycle, status: 'failed', updatedAt: this.iso(), lastError: 'Closed by operator' };
      this.db.prepare('UPDATE cycles SET payload=?,lease_token=NULL,lease_until=0 WHERE id=?').run(JSON.stringify(updated), id);
      this.addMemory({ id: `${id}:closed`, kind: 'decision', content: reason, cycleId: id,
        sourceIds: cycle.observations.map(o => o.id), supersedes: null,
        visibility: cycle.observations.some(o => o.visibility === 'private') ? 'private' : 'public' });
      this.event(id, 'cycle.closed', { stage: cycle.stage });
      return updated;
    }).immediate();
  }
  claim(id: string): Lease {
    return this.db.transaction(() => {
      this.assertRunning();
      const cycle = this.get(id);
      const modelCall = cycle.stage in agentSchemas;
      if (cycle.status !== 'active') throw new StudioError(`Cycle is ${cycle.status}`);
      const lock = this.db.prepare('SELECT lease_until FROM cycles WHERE id=?').get(id) as { lease_until: number };
      if (lock.lease_until > this.now()) throw new BusyError('Another worker holds this cycle lease');
      const n = (this.db.prepare('SELECT count(*) AS n FROM attempts WHERE cycle_id=? AND stage=? AND revision=?')
        .get(id, cycle.stage, cycle.revision) as { n: number }).n;
      if (n >= cycle.policy.maxAttemptsPerStage) throw new AttemptLimitError('Stage attempt limit reached; inspect the cycle before starting a new one');
      const day = this.iso().slice(0, 10);
      if (modelCall) {
        const calls = (this.db.prepare('SELECT count(*) AS n FROM attempts WHERE cycle_id=? AND model_call=1').get(id) as { n: number }).n;
        const daily = (this.db.prepare('SELECT count(*) AS n FROM attempts WHERE day=? AND model_call=1').get(day) as { n: number }).n;
        if (calls >= cycle.policy.maxCallsPerCycle || daily >= cycle.policy.maxCallsPerDay) {
          throw new BudgetError('Model-call allowance exhausted; failed or interrupted calls still count');
        }
      }
      const token = randomUUID(), attemptId = randomUUID();
      // Prior claimed attempts are unknown outcomes after lease expiry; never erase their cost reservation.
      this.db.prepare("UPDATE attempts SET status='interrupted' WHERE cycle_id=? AND status='started'").run(id);
      this.db.prepare('UPDATE cycles SET lease_token=?,lease_until=? WHERE id=?').run(token, this.now() + cycle.policy.leaseMs, id);
      this.db.prepare('INSERT INTO attempts(id,cycle_id,stage,revision,day,model_call,status) VALUES(?,?,?,?,?,?,?)')
        .run(attemptId, id, cycle.stage, cycle.revision, day, Number(modelCall), 'started');
      this.event(id, 'stage.started', { stage: cycle.stage, revision: cycle.revision, attemptId });
      return { token, attemptId, cycle };
    }).immediate();
  }
  private assertLease(lease: Lease) {
    const row = this.db.prepare('SELECT lease_token,lease_until FROM cycles WHERE id=?').get(lease.cycle.id) as { lease_token: string; lease_until: number };
    if (row.lease_token !== lease.token || row.lease_until <= this.now()) throw new BusyError('Lease expired; stale result discarded');
  }
  checkpoint(id: string, stage: Stage, revision = 0): Result | undefined {
    const row = this.db.prepare('SELECT output FROM checkpoints WHERE cycle_id=? AND stage=? AND revision=?').get(id, stage, revision) as { output: string } | undefined;
    return row ? JSON.parse(row.output) as Result : undefined;
  }
  complete(lease: Lease, output: Result, next: Pick<Cycle, 'stage' | 'revision' | 'status' | 'outcome'> & { discoveredObservations?: Observation[] },
    usage?: { inputTokens: number | null; outputTokens: number | null; responseId: string | null }) {
    return this.db.transaction(() => {
      this.assertLease(lease);
      const cycle = lease.cycle;
      this.db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?)').run(cycle.id, cycle.stage, cycle.revision, JSON.stringify(output));
      this.db.prepare("UPDATE attempts SET status='completed',input_tokens=?,output_tokens=?,response_id=? WHERE id=?")
        .run(usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.responseId ?? null, lease.attemptId);
      if (cycle.stage === 'release') {
        this.db.prepare('INSERT INTO releases VALUES(?,?)').run(cycle.id, JSON.stringify(output));
      }
      const updated: Cycle = { ...cycle, ...next, updatedAt: this.iso(), lastError: null };
      for (const observation of next.discoveredObservations ?? []) {
        this.addMemory({ id: `${cycle.id}:source:${observation.id}`, kind: 'observation',
          content: JSON.stringify(observation), cycleId: cycle.id, sourceIds: [observation.id],
          visibility: observation.visibility, supersedes: null });
      }
      this.db.prepare('UPDATE cycles SET payload=?,lease_token=NULL,lease_until=0 WHERE id=?').run(JSON.stringify(updated), cycle.id);
      const kind = cycle.stage === 'reflect' ? 'reflection' : cycle.stage === 'release' ? 'work' : 'decision';
      this.addMemory({ id: `${cycle.id}:${cycle.stage}:${cycle.revision}`, kind, content: JSON.stringify(output),
        cycleId: cycle.id, sourceIds: [...cycle.observations, ...(updated.discoveredObservations ?? [])].map(o => o.id),
        visibility: cycle.observations.some(o => o.visibility === 'private') ? 'private' : 'public', supersedes: null });
      this.event(cycle.id, 'stage.completed', { stage: cycle.stage, revision: cycle.revision, nextStage: next.stage, outcome: next.outcome });
      return updated;
    }).immediate();
  }
  fail(lease: Lease, message: string) {
    this.db.transaction(() => {
      this.assertLease(lease);
      const updated = { ...lease.cycle, lastError: message, updatedAt: this.iso() };
      this.db.prepare('UPDATE cycles SET payload=?,lease_token=NULL,lease_until=0 WHERE id=?').run(JSON.stringify(updated), updated.id);
      this.db.prepare("UPDATE attempts SET status='failed' WHERE id=?").run(lease.attemptId);
      // No raw provider errors, headers, or response payloads in the public event log.
      this.event(updated.id, 'stage.failed', { stage: updated.stage, attemptId: lease.attemptId });
    }).immediate();
  }
  event(cycleId: string | null, type: string, data: unknown) {
    const last = this.db.prepare('SELECT hash FROM events ORDER BY sequence DESC LIMIT 1').get() as { hash: string } | undefined;
    const previousHash = last?.hash ?? '0'.repeat(64), at = this.iso();
    const digest = hash(JSON.stringify({ cycleId, type, data, at, previousHash }));
    this.db.prepare('INSERT INTO events(cycle_id,type,data,at,previous_hash,hash) VALUES(?,?,?,?,?,?)')
      .run(cycleId, type, JSON.stringify(data), at, previousHash, digest);
  }
  events(): Event[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY sequence').all() as Array<Record<string, unknown>>).map(r => ({
      sequence: r.sequence as number, cycleId: r.cycle_id as string | null, type: r.type as string,
      data: JSON.parse(r.data as string), at: r.at as string, previousHash: r.previous_hash as string, hash: r.hash as string,
    }));
  }
  verifyEvents() {
    let previousHash = '0'.repeat(64);
    for (const e of this.events()) {
      if (e.previousHash !== previousHash || e.hash !== hash(JSON.stringify({ cycleId: e.cycleId, type: e.type, data: e.data, at: e.at, previousHash }))) return false;
      previousHash = e.hash;
    }
    return true;
  }
  addMemory(input: Omit<MemoryEntry, 'createdAt'>): MemoryEntry {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(input.id) as Record<string, unknown> | undefined;
      const existing = row ? this.memoryFromRow(row) : undefined;
      if (existing) {
        const { createdAt: _, ...value } = existing;
        if (JSON.stringify(value) !== JSON.stringify(input)) throw new StudioError('Memory ID conflict');
        return existing;
      }
      if (input.supersedes && !this.db.prepare('SELECT 1 FROM memories WHERE id=?').get(input.supersedes)) throw new StudioError('Superseded memory does not exist');
      const entry = { ...input, createdAt: this.iso() };
      this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?)').run(entry.id, entry.kind, entry.content,
        entry.cycleId, JSON.stringify(entry.sourceIds), entry.visibility, entry.supersedes, entry.createdAt);
      this.db.prepare('INSERT INTO memory_search(id,content) VALUES(?,?)').run(entry.id, entry.content);
      return entry;
    })();
  }
  memories(query?: string): MemoryEntry[] {
    const words = query?.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 20);
    const rows = words?.length
      ? this.db.prepare('SELECT m.* FROM memories m JOIN memory_search s ON m.id=s.id WHERE memory_search MATCH ? ORDER BY rank LIMIT 30')
        .all(words.map(w => `"${w}"`).join(' OR '))
      : this.db.prepare('SELECT * FROM memories ORDER BY rowid').all();
    return (rows as Array<Record<string, unknown>>).map(r => this.memoryFromRow(r));
  }
  private memoryFromRow(r: Record<string, unknown>): MemoryEntry {
    return { id: r.id as string, kind: r.kind as MemoryEntry['kind'],
      content: r.content as string, cycleId: r.cycle_id as string | null, sourceIds: JSON.parse(r.source_ids as string),
      visibility: r.visibility as MemoryEntry['visibility'], supersedes: r.supersedes as string | null, createdAt: r.created_at as string };
  }
  recentMemory(): Memory[] {
    return this.list().filter(c => c.status !== 'active' && c.observations.every(o => o.visibility === 'public')).slice(-6).map(c => {
      const proposal = this.checkpoint(c.id, 'propose');
      const row = this.db.prepare('SELECT payload FROM build_jobs WHERE cycle_id=?').get(c.id) as { payload: string } | undefined;
      const build = row ? JSON.parse(row.payload) : null;
      return { id: c.id, title: String(proposal?.title ?? 'No work proposed'), outcome: c.outcome ?? c.status,
        concept: String(proposal?.concept ?? proposal?.hypothesis ?? ''), reflection: this.checkpoint(c.id, 'reflect') ?? null,
        execution: build ? { status: build.status, artifacts: build.artifacts, error: build.error, validation: 'Prototype execution is not customer validation.' } : null };
    });
  }
  attempts() { return this.db.prepare('SELECT * FROM attempts ORDER BY rowid').all(); }
  builds(): Result[] { return (this.db.prepare('SELECT payload FROM build_jobs ORDER BY rowid').all() as { payload: string }[]).map(row => JSON.parse(row.payload)); }
  releases(): Result[] { return (this.db.prepare('SELECT manifest FROM releases ORDER BY rowid').all() as { manifest: string }[]).map(r => JSON.parse(r.manifest) as Result); }
}
