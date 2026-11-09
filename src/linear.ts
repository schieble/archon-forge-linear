/**
 * The small slice of Linear the plugin uses. The GraphQL client below implements it
 * against api.linear.app; tests use an in-memory fake (fake-linear.ts).
 *
 * A Linear team is the plugin's "repository" and a team's issue number is the work
 * item's number: ENG-12 is team ENG, number 12.
 */

/** Linear's workflow state types. Triage, backlog, unstarted and started are open. */
export type StateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

export interface LinearUser {
  readonly id: string;
  /** The user's Linear username, the closest thing Linear has to a login. */
  readonly displayName: string;
}

export interface LinearIssue {
  readonly id: string;
  readonly number: number;
  readonly teamKey: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly state: { readonly type: StateType; readonly name: string };
  readonly labels: readonly string[];
  readonly creator: LinearUser | null;
}

export interface LinearComment {
  readonly id: string;
  readonly body: string;
  readonly url: string;
  readonly user: LinearUser | null;
}

export interface LinearLabel {
  readonly id: string;
  readonly name: string;
  /** `#rrggbb`. */
  readonly color: string;
  readonly description: string | null;
}

export interface LinearState {
  readonly id: string;
  readonly type: StateType;
  readonly name: string;
}

export interface LinearTeam {
  readonly id: string;
  readonly key: string;
  /** The workspace's URL key: `acme` in linear.app/acme. */
  readonly organization: string;
  /** Labels an issue in this team can carry: the team's own and the workspace's. */
  readonly labels: readonly LinearLabel[];
  readonly states: readonly LinearState[];
}

export interface IssueUpdate {
  readonly description?: string;
  readonly labelIds?: readonly string[];
  readonly stateId?: string;
}

export interface LinearApi {
  team(key: string): Promise<LinearTeam | null>;
  /** Never an issue in Linear's trash. */
  issue(teamKey: string, number: number): Promise<LinearIssue | null>;
  /** The team's open issues carrying this label. */
  openIssuesWithLabel(teamKey: string, label: string): Promise<readonly LinearIssue[]>;
  /** The team's issues in every state whose description starts with this text, none in the trash. */
  issuesStartingWith(teamKey: string, prefix: string): Promise<readonly LinearIssue[]>;
  /** Returns the issue as Linear stored it. */
  createIssue(teamId: string, title: string, description: string): Promise<LinearIssue>;
  /** Returns the issue as Linear stored it. */
  updateIssue(id: string, update: IssueUpdate): Promise<LinearIssue>;
  /** Adds one label and leaves the issue's others alone. */
  addLabel(issueId: string, labelId: string): Promise<void>;
  /** Removes one label and leaves the issue's others alone. */
  removeLabel(issueId: string, labelId: string): Promise<void>;
  /** Oldest first, every page. */
  comments(issueId: string): Promise<readonly LinearComment[]>;
  createComment(issueId: string, body: string): Promise<LinearComment>;
  updateComment(id: string, body: string): Promise<LinearComment>;
  createLabel(teamId: string, name: string, color: string, description: string): Promise<LinearLabel>;
}

/** A Linear API answer that said the request was refused (bad input, no permission). */
export class LinearRefusal extends Error {}
