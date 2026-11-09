import { beforeEach, describe, expect, test } from 'bun:test';
import {
  contentDigest,
  forgeRequestSchema,
  forgeResponseSchema,
  pluginMetadataSchema,
  type ForgeResponse,
} from './contract/operations.ts';
import { matchesForgeOperationResponse } from './contract/response-match.ts';
import { DON, FakeLinear } from './fake-linear.ts';
import { handleOperation, linearPluginMetadata } from './handler.ts';

const ENG = { host: 'linear.app', path: 'acme/ENG' };
const ref = (number: number) => ({ repo: ENG, number });
const issueSubject = (number: number) => ({ kind: 'issue' as const, ref: ref(number) });

let linear: FakeLinear;
beforeEach(() => {
  linear = new FakeLinear();
  linear.addTeam('ENG', ['archon-ready', 'archon-blocked', 'bug']);
});

/** Runs one request the way Archon's host would see it: parsed, answered, schema-checked and matched. */
async function run(request: Record<string, unknown>): Promise<ForgeResponse> {
  const parsed = forgeRequestSchema.parse({ operationId: 'op-1', ...request });
  const response = forgeResponseSchema.parse(await handleOperation(parsed, linear));
  const metadata = pluginMetadataSchema.parse(linearPluginMetadata);
  expect(matchesForgeOperationResponse(parsed, response, metadata, 'linear.app')).toBe(true);
  return response;
}

function value(response: ForgeResponse): any {
  if (!response.ok) throw new Error(`expected success, got ${JSON.stringify(response)}`);
  return response.result.value;
}

describe('metadata', () => {
  test('claims linear.app and takes the key from LINEAR_API_KEY', () => {
    const metadata = pluginMetadataSchema.parse(linearPluginMetadata);
    expect(metadata.hosts).toEqual(['linear.app']);
    expect(metadata.token_env).toEqual(['LINEAR_API_KEY']);
    expect(metadata.capabilities).toContain('workitem.view');
  });
});

describe('workitem.view', () => {
  test('reads a Linear issue as a work item', async () => {
    linear.addIssue('ENG', { number: 12, title: 'Trailing slash', description: 'Body', labels: ['bug'] });
    const view = value(await run({ op: 'workitem.view', ref: ref(12) }));
    expect(view).toEqual({
      ref: ref(12),
      kind: 'issue',
      url: 'https://linear.app/acme/issue/ENG-12/slug',
      state: 'open',
      title: 'Trailing slash',
      body: 'Body',
      labels: ['bug'],
      author: { host: 'linear.app', id: 'user-don', login: 'don' },
    });
  });

  test('a completed or canceled issue is closed', async () => {
    linear.addIssue('ENG', { number: 1, stateId: 'state-done' });
    linear.addIssue('ENG', { number: 2, stateId: 'state-canceled' });
    expect(value(await run({ op: 'workitem.view', ref: ref(1) })).state).toBe('closed');
    expect(value(await run({ op: 'workitem.view', ref: ref(2) })).state).toBe('closed');
  });

  test('an issue that does not exist is not_found', async () => {
    const response = await run({ op: 'workitem.view', ref: ref(99) });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.kind).toBe('not_found');
  });

  test('a team the key cannot see is not_found', async () => {
    const response = await run({ op: 'workitem.view', ref: { repo: { host: 'linear.app', path: 'acme/NOPE' }, number: 1 } });
    expect(!response.ok && response.error.kind).toBe('not_found');
  });

  test('a path that is not workspace/TEAM is an invalid request', async () => {
    const response = await run({ op: 'workitem.view', ref: { repo: { host: 'linear.app', path: 'ENG' }, number: 1 } });
    expect(!response.ok && response.error.kind).toBe('invalid_request');
  });
});


describe('workitem.comments', () => {
  test('every comment, oldest first, with its author', async () => {
    const issue = linear.addIssue('ENG', { number: 3 });
    linear.addComment(issue, 'first');
    linear.addComment(issue, '<!-- archon:review -->\nsecond', null);
    const result = value(await run({ op: 'workitem.comments', subject: issueSubject(3) }));
    expect(result.workitem).toEqual({ ref: ref(3), kind: 'issue', url: issue.url, state: 'open' });
    expect(result.comments).toEqual([
      { id: 'comment-1', author: { host: 'linear.app', id: DON.id, login: 'don' }, url: `${issue.url}#comment-1`, body: 'first' },
      { id: 'comment-2', author: null, url: `${issue.url}#comment-2`, body: '<!-- archon:review -->\nsecond' },
    ]);
  });

  test('a pull-request subject is refused: Linear has none', async () => {
    const response = await run({ op: 'workitem.comments', subject: { kind: 'pr', ref: ref(3) } });
    expect(!response.ok && response.error.kind).toBe('invalid_request');
  });
});

describe('workitem.list', () => {
  test('open issues carrying the label', async () => {
    linear.addIssue('ENG', { number: 1, labels: ['archon-ready'] });
    linear.addIssue('ENG', { number: 2, labels: ['archon-blocked'] });
    linear.addIssue('ENG', { number: 3, labels: ['archon-ready'], stateId: 'state-done' });
    linear.addIssue('ENG', { number: 4, labels: ['bug', 'archon-ready'] });
    const result = value(await run({ op: 'workitem.list', repo: ENG, label: 'archon-ready' }));
    expect(result.items.map((item: { ref: { number: number } }) => item.ref.number)).toEqual([1, 4]);
    expect(result.items[0]).toEqual({ ref: ref(1), kind: 'issue', url: 'https://linear.app/acme/issue/ENG-1/slug', state: 'open' });
  });
});

describe('repo.labels.list', () => {
  test('the labels the team can use', async () => {
    const result = value(await run({ op: 'repo.labels.list', repo: ENG }));
    expect(result).toEqual({ repo: ENG, labels: [{ name: 'archon-ready' }, { name: 'archon-blocked' }, { name: 'bug' }] });
  });
});

function failure(response: ForgeResponse) {
  if (response.ok) throw new Error(`expected failure, got ${JSON.stringify(response)}`);
  return response;
}

describe('workitem.label.add and workitem.label.remove', () => {
  test('adds one label, keeps the others, and reports the set read back', async () => {
    linear.addIssue('ENG', { number: 5, labels: ['bug'] });
    const result = value(await run({ op: 'workitem.label.add', subject: issueSubject(5), name: 'archon-ready' }));
    expect(result).toMatchObject({ outcome: 'applied', changed: true, target: ref(5), labels: ['bug', 'archon-ready'] });
    expect(value(await run({ op: 'workitem.view', ref: ref(5) })).labels).toEqual(['bug', 'archon-ready']);
  });

  test('a label already there is applied without a write', async () => {
    linear.addIssue('ENG', { number: 5, labels: ['bug'] });
    const result = value(await run({ op: 'workitem.label.add', subject: issueSubject(5), name: 'bug' }));
    expect(result).toMatchObject({ outcome: 'applied', changed: false, labels: ['bug'] });
    expect(linear.calls.some(call => call.startsWith('updateIssue'))).toBe(false);
  });

  test('removes one label', async () => {
    linear.addIssue('ENG', { number: 5, labels: ['bug', 'archon-ready'] });
    const result = value(await run({ op: 'workitem.label.remove', subject: issueSubject(5), name: 'archon-ready' }));
    expect(result).toMatchObject({ outcome: 'applied', changed: true, labels: ['bug'] });
  });

  test('a label the team does not have is refused, never created', async () => {
    linear.addIssue('ENG', { number: 5 });
    const response = failure(await run({ op: 'workitem.label.add', subject: issueSubject(5), name: 'nope' }));
    expect(response.mutation?.outcome).toBe('refused');
    expect(linear.calls.some(call => call.startsWith('createLabel') || call.startsWith('updateIssue'))).toBe(false);
  });

  test('Linear refusing the write is a refusal', async () => {
    linear.addIssue('ENG', { number: 5 });
    linear.failNext = 'refuse';
    const response = failure(await run({ op: 'workitem.label.add', subject: issueSubject(5), name: 'bug' }));
    expect(response.mutation?.outcome).toBe('refused');
  });

  test('a write whose answer was lost is outcome_unknown', async () => {
    linear.addIssue('ENG', { number: 5 });
    linear.failNext = 'lost';
    const response = failure(await run({ op: 'workitem.label.add', subject: issueSubject(5), name: 'bug' }));
    expect(response.mutation?.outcome).toBe('outcome_unknown');
  });
});

describe('workitem.labels.set', () => {
  test('replaces the whole set', async () => {
    linear.addIssue('ENG', { number: 6, labels: ['bug', 'archon-blocked'] });
    const result = value(await run({ op: 'workitem.labels.set', ref: ref(6), labels: ['archon-ready'] }));
    expect(result).toMatchObject({ outcome: 'applied', changed: true, labels: ['archon-ready'] });
  });

  test('the same set is applied without a write', async () => {
    linear.addIssue('ENG', { number: 6, labels: ['bug', 'archon-ready'] });
    const result = value(await run({ op: 'workitem.labels.set', ref: ref(6), labels: ['archon-ready', 'bug'] }));
    expect(result).toMatchObject({ changed: false });
    expect(linear.calls.some(call => call.startsWith('updateIssue'))).toBe(false);
  });

  test('a name the team does not have refuses the whole write', async () => {
    linear.addIssue('ENG', { number: 6 });
    const response = failure(await run({ op: 'workitem.labels.set', ref: ref(6), labels: ['bug', 'nope'] }));
    expect(response.mutation?.outcome).toBe('refused');
  });
});

describe('repo.label.ensure', () => {
  test('creates a missing label with its color and description', async () => {
    const result = value(
      await run({ op: 'repo.label.ensure', repo: ENG, name: 'archon-triage', color: 'FBCA04', description: 'Request a fresh triage' })
    );
    expect(result).toMatchObject({
      outcome: 'applied',
      changed: true,
      label: { name: 'archon-triage', color: 'fbca04', descriptionDigest: contentDigest('Request a fresh triage') },
    });
    expect(value(await run({ op: 'repo.labels.list', repo: ENG })).labels).toContainEqual({ name: 'archon-triage' });
  });

  test('an existing label is left as the operator set it', async () => {
    const result = value(await run({ op: 'repo.label.ensure', repo: ENG, name: 'bug', color: '000000', description: 'x' }));
    expect(result).toMatchObject({ outcome: 'applied', changed: false, label: { name: 'bug', color: 'bbbbbb' } });
    expect(linear.calls.some(call => call.startsWith('createLabel'))).toBe(false);
  });
});

describe('workitem.comment.upsert', () => {
  const marker = '<!-- archon:intake -->';

  test('creates the marked comment when there is none', async () => {
    const issue = linear.addIssue('ENG', { number: 7 });
    linear.addComment(issue, 'a person said something');
    const body = `${marker}\nTriaged: build, small.`;
    const result = value(await run({ op: 'workitem.comment.upsert', subject: issueSubject(7), marker, body }));
    expect(result).toMatchObject({ outcome: 'applied', changed: true, comment: { ref: ref(7), bodyDigest: contentDigest(body) } });
    const comments = value(await run({ op: 'workitem.comments', subject: issueSubject(7) })).comments;
    expect(comments.map((comment: { body: string }) => comment.body)).toEqual(['a person said something', body]);
  });

  test('replaces the marked comment in place', async () => {
    const issue = linear.addIssue('ENG', { number: 7 });
    const old = linear.addComment(issue, `${marker}\nold`);
    const body = `${marker}\nnew`;
    const result = value(await run({ op: 'workitem.comment.upsert', subject: issueSubject(7), marker, body }));
    expect(result).toMatchObject({ changed: true, comment: { id: old.id } });
    expect(linear.calls.some(call => call.startsWith('createComment'))).toBe(false);
  });

  test('the same body is applied without a write', async () => {
    const issue = linear.addIssue('ENG', { number: 7 });
    linear.addComment(issue, `${marker}\nsame`);
    const result = value(await run({ op: 'workitem.comment.upsert', subject: issueSubject(7), marker, body: `${marker}\nsame` }));
    expect(result).toMatchObject({ changed: false });
  });

  test('two marked comments are a conflict', async () => {
    const issue = linear.addIssue('ENG', { number: 7 });
    linear.addComment(issue, `${marker}\none`);
    linear.addComment(issue, `${marker}\ntwo`);
    const response = failure(await run({ op: 'workitem.comment.upsert', subject: issueSubject(7), marker, body: `${marker}\nx` }));
    expect(response.error.kind).toBe('conflict');
    expect(response.mutation?.outcome).toBe('refused');
  });

  test('a body that does not start with the marker is refused', async () => {
    linear.addIssue('ENG', { number: 7 });
    const response = failure(await run({ op: 'workitem.comment.upsert', subject: issueSubject(7), marker, body: 'no marker' }));
    expect(response.mutation?.outcome).toBe('refused');
  });
});

describe('workitem.close', () => {
  test.each([
    ['completed', 'Done'],
    ['not_planned', 'Canceled'],
    ['duplicate', 'Duplicate'],
  ] as const)('%s moves the issue to %s', async (reason, stateName) => {
    linear.addIssue('ENG', { number: 8 });
    const result = value(await run({ op: 'workitem.close', ref: ref(8), reason }));
    expect(result).toMatchObject({ outcome: 'applied', changed: true, reason, workitem: { state: 'closed' } });
    expect((await linear.issue('ENG', 8))?.state.name).toBe(stateName);
  });

  test('already closed for the same reason is applied without a write', async () => {
    linear.addIssue('ENG', { number: 8, stateId: 'state-done' });
    const result = value(await run({ op: 'workitem.close', ref: ref(8), reason: 'completed' }));
    expect(result).toMatchObject({ changed: false, reason: 'completed' });
  });

  test('closed for another reason is a conflict, never rewritten', async () => {
    linear.addIssue('ENG', { number: 8, stateId: 'state-canceled' });
    const response = failure(await run({ op: 'workitem.close', ref: ref(8), reason: 'completed' }));
    expect(response.error.kind).toBe('conflict');
    expect(response.mutation?.outcome).toBe('refused');
  });
});

describe('workitem.edit-body', () => {
  test('applied when a fresh read returns what Linear stored from the write', async () => {
    linear.addIssue('ENG', { number: 9, description: 'old' });
    const body = '<!-- m -->\n- item\n\n### Current scope (2026-11-08)\nOnly the API.';
    const result = value(await run({ op: 'workitem.edit-body', ref: ref(9), body }));
    expect(result).toMatchObject({ outcome: 'applied', changed: true, bodyDigest: contentDigest(body) });
  });

  test('another edit landing between the write and the read is a verification failure', async () => {
    linear.addIssue('ENG', { number: 9, description: 'old' });
    linear.raceDescription = 'someone else typed this';
    const response = failure(await run({ op: 'workitem.edit-body', ref: ref(9), body: 'mine' }));
    expect(response.mutation?.outcome).toBe('verification_failed');
  });
});

describe('workitem.create', () => {
  const marker = '<!-- archon-discovery k1 -->';
  const body = `${marker}\n## Problem\n- slash 404s`;

  test('creates an issue and proves it by a fresh read', async () => {
    const result = value(await run({ op: 'workitem.create', repo: ENG, title: 'Trailing slash 404s', body, marker }));
    expect(result).toMatchObject({
      outcome: 'applied',
      changed: true,
      workitem: { ref: ref(1), state: 'open', url: 'https://linear.app/acme/issue/ENG-1/slug' },
      markerDigest: contentDigest(marker),
      titleDigest: contentDigest('Trailing slash 404s'),
      bodyDigest: contentDigest(body),
    });
  });

  test('an issue already carrying the marker is returned, never edited or reopened', async () => {
    linear.addIssue('ENG', { number: 4, description: `${marker}\n\nolder text`, stateId: 'state-done' });
    const result = value(await run({ op: 'workitem.create', repo: ENG, title: 'T', body, marker }));
    expect(result).toMatchObject({ changed: false, workitem: { ref: ref(4), state: 'closed' }, markerDigest: contentDigest(marker) });
    expect(linear.calls.some(call => call.startsWith('createIssue') || call.startsWith('updateIssue'))).toBe(false);
  });

  test('two issues carrying the marker are a conflict', async () => {
    linear.addIssue('ENG', { number: 1, description: marker });
    linear.addIssue('ENG', { number: 2, description: `${marker}\nx` });
    const response = failure(await run({ op: 'workitem.create', repo: ENG, title: 'T', body, marker }));
    expect(response.error.kind).toBe('conflict');
    expect(response.mutation?.outcome).toBe('refused');
  });

  test('a create whose answer was lost is outcome_unknown', async () => {
    linear.failNext = 'lost';
    const response = failure(await run({ op: 'workitem.create', repo: ENG, title: 'T', body, marker }));
    expect(response.mutation?.outcome).toBe('outcome_unknown');
  });
});

describe('review fixes', () => {
  test('label.add keeps a label another writer adds at the same moment', async () => {
    linear.addIssue('ENG', { number: 5 });
    linear.onWrite = () => linear.labelIssue('ENG', 5, 'bug');
    const result = value(await run({ op: 'workitem.label.add', subject: issueSubject(5), name: 'archon-ready' }));
    expect(result).toMatchObject({ outcome: 'applied', changed: true });
    expect((await linear.issue('ENG', 5))?.labels).toEqual(['bug', 'archon-ready']);
  });

  test('removing a label the team does not even have is applied without a write', async () => {
    linear.addIssue('ENG', { number: 5 });
    const result = value(await run({ op: 'workitem.label.remove', subject: issueSubject(5), name: 'nope' }));
    expect(result).toMatchObject({ outcome: 'applied', changed: false });
  });

  test('a label created but not readable afterwards is a verification failure, not a refusal', async () => {
    linear.onWrite = () => { linear.failNextRead = true; };
    const response = failure(
      await run({ op: 'repo.label.ensure', repo: ENG, name: 'archon-triage', color: 'FBCA04', description: 'x' })
    );
    expect(response.mutation?.outcome).toBe('verification_failed');
  });

  test('an issue in the trash carrying the marker does not count; a new one is created', async () => {
    linear.addIssue('ENG', { number: 1, description: '<!-- k -->\nold', trashed: true });
    const result = value(await run({ op: 'workitem.create', repo: ENG, title: 'T', body: '<!-- k -->\nnew', marker: '<!-- k -->' }));
    expect(result).toMatchObject({ changed: true, workitem: { ref: ref(2) } });
  });

  test('a trashed issue is not found and is never listed', async () => {
    linear.addIssue('ENG', { number: 1, labels: ['archon-ready'], trashed: true });
    expect(failure(await run({ op: 'workitem.view', ref: ref(1) })).error.kind).toBe('not_found');
    expect(value(await run({ op: 'workitem.list', repo: ENG, label: 'archon-ready' })).items).toEqual([]);
  });
});
