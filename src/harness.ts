import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  agentSchemas, schemasFor, isFounder, isFounderArtifact, observationsSchema, profileSchema, policySchema, StudioError,
  type AgentProvider, type AgentRequest, type AgentResponse, type AgentStage,
  type StudioArtifact, type Cycle, type Observation, type Policy, type Profile, type Result,
} from './domain.js';
import { Store } from './store.js';
import { agentInput } from './agents.js';
import { inspectArtifact, prepareRelease, renderArtwork } from './artifacts.js';
import { inspectExperiment, renderExperiment, releaseExperiment } from './founder.js';

export class Harness {
  readonly store: Store;
  constructor(readonly root: string, readonly provider: AgentProvider, store?: Store) {
    this.store = store ?? new Store(join(root, 'studio.sqlite'));
  }
  start(triggerKey: string, profileInput: Profile, policyInput: Policy, observationsInput: Observation[]): Cycle {
    if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(triggerKey)) throw new StudioError('Trigger keys must be 1–160 letters, numbers, colons, underscores, or hyphens');
    const profile = profileSchema.parse(profileInput), policy = policySchema.parse(policyInput);
    const observations = observationsSchema.parse(observationsInput);
    const now = this.store.iso();
    // Bind before memory retrieval so another studio's history can never enter this context.
    this.store.bindStudio(isFounder(profile) ? 'founder' : 'artist', isFounder(profile) ? profile.instanceId : null);
    const interests = isFounder(profile) ? [profile.mandate, profile.audience, profile.thesis] : profile.preoccupations;
    const query = [...observations.map(o => o.title), ...interests].join(' ');
    const all = this.store.memories();
    const superseded = new Set(all.map(m => m.supersedes).filter(Boolean));
    const recalled = this.store.memories(query).filter(m => m.visibility === 'public' && !superseded.has(m.id)).slice(0, 8);
    const cycle: Cycle = {
      id: randomUUID(), triggerKey, provider: this.provider.name, model: this.provider.model,
      profile, policy, observations, memory: this.store.recentMemory(),
      recalledMemories: recalled.map(({ id, kind, content, sourceIds, supersedes }) => ({ id, kind, content, sourceIds, supersedes })),
      stage: 'research', revision: 0, status: 'active', outcome: null,
      createdAt: now, updatedAt: now, lastError: null,
    };
    return this.store.create(cycle);
  }
  private required(cycle: Cycle, stage: Cycle['stage'], revision = 0): Result {
    const result = this.store.checkpoint(cycle.id, stage, revision);
    if (!result) throw new StudioError(`Missing ${stage} checkpoint`);
    return result;
  }
  async step(id: string): Promise<Cycle> {
    const initial = this.store.get(id);
    if (initial.status !== 'active') return initial;
    if (initial.provider !== this.provider.name || initial.model !== this.provider.model) throw new StudioError('Resume with the original provider and model');
    const lease = this.store.claim(id);
    const cycle = lease.cycle;
    const isAgent = cycle.stage in agentSchemas;
    try {
      let output: Result;
      let usage: AgentResponse | undefined;
      const next = { stage: cycle.stage, revision: cycle.revision, status: cycle.status, outcome: cycle.outcome };
      if (isAgent) {
        const context: Record<string, unknown> = {};
        if (cycle.stage !== 'research') context.research = this.required(cycle, 'research');
        if (!['research', 'propose'].includes(cycle.stage)) context.proposal = this.required(cycle, 'propose');
        if (cycle.stage === 'make' && cycle.revision > 0) {
          context.previousArtwork = this.required(cycle, 'make', cycle.revision - 1);
          context.critique = this.required(cycle, 'critique', cycle.revision - 1);
          context.artistDecision = this.required(cycle, 'decide', cycle.revision - 1);
        }
        let image: AgentRequest['image'];
        if (['critique', 'decide'].includes(cycle.stage)) {
          context.artwork = this.required(cycle, 'make', cycle.revision);
          context.artifact = this.required(cycle, 'render', cycle.revision);
          const artifact = context.artifact as StudioArtifact;
          if (isFounderArtifact(artifact)) context.artifactDocument = await inspectExperiment(this.root, artifact);
          else image = { base64: (await inspectArtifact(this.root, artifact)).toString('base64'), hash: artifact.hash };
        }
        if (cycle.stage === 'decide') context.critique = this.required(cycle, 'critique', cycle.revision);
        if (cycle.stage === 'reflect') {
          context.outcome = cycle.outcome;
          context.decision = this.store.checkpoint(id, 'decide', cycle.revision) ?? null;
          context.artwork = this.store.checkpoint(id, 'make', cycle.revision) ?? null;
          context.release = this.store.checkpoint(id, 'release', cycle.revision) ?? null;
        }
        const request: AgentRequest = { stage: cycle.stage as AgentStage, cycle, context, image };
        if (Buffer.byteLength(JSON.stringify(agentInput(request))) > cycle.policy.maxInputBytes) throw new StudioError('Agent context exceeds configured input limit');
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new StudioError('Agent call timed out')); }, cycle.policy.callTimeoutMs);
        });
        try { usage = await Promise.race([this.provider.generate(request, controller.signal), timeout]); }
        finally { clearTimeout(timer!); }
        output = schemasFor(cycle.profile)[request.stage].parse(usage.output) as Result;
        this.validateReferences(cycle, output);
      } else if (cycle.stage === 'render') {
        output = isFounder(cycle.profile)
          ? await renderExperiment(this.root, this.required(cycle, 'propose'), this.required(cycle, 'make', cycle.revision))
          : await renderArtwork(this.root, this.required(cycle, 'make', cycle.revision));
      } else if (cycle.stage === 'release') {
        const decision = this.required(cycle, 'decide', cycle.revision);
        if (decision.action !== 'accept') throw new StudioError('Only principal-accepted artifacts can be released');
        const artifact = this.required(cycle, 'render', cycle.revision) as StudioArtifact;
        output = isFounderArtifact(artifact)
          ? await releaseExperiment(this.root, cycle, artifact, this.required(cycle, 'propose'), this.required(cycle, 'make', cycle.revision))
          : await prepareRelease(this.root, cycle, artifact, this.required(cycle, 'propose'), this.required(cycle, 'make', cycle.revision));
      } else throw new StudioError(`Unexpected stage ${cycle.stage}`);

      switch (cycle.stage) {
        case 'research': next.stage = 'propose'; break;
        case 'propose':
          if (output.action === 'abstain') { next.stage = 'reflect'; next.outcome = 'abstained'; }
          else next.stage = 'make';
          break;
        case 'make': next.stage = 'render'; break;
        case 'render': next.stage = 'critique'; break;
        case 'critique': next.stage = 'decide'; break;
        case 'decide':
          if (output.action === 'accept') next.stage = 'release';
          else if (output.action === 'reject') { next.stage = 'reflect'; next.outcome = 'rejected'; }
          else if (cycle.revision < cycle.policy.maxRevisions) { next.stage = 'make'; next.revision++; }
          else { next.stage = 'reflect'; next.outcome = 'rejected'; output = { ...output, harnessDisposition: 'Revision allowance exhausted; work not released.' }; }
          break;
        case 'release': next.stage = 'reflect'; next.outcome = 'released'; break;
        case 'reflect': next.stage = 'done'; next.status = cycle.outcome ?? 'failed'; break;
      }
      return this.store.complete(lease, output, next, usage);
    } catch (error) {
      // Persist a bounded generic error; provider messages may include private request data.
      const message = error instanceof StudioError ? error.message : 'Stage failed; inspect the local exception and retry within the attempt allowance';
      try { this.store.fail(lease, message); } catch { /* A newer worker owns recovery after lease expiry. */ }
      throw error;
    }
  }
  private validateReferences(cycle: Cycle, output: Result) {
    const sourceIds = new Set(cycle.observations.map(o => o.id));
    if (cycle.stage === 'research') {
      for (const item of output.findings as { observationId: string }[]) if (!sourceIds.has(item.observationId)) throw new StudioError('Research cited an unknown observation');
      if (isFounder(cycle.profile)) {
        const reported = output.reportedProblemSourceIds as string[];
        const allowed = new Set(cycle.observations.filter(o => o.kind === 'source' && ['customer', 'usage'].includes(o.stream)).map(o => o.id));
        if (reported.some(id => !allowed.has(id))) throw new StudioError('Customer evidence must reference supplied customer or usage sources; fixtures and notes are not evidence');
        if ((output.evidenceLevel === 'source_reports') !== (reported.length > 0)) throw new StudioError('Evidence level does not match reported sources');
      } else if (output.reception === 'observed' && !cycle.observations.some(o => o.stream === 'reception' && o.kind === 'source')) throw new StudioError('Research claimed reception without an external reception source');
    }
    if (cycle.stage === 'propose') {
      if ((output.sourceIds as string[]).some(id => !sourceIds.has(id))) throw new StudioError('Proposal cited an unknown source');
      if ((output.previousWorkIds as string[]).some(id => !cycle.memory.some(m => m.id === id))) throw new StudioError('Proposal cited an unknown previous work');
    }
    if (cycle.stage === 'critique') {
      const artifact = this.required(cycle, 'render', cycle.revision);
      if (output.inspectedArtifactHash !== artifact.hash) throw new StudioError('Critic inspected the wrong artifact version');
    }
  }
  async run(id: string, maxSteps = 32, onStep: (cycle: Cycle) => void = () => {}) {
    let cycle = this.store.get(id);
    for (let i = 0; i < maxSteps && cycle.status === 'active'; i++) {
      cycle = await this.step(id);
      onStep(cycle);
    }
    return cycle;
  }
}
