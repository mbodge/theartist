import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from './store.js';
import { Board, boardMemberInputSchema } from './board.js';
import { founderProfileSchema, StudioError } from './domain.js';

export function instancePaths(root: string, id: string) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) throw new StudioError('Founder ID must start with a lowercase letter and contain up to 48 lowercase letters, numbers, or hyphens');
  const directory = join(root, 'studios', id);
  return { directory, profile: join(directory, 'founder.json'), policy: join(directory, 'policy.json'),
    observations: join(directory, 'observations.json'), data: join(root, '.studio', 'instances', id) };
}

export async function createFounder(root: string, id: string, options: { mission?: string; audience?: string; venture?: string; launcher?: { id: string; name: string } } = {}) {
  const paths = instancePaths(root, id);
  const launcher = boardMemberInputSchema.parse(options.launcher ?? { id: 'launcher', name: 'Studio launcher' });
  const template = founderProfileSchema.parse(JSON.parse(await readFile(join(root, 'config', 'founder.json'), 'utf8')));
  const profile = founderProfileSchema.parse({ ...template, name: id, instanceId: id,
    mandate: options.mission ?? template.mandate, audience: options.audience ?? template.audience,
    ventureType: options.venture ?? template.ventureType });
  const policy = await readFile(join(root, 'config', 'founder-policy.json'), 'utf8');
  await mkdir(join(root, 'studios'), { recursive: true });
  try { await mkdir(paths.directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StudioError('That founder already exists; its configuration was not overwritten');
    throw error;
  }
  await writeFile(paths.profile, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx' });
  await writeFile(paths.policy, policy, { flag: 'wx' });
  await writeFile(paths.observations, '[]\n', { flag: 'wx' });
  const store = new Store(join(paths.data, 'studio.sqlite'));
  try { store.bindStudio('founder', id); new Board(store).initialize(launcher); } finally { store.close(); }
  return { id, ...paths, nextCommand: `npm run studio -- tick --instance ${id}` };
}

export async function listFounders(root: string) {
  let directories;
  try { directories = await readdir(join(root, 'studios'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const directory of directories.filter(d => d.isDirectory())) {
    const paths = instancePaths(root, directory.name);
    const profile = founderProfileSchema.parse(JSON.parse(await readFile(paths.profile, 'utf8')));
    records.push({ id: directory.name, name: profile.name, mission: profile.mandate, audience: profile.audience, provisional: profile.provisional });
  }
  return records;
}
