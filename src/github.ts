// Small GitHub REST client: global fetch, injectable fetch/sleep/clock,
// and bounded rate-limit handling.

export type ErrorKind =
  | 'not_found'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'validation'
  | 'network'
  | 'http';

export class GitHubError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface ClientOptions {
  token?: string;
  fetch?: typeof fetch;
  /** Injected in tests so they never really sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds since epoch. Injected in tests. */
  now?: () => number;
  /** Longest rate-limit wait we will sit through. Default 10 s. */
  maxWaitMs?: number;
  /** Maximum number of retries after a rate-limit response. Default 2. */
  maxRetries?: number;
  baseUrl?: string;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  accept?: string;
  /** "json" (default) parses the body; "text" returns it as a string. */
  as?: 'json' | 'text';
}

const API_VERSION = '2022-11-28';
const DEFAULT_MAX_WAIT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;

export class GitHubClient {
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxWaitMs: number;
  private readonly maxRetries: number;
  private readonly baseUrl: string;

  constructor(options: ClientOptions = {}) {
    this.token = options.token || undefined;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseUrl = options.baseUrl ?? 'https://api.github.com';
  }

  async getJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.request(path, { ...options, as: 'json' })) as T;
  }

  async getText(path: string, options: RequestOptions = {}): Promise<string> {
    return (await this.request(path, { ...options, as: 'text' })) as string;
  }

  private async request(path: string, options: RequestOptions): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Accept: options.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'triage-mcp',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { headers });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new GitHubError('network', `Could not reach GitHub: ${reason}`);
      }

      if (response.ok) {
        return options.as === 'text' ? response.text() : response.json();
      }

      if (response.status === 403 || response.status === 429) {
        const resetAt = this.rateLimitResetAt(response);
        if (resetAt !== null) {
          const waitMs = Math.max(0, resetAt - this.now());
          if (waitMs > this.maxWaitMs) throw this.rateLimitError(resetAt);
          if (attempt >= this.maxRetries) {
            throw new GitHubError(
              'rate_limited',
              `GitHub rate limit still in effect after ${this.maxRetries} retries.`,
              response.status,
            );
          }
          await this.sleep(waitMs);
          continue;
        }
      }
      throw await this.errorFor(response);
    }
  }

  /**
   * Returns the epoch ms at which a rate-limited request may be retried, or
   * null if this response is not a rate-limit response.
   */
  private rateLimitResetAt(response: Response): number | null {
    const retryAfter = Number(response.headers.get('retry-after'));
    if (response.headers.has('retry-after') && Number.isFinite(retryAfter)) {
      return this.now() + retryAfter * 1000;
    }
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) {
      return reset * 1000;
    }
    return null;
  }

  private rateLimitError(resetAt: number): GitHubError {
    const seconds = Math.ceil((resetAt - this.now()) / 1000);
    const hint = this.token ? '' : ' Set GITHUB_TOKEN to get a higher limit.';
    return new GitHubError(
      'rate_limited',
      `GitHub rate limit reached. It resets at ${new Date(resetAt).toISOString()} ` +
        `(in about ${seconds} seconds), which is longer than the ` +
        `${this.maxWaitMs / 1000} s this server will wait.${hint}`,
      429,
    );
  }

  private async errorFor(response: Response): Promise<GitHubError> {
    let detail = '';
    try {
      const body = (await response.json()) as { message?: string };
      detail = body.message ?? '';
    } catch {
      // Body was not JSON; the status code is enough.
    }
    const suffix = detail ? `: ${detail}` : '';
    switch (response.status) {
      case 404:
        return new GitHubError(
          'not_found',
          `Not found${suffix}. The repository or item may not exist, or it may be private.`,
          404,
        );
      case 401:
        return new GitHubError(
          'unauthorized',
          `GitHub requires authentication for this request${suffix}. Set a valid GITHUB_TOKEN.`,
          401,
        );
      case 403:
        return new GitHubError('forbidden', `GitHub refused the request${suffix}`, 403);
      case 422:
        return new GitHubError(
          'validation',
          `GitHub rejected the request as invalid${suffix}`,
          422,
        );
      case 429:
        return new GitHubError(
          'rate_limited',
          `GitHub rate limit reached (no reset time given)${suffix}`,
          429,
        );
      default:
        return new GitHubError(
          'http',
          `GitHub returned HTTP ${response.status}${suffix}`,
          response.status,
        );
    }
  }
}
