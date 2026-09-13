import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { artworkSchema, StudioError, type Artifact, type Cycle, type Result } from './domain.js';
import { hash } from './store.js';

const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export async function immutableWrite(file: string, content: string | Buffer) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx' });
  try {
    try { await link(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (hash(await readFile(file)) !== hash(content)) throw new StudioError('Immutable artifact conflict');
    }
  } finally { await unlink(temporary); }
}

/** Only validated text/color data reaches SVG. No model-authored code, paths, URLs or markup. */
export async function renderArtwork(root: string, output: Result): Promise<Artifact> {
  const spec = artworkSchema.parse(output);
  const canonical = JSON.stringify({ renderer: 1, spec });
  const digest = hash(canonical);
  const directory = join('artifacts', digest);
  await mkdir(join(root, directory), { recursive: true });
  const x = spec.alignment === 'center' ? 600 : 100;
  const anchor = spec.alignment === 'center' ? 'middle' : 'start';
  const lines = spec.lines.map((line, i) => {
    const size = line.emphasis === 'strong' ? 48 : line.emphasis === 'quiet' ? 23 : 31;
    // Bound long lines to the page while preserving short-line spacing.
    const estimatedWidth = [...line.text].length * size * 0.62;
    const length = estimatedWidth > 1000 ? ' textLength="1000" lengthAdjust="spacingAndGlyphs"' : '';
    return `<text x="${x}" y="${260 + i * 78}" font-size="${size}" font-weight="${line.emphasis === 'strong' ? '700' : '400'}" text-anchor="${anchor}" fill="${line.emphasis === 'quiet' ? spec.accent : spec.foreground}"${length}>${escape(line.text)}</text>`;
  }).join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600"><title>${escape(spec.title)}</title><rect width="1200" height="1600" fill="${spec.background}"/><g font-family="sans-serif">${lines}</g><path d="M100 1440H1100" stroke="${spec.accent}" stroke-width="2"/></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const files = { svg: join(directory, 'artwork.svg'), png: join(directory, 'artwork.png'), spec: join(directory, 'spec.json') };
  await immutableWrite(join(root, files.svg), svg);
  await immutableWrite(join(root, files.png), png);
  await immutableWrite(join(root, files.spec), canonical);
  return { hash: digest, pngHash: hash(png), svgHash: hash(svg), directory, ...files, width: 1200, height: 1600 };
}

export async function inspectArtifact(root: string, artifact: Artifact): Promise<Buffer> {
  const rootPath = resolve(root) + sep;
  for (const path of [artifact.png, artifact.svg, artifact.spec]) {
    if (!resolve(root, path).startsWith(rootPath)) throw new StudioError('Artifact path escaped studio storage');
  }
  const png = await readFile(join(root, artifact.png));
  if (hash(png) !== artifact.pngHash || hash(await readFile(join(root, artifact.svg))) !== artifact.svgHash ||
      hash(await readFile(join(root, artifact.spec))) !== artifact.hash) throw new StudioError('Artifact integrity check failed');
  const metadata = await sharp(png).metadata();
  if (metadata.width !== 1200 || metadata.height !== 1600 || metadata.format !== 'png') throw new StudioError('Unexpected artifact format');
  return png;
}

export async function prepareRelease(root: string, cycle: Cycle, artifact: Artifact, proposal: Result, artwork: Result): Promise<Result> {
  await inspectArtifact(root, artifact);
  const directory = join(root, 'releases', cycle.id);
  await mkdir(directory, { recursive: true });
  const manifest = {
    id: cycle.id, title: artwork.title, medium: proposal.medium,
    statement: artwork.statement, status: 'local-release', provider: cycle.provider,
    fixture: cycle.provider === 'fixture', artist: cycle.profile.name,
    profileVersion: cycle.profile.version, artifact,
    sourceIds: proposal.sourceIds, previousWorkIds: proposal.previousWorkIds,
  };
  await immutableWrite(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
