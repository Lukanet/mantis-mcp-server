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

export interface BulkResult {
  results: Array<{ id: number; status: string; [key: string]: any }>;
  ok_count: number;
  error_count: number;
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

  // Get single issue details
  async getIssueById(issueId: number): Promise<Issue> {
    log.info('Fetching issue details', { issueId });
    
    const cacheKey = `issue-${issueId}`;
    
    return this.cachedRequest<Issue>(cacheKey, () => {
      return this.api.get(`/issues/${issueId}`);
    });
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

  // Apply the same field update to many issues in one request
  async bulkUpdateIssues(ids: number[], issue: any, suppressNotifications = false): Promise<BulkResult> {
    log.info('Bulk updating issues', {
      count: ids.length,
      fields: Object.keys(issue || {}),
      suppressNotifications,
    });
    const response = await this.api.patch('/issues/bulk', {
      ids,
      issue,
      suppress_notifications: suppressNotifications,
    });
    this.clearCache();
    return response.data;
  }

  // Add the same note to many issues in one request
  async bulkAddNote(ids: number[], note: any, suppressNotifications = false): Promise<BulkResult> {
    log.info('Bulk adding note', {
      count: ids.length,
      textLength: typeof note?.text === 'string' ? note.text.length : 0,
      suppressNotifications,
    });
    const response = await this.api.post('/issues/bulk/notes', {
      ids,
      note,
      suppress_notifications: suppressNotifications,
    });
    this.clearCache();
    return response.data;
  }
}

// Create singleton instance
export const mantisApi = new MantisApi();

export default mantisApi; 