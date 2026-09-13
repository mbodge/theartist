import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, type Store } from './store.js';
import { immutableWrite, inspectArtifact } from './artifacts.js';
import { instructions } from './agents.js';
import type { Artifact } from './domain.js';

/** Portable public record. A projection of the studio, never a raw database dump. */
export async function exportArchive(store: Store, studioRoot: string, destination: string) {
  const allMemories = store.memories();
  const memories = allMemories.filter(m => m.visibility === 'public');
  const cycles = store.list().filter(c => c.observations.every(o => o.visibility === 'public')).map(c => ({
    id: c.id, provider: c.provider, model: c.model, fixture: c.provider === 'fixture',
    profile: c.profile, observations: c.observations, priorPractice: c.memory,
    recalledMemoryIds: c.recalledMemories.map(m => m.id),
    stage: c.stage, status: c.status, outcome: c.outcome, revision: c.revision,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  }));
  const ids = new Set(cycles.map(c => c.id));
  const releases = store.releases().filter(r => ids.has(String(r.id)));
  const events = store.events(); // Event payloads are operational metadata, never provider responses.
  const manifest = {
    schemaVersion: 1, title: 'theartist — public studio archive',
    explanation: 'Explicit studio outputs, decisions, sources, and reflections. Fixture runs are synthetic. Local releases are not public exhibitions. Credentials, raw provider traces, and private source-derived records are excluded.',
    instructions, cycles, memories, releases, events,
    withheldMemoryCount: allMemories.length - memories.length,
    eventChainValid: store.verifyEvents(),
  };
  const serialized = JSON.stringify(manifest, null, 2) + '\n';
  const digest = hash(serialized);
  const directory = join(destination, digest);
  await mkdir(directory, { recursive: true });
  const artifacts = new Map<string, Artifact>();
  for (const cycle of cycles) {
    for (let revision = 0; revision <= cycle.revision; revision++) {
      const artifact = store.checkpoint(cycle.id, 'render', revision) as Artifact | undefined;
      if (artifact) artifacts.set(artifact.hash, artifact);
    }
  }
  for (const artifact of artifacts.values()) {
    await inspectArtifact(studioRoot, artifact);
    await mkdir(join(directory, artifact.directory), { recursive: true });
    for (const path of [artifact.png, artifact.svg, artifact.spec]) {
      await immutableWrite(join(directory, path), await readFile(join(studioRoot, path)));
    }
  }
  await immutableWrite(join(directory, 'archive.json'), serialized);
  await immutableWrite(join(directory, 'memory.jsonl'), memories.map(m => JSON.stringify(m)).join('\n') + '\n');
  const temp = join(destination, `.latest-${randomUUID()}.json`);
  await writeFile(temp, JSON.stringify({ hash: digest, archive: `${digest}/archive.json`, memory: `${digest}/memory.jsonl` }, null, 2) + '\n');
  await rename(temp, join(destination, 'latest.json'));
  return { directory, hash: digest, memories: memories.length, cycles: cycles.length, artifacts: artifacts.size };
}
