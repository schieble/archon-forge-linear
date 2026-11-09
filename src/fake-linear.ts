/**
 * An in-memory Linear for tests. Like the real one (probes/linear-markdown-probe.sh), it
 * stores comments exactly but rewrites issue descriptions; here the rewrite is the one the
 * probe saw first: a blank line after the first line, and `-` bullets become `*`.
 */
import { LinearRefusal } from './linear.ts';
import type {
  IssueUpdate,
  LinearApi,
  LinearComment,
  LinearIssue,
  LinearLabel,
  LinearState,
  LinearTeam,
  LinearUser,
} from './linear.ts';

export function linearRewrite(description: string): string {
  const [first, ...rest] = description.split('\n');
  const body = rest.join('\n').replace(/^- /gm, '* ');
  return rest.length === 0 || rest[0] === '' ? `${first}\n${body}` : `${first}\n\n${body}`;
}

export const DON: LinearUser = { id: 'user-don', displayName: 'don' };

const STATES: LinearState[] = [
  { id: 'state-backlog', type: 'backlog', name: 'Backlog' },
  { id: 'state-todo', type: 'unstarted', name: 'Todo' },
  { id: 'state-done', type: 'completed', name: 'Done' },
  { id: 'state-canceled', type: 'canceled', name: 'Canceled' },
  { id: 'state-duplicate', type: 'canceled', name: 'Duplicate' },
];

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface StoredIssue extends Mutable<Omit<LinearIssue, 'labels' | 'state'>> {
  labelIds: string[];
  stateId: string;
  trashed: boolean;
}

export class FakeLinear implements LinearApi {
  readonly calls: string[] = [];
  private seq = 0;
  private readonly teams = new Map<string, { id: string; key: string; labels: LinearLabel[] }>();
  private readonly stored: StoredIssue[] = [];
  private readonly commentsOf = new Map<string, (Mutable<LinearComment> & { at: number })[]>();
  /**
   * When set, the next write fails: `refuse` as Linear refusing it (nothing written), `lost` as
   * a write that was applied but whose answer never arrived.
   */
  failNext: 'refuse' | 'lost' | null = null;
  /** Runs as a write begins: another writer acting at the same moment. */
  onWrite: (() => void) | null = null;
  /** When set, the next read fails. */
  failNextRead = false;
  /** When set, the next description write is stored as this text instead (a racing editor). */
  raceDescription: string | null = null;

  constructor(readonly organization = 'acme') {}

  addTeam(key: string, labels: readonly string[] = []): void {
    const id = `team-${key}`;
    this.teams.set(key, {
      id,
      key,
      labels: labels.map(name => ({ id: `label-${name}`, name, color: '#bbbbbb', description: null })),
    });
  }

  addIssue(teamKey: string, fields: Partial<Omit<StoredIssue, 'teamKey'>> & { labels?: string[] } = {}): LinearIssue {
    const team = this.requireTeam(teamKey);
    const number = fields.number ?? this.stored.filter(issue => issue.teamKey === teamKey).length + 1;
    const issue: StoredIssue = {
      id: `issue-${teamKey}-${number}`,
      number,
      teamKey,
      url: `https://linear.app/${this.organization}/issue/${teamKey}-${number}/slug`,
      title: fields.title ?? `Issue ${number}`,
      description: fields.description ?? '',
      creator: fields.creator === undefined ? DON : fields.creator,
      stateId: fields.stateId ?? 'state-backlog',
      trashed: fields.trashed ?? false,
      labelIds: (fields.labels ?? []).map(name => {
        const label = team.labels.find(candidate => candidate.name === name);
        if (!label) throw new Error(`fake: no label ${name}`);
        return label.id;
      }),
    };
    this.stored.push(issue);
    return this.view(issue);
  }

  addComment(issue: LinearIssue, body: string, user: LinearUser | null = DON): LinearComment {
    const comment = { id: `comment-${++this.seq}`, body, url: `${issue.url}#comment-${this.seq}`, user, at: this.seq };
    this.commentsOf.set(issue.id, [...(this.commentsOf.get(issue.id) ?? []), comment]);
    return comment;
  }

  /** Another writer adding a label, outside the plugin. */
  labelIssue(teamKey: string, number: number, name: string): void {
    const issue = this.stored.find(candidate => candidate.teamKey === teamKey && candidate.number === number);
    const label = this.requireTeam(teamKey).labels.find(candidate => candidate.name === name);
    if (!issue || !label) throw new Error('fake: no such issue or label');
    if (!issue.labelIds.includes(label.id)) issue.labelIds.push(label.id);
  }

  async team(key: string): Promise<LinearTeam | null> {
    this.reading();
    this.calls.push(`team ${key}`);
    const team = this.teams.get(key);
    return team ? { ...team, organization: this.organization, labels: [...team.labels], states: STATES } : null;
  }

  async issue(teamKey: string, number: number): Promise<LinearIssue | null> {
    this.reading();
    this.calls.push(`issue ${teamKey}-${number}`);
    const issue = this.live(teamKey).find(candidate => candidate.number === number);
    return issue ? this.view(issue) : null;
  }

  async openIssuesWithLabel(teamKey: string, label: string): Promise<readonly LinearIssue[]> {
    this.reading();
    this.calls.push(`openIssuesWithLabel ${teamKey} ${label}`);
    return this.live(teamKey)
      .map(issue => this.view(issue))
      .filter(issue => issue.labels.includes(label) && issue.state.type !== 'completed' && issue.state.type !== 'canceled');
  }

  async issuesStartingWith(teamKey: string, prefix: string): Promise<readonly LinearIssue[]> {
    this.reading();
    this.calls.push(`issuesStartingWith ${teamKey}`);
    return this.live(teamKey).filter(issue => issue.description.startsWith(prefix)).map(issue => this.view(issue));
  }

  async addLabel(issueId: string, labelId: string): Promise<void> {
    const lost = this.failing();
    this.calls.push(`addLabel ${issueId} ${labelId}`);
    const issue = this.stored.find(candidate => candidate.id === issueId);
    if (!issue) throw new Error(`fake: no issue ${issueId}`);
    if (!issue.labelIds.includes(labelId)) issue.labelIds.push(labelId);
    lost();
  }

  async removeLabel(issueId: string, labelId: string): Promise<void> {
    const lost = this.failing();
    this.calls.push(`removeLabel ${issueId} ${labelId}`);
    const issue = this.stored.find(candidate => candidate.id === issueId);
    if (!issue) throw new Error(`fake: no issue ${issueId}`);
    issue.labelIds = issue.labelIds.filter(id => id !== labelId);
    lost();
  }

  async createIssue(teamId: string, title: string, description: string): Promise<LinearIssue> {
    const lost = this.failing();
    this.calls.push(`createIssue ${teamId}`);
    const team = [...this.teams.values()].find(candidate => candidate.id === teamId);
    if (!team) throw new Error(`fake: no team ${teamId}`);
    const created = this.addIssue(team.key, { title, description: linearRewrite(description) });
    lost();
    return created;
  }

  async updateIssue(id: string, update: IssueUpdate): Promise<LinearIssue> {
    const lost = this.failing();
    this.calls.push(`updateIssue ${id} ${Object.keys(update).join(',')}`);
    const issue = this.stored.find(candidate => candidate.id === id);
    if (!issue) throw new Error(`fake: no issue ${id}`);
    const returned: StoredIssue = { ...issue };
    if (update.description !== undefined) returned.description = linearRewrite(update.description);
    if (update.labelIds !== undefined) returned.labelIds = [...update.labelIds];
    if (update.stateId !== undefined) returned.stateId = update.stateId;
    Object.assign(issue, returned);
    if (update.description !== undefined && this.raceDescription !== null) {
      issue.description = this.raceDescription;
      this.raceDescription = null;
    }
    lost();
    return this.view(returned);
  }

  async comments(issueId: string): Promise<readonly LinearComment[]> {
    this.calls.push(`comments ${issueId}`);
    return (this.commentsOf.get(issueId) ?? []).map(({ at: _at, ...comment }) => comment);
  }

  async createComment(issueId: string, body: string): Promise<LinearComment> {
    const lost = this.failing();
    this.calls.push(`createComment ${issueId}`);
    const issue = this.stored.find(candidate => candidate.id === issueId);
    if (!issue) throw new Error(`fake: no issue ${issueId}`);
    const { at: _at, ...comment } = this.addComment(this.view(issue), body) as LinearComment & { at: number };
    lost();
    return comment;
  }

  async updateComment(id: string, body: string): Promise<LinearComment> {
    const lost = this.failing();
    this.calls.push(`updateComment ${id}`);
    for (const list of this.commentsOf.values()) {
      const comment = list.find(candidate => candidate.id === id);
      if (comment) {
        comment.body = body;
        lost();
        const { at: _at, ...rest } = comment;
        return rest;
      }
    }
    throw new Error(`fake: no comment ${id}`);
  }

  async createLabel(teamId: string, name: string, color: string, description: string): Promise<LinearLabel> {
    const lost = this.failing();
    this.calls.push(`createLabel ${name}`);
    const team = [...this.teams.values()].find(candidate => candidate.id === teamId);
    if (!team) throw new Error(`fake: no team ${teamId}`);
    const label = { id: `label-${name}`, name, color, description };
    team.labels.push(label);
    lost();
    return label;
  }

  /** Throws for a `refuse`; for a `lost`, returns a function that throws after the write is applied. */
  private failing(): () => void {
    const mode = this.failNext;
    this.failNext = null;
    const concurrent = this.onWrite;
    this.onWrite = null;
    concurrent?.();
    if (mode === 'refuse') throw new LinearRefusal('Linear refused the write');
    return mode === 'lost' ? () => { throw new Error('socket hang up'); } : () => {};
  }

  private reading(): void {
    if (!this.failNextRead) return;
    this.failNextRead = false;
    throw new Error('fake: read failed');
  }

  private live(teamKey: string): StoredIssue[] {
    return this.stored.filter(issue => issue.teamKey === teamKey && !issue.trashed);
  }

  private requireTeam(key: string) {
    const team = this.teams.get(key);
    if (!team) throw new Error(`fake: no team ${key}`);
    return team;
  }

  private view(issue: StoredIssue): LinearIssue {
    const team = this.requireTeam(issue.teamKey);
    const state = STATES.find(candidate => candidate.id === issue.stateId);
    if (!state) throw new Error(`fake: no state ${issue.stateId}`);
    const { labelIds, stateId: _stateId, trashed: _trashed, ...rest } = issue;
    return {
      ...rest,
      state: { type: state.type, name: state.name },
      labels: labelIds.map(id => team.labels.find(label => label.id === id)?.name ?? id),
    };
  }
}
