import OpenAI from 'openai';
import type { AgentSessionItem } from 'openai/resources/beta/agents/agents';
import { builderInstructions, staticDeploymentInstructions, type BuildJob, type BuildTransport, type RemoteBuild } from './builder.js';
import { StudioError } from './domain.js';

export function executionLog(items: AgentSessionItem[]) {
  const commands: BuildJob['commands'] = [];
  const messages: string[] = [];
  for (const item of items) {
    if (item.type === 'command_execution') commands.push({ command: item.command.slice(0, 32000),
      exitCode: item.exit_code, output: (item.output ?? '').slice(0, 32000), status: item.status });
    if (item.type === 'message' && item.role === 'assistant') {
      for (const part of item.content) if (part.type === 'output_text') messages.push(part.text);
    }
  }
  return { commands: commands.slice(-200), summary: messages.join('\n\n').slice(-16000) };
}

export class ManagedBuilder implements BuildTransport {
  readonly client: OpenAI;
  constructor(apiKey: string) {
    if (!apiKey.trim()) throw new StudioError('Coding workshop needs OPENAI_API_KEY');
    this.client = new OpenAI({ apiKey, maxRetries: 0, timeout: 20000 });
  }
  async create(job: BuildJob) {
    const session = await this.client.beta.agents.sessions.create({
      agent: { model: job.model, instructions: builderInstructions + '\n' + staticDeploymentInstructions, multi_agent: { enabled: false }, reasoning: { effort: 'high' } },
      environment: { type: 'openai_hosted', network: { access: 'disabled' },
        files: [{ type: 'inline', path: '/workspace/accepted-experiment.json', data: Buffer.from(job.brief).toString('base64') }] },
      metadata: { studio_build_id: job.id, studio_cycle_id: job.cycleId },
      // No model input until the returned session ID is durably recorded.
    });
    return session.id;
  }
  async find(job: BuildJob) {
    let seen = 0;
    for await (const session of this.client.beta.agents.sessions.list({ limit: 100 })) {
      if (session.metadata.studio_build_id === job.id && session.metadata.studio_cycle_id === job.cycleId) return session.id;
      if (++seen >= 1000) break;
    }
    return null;
  }
  async submit(job: BuildJob) {
    await this.client.beta.agents.sessions.events.create(job.sessionId!, { events: [{ type: 'agent.session.input.message',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Read /workspace/accepted-experiment.json. Build the functional prototype now, run meaningful tests and a sample, fix defects, and put all source and results under /workspace/outputs/prototype. This is the execution phase, not another planning exercise. Report exactly what you ran and what remains unvalidated.' }] }] }] });
  }
  async inspect(job: BuildJob): Promise<RemoteBuild> {
    const session = await this.client.beta.agents.sessions.retrieve(job.sessionId!);
    const turns = await this.client.beta.agents.sessions.turns.list(job.sessionId!, { limit: 100, order: 'asc' });
    const turn = turns.data.find(t => t.subagent_id === null);
    const items: AgentSessionItem[] = [];
    if (turn) {
      for await (const item of this.client.beta.agents.sessions.items.list(job.sessionId!, { limit: 100, order: 'asc' })) {
        if (item.turn_id === turn.id && item.type !== 'reasoning') items.push(item);
        if (items.length >= 1000) throw new StudioError('Coding trace exceeded its item limit');
      }
    }
    return { status: session.status === 'failed' ? 'failed' : !turn ? 'pending'
      : ['completed', 'failed', 'cancelled'].includes(turn.status) ? turn.status as 'completed' | 'failed' | 'cancelled' : 'running',
      turnId: turn?.id ?? null, ...executionLog(items), usage: turn?.usage ?? session.usage };
  }
  async files(job: BuildJob) {
    const files = [];
    for await (const file of this.client.beta.agents.sessions.artifacts.list(job.sessionId!, { limit: 100, order: 'asc' })) {
      if (file.turn_id === job.turnId) files.push({ id: file.id, path: file.path, sizeBytes: file.size_bytes });
      if (files.length > job.policy.maxFiles) break;
    }
    return files;
  }
  async download(job: BuildJob, id: string) {
    const response = await this.client.beta.agents.sessions.artifacts.content(id, { session_id: job.sessionId! }, { signal: AbortSignal.timeout(20000) });
    if (!response.body) throw new StudioError('Empty artifact response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > job.policy.maxBytes) throw new StudioError('Artifact download exceeds byte limit');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  }
  async cancel(job: BuildJob) {
    await this.client.beta.agents.sessions.events.create(job.sessionId!, { events: [{ type: 'agent.session.input.cancel' }] });
  }
  async cleanup(job: BuildJob) {
    try { await this.client.beta.agents.sessions.delete(job.sessionId!); }
    catch (error) {
      if (error instanceof OpenAI.APIError && error.status === 404) return;
      if (error instanceof OpenAI.APIError && error.status === 409) throw new StudioError('Provider still reports an active session and refused deletion; cancellation remains unresolved. No new build will be dispatched.');
      throw error;
    }
  }
}
