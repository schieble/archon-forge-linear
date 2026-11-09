/**
 * Archon forge operations for Linear work items (protocol 1).
 *
 * A Linear team stands where a forge repository would: the repository reference is
 * `{host: "linear.app", path: "<workspace>/<TEAM>"}` and the work item's number is the
 * team's issue number, so ENG-12 is `{repo: {host: "linear.app", path: "acme/ENG"}, number: 12}`.
 * Pull requests stay on their own forge; this plugin has none, and refuses a `pr` subject.
 */
import {
  contentDigest,
  isMutationRequest,
  mutationTarget,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
} from './contract/operations.ts';
import type { WorkItemRef } from './contract/identity.ts';
import { LinearRefusal, type LinearApi, type LinearIssue, type LinearLabel, type LinearTeam } from './linear.ts';

export const HOST = 'linear.app';

const CAPABILITIES = [
  'workitem.view',
  'workitem.comments',
  'workitem.list',
  'repo.labels.list',
  'workitem.label.add',
  'workitem.label.remove',
  'workitem.labels.set',
  'repo.label.ensure',
  'workitem.comment.upsert',
  'workitem.close',
  'workitem.edit-body',
  'workitem.create',
] as const;

type CloseReason = 'completed' | 'not_planned' | 'duplicate';

export const linearPluginMetadata = {
  name: 'linear',
  version: '0.2.0',
  protocol: 1,
  forge: 'linear',
  hosts: [HOST],
  capabilities: [...CAPABILITIES],
  token_env: ['LINEAR_API_KEY'],
};

type Kind = Extract<ForgeResponse, { ok: false }>['error']['kind'];

class OperationError extends Error {
  constructor(
    readonly kind: Kind,
    message: string
  ) {
    super(message);
  }
}

type Outcome = 'refused' | 'verification_failed' | 'outcome_unknown';

/** A write that failed, and which of the three ways it failed. */
class MutationFailure extends Error {
  constructor(
    readonly outcome: Outcome,
    readonly kind: Kind,
    message: string,
    readonly leaveBehind?: string
  ) {
    super(message);
  }
}

/**
 * Performs one Linear write. Linear answering with a refusal means nothing was written;
 * any other failure (a lost answer, a timeout) leaves what happened unknown.
 */
async function write<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof LinearRefusal) throw new MutationFailure('refused', 'forge_error', `${what}: ${message}`);
    throw new MutationFailure('outcome_unknown', 'forge_error', `${what}: ${message}; reconcile before retrying`);
  }
}

/** A read-back that disagrees with the write it follows. */
function disagrees(what: string, leaveBehind: string): MutationFailure {
  return new MutationFailure('verification_failed', 'forge_error', `${what} did not read back as written`, leaveBehind);
}

type RepoRef = WorkItemRef['repo'];

/** ENG-12. */
function identifier(team: LinearTeam, number: number): string {
  return `${team.key}-${String(number)}`;
}

/** The team a repository reference names, read from Linear. */
async function team(api: LinearApi, repo: RepoRef): Promise<LinearTeam> {
  const match = /^([^/]+)\/([A-Za-z0-9]+)$/.exec(repo.path);
  if (!match) throw new OperationError('invalid_request', `a Linear path is <workspace>/<TEAM>, not "${repo.path}"`);
  const [, workspace, key] = match as unknown as [string, string, string];
  const found = await api.team(key.toUpperCase());
  if (!found || found.organization.toLowerCase() !== workspace.toLowerCase())
    throw new OperationError('not_found', `no Linear team ${repo.path} that this key can see`);
  return found;
}

async function issue(api: LinearApi, ref: WorkItemRef): Promise<{ owner: LinearTeam; found: LinearIssue }> {
  const owner = await team(api, ref.repo);
  const found = await api.issue(owner.key, ref.number);
  if (!found) throw new OperationError('not_found', `no issue ${identifier(owner, ref.number)}`);
  return { owner, found };
}

/** The issue a subject names. Linear has no pull requests, so a `pr` subject is refused. */
async function subjectIssue(api: LinearApi, subject: { kind: 'issue' | 'pr'; ref: WorkItemRef }) {
  if (subject.kind !== 'issue')
    throw new OperationError('invalid_request', 'Linear has no pull requests; a Linear subject is always an issue');
  return issue(api, subject.ref);
}

function isOpen(found: LinearIssue): boolean {
  return found.state.type !== 'completed' && found.state.type !== 'canceled';
}

/** The work-item record the contract asks for: identity, URL and open or closed. */
function workItemRecord(repo: RepoRef, found: LinearIssue) {
  return {
    ref: { repo, number: found.number },
    kind: 'issue' as const,
    url: found.url,
    state: isOpen(found) ? ('open' as const) : ('closed' as const),
  };
}

function actor(user: LinearIssue['creator']) {
  return user ? { host: HOST, id: user.id, login: user.displayName } : null;
}

function labelRecord(label: LinearLabel) {
  return {
    name: label.name,
    color: label.color.replace(/^#/, '').toLowerCase(),
    descriptionDigest: contentDigest(label.description ?? ''),
  };
}

function sameLabels(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(name => right.includes(name));
}

/** The ids of these label names in the team, or a refusal naming the ones it lacks. */
function labelIds(owner: LinearTeam, names: readonly string[]): string[] {
  const missing = names.filter(name => !owner.labels.some(label => label.name === name));
  if (missing.length > 0)
    throw new OperationError('not_found', `team ${owner.key} has no label ${missing.join(', ')}; labels are never created here`);
  return names.map(name => owner.labels.find(label => label.name === name)!.id);
}

/** Re-reads an issue after a write; a write is proven only by a fresh read. */
async function readBack(api: LinearApi, owner: LinearTeam, number: number, what: string): Promise<LinearIssue> {
  try {
    const found = await api.issue(owner.key, number);
    if (found) return found;
  } catch {
    // fall through: the write happened, its effect could not be read
  }
  throw disagrees(what, `${identifier(owner, number)} may carry the write; it could not be read back`);
}

/** Why a closed issue closed, from its Linear state. Null while it is open. */
function closeReason(found: LinearIssue): CloseReason | null {
  if (found.state.type === 'completed') return 'completed';
  if (found.state.type !== 'canceled') return null;
  return /duplicate/i.test(found.state.name) ? 'duplicate' : 'not_planned';
}

/** The team's workflow state a close for this reason moves an issue to. */
function closeState(owner: LinearTeam, reason: CloseReason) {
  const state = owner.states.find(candidate =>
    reason === 'completed'
      ? candidate.type === 'completed'
      : candidate.type === 'canceled' && /duplicate/i.test(candidate.name) === (reason === 'duplicate')
  );
  if (!state) throw new OperationError('not_found', `team ${owner.key} has no workflow state for a ${reason} close`);
  return state;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? '';
}

/**
 * Proves a description write. Linear rewrites Markdown as it stores it (it adds a blank line
 * after the first line, changes bullets, escapes characters), so the stored text never equals
 * the text sent. The write is proven instead by a fresh read that returns exactly what Linear
 * answered the write with: the description is the one this write produced, and no other edit
 * landed after it. The digest reported is the requested text's, which is what Archon's host
 * checks; the bytes Linear holds are its rewrite of that text.
 */
async function proveDescription(api: LinearApi, owner: LinearTeam, stored: LinearIssue, what: string): Promise<LinearIssue> {
  const after = await readBack(api, owner, stored.number, what);
  if (after.description !== stored.description)
    throw disagrees(what, `${identifier(owner, stored.number)} holds a description another edit changed after this write`);
  return after;
}

function commentRecord(ref: WorkItemRef, comment: { id: string; url: string; body: string }) {
  return { ref, id: comment.id, url: comment.url, bodyDigest: contentDigest(comment.body) };
}

function applied(request: ForgeMutationRequest, changed: boolean, evidence: Record<string, unknown>) {
  return { target: mutationTarget(request), outcome: 'applied', changed, ...evidence };
}

/** The result value of one operation, or a thrown OperationError / MutationFailure. */
async function operationValue(request: ForgeRequest, api: LinearApi): Promise<unknown> {
  switch (request.op) {
    case 'workitem.view': {
      const { found } = await issue(api, request.ref);
      return {
        ...workItemRecord(request.ref.repo, found),
        title: found.title,
        body: found.description,
        labels: [...found.labels],
        author: actor(found.creator),
      };
    }
    case 'workitem.comments': {
      const { found } = await subjectIssue(api, request.subject);
      const comments = await api.comments(found.id);
      return {
        workitem: workItemRecord(request.subject.ref.repo, found),
        comments: comments.map(comment => ({ id: comment.id, author: actor(comment.user), url: comment.url, body: comment.body })),
      };
    }
    case 'workitem.list': {
      const owner = await team(api, request.repo);
      const issues = await api.openIssuesWithLabel(owner.key, request.label);
      return {
        repo: request.repo,
        label: request.label,
        items: [...issues].sort((left, right) => left.number - right.number).map(found => workItemRecord(request.repo, found)),
      };
    }
    case 'repo.labels.list': {
      const owner = await team(api, request.repo);
      return { repo: request.repo, labels: owner.labels.map(label => ({ name: label.name })) };
    }
    case 'workitem.label.add':
    case 'workitem.label.remove': {
      // One label through Linear's single-label writes, so another writer's labels survive.
      const { owner, found } = await subjectIssue(api, request.subject);
      const adding = request.op === 'workitem.label.add';
      const record = (after: LinearIssue) => ({ workitem: workItemRecord(request.subject.ref.repo, after), labels: [...after.labels] });
      if (found.labels.includes(request.name) === adding) return applied(request, false, record(found));
      const [labelId] = labelIds(owner, [request.name]) as [string];
      await write(request.op, () => (adding ? api.addLabel(found.id, labelId) : api.removeLabel(found.id, labelId)));
      const after = await readBack(api, owner, found.number, request.op);
      if (after.labels.includes(request.name) !== adding)
        throw disagrees(request.op, `${identifier(owner, found.number)} carries ${after.labels.join(', ') || 'no labels'}`);
      return applied(request, true, record(after));
    }
    case 'workitem.labels.set': {
      const { owner, found } = await issue(api, request.ref);
      const record = (after: LinearIssue) => ({ workitem: workItemRecord(request.ref.repo, after), labels: [...after.labels] });
      if (sameLabels(request.labels, found.labels)) return applied(request, false, record(found));
      const ids = labelIds(owner, request.labels);
      await write(request.op, () => api.updateIssue(found.id, { labelIds: ids }));
      const after = await readBack(api, owner, found.number, request.op);
      if (!sameLabels(request.labels, after.labels))
        throw disagrees(request.op, `${identifier(owner, found.number)} carries ${after.labels.join(', ') || 'no labels'}`);
      return applied(request, true, record(after));
    }
    case 'repo.label.ensure': {
      const owner = await team(api, request.repo);
      const existing = owner.labels.find(label => label.name === request.name);
      if (existing) return applied(request, false, { label: labelRecord(existing) });
      await write(request.op, () => api.createLabel(owner.id, request.name, `#${request.color}`, request.description));
      const created = await team(api, request.repo).then(
        after => after.labels.find(label => label.name === request.name),
        () => undefined
      );
      const label = created && labelRecord(created);
      if (!label || label.color !== request.color || label.descriptionDigest !== contentDigest(request.description))
        throw disagrees(request.op, `team ${owner.key} may have a label ${request.name}`);
      return applied(request, true, { label });
    }
    case 'workitem.comment.upsert': {
      const { owner, found } = await subjectIssue(api, request.subject);
      if (firstLine(request.body) !== request.marker)
        throw new OperationError('invalid_request', 'the comment body must begin with its marker line');
      const marked = (await api.comments(found.id)).filter(comment => firstLine(comment.body) === request.marker);
      if (marked.length > 1)
        throw new OperationError('conflict', `${identifier(owner, found.number)} has ${String(marked.length)} comments marked ${request.marker}`);
      const existing = marked[0];
      const workitem = workItemRecord(request.subject.ref.repo, found);
      if (existing?.body === request.body)
        return applied(request, false, { workitem, comment: commentRecord(request.subject.ref, existing) });
      const written = await write(request.op, () =>
        existing ? api.updateComment(existing.id, request.body) : api.createComment(found.id, request.body)
      );
      // Linear stores comments exactly, so the read-back must be the very text sent.
      const comment = (await api.comments(found.id).catch(() => [])).find(candidate => candidate.id === written.id);
      if (comment?.body !== request.body)
        throw disagrees(request.op, `comment ${written.id} on ${identifier(owner, found.number)} may hold the write`);
      return applied(request, true, { workitem, comment: commentRecord(request.subject.ref, comment) });
    }
    case 'workitem.close': {
      const { owner, found } = await issue(api, request.ref);
      const current = closeReason(found);
      if (current === request.reason)
        return applied(request, false, { workitem: workItemRecord(request.ref.repo, found), reason: current });
      if (current !== null)
        throw new OperationError('conflict', `${identifier(owner, found.number)} is already closed as ${current}`);
      const state = closeState(owner, request.reason);
      await write(request.op, () => api.updateIssue(found.id, { stateId: state.id }));
      const after = await readBack(api, owner, found.number, request.op);
      if (closeReason(after) !== request.reason)
        throw disagrees(request.op, `${identifier(owner, found.number)} is in state ${after.state.name}`);
      return applied(request, true, { workitem: workItemRecord(request.ref.repo, after), reason: request.reason });
    }
    case 'workitem.edit-body': {
      // Linear rewrites what it stores, so resending an unchanged body writes again; harmless.
      const { owner, found } = await issue(api, request.ref);
      if (found.description === request.body)
        return applied(request, false, { workitem: workItemRecord(request.ref.repo, found), bodyDigest: contentDigest(request.body) });
      const stored = await write(request.op, () => api.updateIssue(found.id, { description: request.body }));
      const after = await proveDescription(api, owner, stored, request.op);
      return applied(request, true, { workitem: workItemRecord(request.ref.repo, after), bodyDigest: contentDigest(request.body) });
    }
    case 'workitem.create': {
      const owner = await team(api, request.repo);
      const marked = (await api.issuesStartingWith(owner.key, request.marker)).filter(
        found => firstLine(found.description) === request.marker
      );
      if (marked.length > 1)
        throw new OperationError('conflict', `team ${owner.key} has ${String(marked.length)} issues marked ${request.marker}`);
      if (marked[0]) {
        // One match is read directly and returned; recovery never edits or reopens it.
        const { found: existing } = await issue(api, { repo: request.repo, number: marked[0].number });
        return applied(request, false, {
          workitem: workItemRecord(request.repo, existing),
          markerDigest: contentDigest(request.marker),
          titleDigest: contentDigest(existing.title),
          bodyDigest: contentDigest(existing.description),
        });
      }
      const stored = await write(request.op, () => api.createIssue(owner.id, request.title, request.body));
      const after = await proveDescription(api, owner, stored, request.op);
      if (after.title !== request.title || firstLine(after.description) !== request.marker || !isOpen(after))
        throw disagrees(request.op, `${identifier(owner, after.number)} was created but does not read back as requested`);
      return applied(request, true, {
        workitem: workItemRecord(request.repo, after),
        markerDigest: contentDigest(request.marker),
        titleDigest: contentDigest(request.title),
        bodyDigest: contentDigest(request.body),
      });
    }
    default:
      throw new OperationError('unsupported_op', `the Linear plugin does not support ${request.op}`);
  }
}

export async function handleOperation(request: ForgeRequest, api: LinearApi): Promise<ForgeResponse> {
  try {
    const value = await operationValue(request, api);
    return { operationId: request.operationId, ok: true, result: { op: request.op, value } } as ForgeResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure =
      error instanceof MutationFailure
        ? error
        : // Anything thrown before a write began (a missing issue, a bad request, a failed read)
          // means nothing was written.
          new MutationFailure('refused', error instanceof OperationError ? error.kind : 'forge_error', message);
    const response = { operationId: request.operationId, ok: false as const, error: { kind: failure.kind, message } };
    if (!isMutationRequest(request)) return response;
    const mutation =
      failure.outcome === 'verification_failed'
        ? { op: request.op, target: mutationTarget(request), outcome: failure.outcome, leaveBehind: failure.leaveBehind ?? 'unknown' }
        : { op: request.op, target: mutationTarget(request), outcome: failure.outcome };
    return { ...response, mutation } as ForgeResponse;
  }
}
