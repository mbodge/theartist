import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, type Store } from './store.js';
import { immutableWrite, inspectArtifact } from './artifacts.js';
import { artifactPath, type BuildJob } from './builder.js';
import { Board, boardInstructions } from './board.js';
import { instructions } from './agents.js';
import { founderInstructions, inspectExperiment } from './founder.js';
import { isFounderArtifact, studioKind, StudioError, type StudioArtifact } from './domain.js';

/** Portable public record. A projection of the studio, never a raw database dump. */
export async function exportArchive(store: Store, studioRoot: string, destination: string) {
  const allMemories = store.memories();
  const memories = allMemories.filter(m => m.visibility === 'public');
  const cycles = store.list().filter(c => c.observations.every(o => o.visibility === 'public')).map(c => ({
    id: c.id, studio: studioKind(c.profile), provider: c.provider, model: c.model, fixture: c.provider === 'fixture',
    profile: c.profile, observations: c.observations, discoveredObservations: c.discoveredObservations ?? [], priorPractice: c.memory,
    recalledMemoryIds: c.recalledMemories.map(m => m.id),
    stage: c.stage, status: c.status, outcome: c.outcome, revision: c.revision,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  }));
  const ids = new Set(cycles.map(c => c.id));
  const releases = store.releases().filter(r => ids.has(String(r.id)));
  const events = store.events(); // Event payloads are operational metadata, never provider responses.
  const builds = (store.builds() as unknown as BuildJob[]).filter(b => b.visibility === 'public' && ids.has(b.cycleId));
  const manifest = {
    schemaVersion: 5, title: `${cycles[0]?.profile.name ?? 'Studio'} — public archive`,
    explanation: 'Explicit studio outputs, decisions, sources, and reflections. Fixture runs are synthetic. Local releases are not public exhibitions. Credentials, raw provider traces, and private source-derived records are excluded.',
    instructions, founderInstructions, boardInstructions, board: new Board(store).publicRecord(ids), cycles, memories, releases, builds,
    deployments: store.deployments().filter(d => d.kind === 'app' && ids.has(String(d.cycleId))), events,
    withheldMemoryCount: allMemories.length - memories.length,
    eventChainValid: store.verifyEvents(),
  };
  const serialized = JSON.stringify(manifest, null, 2) + '\n';
  const digest = hash(serialized);
  const directory = join(destination, digest);
  await mkdir(directory, { recursive: true });
  const artifacts = new Map<string, StudioArtifact>();
  for (const cycle of cycles) {
    for (let revision = 0; revision <= cycle.revision; revision++) {
      const artifact = store.checkpoint(cycle.id, 'render', revision) as StudioArtifact | undefined;
      if (artifact) artifacts.set(artifact.hash, artifact);
    }
  }
  for (const artifact of artifacts.values()) {
    if (isFounderArtifact(artifact)) await inspectExperiment(studioRoot, artifact);
    else await inspectArtifact(studioRoot, artifact);
    await mkdir(join(directory, artifact.directory), { recursive: true });
    const files = isFounderArtifact(artifact) ? [artifact.document, artifact.spec] : [artifact.png, artifact.svg, artifact.spec];
    for (const path of files) {
      await immutableWrite(join(directory, path), await readFile(join(studioRoot, path)));
    }
  }
  for (const build of builds) {
    if (!/^[a-f0-9-]{36}$/.test(build.id)) throw new StudioError('Unsafe build ID');
    for (const artifact of build.artifacts) {
      const expected = join('builds', build.id, artifactPath(`/workspace/outputs/${artifact.path}`));
      if (artifact.file !== expected) throw new StudioError('Unsafe build file path');
      const bytes = await readFile(join(studioRoot, expected));
      if (bytes.byteLength !== artifact.sizeBytes || hash(bytes) !== artifact.sha256) throw new StudioError('Build artifact integrity check failed');
      await mkdir(dirname(join(directory, expected)), { recursive: true });
      await immutableWrite(join(directory, expected), bytes);
    }
  }
  await immutableWrite(join(directory, 'archive.json'), serialized);
  await immutableWrite(join(directory, 'memory.jsonl'), memories.map(m => JSON.stringify(m)).join('\n') + '\n');
  const temp = join(destination, `.latest-${randomUUID()}.json`);
  await writeFile(temp, JSON.stringify({ hash: digest, archive: `${digest}/archive.json`, memory: `${digest}/memory.jsonl` }, null, 2) + '\n');
  await rename(temp, join(destination, 'latest.json'));
  return { directory, hash: digest, memories: memories.length, cycles: cycles.length, artifacts: artifacts.size, builds: builds.length };
}
