// Only the fields of GitHub REST responses that this server reads.

export interface GhUser {
  login: string;
}

export interface GhLabel {
  name: string;
}

export interface GhPullRequestRef {
  merged_at: string | null;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  state_reason?: string | null;
  html_url: string;
  comments: number;
  created_at: string;
  updated_at: string;
  user: GhUser | null;
  labels: Array<GhLabel | string>;
  assignees?: GhUser[] | null;
  draft?: boolean;
  pull_request?: GhPullRequestRef;
  repository_url?: string;
}

export interface GhComment {
  user: GhUser | null;
  created_at: string;
  body: string | null;
}

export interface GhSearchIssuesResponse {
  total_count: number;
  items: GhIssue[];
}

export interface GhTimelineEvent {
  event: string;
  source?: { type?: string; issue?: GhIssue };
}

export interface GhTextMatch {
  fragment: string;
}

export interface GhCodeItem {
  path: string;
  html_url: string;
  repository: { full_name: string };
  text_matches?: GhTextMatch[];
}

export interface GhSearchCodeResponse {
  total_count: number;
  items: GhCodeItem[];
}
