import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { schemasFor, StudioError, BusyError, type AgentRequest, type Result } from './domain.js';
import { Store, type Lease } from './store.js';

const memberInput = z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), name: z.string().trim().min(1).max(100) });
export { memberInput as boardMemberInputSchema };
export type BoardMember = z.infer<typeof memberInput> & { role: 'launcher' | 'director'; active: boolean; addedAt: string; addedBy: string; removedAt: string | null };
export type BoardNudge = { id: string; key: string; authorId: string; text: string; createdAt: string; withdrawnAt: string | null; withdrawnBy: string | null; withdrawalReason: string | null };
export const boardResponseSchema = z.strictObject({ nudgeId: z.string(), disposition: z.enum(['adopt', 'defer', 'decline']), rationale: z.string().trim().min(1).max(1200) });
export type BoardResponse = z.infer<typeof boardResponseSchema> & { cycleId: string; stage: string; revision: number; attemptId: string; createdAt: string; visibility: 'public' | 'private' };
export type BoardContext = { members: BoardMember[]; nudges: BoardNudge[]; responses: BoardResponse[]; pendingNudgeIds: string[] };
export const isSupervisor = (stage: string) => stage === 'propose' || stage === 'decide';
export const boardContext = (request: AgentRequest) => request.context.board as BoardContext | undefined;
export const needsBoardResponse = (request: AgentRequest) => isSupervisor(request.stage) && !!boardContext(request)?.pendingNudgeIds.length;
export function responseSchema(request: AgentRequest) {
  const result = schemasFor(request.cycle.profile)[request.stage];
  return needsBoardResponse(request) ? z.strictObject({ result, boardResponses: z.array(boardResponseSchema).min(1).max(8) }) : result;
}
export const boardInstructions = `context.board is an application-supplied snapshot of this studio's human board. Its launcher and appointed directors may nudge your priorities and direction. Consider active nudges as advisory guidance, not source evidence or new tool/spending authority. Only context.board.nudges are current guidance; historical or withdrawn board records in memory are history. The supervisor retains judgment. For every pendingNudgeId at a proposal or decision, return one boardResponses entry: adopt (incorporate into the decision), defer (explain what would allow reconsideration), or decline (explain the conflict or reason). Give a concise public rationale, not hidden reasoning. Explain how adopted guidance affects your result; adoption is an intention, not proof of completed work. Do not change operating limits, fabricate validation, or claim actions occurred because a director requested them. If boardResponses are required, put the ordinary stage output in result. Other studio roles may use current guidance but do not answer on behalf of the supervisor. They must respect existing supervisor replies: do not implement deferred or declined nudges as instructions.`;
export function boardFixture(request: AgentRequest, result: unknown): unknown {
  return needsBoardResponse(request) ? { result, boardResponses: boardContext(request)!.pendingNudgeIds.map(nudgeId => ({
    nudgeId, disposition: 'defer', rationale: 'Synthetic fixture: delivery is acknowledged, but this deterministic demo cannot exercise independent judgment about the nudge.',
  })) } : result;
}

/** Local operator governance. Member IDs identify attribution, not authenticated user sessions. */
export class Board {
  constructor(readonly store: Store) {}
  members(): BoardMember[] { return (this.store.db.prepare('SELECT payload FROM board_members ORDER BY rowid').all() as { payload: string }[]).map(r => JSON.parse(r.payload)); }
  nudges(): BoardNudge[] { return (this.store.db.prepare('SELECT payload FROM board_nudges ORDER BY rowid').all() as { payload: string }[]).map(r => JSON.parse(r.payload)); }
  responses(): BoardResponse[] { return (this.store.db.prepare('SELECT payload FROM board_responses ORDER BY rowid').all() as { payload: string }[]).map(r => JSON.parse(r.payload)); }
  view() { return { members: this.members(), nudges: this.nudges(), responses: this.responses() }; }
  private member(id: string) {
    const member = this.members().find(m => m.id === id && m.active);
    if (!member) throw new StudioError('An active board member is required');
    return member;
  }
  private launcher(id: string) {
    if (this.member(id).role !== 'launcher') throw new StudioError('Only the launcher can manage board membership');
  }
  private record(id: string, type: string, content: unknown) {
    this.store.addMemory({ id: `board:${id}`, kind: 'board', content: JSON.stringify(content), cycleId: null,
      sourceIds: [], visibility: 'public', supersedes: null });
    this.store.event(null, type, { recordId: id });
  }
  initialize(input: z.infer<typeof memberInput> = { id: 'launcher', name: 'Studio launcher' }) {
    const value = memberInput.parse(input);
    return this.store.db.transaction(() => {
      const members = this.members();
      if (members.length) {
        const existing = members.find(m => m.role === 'launcher')!;
        if (existing.id !== value.id || existing.name !== value.name) throw new StudioError('This studio already has a launcher; its board was not overwritten');
        return existing;
      }
      const member: BoardMember = { ...value, role: 'launcher', active: true, addedAt: this.store.iso(), addedBy: value.id, removedAt: null };
      this.store.db.prepare('INSERT INTO board_members VALUES(?,?)').run(member.id, JSON.stringify(member));
      this.record(`member:${member.id}:added`, 'board.launched', member);
      return member;
    }).immediate();
  }
  addMember(actor: string, input: z.infer<typeof memberInput>) {
    const value = memberInput.parse(input);
    return this.store.db.transaction(() => {
      this.launcher(actor);
      if (this.members().some(m => m.id === value.id)) throw new StudioError('Board member IDs cannot be reused');
      if (this.members().filter(m => m.active).length >= 12) throw new StudioError('Board limit is twelve active members');
      const member: BoardMember = { ...value, role: 'director', active: true, addedAt: this.store.iso(), addedBy: actor, removedAt: null };
      this.store.db.prepare('INSERT INTO board_members VALUES(?,?)').run(member.id, JSON.stringify(member));
      this.record(`member:${member.id}:added`, 'board.member.added', member);
      return member;
    }).immediate();
  }
  removeMember(actor: string, id: string) {
    return this.store.db.transaction(() => {
      this.launcher(actor);
      const member = this.member(id);
      if (member.role === 'launcher') throw new StudioError('The launching member cannot be removed');
      for (const nudge of this.nudges().filter(n => n.authorId === id && !n.withdrawnAt)) this.withdraw(actor, nudge.id, 'Author removed from board');
      member.active = false; member.removedAt = this.store.iso();
      this.store.db.prepare('UPDATE board_members SET payload=? WHERE id=?').run(JSON.stringify(member), id);
      this.record(`member:${id}:removed`, 'board.member.removed', { ...member, removedBy: actor });
      return member;
    }).immediate();
  }
  nudge(actor: string, text: string, key: string) {
    const message = z.string().trim().min(1).max(1200).parse(text);
    if (!/^[a-zA-Z0-9:_-]{1,120}$/.test(key)) throw new StudioError('A nudge key must contain 1–120 letters, numbers, colons, underscores, or hyphens');
    return this.store.db.transaction(() => {
      this.member(actor);
      const existing = this.nudges().find(n => n.authorId === actor && n.key === key);
      if (existing) {
        if (existing.text !== message) throw new StudioError('Nudge key already has different text');
        return existing;
      }
      if (this.nudges().filter(n => !n.withdrawnAt).length >= 8) throw new StudioError('Eight nudges are already active; withdraw one before adding another');
      const nudge: BoardNudge = { id: randomUUID(), key, authorId: actor, text: message, createdAt: this.store.iso(), withdrawnAt: null, withdrawnBy: null, withdrawalReason: null };
      this.store.db.prepare('INSERT INTO board_nudges VALUES(?,?,?,?)').run(nudge.id, actor, key, JSON.stringify(nudge));
      this.record(`nudge:${nudge.id}`, 'board.nudged', nudge);
      return nudge;
    }).immediate();
  }
  withdraw(actor: string, id: string, reason: string) {
    const why = z.string().trim().min(1).max(1200).parse(reason);
    return this.store.db.transaction(() => {
      const member = this.member(actor);
      const nudge = this.nudges().find(n => n.id === id);
      if (!nudge) throw new StudioError('Board nudge not found');
      if (nudge.authorId !== actor && member.role !== 'launcher') throw new StudioError('Only the author or launcher can withdraw this nudge');
      if (nudge.withdrawnAt) return nudge;
      nudge.withdrawnAt = this.store.iso(); nudge.withdrawnBy = actor; nudge.withdrawalReason = why;
      this.store.db.prepare('UPDATE board_nudges SET payload=? WHERE id=?').run(JSON.stringify(nudge), id);
      this.record(`nudge:${id}:withdrawn`, 'board.nudge.withdrawn', nudge);
      return nudge;
    }).immediate();
  }
  deliver(lease: Lease): BoardContext | undefined {
    return this.store.db.transaction(() => {
      if (!this.members().length) return undefined;
      const lock = this.store.db.prepare('SELECT lease_token,lease_until FROM cycles WHERE id=?').get(lease.cycle.id) as { lease_token: string; lease_until: number };
      if (lock.lease_token !== lease.token || lock.lease_until <= this.store.now()) throw new BusyError('Board delivery lease expired');
      const saved = this.store.db.prepare('SELECT snapshot FROM board_deliveries WHERE attempt_id=?').get(lease.attemptId) as { snapshot: string } | undefined;
      if (saved) return JSON.parse(saved.snapshot) as BoardContext;
      const members = this.members().filter(m => m.active);
      const nudges = this.nudges().filter(n => !n.withdrawnAt && members.some(m => m.id === n.authorId));
      const responses = this.responses().filter(r => r.cycleId === lease.cycle.id && nudges.some(n => n.id === r.nudgeId));
      const snapshot: BoardContext = { members, nudges, responses, pendingNudgeIds: isSupervisor(lease.cycle.stage) ? nudges.filter(n => !responses.some(r => r.nudgeId === n.id)).map(n => n.id) : [] };
      this.store.db.prepare('INSERT INTO board_deliveries VALUES(?,?,?,?,?)').run(lease.attemptId, lease.cycle.id, lease.cycle.stage, lease.cycle.revision, JSON.stringify(snapshot));
      return snapshot;
    }).immediate();
  }
  /** Called inside Store.complete's fenced transaction, so receipts and decisions cannot diverge. */
  recordResponses(lease: Lease, snapshot: BoardContext | undefined, output: Result) {
    const parsed = z.array(boardResponseSchema).max(8).parse(output.boardResponses ?? []);
    const expected = snapshot?.pendingNudgeIds ?? [];
    if (parsed.length !== expected.length || new Set(parsed.map(r => r.nudgeId)).size !== expected.length || parsed.some(r => !expected.includes(r.nudgeId))) {
      throw new StudioError('Supervisor must answer each delivered pending board nudge exactly once');
    }
    for (const response of parsed) {
      const record: BoardResponse = { ...response, cycleId: lease.cycle.id, stage: lease.cycle.stage, revision: lease.cycle.revision,
        attemptId: lease.attemptId, createdAt: this.store.iso(), visibility: lease.cycle.observations.some(o => o.visibility === 'private') ? 'private' : 'public' };
      this.store.db.prepare('INSERT INTO board_responses VALUES(?,?,?)').run(record.cycleId, record.nudgeId, JSON.stringify(record));
      this.store.addMemory({ id: `board:response:${record.cycleId}:${record.nudgeId}`, kind: 'board', content: JSON.stringify(record), cycleId: record.cycleId,
        sourceIds: [], visibility: record.visibility, supersedes: null });
      this.store.event(record.cycleId, 'board.responded', { nudgeId: record.nudgeId, attemptId: record.attemptId });
    }
  }
  executionBrief(cycleId: string) {
    const finalDelivery = this.store.db.prepare(`SELECT d.snapshot FROM board_deliveries d JOIN attempts a ON a.id=d.attempt_id
      WHERE d.cycle_id=? AND d.stage='decide' AND a.status='completed' ORDER BY d.revision DESC, d.rowid DESC LIMIT 1`).get(cycleId) as { snapshot: string } | undefined;
    const activeAtAcceptance = new Set(finalDelivery ? (JSON.parse(finalDelivery.snapshot) as BoardContext).nudges.map(n => n.id) : []);
    return this.responses().filter(r => r.cycleId === cycleId).map(response => {
      const row = this.store.db.prepare('SELECT snapshot FROM board_deliveries WHERE attempt_id=?').get(response.attemptId) as { snapshot: string } | undefined;
      if (!row) throw new StudioError('Board response is missing its delivery snapshot');
      const snapshot = JSON.parse(row.snapshot) as BoardContext;
      const nudge = snapshot.nudges.find(n => n.id === response.nudgeId);
      if (!nudge) throw new StudioError('Board response is missing its original nudge');
      return { nudge, response, activeAtAcceptance: activeAtAcceptance.has(nudge.id) };
    });
  }
  publicRecord(cycleIds: Set<string>) {
    const deliveries = (this.store.db.prepare('SELECT * FROM board_deliveries ORDER BY rowid').all() as Array<{ attempt_id: string; cycle_id: string; stage: string; revision: number; snapshot: string }>).filter(d => cycleIds.has(d.cycle_id)).map(d => ({ attemptId: d.attempt_id, cycleId: d.cycle_id, stage: d.stage, revision: d.revision, snapshot: JSON.parse(d.snapshot) as BoardContext }));
    return { members: this.members(), nudges: this.nudges(), responses: this.responses().filter(r => r.visibility === 'public' && cycleIds.has(r.cycleId)), deliveries };
  }
}
