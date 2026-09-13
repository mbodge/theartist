import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { immutableWrite } from './artifacts.js';
import { hash } from './store.js';
import {
  experimentSchema, founderProposalSchema, StudioError,
  isFounder, type AgentRequest, type AgentStage, type Cycle, type FounderArtifact, type Result,
} from './domain.js';

export const founderInstructions: Record<AgentStage, string> = {
  research: `You are the founder's researcher. Summarize only supplied observations; you have no browsing or interview tool. Distinguish customer/usage source reports from founder ideas and fixtures. Only real source observations in customer or usage streams may appear in reportedProblemSourceIds. They are reports, not independently verified demand. Use hypothesis_only when there are none. Interpret evidence in relation to this founder's mission, which need not concern software.`,
  propose: `You are the configured founder. Pursue the mission and venture type in your profile; do not assume an app, SaaS company, or particular industry. Form one falsifiable hypothesis for the intended audience, or abstain. Propose the smallest useful experiment, a specific metric with target and time window, a stop condition, and a maintenance commitment. When abstaining, set successCriterion to null; do not invent a metric for an experiment that does not exist. A make proposal requires a non-null successCriterion. Do not claim validation. This workshop can produce a local experiment package, not launch an initiative. Only cite supplied source IDs and previous cycle IDs.`,
  make: `You are the founder's experiment designer. Turn the proposal into a concrete experiment package for this venture: intended prototype or pilot behavior, ordered test steps, acceptance checks, recruiting and instrumentation plans, support responsibilities, and limitations. No outreach or execution has occurred. Do not replace the founder's metric, target, or stop condition; they remain fixed in the proposal. Incorporate recorded revision instructions.`,
  critique: `You are the independent venture reviewer. Inspect the complete experiment document in context.artifactDocument. Assess whether the test can falsify the hypothesis, its scope, evidence gaps, and maintenance burden. Copy the artifact hash to inspectedArtifactHash. Acceptance means ready for a future experiment, never proven demand or an initiative already launched.`,
  decide: `You are the founder reviewing the experiment package and independent critique. Accept it for a future experiment, request a bounded revision, or reject. There is no launch or revenue tool. Do not mistake a local package for validated demand. At the revision limit choose acceptance or rejection.`,
  reflect: `You are the founder maintaining a persistent venture history. Record what was learned about experiment design, what remains untested, and the next question. Keep fixture and real evidence distinct. No experiment was actually executed by this workflow. identityChangeProposed may suggest a founder-thesis change but does not apply it.`,
};

export function founderFixture(request: AgentRequest): unknown {
  const { cycle, stage, context } = request;
  if (!isFounder(cycle.profile)) throw new StudioError('Founder fixture requires a founder profile');
  const realReports = cycle.observations.filter(o => o.kind === 'source' && ['customer', 'usage'].includes(o.stream));
  const previous = cycle.memory.at(-1);
  const title = `First experiment: ${cycle.profile.name}`;
  const outputs: Record<AgentStage, unknown> = {
    research: {
      summary: 'Synthetic briefing for the configured founder mission. No market research was performed.',
      findings: cycle.observations.map(o => ({ observationId: o.id, interpretation: `Fixture interpretation of supplied input: ${o.title}` })),
      uncertainties: ['The problem frequency, customer group, and willingness to change behavior are unverified.'],
      evidenceLevel: realReports.length ? 'source_reports' : 'hypothesis_only',
      reportedProblemSourceIds: realReports.map(o => o.id),
    },
    propose: {
      action: 'make', rationale: 'Design a cheap falsifiable test of the fictional workflow problem.', title,
      targetAudience: cycle.profile.audience,
      problem: `The need addressed by this mission remains untested: ${cycle.profile.mandate.slice(0, 1800)}`,
      hypothesis: 'A small facilitated pilot may establish whether the intended audience can achieve a useful outcome related to the mission.',
      smallestTest: 'Facilitate one representative audience activity manually before committing to a full venture.',
      successCriterion: { metric: 'Participants completing the agreed activity without facilitator intervention', target: 3, unit: 'participants out of 5 recruited', windowDays: 7 },
      stopCondition: 'Stop if the need is not recurring or fewer than three of five participants complete the activity.',
      maintenancePlan: 'Assign an owner for feedback triage and delete test data after the agreed retention period.',
      sourceIds: cycle.observations.map(o => o.id), previousWorkIds: previous ? [previous.id] : [],
    },
    make: {
      title, summary: 'A synthetic experiment design. There are no real participants, measured results, or deployed software.',
      prototypeBehavior: ['Specify one audience activity related to the founder mission.', 'Provide the minimum manual pilot needed to attempt that activity.'],
      testSteps: ['Obtain agreement from five relevant participants for a future test.', 'Define one representative activity and a clear completion condition.', 'Observe each participant attempt the activity.', 'Record outcomes against the original criterion.'],
      acceptanceChecks: ['The activity has a clear completion condition.', 'The observer can tell whether facilitator intervention was needed.'],
      recruitingPlan: 'Prepare a recruitment brief for the owner; no outreach is sent by this harness.',
      instrumentation: 'Record participant pseudonym, completion, and facilitator intervention. Keep personal information private.',
      supportPlan: 'One person owns questions during the seven-day test; no live service is promised.',
      limitations: ['Customer group is provisional.', 'Fixture inputs are not validation.', 'This package does not contain executable software.'],
    },
    critique: {
      inspectedArtifactHash: String((context.artifact as { hash?: string } | undefined)?.hash ?? ''),
      recommendation: 'accept', reading: 'Synthetic reviewer fixture: the package specifies a bounded future test, not a completed experiment.',
      strengths: ['A pass threshold and stop condition are fixed before data collection.'],
      weaknesses: ['The fictional customer problem still requires real discovery.'], revisionInstructions: [],
    },
    decide: { action: 'accept', rationale: 'Accept the fixture package as an unvalidated experiment design.', revisionInstructions: [] },
    reflect: {
      learning: 'The studio can retain a hypothesis, predeclared criterion, and test design without claiming measured success.',
      unresolvedQuestion: 'Does a real customer have this problem frequently enough to change their workflow?',
      nextExperiment: previous ? `Refine the untested assumption from ${previous.title}.` : 'Collect actual problem reports from a chosen customer group.',
      identityChangeProposed: null,
    },
  };
  return outputs[stage];
}

// Prevent generated text from becoming active HTML, links, or embedded resources in Markdown viewers.
const md = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('\\', '\\\\').replace(/([`*_{}\[\]()#!|])/g, '\\$1');

export async function renderExperiment(root: string, proposalOutput: Result, makerOutput: Result): Promise<FounderArtifact> {
  const proposal = founderProposalSchema.parse(proposalOutput), experiment = experimentSchema.parse(makerOutput);
  if (proposal.action !== 'make' || proposal.successCriterion === null) throw new StudioError('Only experiment proposals with a success criterion can be rendered');
  const spec = JSON.stringify({ renderer: 'experiment-package-v1', validationStatus: 'unvalidated', proposal, experiment });
  const digest = hash(spec), directory = join('artifacts', digest);
  await mkdir(join(root, directory), { recursive: true });
  const list = (items: string[]) => items.map(item => `- ${md(item)}`).join('\n');
  const document = [
    `# ${md(experiment.title)}`, '**Status: unvalidated experiment package. No initiative has been launched and no test results are claimed.**',
    '## Audience and problem', md(proposal.targetAudience), md(proposal.problem),
    '## Hypothesis', md(proposal.hypothesis), '## Smallest test', md(proposal.smallestTest),
    '## Criterion recorded before execution', `${md(proposal.successCriterion.metric)}: ${proposal.successCriterion.target} ${md(proposal.successCriterion.unit)} within ${proposal.successCriterion.windowDays} days.`,
    '## Stop condition', md(proposal.stopCondition), '## Intended prototype behavior', list(experiment.prototypeBehavior),
    '## Test procedure', list(experiment.testSteps), '## Acceptance checks', list(experiment.acceptanceChecks),
    '## Recruitment plan', md(experiment.recruitingPlan), '## Instrumentation plan', md(experiment.instrumentation),
    '## Maintenance and support', md(proposal.maintenancePlan), md(experiment.supportPlan),
    '## Limitations', list(experiment.limitations),
  ].join('\n\n') + '\n';
  const artifact: FounderArtifact = { kind: 'experiment-package', hash: digest, documentHash: hash(document), directory,
    document: join(directory, 'experiment.md'), spec: join(directory, 'spec.json') };
  await immutableWrite(join(root, artifact.document), document);
  await immutableWrite(join(root, artifact.spec), spec);
  return artifact;
}

export async function inspectExperiment(root: string, artifact: FounderArtifact): Promise<string> {
  for (const file of [artifact.document, artifact.spec]) {
    if (!resolve(root, file).startsWith(resolve(root) + sep)) throw new StudioError('Experiment path escaped studio storage');
  }
  const document = await readFile(join(root, artifact.document), 'utf8');
  if (hash(document) !== artifact.documentHash || hash(await readFile(join(root, artifact.spec))) !== artifact.hash) {
    throw new StudioError('Experiment integrity check failed');
  }
  return document;
}

export async function releaseExperiment(root: string, cycle: Cycle, artifact: FounderArtifact, proposal: Result, maker: Result): Promise<Result> {
  await inspectExperiment(root, artifact);
  const manifest = { id: cycle.id, title: maker.title, studio: 'founder', medium: 'experiment-package',
    status: 'local-release', validationStatus: 'unvalidated', launchStatus: 'not-launched',
    provider: cycle.provider, fixture: cycle.provider === 'fixture', founder: cycle.profile.name,
    profileVersion: cycle.profile.version, artifact, sourceIds: proposal.sourceIds,
    previousWorkIds: proposal.previousWorkIds, successCriterion: proposal.successCriterion, stopCondition: proposal.stopCondition };
  const directory = join(root, 'releases', cycle.id);
  await mkdir(directory, { recursive: true });
  await immutableWrite(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
