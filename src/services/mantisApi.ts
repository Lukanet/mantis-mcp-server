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
  statusId?: number;
  handlerId?: number;
  reporterId?: number;
  priority?: number;
  severity?: number;
  pageSize?: number;
  page?: number;
  search?: string;
  select?: string[];
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
      timeout: 10000,
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
  async getIssues(params: IssueSearchParams = {}): Promise<Issue[]> {
    log.info('Fetching issues list', { params });

    // Build filter URL
    let filter = '';
    if (params.projectId) filter += `&project_id=${params.projectId}`;
    if (params.statusId) filter += `&status_id=${params.statusId}`;
    if (params.handlerId) filter += `&handler_id=${params.handlerId}`;
    if (params.reporterId) filter += `&reporter_id=${params.reporterId}`;
    if (params.priority) filter += `&priority=${params.priority}`;
    if (params.severity) filter += `&severity=${params.severity}`;
    if (params.search) filter += `&search=${encodeURIComponent(params.search)}`;
    if (params.select?.length) filter += `&select=${params.select.join(',')}`;
    
    const pageSize = params.pageSize || 50;
    const page = params.page ||1;
    
    const cacheKey = `issues-${filter}-${page}-${pageSize}`;
    
    const response = await this.cachedRequest<{issues: Issue[]}>(cacheKey, () => {
      return this.api.get(`/issues?page=${page}&page_size=${pageSize}${filter}`);
    });

    return response.issues;
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
    return response.data.issue;
  }

  // Add issue note
  async addIssueNote(issueId: number, noteData: any): Promise<any> {
    log.info('Adding issue note', { issueId, noteData });
    const response = await this.api.post(`/issues/${issueId}/notes`, noteData);
    this.clearCache(); // Clear cache because issue was updated
    return response.data;
  }
}

// Create singleton instance
export const mantisApi = new MantisApi();

export default mantisApi; 