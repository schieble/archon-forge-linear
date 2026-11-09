/**
 * LinearApi over Linear's GraphQL API (api.linear.app), authenticated with a personal API
 * key. Checked live by probes/forge-linear-probe.sh rather than by unit tests.
 *
 * Linear answering a write with GraphQL errors or an HTTP 4xx means it refused the write and
 * nothing was written (LinearRefusal). A network failure, a timeout or a 5xx leaves the write's
 * fate unknown and is thrown as a plain Error.
 */
import {
  LinearRefusal,
  type IssueUpdate,
  type LinearApi,
  type LinearComment,
  type LinearIssue,
  type LinearLabel,
  type LinearTeam,
  type StateType,
} from './linear.ts';

const ENDPOINT = 'https://api.linear.app/graphql';
const PAGE = 250;

const ISSUE_FIELDS = `id number url title description trashed
  state { type name } labels(first: 250) { nodes { name } } creator { id displayName } team { key }`;
const COMMENT_FIELDS = 'id body url createdAt user { id displayName }';
const LABEL_FIELDS = 'id name color description isGroup';

interface RawIssue {
  id: string;
  number: number;
  url: string;
  title: string;
  description: string | null;
  trashed: boolean | null;
  state: { type: string; name: string };
  labels: { nodes: { name: string }[] };
  creator: { id: string; displayName: string } | null;
  team: { key: string };
}
interface RawComment {
  id: string;
  body: string;
  url: string;
  createdAt: string;
  user: { id: string; displayName: string } | null;
}
interface RawLabel {
  id: string;
  name: string;
  color: string;
  description: string | null;
  isGroup: boolean;
}
interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function toIssue(raw: RawIssue): LinearIssue {
  return {
    id: raw.id,
    number: raw.number,
    teamKey: raw.team.key,
    url: raw.url,
    title: raw.title,
    description: raw.description ?? '',
    state: { type: raw.state.type as StateType, name: raw.state.name },
    labels: raw.labels.nodes.map(label => label.name),
    creator: raw.creator ? { id: raw.creator.id, displayName: raw.creator.displayName } : null,
  };
}

function toComment(raw: RawComment): LinearComment {
  return {
    id: raw.id,
    body: raw.body,
    url: raw.url,
    user: raw.user ? { id: raw.user.id, displayName: raw.user.displayName } : null,
  };
}

function toLabel(raw: RawLabel): LinearLabel {
  return { id: raw.id, name: raw.name, color: raw.color, description: raw.description };
}

export class LinearGraphql implements LinearApi {
  constructor(
    private readonly key: string,
    private readonly timeoutMs = 30_000
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown>, mutation: boolean): Promise<T> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let payload: { data?: T; errors?: { message: string }[] } | undefined;
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      payload = undefined;
    }
    const problem = payload?.errors?.map(error => error.message).join('; ');
    if (response.ok && payload?.data && !problem) return payload.data;
    const message = `Linear answered ${String(response.status)}: ${problem ?? text.slice(0, 300)}`;
    // A 4xx or GraphQL errors on a 200 is Linear refusing; a 5xx may have applied a write.
    if (mutation && response.status < 500 && (problem !== undefined || !response.ok)) throw new LinearRefusal(message);
    throw new Error(message);
  }

  private async pages<T>(
    query: string,
    variables: Record<string, unknown>,
    pick: (data: any) => Connection<T>
  ): Promise<T[]> {
    const all: T[] = [];
    let after: string | null = null;
    do {
      const page: Connection<T> = pick(await this.request(query, { ...variables, after, first: PAGE }, false));
      all.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return all;
  }

  async team(key: string): Promise<LinearTeam | null> {
    const data = await this.request<{
      teams: { nodes: { id: string; key: string; organization: { urlKey: string }; states: { nodes: { id: string; type: string; name: string }[] } }[] };
    }>(
      `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes {
        id key organization { urlKey } states(first: 100) { nodes { id type name } } } } }`,
      { key },
      false
    );
    const team = data.teams.nodes[0];
    if (!team) return null;
    // An issue can carry the team's labels and the workspace's; a group is not a label.
    const own = await this.pages<RawLabel>(
      `query($id: String!, $first: Int!, $after: String) { team(id: $id) { labels(first: $first, after: $after) {
        nodes { ${LABEL_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
      { id: team.id },
      data => data.team.labels
    );
    const workspace = await this.pages<RawLabel>(
      `query($first: Int!, $after: String) { issueLabels(first: $first, after: $after, filter: { team: { null: true } }) {
        nodes { ${LABEL_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
      {},
      data => data.issueLabels
    );
    return {
      id: team.id,
      key: team.key,
      organization: team.organization.urlKey,
      // A team's label connection already carries some workspace labels; keep each label once.
      labels: [...new Map([...own, ...workspace].map(label => [label.id, label])).values()]
        .filter(label => !label.isGroup)
        .map(toLabel),
      states: team.states.nodes.map(state => ({ id: state.id, type: state.type as StateType, name: state.name })),
    };
  }

  async issue(teamKey: string, number: number): Promise<LinearIssue | null> {
    const data = await this.request<{ issues: { nodes: RawIssue[] } }>(
      `query($key: String!, $number: Float!) { issues(first: 5, includeArchived: true,
        filter: { team: { key: { eq: $key } }, number: { eq: $number } }) { nodes { ${ISSUE_FIELDS} } } }`,
      { key: teamKey, number },
      false
    );
    const raw = data.issues.nodes.find(node => !node.trashed);
    return raw ? toIssue(raw) : null;
  }

  async openIssuesWithLabel(teamKey: string, label: string): Promise<readonly LinearIssue[]> {
    const raw = await this.pages<RawIssue>(
      `query($key: String!, $label: String!, $first: Int!, $after: String) { issues(first: $first, after: $after,
        filter: { team: { key: { eq: $key } }, labels: { some: { name: { eq: $label } } },
                  state: { type: { nin: ["completed", "canceled"] } } }) {
        nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
      { key: teamKey, label },
      data => data.issues
    );
    return raw.filter(node => !node.trashed).map(toIssue);
  }

  async issuesStartingWith(teamKey: string, prefix: string): Promise<readonly LinearIssue[]> {
    // Archived issues count (a closed issue keeps its marker); trashed ones do not.
    const raw = await this.pages<RawIssue>(
      `query($key: String!, $prefix: String!, $first: Int!, $after: String) { issues(first: $first, after: $after,
        includeArchived: true, filter: { team: { key: { eq: $key } }, description: { startsWith: $prefix } }) {
        nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
      { key: teamKey, prefix },
      data => data.issues
    );
    return raw.filter(node => !node.trashed).map(toIssue);
  }

  /**
   * Up to 50 of the team's issues, open or closed, whose title or description contains
   * `term` (any case), most recently updated first. Only search.ts uses it: the forge
   * contract has no text search.
   */
  async searchIssues(teamKey: string, term: string): Promise<readonly LinearIssue[]> {
    const data = await this.request<{ issues: { nodes: RawIssue[] } }>(
      `query($key: String!, $term: String!) { issues(first: 50, includeArchived: true, orderBy: updatedAt,
        filter: { team: { key: { eq: $key } }, or: [{ title: { containsIgnoreCase: $term } },
                                                    { description: { containsIgnoreCase: $term } }] }) {
        nodes { ${ISSUE_FIELDS} } } }`,
      { key: teamKey, term },
      false
    );
    return data.issues.nodes.filter(node => !node.trashed).map(toIssue);
  }

  /** Every open issue of the team (not completed or canceled). Only items.ts uses it. */
  async openIssues(teamKey: string): Promise<readonly LinearIssue[]> {
    const raw = await this.pages<RawIssue>(
      `query($key: String!, $first: Int!, $after: String) { issues(first: $first, after: $after,
        filter: { team: { key: { eq: $key } }, state: { type: { nin: ["completed", "canceled"] } } }) {
        nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
      { key: teamKey },
      data => data.issues
    );
    return raw.filter(node => !node.trashed).map(toIssue);
  }

  /**
   * Each time a label was added to the issue, oldest first: the history entry's id, when,
   * who (Linear username, null for an integration), and the labels it added. Only items.ts
   * uses it, for the intake sweep's label requests.
   */
  async labelAdds(issueId: string): Promise<readonly { id: string; at: string; actor: string | null; labels: readonly string[] }[]> {
    type Entry = { id: string; createdAt: string; actor: { displayName: string } | null; addedLabels: { name: string }[] | null };
    const entries = await this.pages<Entry>(
      `query($id: String!, $first: Int!, $after: String) { issue(id: $id) { history(first: $first, after: $after) {
        nodes { id createdAt actor { displayName } addedLabels { name } } pageInfo { hasNextPage endCursor } } } }`,
      { id: issueId },
      data => data.issue.history
    );
    return entries
      .filter(entry => (entry.addedLabels ?? []).length > 0)
      .map(entry => ({ id: entry.id, at: entry.createdAt, actor: entry.actor?.displayName ?? null, labels: (entry.addedLabels ?? []).map(label => label.name) }))
      .sort((left, right) => left.at.localeCompare(right.at));
  }

  async addLabel(issueId: string, labelId: string): Promise<void> {
    await this.request(
      `mutation($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }`,
      { id: issueId, labelId },
      true
    );
  }

  async removeLabel(issueId: string, labelId: string): Promise<void> {
    await this.request(
      `mutation($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }`,
      { id: issueId, labelId },
      true
    );
  }

  async createIssue(teamId: string, title: string, description: string): Promise<LinearIssue> {
    const data = await this.request<{ issueCreate: { issue: RawIssue } }>(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { ${ISSUE_FIELDS} } } }`,
      { input: { teamId, title, description } },
      true
    );
    return toIssue(data.issueCreate.issue);
  }

  async updateIssue(id: string, update: IssueUpdate): Promise<LinearIssue> {
    const data = await this.request<{ issueUpdate: { issue: RawIssue } }>(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } } }`,
      { id, input: update },
      true
    );
    return toIssue(data.issueUpdate.issue);
  }

  async comments(issueId: string): Promise<readonly LinearComment[]> {
    const raw = await this.pages<RawComment>(
      `query($id: String!, $first: Int!, $after: String) { issue(id: $id) { comments(first: $first, after: $after) {
        nodes { ${COMMENT_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
      { id: issueId },
      data => data.issue.comments
    );
    return raw.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(toComment);
  }

  async createComment(issueId: string, body: string): Promise<LinearComment> {
    const data = await this.request<{ commentCreate: { comment: RawComment } }>(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { ${COMMENT_FIELDS} } } }`,
      { input: { issueId, body } },
      true
    );
    return toComment(data.commentCreate.comment);
  }

  async updateComment(id: string, body: string): Promise<LinearComment> {
    const data = await this.request<{ commentUpdate: { comment: RawComment } }>(
      `mutation($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { comment { ${COMMENT_FIELDS} } } }`,
      { id, input: { body } },
      true
    );
    return toComment(data.commentUpdate.comment);
  }

  async createLabel(teamId: string, name: string, color: string, description: string): Promise<LinearLabel> {
    const data = await this.request<{ issueLabelCreate: { issueLabel: RawLabel } }>(
      `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { ${LABEL_FIELDS} } } }`,
      { input: { teamId, name, color, description } },
      true
    );
    return toLabel(data.issueLabelCreate.issueLabel);
  }
}
