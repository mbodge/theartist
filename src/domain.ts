import { z } from 'zod';

const prose = z.string().min(1).max(2400);
export const artistProfileSchema = z.strictObject({
  name: z.string().min(1).max(100), version: z.number().int().positive(),
  provisional: z.boolean(), description: prose,
  preoccupations: z.array(prose).min(1).max(10),
  preferences: z.array(prose).max(20), refusals: z.array(prose).max(20),
  voice: prose, initialBodyOfWork: prose, referenceNotes: z.array(prose).max(20),
});
export const founderProfileSchema = z.strictObject({
  studio: z.literal('founder'), name: z.string().min(1).max(100),
  instanceId: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/).nullable().default(null),
  version: z.number().int().positive(), provisional: z.boolean(), description: prose,
  audience: prose, ventureType: prose, mandate: prose, thesis: prose,
  successSignals: z.array(prose).min(1).max(10),
  principles: z.array(prose).min(1).max(20), exclusions: z.array(prose).max(20),
  voice: prose, referenceNotes: z.array(prose).max(20),
});
export const profileSchema = z.union([artistProfileSchema, founderProfileSchema]);
export type Profile = z.infer<typeof profileSchema>;
export type StudioKind = 'artist' | 'founder';
export function isFounder(profile: Profile): profile is z.infer<typeof founderProfileSchema> {
  return 'studio' in profile && profile.studio === 'founder';
}
export const studioKind = (profile: Profile): StudioKind => isFounder(profile) ? 'founder' : 'artist';

export const policySchema = z.strictObject({
  maxActiveCycles: z.number().int().min(1).max(3),
  maxRevisions: z.number().int().min(0).max(5),
  maxCallsPerCycle: z.number().int().min(1).max(100),
  maxCallsPerDay: z.number().int().min(1).max(1000),
  maxOutputTokens: z.number().int().min(100).max(16000),
  maxInputBytes: z.number().int().min(1000).max(200000),
  maxAttemptsPerStage: z.number().int().min(1).max(5),
  callTimeoutMs: z.number().int().min(100).max(300000),
  leaseMs: z.number().int().min(500).max(600000),
}).refine(p => p.leaseMs > p.callTimeoutMs, 'Lease must exceed model timeout');
export type Policy = z.infer<typeof policySchema>;

export const observationSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  stream: z.enum(['world', 'interest', 'reception', 'customer', 'usage']),
  kind: z.enum(['source', 'studio_note', 'fixture']),
  visibility: z.enum(['public', 'private']).default('public'),
  title: z.string().min(1).max(300), text: z.string().min(1).max(8000),
  url: z.string().url().nullable(), observedAt: z.string().datetime(),
}).refine(o => o.kind !== 'source' || (o.url !== null && /^https?:\/\//.test(o.url)),
  'External source observations need an HTTP(S) source URL');
export const observationsSchema = z.array(observationSchema).max(20)
  .refine(items => new Set(items.map(o => o.id)).size === items.length, 'Observation IDs must be unique');
export type Observation = z.infer<typeof observationSchema>;

export const researchSchema = z.strictObject({
  summary: prose,
  findings: z.array(z.strictObject({ observationId: z.string(), interpretation: prose })).max(12),
  uncertainties: z.array(prose).max(8),
  reception: z.enum(['none_observed', 'observed']),
});
export const proposalSchema = z.strictObject({
  action: z.enum(['make', 'abstain']), rationale: prose,
  title: z.string().min(1).max(160),
  medium: z.enum(['typographic-poster', 'instruction-score']),
  concept: prose, materialReason: prose, withoutAudience: prose, abandonIf: prose,
  sourceIds: z.array(z.string()).max(20), previousWorkIds: z.array(z.string()).max(10),
});
export const artworkSchema = z.strictObject({
  title: z.string().min(1).max(160), statement: prose,
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  foreground: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  alignment: z.enum(['left', 'center']),
  lines: z.array(z.strictObject({
    text: z.string().min(1).max(72),
    emphasis: z.enum(['quiet', 'normal', 'strong']),
  })).min(1).max(14),
});
export const critiqueSchema = z.strictObject({
  inspectedArtifactHash: z.string(),
  recommendation: z.enum(['accept', 'revise', 'reject']),
  reading: prose, strengths: z.array(prose).max(6),
  weaknesses: z.array(prose).max(6), revisionInstructions: z.array(prose).max(6),
});
export const decisionSchema = z.strictObject({
  action: z.enum(['accept', 'revise', 'reject']), rationale: prose,
  revisionInstructions: z.array(prose).max(6),
});
export const reflectionSchema = z.strictObject({
  learning: prose, unresolvedQuestion: prose,
  nextExperiment: prose, identityChangeProposed: prose.nullable(),
});

export const founderResearchSchema = z.strictObject({
  summary: prose,
  findings: z.array(z.strictObject({ observationId: z.string(), interpretation: prose })).max(12),
  uncertainties: z.array(prose).max(8),
  evidenceLevel: z.enum(['hypothesis_only', 'source_reports']),
  reportedProblemSourceIds: z.array(z.string()).max(20),
});
export const founderProposalSchema = z.strictObject({
  action: z.enum(['make', 'abstain']), rationale: prose,
  title: z.string().min(1).max(160), targetAudience: prose, problem: prose,
  hypothesis: prose, smallestTest: prose,
  successCriterion: z.strictObject({ metric: prose, target: z.number().positive().max(1000000),
    unit: z.string().min(1).max(80), windowDays: z.number().int().min(1).max(365) }),
  stopCondition: prose, maintenancePlan: prose,
  sourceIds: z.array(z.string()).max(20), previousWorkIds: z.array(z.string()).max(10),
});
export const experimentSchema = z.strictObject({
  title: z.string().min(1).max(160), summary: prose,
  prototypeBehavior: z.array(prose).min(1).max(8),
  testSteps: z.array(prose).min(1).max(10),
  acceptanceChecks: z.array(prose).min(1).max(8),
  recruitingPlan: prose, instrumentation: prose, supportPlan: prose,
  limitations: z.array(prose).min(1).max(8),
});

export const stages = ['research', 'propose', 'make', 'render', 'critique', 'decide', 'release', 'reflect', 'done'] as const;
export type Stage = typeof stages[number];
export type AgentStage = 'research' | 'propose' | 'make' | 'critique' | 'decide' | 'reflect';
export const agentSchemas = {
  research: researchSchema, propose: proposalSchema, make: artworkSchema,
  critique: critiqueSchema, decide: decisionSchema, reflect: reflectionSchema,
} as const;
export const founderAgentSchemas = {
  research: founderResearchSchema, propose: founderProposalSchema, make: experimentSchema,
  critique: critiqueSchema, decide: decisionSchema, reflect: reflectionSchema,
} as const;
export const schemasFor = (profile: Profile) => isFounder(profile) ? founderAgentSchemas : agentSchemas;
export type ProviderName = 'fixture' | 'openai';
export type Result = Record<string, unknown>;
export type Cycle = {
  id: string; triggerKey: string; provider: ProviderName; model: string | null;
  profile: Profile; policy: Policy; observations: Observation[];
  memory: Memory[]; stage: Stage; revision: number;
  recalledMemories: Array<{ id: string; kind: string; content: string; sourceIds: string[]; supersedes: string | null }>;
  status: 'active' | 'released' | 'abstained' | 'rejected' | 'failed';
  outcome: 'released' | 'abstained' | 'rejected' | null;
  createdAt: string; updatedAt: string; lastError: string | null;
};
export type Memory = {
  id: string; title: string; outcome: string; concept: string;
  reflection: Result | null;
};
export type Artifact = {
  hash: string; pngHash: string; svgHash: string; directory: string;
  png: string; svg: string; spec: string; width: number; height: number;
};
export type FounderArtifact = {
  kind: 'experiment-package'; hash: string; documentHash: string;
  directory: string; document: string; spec: string;
};
export type StudioArtifact = Artifact | FounderArtifact;
export const isFounderArtifact = (artifact: StudioArtifact): artifact is FounderArtifact => 'kind' in artifact && artifact.kind === 'experiment-package';
export type AgentRequest = {
  stage: AgentStage; cycle: Cycle; context: Record<string, unknown>;
  image?: { base64: string; hash: string };
};
export type AgentResponse = { output: unknown; inputTokens: number | null; outputTokens: number | null; responseId: string | null };
export interface AgentProvider {
  name: ProviderName;
  model: string | null;
  generate(request: AgentRequest, signal: AbortSignal): Promise<AgentResponse>;
}
export class StudioError extends Error {}
export class PausedError extends StudioError {}
export class BusyError extends StudioError {}
export class BudgetError extends StudioError {}
export class AttemptLimitError extends StudioError {}
