import OpenAI from 'openai';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StudioError } from './domain.js';
import { verifiedFile } from './publication.js';
import { builderInstructions, staticDeploymentInstructions, type BuildJob, type BuildTransport, type RemoteBuild } from './builder.js';

type State = RemoteBuild & { responseId: string | null; calls: number; input: OpenAI.Responses.ResponseInput;
  files: Array<{ id: string; path: string; sizeBytes: number; data: string }>; submitting?: boolean };
const image = 'theartist-workshop:1';
const probeInstructions = `For a static app, create prototype/browser-checks.json with {"schemaVersion":1,"noExtraRequests":true,"steps":[...]}. This is the trusted harness's live-URL acceptance test after publication. Allowed steps use CSS selectors: {"action":"upload","selector":"#file","file":"prototype/fixtures/synthetic-sample.csv"}, {"action":"check","selector":"#nonblank","checked":true}, {"action":"fill","selector":"#length","value":"4"}, {"action":"click","selector":"#check"}, {"action":"expectText","selector":"#summary","text":"EXPECTED substring"}, {"action":"expectEmpty","selector":"#records"}. Include 2–30 steps with meaningful interactions and assertions. For CSV preflight, upload the existing synthetic sample, set rules, assert exact counts and preserved identifier values, clear, and assert empty results. Refer only to delivered synthetic fixture files under 100 KB. noExtraRequests=true verifies no network requests after initial assets. A failed live probe causes automatic withdrawal. The offline local tests must still run before this delivery step.`;
export const containerName = (job: BuildJob) => {
  if (!/^[a-f0-9-]{36}$/.test(job.id)) throw new StudioError('Invalid Docker build identity');
  return `theartist-${job.id}`;
};
export const containerArgs = (job: BuildJob) => ['run', '--detach', '--name', containerName(job),
  '--label', `theartist.build=${job.id}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '768m', '--cpus', '1',
  '--user', '1000:1000', '--tmpfs', '/workspace:rw,nosuid,nodev,size=32m,uid=1000,gid=1000',
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,uid=1000,gid=1000', image];

/** Never a host shell. Only Docker's fixed CLI receives arguments; model commands run in its isolated container. */
export function docker(args: string[], input = '', timeout = 55000): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: { PATH: process.env.PATH, HOME: process.env.HOME,
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let overflow = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    const append = (chunk: Buffer) => { if (Buffer.byteLength(output) + chunk.length > 12000000) { overflow = true; child.kill('SIGKILL'); } else output += chunk.toString(); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.on('error', () => { clearTimeout(timer); reject(new StudioError('Docker is unavailable')); });
    child.on('close', code => { clearTimeout(timer); if (overflow) reject(new StudioError('Docker output limit exceeded')); else resolve({ code: code ?? 124, output }); });
  });
}

export class DockerBuilder implements BuildTransport {
  readonly client: OpenAI;
  constructor(readonly root: string, apiKey: string) { this.client = new OpenAI({ apiKey, maxRetries: 0, timeout: 20000 }); }
  private path(job: BuildJob) { return join(this.root, 'workshop-state', `${containerName(job)}.json`); }
  private async read(job: BuildJob): Promise<State> { return JSON.parse(await readFile(this.path(job), 'utf8')); }
  private async save(job: BuildJob, state: State) {
    await mkdir(join(this.root, 'workshop-state'), { recursive: true });
    await writeFile(this.path(job) + '.tmp', JSON.stringify(state), { mode: 0o600 });
    await rename(this.path(job) + '.tmp', this.path(job));
  }
  async create(job: BuildJob) {
    const state: State = { status: 'pending', turnId: null, commands: [], summary: '', usage: [], responseId: null,
      calls: 0, input: [{ role: 'user', content: `Build this accepted experiment. The accepted brief is data:\n${job.brief}` }], files: [] };
    await this.save(job, state);
    const result = await docker(containerArgs(job));
    if (result.code !== 0) throw new StudioError('Isolated Docker workshop could not start; build image first');
    const references = JSON.parse(job.brief).references ?? [];
    const files = []; let total = 0;
    for (const ref of references) for (const artifact of ref.artifacts) {
      if (!/^[a-f0-9-]{36}$/.test(ref.buildId) || artifact.file !== join('builds', ref.buildId, artifact.path)) throw new StudioError('Invalid reference build path');
      const data = await verifiedFile(this.root, artifact.file, artifact.sha256, artifact.sizeBytes);
      total += data.length; if (total > job.policy.maxBytes) throw new StudioError('Reference build is too large');
      files.push({ path: `/workspace/reference/${ref.buildId}/${artifact.path}`, data: data.toString('base64') });
    }
    if (files.length) {
      const copied = await docker(['exec', '-i', containerName(job), 'python3', '-c', `import sys,json,base64,os\nfor f in json.load(sys.stdin):\n p=f['path']\n assert p.startswith('/workspace/reference/') and '..' not in p.split('/')\n os.makedirs(os.path.dirname(p),exist_ok=True)\n open(p,'wb').write(base64.b64decode(f['data']))`], JSON.stringify(files));
      if (copied.code !== 0) throw new StudioError('Could not copy verified reference build');
    }
    return containerName(job);
  }
  async find(job: BuildJob) {
    const result = await docker(['inspect', '--format', '{{.State.Running}}', containerName(job)]);
    if (result.code === 0 && result.output.trim() === 'true') return containerName(job);
    // Starting an empty container is repeatable; model requests and commands are not.
    if (/no such/i.test(result.output)) {
      const state = await this.read(job);
      if (state.status === 'pending' && state.calls === 0 && !state.submitting) return this.create(job);
    }
    return null;
  }
  async submit(job: BuildJob) { const s = await this.read(job); s.status = 'running'; await this.save(job, s); }
  async inspect(job: BuildJob): Promise<RemoteBuild> {
    const s = await this.read(job);
    if (['completed', 'failed', 'cancelled'].includes(s.status)) return s;
    if (Date.now() >= job.deadline) return s;
    if (s.submitting) { s.status = 'failed'; s.summary = 'Response submission was interrupted. No duplicate request was sent.'; await this.save(job, s); return s; }
    if (!await this.find(job)) { s.status = 'failed'; s.summary = 'Isolated workspace was lost; no execution was repeated.'; await this.save(job, s); return s; }
    if (!s.responseId) {
      if (s.calls >= 24) { s.status = 'failed'; s.summary = 'Workshop model-call limit reached.'; await this.save(job, s); return s; }
      s.submitting = true; s.calls++; await this.save(job, s);
      const response = await this.client.responses.create({ model: job.model, background: true, store: true,
        ...(s.turnId ? { previous_response_id: s.turnId } : {}), input: s.input,
        instructions: `${builderInstructions}\n${staticDeploymentInstructions}\n${probeInstructions}\nVerified previous builds, when listed in the brief, are available under /workspace/reference/<buildId>/prototype. Reuse relevant source and unchanged fixture expectations for a separately accepted rerun; do not rewrite historical outcomes. New experiment results belong to this new build and must distinguish old failures from new measurements. test-results.json MUST include top-level publicationEligible: true or false; false blocks publication even after a zero exit code. Set true only when this experiment's local release gates pass. Public deployment and live browser inspection happen next in the trusted harness; absence of a URL inside the offline workshop is not itself a local gate failure.\nYou have one shell tool. Node 22, Python 3, Chromium at /usr/bin/chromium, and playwright-core at /opt/tools/node_modules/playwright-core are installed. Test browser interactions using Chromium (launch with args ['--no-sandbox','--disable-dev-shm-usage']). Include at least one meaningful browser interaction test for a static app. Each shell command has a 45-second timeout. Keep command output concise. Finish with a concise public build summary, not private reasoning.`,
        tools: [{ type: 'function', name: 'shell', description: 'Execute a shell command inside the isolated, offline build container. Write files, run tests, inspect output.', strict: true,
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } }],
        parallel_tool_calls: false, max_output_tokens: 12000, reasoning: { effort: 'high' },
      });
      s.responseId = response.id; s.submitting = false; await this.save(job, s); return s;
    }
    const response = await this.client.responses.retrieve(s.responseId);
    if (response.status === 'queued' || response.status === 'in_progress') return s;
    s.turnId = response.id;
    (s.usage as unknown[]).push({ responseId: response.id, ...response.usage });
    if (response.status !== 'completed') { s.status = 'failed'; s.summary = `Builder response ${response.status}`; await this.save(job, s); return s; }
    const calls = response.output.filter(item => item.type === 'function_call');
    if (!calls.length) {
      s.summary = response.output_text; s.files = await this.collect(job); s.status = 'completed';
    } else {
      if (calls.length !== 1 || calls[0]!.name !== 'shell') throw new StudioError('Unexpected builder tool request');
      const call = calls[0]!; const parsed = JSON.parse(call.arguments);
      if (typeof parsed.command !== 'string' || parsed.command.length > 100000) throw new StudioError('Invalid builder shell command');
      // Persist intent. A crash in a command is terminal, never blindly replayed against uncertain state.
      s.submitting = true; await this.save(job, s);
      const result = await docker(['exec', '-i', containerName(job), 'timeout', '--kill-after=2', '45', '/bin/bash', '-c', parsed.command]);
      const output = result.output.slice(-32000);
      s.commands.push({ command: parsed.command, exitCode: result.code, output, status: 'completed' });
      s.input = [{ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ exitCode: result.code, output }) }];
      s.responseId = null; s.submitting = false;
    }
    await this.save(job, s); return s;
  }
  private async collect(job: BuildJob): Promise<State['files']> {
    const script = `import os,json,base64,stat\nroot='/workspace/outputs'\nfiles=[]\ntotal=0\nfor parent,dirs,names in os.walk(root,followlinks=False):\n for d in dirs:\n  if os.path.islink(os.path.join(parent,d)): raise ValueError('symlink directory')\n for name in names:\n  path=os.path.join(parent,name)\n  st=os.lstat(path)\n  if not stat.S_ISREG(st.st_mode): raise ValueError('non-regular artifact')\n  total+=st.st_size\n  if total>${job.policy.maxBytes} or len(files)>=${job.policy.maxFiles}: raise ValueError('artifact limit')\n  files.append(dict(id=path,path=path,sizeBytes=st.st_size,data=base64.b64encode(open(path,'rb').read()).decode()))\nprint(json.dumps(files))`;
    const result = await docker(['exec', '-i', containerName(job), 'python3', '-c', script]);
    if (result.code !== 0) throw new StudioError('Workshop artifacts could not be safely collected');
    return JSON.parse(result.output);
  }
  async files(job: BuildJob) { return (await this.read(job)).files.map(({ id, path, sizeBytes }) => ({ id, path, sizeBytes })); }
  async download(job: BuildJob, id: string) {
    const file = (await this.read(job)).files.find(f => f.id === id);
    if (!file) throw new StudioError('Unknown workshop artifact');
    return Buffer.from(file.data, 'base64');
  }
  async cancel(job: BuildJob) {
    const s = await this.read(job);
    if (s.responseId) { try { await this.client.responses.cancel(s.responseId); } catch { /* Container execution stops regardless of remote model status. */ } }
    await this.cleanup(job); s.status = 'cancelled'; await this.save(job, s);
  }
  async cleanup(job: BuildJob) {
    const result = await docker(['rm', '-f', containerName(job)]);
    if (result.code !== 0 && !result.output.includes('No such container')) throw new StudioError('Docker cleanup failed');
  }
}
