import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { config } from '../config/index.js';
import { log } from '../utils/logger.js';

export interface Issue {
  id: number;
  summary: string;
  description: string;
  status: {
    id: number;
    name: string;
  };
  project: {
    id: number;
    name: string;
  };
  category: {
    id: number;
    name: string;
  };
  reporter: {
    id: number;
    name: string;
    email: string;
  };
  handler?: {
    id: number;
    name: string;
    email: string;
  };
  priority?: {
    id: number;
    name: string;
  };
  severity?: {
    id: number;
    name: string;
  };
  created_at: string;
  updated_at: string;
}

export interface IssueSearchParams {
  projectId?: number;
  statusId?: number | string;
  handlerId?: number;
  reporterId?: number;
  priority?: number;
  severity?: number;
  category?: string;
  resolutionId?: number;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  pageSize?: number;
  page?: number;
  search?: string;
  select?: string[];
  countOnly?: boolean;
  idsOnly?: boolean;
}

/** Envelope returned by GET /issues. `issues` is absent when count_only is used. */
export interface IssueListResult {
  issues?: Issue[];
  total_count?: number;
  page_count?: number;
  warnings?: string[];
}

export interface FullTextSearchParams {
  q: string;
  projectId?: number | string;
  statusId?: number | string;
  handlerId?: number | string;
  category?: string;
  tagId?: number | string;
  clientName?: string;
  clientId?: string;
  dateFrom?: string;
  dateTo?: string;
  dateType?: number;
  lastUpdatedFrom?: string;
  lastUpdatedTo?: string;
  sortBy?: number;
  page?: number;
  pageSize?: number;
}

/** Row returned by the full-text search endpoint - a summary, not a full issue. */
export interface SearchHit {
  id: number;
  summary: string;
  status: number;
  priority: number;
  resolution: number;
  project_id: number;
  project_name: string;
  category_name: string | null;
  handler: string | null;
  handler_id: number;
  reporter: string | null;
  client_name: string | null;
  client_id: string | null;
  notes_count: number;
  date_submitted: string;
  last_updated: string;
  last_note: { user: string; text: string; date: string | null } | null;
}

export interface FullTextSearchResult {
  issues: SearchHit[];
  total_count: number;
  sphinx: {
    time: string | number;
    total_found: string | number;
    matches: number;
    truncated: boolean;
    words: Record<string, { docs: string | number; hits: string | number }>;
  } | null;
}

export interface BulkResult {
  results: Array<{ id: number; status: string; [key: string]: any }>;
  ok_count: number;
  error_count: number;
  /** Set when the batch was split across several requests. */
  chunks?: number;
  /** Set when the server only reported what it would have done. */
  dry_run?: boolean;
  /** Dry-run preview: what the batch resolved to. */
  issue_count?: number;
  ids?: number[];
  suppress_notifications?: boolean;
  tag?: string | null;
  patch?: any;
  notes?: Array<{ id: number; text_length: number }>;
}

export interface IssueFile {
  id: number;
  filename: string;
  size: number;
  content_type: string;
  created_at?: string;
  reporter?: { id: number; name: string };
  /** Base64. Only present when the file is fetched through /issues/{id}/files. */
  content?: string;
}

export interface User {
  id: number;
  name: string;
  email: string;
  real_name?: string;
  access_level?: {
    id: number;
    name: string;
  };
  enabled?: boolean;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  status: {
    id: number;
    name: string;
  };
}

export class MantisApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: any
  ) {
    super(message);
    this.name = 'MantisApiError';
  }
}

export class MantisApi {
  async getUserByUsername(username: string): Promise<User> {
    const cacheKey = `user_${username}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < 300000) {
      return cached.data;
    }

    try {
      const response = await this.api.get(`/users/username/${encodeURIComponent(username)}`);
      const user = response.data;

      this.cache.set(cacheKey, {
        data: user,
        timestamp: Date.now()
      });

      return user;
    } catch (error) {
      if (error instanceof MantisApiError) {
        throw error;
      }
      if (error instanceof Error) {
        throw new MantisApiError(`Failed to get user info: ${error.message}`);
      }
      throw new MantisApiError('Failed to get user info');
    }
  }
  private api: AxiosInstance;
  private cache: Map<string, { data: any; timestamp: number }> = new Map();

  constructor() {
    if (!config.MANTIS_API_URL) {
      log.error('Mantis API URL is not set');
      throw new Error('Mantis API URL is not set');
    }

    this.api = axios.create({
      baseURL: config.MANTIS_API_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        ...(config.MANTIS_API_KEY && { 'Authorization': config.MANTIS_API_KEY }),
      },
    });

    log.info('Mantis API client initialized', {
      baseURL: config.MANTIS_API_URL,
      timeout: 10000,
      hasApiKey: !!config.MANTIS_API_KEY
    });

    // Add request interceptor for error handling
    this.api.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response) {
          const errorMessage = `API error: ${error.response.status} ${error.response.statusText}`;
          log.error(errorMessage, {
            status: error.response.status,
            data: error.response.data,
            url: error.config?.url
          });
          throw new MantisApiError(
            errorMessage,
            error.response.status,
            error.response.data
          );
        } else if (error.request) {
          const errorMessage = 'No API response received';
          log.error(errorMessage, {
            url: error.config?.url,
            method: error.config?.method
          });
          throw new MantisApiError(errorMessage, 0);
        } else {
          const errorMessage = `Request error: ${error.message}`;
          log.error(errorMessage, {
            url: error.config?.url,
            error: error.message
          });
          throw new MantisApiError(errorMessage);
        }
      }
    );
  }

  // Wrap API call with cache
  private async cachedRequest<T>(
    key: string,
    requestFn: () => Promise<AxiosResponse<T>>
  ): Promise<T> {
    if (config.CACHE_ENABLED) {
      const cachedData = this.cache.get(key);
      const now = Date.now();
      
      // If cache is valid and not expired
      if (
        cachedData &&
        now - cachedData.timestamp < config.CACHE_TTL_SECONDS * 1000
      ) {
        log.debug('Using cached data', { key, age: (now - cachedData.timestamp) / 1000 });
        return cachedData.data;
      }
    }
    
    // No cache or cache expired, execute request
    log.debug('Sending API request', { key });
    const response = await requestFn();
    
    if (config.CACHE_ENABLED) {
      this.cache.set(key, {
        data: response.data,
        timestamp: Date.now(),
      });
      log.debug('Updating cache data', { key });
    }
    
    return response.data;
  }

  // Get issues list
  async getIssues(params: IssueSearchParams = {}): Promise<IssueListResult> {
    // Only the shape of the query is logged: values such as `search` are user
    // content and must not end up in the log.
    log.info('Fetching issues list', { params: Object.keys(params) });

    const query = new URLSearchParams();
    const pageSize = params.pageSize || 50;
    const page = params.page || 1;

    if (!params.countOnly) {
      query.set('page', String(page));
      query.set('page_size', String(pageSize));
    }

    if (params.projectId) query.set('project_id', String(params.projectId));
    if (params.statusId) query.set('status_id', String(params.statusId));
    if (params.handlerId) query.set('handler_id', String(params.handlerId));
    if (params.reporterId) query.set('reporter_id', String(params.reporterId));
    if (params.priority) query.set('priority_id', String(params.priority));
    if (params.severity) query.set('severity_id', String(params.severity));
    if (params.resolutionId) query.set('resolution_id', String(params.resolutionId));
    if (params.category) query.set('category', params.category);
    if (params.createdAfter) query.set('created_after', params.createdAfter);
    if (params.createdBefore) query.set('created_before', params.createdBefore);
    if (params.updatedAfter) query.set('updated_after', params.updatedAfter);
    if (params.updatedBefore) query.set('updated_before', params.updatedBefore);
    if (params.search) query.set('search', params.search);

    // count_only and fields=id are mutually exclusive shortcuts; count_only wins.
    if (params.countOnly) {
      query.set('count_only', '1');
    } else if (params.idsOnly) {
      query.set('fields', 'id');
    } else if (params.select?.length) {
      query.set('select', params.select.join(','));
    }

    const queryString = query.toString();
    const cacheKey = `issues-${queryString}`;

    return this.cachedRequest<IssueListResult>(cacheKey, () => {
      return this.api.get(`/issues?${queryString}`);
    });
  }

  // Full-text search through the Sphinx-backed plugin endpoint
  async searchIssues(params: FullTextSearchParams): Promise<FullTextSearchResult> {
    // Only the shape of the query is logged; `q` is user content.
    log.info('Full-text issue search', { params: Object.keys(params) });

    const query = new URLSearchParams();
    query.set('q', params.q);
    query.set('page', String(params.page || 1));
    query.set('page_size', String(params.pageSize || 25));

    if (params.projectId) query.set('project_id', String(params.projectId));
    if (params.statusId) query.set('status_id', String(params.statusId));
    if (params.handlerId) query.set('handler_id', String(params.handlerId));
    if (params.category) query.set('category', params.category);
    if (params.tagId) query.set('tag_id', String(params.tagId));
    if (params.clientName) query.set('client_name', params.clientName);
    if (params.clientId) query.set('client_id', params.clientId);
    if (params.dateFrom) query.set('date_from', params.dateFrom);
    if (params.dateTo) query.set('date_to', params.dateTo);
    if (params.dateType) query.set('date_type', String(params.dateType));
    if (params.lastUpdatedFrom) query.set('last_updated_from', params.lastUpdatedFrom);
    if (params.lastUpdatedTo) query.set('last_updated_to', params.lastUpdatedTo);
    if (params.sortBy) query.set('sort_by', String(params.sortBy));

    const queryString = query.toString();

    try {
      return await this.cachedRequest<FullTextSearchResult>(`search-${queryString}`, () => {
        return this.api.get(`/plugins/BarsySupport/search?${queryString}`);
      });
    } catch (error) {
      // The endpoint explains itself in the body (bad expression, Sphinx down);
      // the bare status line would hide that.
      if (error instanceof MantisApiError && error.response?.message) {
        throw new MantisApiError(error.response.message, error.statusCode, error.response);
      }
      throw error;
    }
  }

  // Get single issue details
  async getIssueById(issueId: number): Promise<Issue> {
    log.info('Fetching issue details', { issueId });
    
    const cacheKey = `issue-${issueId}`;
    
    return this.cachedRequest<Issue>(cacheKey, () => {
      return this.api.get(`/issues/${issueId}`);
    });
  }

  // Get one attachment with its content (base64). Not cached: files can be large.
  async getIssueFile(issueId: number, fileId: number): Promise<IssueFile> {
    log.info('Fetching issue attachment', { issueId, fileId });
    const response = await this.api.get(`/issues/${issueId}/files/${fileId}`, {
      // Attachments are bounded by the tracker's upload limit, not by our 30 s default.
      timeout: 120000,
      maxContentLength: Infinity,
    });
    // Older trackers ignore the file id and return every file of the issue.
    const files: IssueFile[] = response.data?.files ?? [];
    const file = files.find((f) => f.id === fileId);
    if (!file) {
      throw new MantisApiError(`Attachment ${fileId} not found on issue ${issueId}`, 404);
    }
    return file;
  }

  // Upload files to an issue, optionally as part of a new note so they show up under it.
  async uploadIssueFiles(
    issueId: number,
    files: Array<{ name: string; content: string }>,
    note?: { text: string; view_state: { name: string } }
  ): Promise<any> {
    log.info('Uploading issue attachments', {
      issueId,
      files: files.map((f) => f.name),
      withNote: !!note,
    });
    // Base64 bodies easily pass axios' 10 MB default; the tracker enforces its own limit.
    const options = { timeout: 120000, maxBodyLength: Infinity, maxContentLength: Infinity };
    const response = note
      ? await this.api.post(`/issues/${issueId}/notes`, { ...note, files }, options)
      : await this.api.post(`/issues/${issueId}/files`, { files }, options);
    this.clearCache(); // Cached issue still lists the old attachments
    return response.data;
  }

  // Get current user info
  async getCurrentUser(): Promise<User> {
    log.info('Fetching current user info');
    
    const cacheKey = 'current-user';
    
    return this.cachedRequest<User>(cacheKey, () => {
      return this.api.get('/users/me');
    });
  }

  // Get user info by ID
  async getUser(userId: number): Promise<User> {
    log.info('Fetching user info', { userId });

    if (!userId) {
      throw new MantisApiError('User ID is required');
    }
    
    const cacheKey = `user-${userId}`;
    
    return this.cachedRequest<User>(cacheKey, () => {
      return this.api.get(`/users/${userId}`);
    });
  }

  // Get projects list
  async getProjects(): Promise<Project[]> {
    log.info('Fetching projects list');
    
    const cacheKey = 'projects';
    
    return this.cachedRequest<Project[]>(cacheKey, () => {
      return this.api.get('/projects');
    });
  }

  // Get all users for project
  async getUsersByProjectId(projectId: number): Promise<User[]> {
    log.info('Fetching all users for project', { projectId });
    
    const cacheKey = `users-by-project-${projectId}`;
    
    return this.cachedRequest<User[]>(cacheKey, () => {
      return this.api.get(`/projects/${projectId}/users`);
    });
  }

  // Clear cache
  clearCache() {
    log.info('Clearing API cache');
    this.cache.clear();
  }

  // Create issue
  async createIssue(issueData: any): Promise<Issue> {
    log.info('Creating issue', { issueData });
    const response = await this.api.post('/issues', issueData);
    this.clearCache(); // Clear cache due to new issue
    return response.data.issue;
  }

  // Update issue
  async updateIssue(issueId: number, updateData: any): Promise<Issue> {
    log.info('Updating issue', { issueId, updateData });
    const response = await this.api.patch(`/issues/${issueId}`, updateData);
    this.clearCache(); // Clear cache because issue was updated
    // PATCH /issues/{id} answers with {"issues":[...]}, unlike POST /issues which answers with {"issue":...}.
    return response.data.issue ?? response.data.issues?.[0];
  }

  // Add issue note
  async addIssueNote(issueId: number, noteData: any): Promise<any> {
    log.info('Adding issue note', { issueId, fields: Object.keys(noteData || {}) });
    const response = await this.api.post(`/issues/${issueId}/notes`, noteData);
    this.clearCache(); // Clear cache because issue was updated
    return response.data;
  }

  // Link two issues
  async addRelationship(issueId: number, targetIssueId: number, type: string): Promise<any> {
    log.info('Adding issue relationship', { issueId, targetIssueId, type });
    const response = await this.api.post(`/issues/${issueId}/relationships`, {
      issue: { id: targetIssueId },
      type: { name: type },
    });
    this.clearCache();
    return response.data;
  }

  // Remove a link between two issues
  async deleteRelationship(issueId: number, relationshipId: number): Promise<any> {
    log.info('Deleting issue relationship', { issueId, relationshipId });
    const response = await this.api.delete(`/issues/${issueId}/relationships/${relationshipId}`);
    this.clearCache();
    return response.data;
  }

  // Apply the same field update to many issues, chunked to the server's limit
  async bulkUpdateIssues(
    ids: number[],
    issue: any,
    opts: BulkOptions = {}
  ): Promise<BulkResult> {
    log.info('Bulk updating issues', {
      count: ids.length,
      fields: Object.keys(issue || {}),
      ...opts,
    });
    return this.runChunked(ids, opts, (chunk) =>
      this.api.patch('/issues/bulk', {
        ids: chunk,
        issue,
        ...bulkBodyOptions(opts),
      })
    );
  }

  // Add a note to many issues. One shared text, or one text per issue.
  async bulkAddNote(
    entries: number[] | BulkNoteEntry[],
    note: any,
    opts: BulkOptions = {}
  ): Promise<BulkResult> {
    const perIssue = entries.length > 0 && typeof entries[0] !== 'number';
    log.info('Bulk adding note', {
      count: entries.length,
      perIssue,
      textLength: typeof note?.text === 'string' ? note.text.length : 0,
      ...opts,
    });

    if (!perIssue) {
      return this.runChunked(entries as number[], opts, (chunk) =>
        this.api.post('/issues/bulk/notes', {
          ids: chunk,
          note,
          ...bulkBodyOptions(opts),
        })
      );
    }

    return this.runChunked(entries as BulkNoteEntry[], opts, (chunk) =>
      this.api.post('/issues/bulk/notes', {
        issues: chunk.map((e) => ({
          id: e.id,
          note: { text: e.text, view_state: { name: e.view_state ?? 'public' } },
        })),
        ...bulkBodyOptions(opts),
      })
    );
  }

  /**
   * Split a batch into server-sized chunks and merge the responses.
   *
   * The REST endpoint caps a request at BULK_CHUNK issues. Making the caller do
   * that arithmetic is how a 600-issue job turns into a wrong loop, so the
   * splitting lives here and the merged result reads like a single call.
   *
   * A chunk that fails outright (network, 500) is recorded as an error entry per
   * issue rather than thrown, so one bad chunk cannot hide the work that did land.
   */
  private async runChunked<T extends number | BulkNoteEntry>(
    items: T[],
    opts: BulkOptions,
    send: (chunk: T[]) => Promise<{ data: BulkResult }>
  ): Promise<BulkResult> {
    const merged: BulkResult = { results: [], ok_count: 0, error_count: 0 };
    const chunkCount = Math.ceil(items.length / BULK_CHUNK);

    for (let i = 0; i < items.length; i += BULK_CHUNK) {
      const chunk = items.slice(i, i + BULK_CHUNK);
      try {
        const { data } = await send(chunk);
        if (data.dry_run) {
          // A dry run answers with a description of the work, not with results.
          // Merging only the counters would throw away the very thing the caller
          // asked for, so the preview is accumulated instead.
          merged.dry_run = true;
          merged.issue_count = (merged.issue_count ?? 0) + (data.issue_count ?? 0);
          merged.ids = [...(merged.ids ?? []), ...(data.ids ?? [])];
          merged.suppress_notifications = data.suppress_notifications;
          merged.tag = data.tag;
          if (data.patch !== undefined) {
            merged.patch = data.patch;
          }
          if (data.notes) {
            merged.notes = [...(merged.notes ?? []), ...data.notes];
          }
          continue;
        }
        merged.results.push(...(data.results ?? []));
        merged.ok_count += data.ok_count ?? 0;
        merged.error_count += data.error_count ?? 0;
      } catch (err: any) {
        const message = err?.response?.data?.message ?? err?.message ?? 'request failed';
        for (const item of chunk) {
          const id = typeof item === 'number' ? item : item.id;
          merged.results.push({ id, status: 'error', message });
          merged.error_count++;
        }
      }
    }

    if (chunkCount > 1) {
      merged.chunks = chunkCount;
    }
    this.clearCache();
    return merged;
  }
}

/** Maximum issues the REST endpoint accepts in one bulk request. */
const BULK_CHUNK = 100;

export interface BulkOptions {
  suppressNotifications?: boolean;
  tag?: string;
  dryRun?: boolean;
}

export interface BulkNoteEntry {
  id: number;
  text: string;
  view_state?: 'public' | 'private';
}

/** Map the camelCase options onto the snake_case fields the REST API expects. */
function bulkBodyOptions(opts: BulkOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    suppress_notifications: opts.suppressNotifications ?? false,
  };
  if (opts.tag) {
    body.tag = opts.tag;
  }
  if (opts.dryRun) {
    body.dry_run = true;
  }
  return body;
}

// Create singleton instance
export const mantisApi = new MantisApi();

export default mantisApi; 