import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isMantisConfigured } from "./config/index.js";
import mantisApi, { MantisApiError, User } from "./services/mantisApi.js";
import { log } from "./utils/logger.js";
import { gzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);

// Compression threshold in bytes
const COMPRESSION_THRESHOLD = 1024 * 100; // 100KB

// Log data type
interface LogData {
  tool: string;
  [key: string]: any;
  error?: any;
}

// Higher-order function: check Mantis config and run tool logic
async function withMantisConfigured<T>(
  toolName: string,
  action: () => Promise<T>
): Promise<{
  [x: string]: unknown;
  content: Array<{
    [x: string]: unknown;
    type: "text";
    text: string;
  }>;
  _meta?: { [key: string]: unknown } | undefined;
  isError?: boolean | undefined;
}> {
  try {
    // Check if Mantis API is configured
    if (!isMantisConfigured()) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: "Mantis API is not configured",
                message: "Please set MANTIS_API_URL and MANTIS_API_KEY in environment variables"
              },
              null,
              2
            ),
          },
        ],
        isError: true
      };
    }

    // Execute tool logic
    const result = await action();
    return {
      content: [
        {
          type: "text",
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    // Handle errors
    let errorMessage = `Error occurred while executing ${toolName}`;
    let logData: LogData = { tool: toolName };

    if (error instanceof MantisApiError) {
      errorMessage = `Mantis API error: ${error.message}`;
      if (error.statusCode) {
        errorMessage += ` (HTTP ${error.statusCode})`;
        logData = { ...logData, statusCode: error.statusCode };
      }
      log.error(errorMessage, { ...logData, error: error.message });
    } else if (error instanceof Error) {
      errorMessage = error.message;
      log.error(errorMessage, { ...logData, error: error.stack });
    } else {
      log.error(errorMessage, { ...logData, error });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: errorMessage,
            },
            null,
            2
          ),
        },
      ],
      isError: true
    };
  }
}

// Compress JSON data
async function compressJsonData(data: any): Promise<string> {
  const jsonString = JSON.stringify(data);
  if (jsonString.length < COMPRESSION_THRESHOLD) {
    return jsonString;
  }

  const compressed = await gzipAsync(Buffer.from(jsonString));
  return compressed.toString('base64');
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "Mantis MCP Server",
    version: "0.1.0",
  });

  // Get issues list
  server.tool(
    "get_issues",
    "Get Mantis issues list with multiple filters; recommend using select: id, summary, description to avoid excessive data and possible errors",
    {
      projectId: z.number().optional().describe("Project ID"),
      statusId: z.number().optional().describe("Status ID"),
      handlerId: z.number().optional().describe("Handler ID"),
      reporterId: z.number().optional().describe("Reporter ID"),
      search: z.string().optional().describe("Search keyword"),
      pageSize: z.number().optional().default(20).describe("Page size"),
      page: z.number().optional().default(0).describe("Pagination offset, starting from 1"),
      select: z.array(z.string()).optional().describe("Fields to return, e.g. ['id', 'summary', 'description']"),
    },
    async (params) => {
      return withMantisConfigured("get_issues", async () => {
        const issues = await mantisApi.getIssues(params);
        const jsonString = JSON.stringify(issues);
        
        if (jsonString.length < COMPRESSION_THRESHOLD) {
          return jsonString;
        }

        const compressed = await gzipAsync(Buffer.from(jsonString));
        const base64Data = compressed.toString('base64');

        return JSON.stringify({
          compressed: true,
          data: base64Data,
          originalSize: jsonString.length,
          compressedSize: base64Data.length
        });
      });
    }
  );

  // Get issue details by ID
  server.tool(
    "get_issue_by_id",
    "Get Mantis issue details by ID",
    {
      issueId: z.number().describe("Issue ID"),
    },
    async ({ issueId }) => {
      return withMantisConfigured("get_issue_by_id", async () => {
        const issue = await mantisApi.getIssueById(issueId);
        return JSON.stringify(issue, null, 2);
      });
    }
  );

  // Get user by username
  server.tool(
    "get_user",
    "Get Mantis user by username",
    {
      username: z.string().describe("Username")
    },
    async (params) => {
      return withMantisConfigured("get_user", async () => {
        const user = await mantisApi.getUserByUsername(params.username);
        return JSON.stringify(user, null, 2);
      });
    }
  );

  // Get projects list
  server.tool(
    "get_projects",
    "Get Mantis projects list",
    {},
    async () => {
      return withMantisConfigured("get_projects", async () => {
        const projects = await mantisApi.getProjects();
        return JSON.stringify(projects, null, 2);
      });
    }
  );

  // Get issue statistics
  server.tool(
    "get_issue_statistics",
    "Get Mantis issue statistics by different dimensions",
    {
      projectId: z.number().optional().describe("Project ID"),
      groupBy: z.enum(['status', 'priority', 'severity', 'handler', 'reporter']).describe("Group by"),
      period: z.enum(['all', 'today', 'week', 'month']).default('all').describe("Time range: all, today, week, month"),
    },
    async (params) => {
      return withMantisConfigured("get_issue_statistics", async () => {
        // Fetch issues from Mantis API and compute statistics
        const issues = await mantisApi.getIssues({
          projectId: params.projectId,
          pageSize: 1000 // Fetch large dataset for statistics
        });

        // Build statistics result
        const statistics = {
          total: issues.length,
          groupedBy: params.groupBy,
          period: params.period,
          data: {} as Record<string, number>
        };

        // Filter by time range
        let filteredIssues = issues;
        log.debug("Filter issues by time range", { issues, params });
        
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        switch (params.period) {
          case 'today':
            filteredIssues = issues.filter(issue => {
              const createdAt = new Date(issue.created_at);
              return createdAt >= startOfDay;
            });
            break;
          case 'week':
            filteredIssues = issues.filter(issue => {
              const createdAt = new Date(issue.created_at);
              return createdAt >= startOfWeek;
            });
            break;
          case 'month':
            filteredIssues = issues.filter(issue => {
              const createdAt = new Date(issue.created_at);
              return createdAt >= startOfMonth;
            });
            break;
          case 'all':
          default:
            // Keep original issues unchanged
            break;
        }

        if (!filteredIssues || filteredIssues.length === 0) {
          return { error: "No issues found" };
        }

        // Aggregate by group
        filteredIssues.forEach(issue => {
          let key = '';

          switch (params.groupBy) {
            case 'status':
              key = issue.status?.name || 'unknown';
              break;
            case 'priority':
              key = issue.priority?.name || 'unknown';
              break;
            case 'severity':
              key = issue.severity?.name || 'unknown';
              break;
            case 'handler':
              key = issue.handler?.name || 'unassigned';
              break;
            case 'reporter':
              key = issue.reporter?.name || 'unknown';
              break;
          }

          statistics.data[key] = (statistics.data[key] || 0) + 1;
        });

        return JSON.stringify(statistics, null, 2);
      });
    }
  );

  // Get assignment statistics
  server.tool(
    "get_assignment_statistics",
    "Get Mantis assignment statistics per user",
    {
      projectId: z.number().optional().describe("Project ID"),
      includeUnassigned: z.boolean().default(true).describe("Include unassigned issues"),
      statusFilter: z.array(z.number()).optional().describe("Status filter: only count issues in these statuses"),
    },
    async (params) => {
      return withMantisConfigured("get_assignment_statistics", async () => {
        // Get issues
        const issues = await mantisApi.getIssues({
          projectId: params.projectId,
          pageSize: 1000 // Fetch large dataset for statistics
        });

        // Filter issues
        let filteredIssues = issues;
        if (params.statusFilter?.length) {
          filteredIssues = issues.filter(issue =>
            params.statusFilter?.includes(issue.status.id)
          );
        }

        // Build per-user issue statistics
        const userMap = new Map<number, {
          id: number;
          name: string;
          email: string;
          issueCount: number;
          openIssues: number;
          closedIssues: number;
          issues: number[];
        }>();

        // Collect all handler IDs from issues
        const handlerIds = new Set<number>();
        filteredIssues.forEach(issue => {
          if (issue.handler?.id) {
            handlerIds.add(issue.handler.id);
          }
        });

        // Fetch each handler's details and init statistics
        for (const handlerId of handlerIds) {
          const user = await mantisApi.getUser(handlerId);
          userMap.set(user.id, {
            id: user.id,
            name: user.name,
            email: user.email || '',
            issueCount: 0,
            openIssues: 0,
            closedIssues: 0,
            issues: []
          });
        }

        // Unassigned issues count
        let unassignedCount = 0;
        let unassignedIssues: number[] = [];

        // Compute statistics
        filteredIssues.forEach(issue => {
          if (issue.handler && issue.handler.id) {
            const userStat = userMap.get(issue.handler.id);
            if (userStat) {
              userStat.issueCount++;
              userStat.issues.push(issue.id);

              // Determine if status is closed
              if (issue.status.name.toLowerCase().includes('closed') ||
                issue.status.name.toLowerCase().includes('resolved')) {
                userStat.closedIssues++;
              } else {
                userStat.openIssues++;
              }
            }
          } else if (params.includeUnassigned) {
            unassignedCount++;
            unassignedIssues.push(issue.id);
          }
        });

        // Build result
        const statistics = {
          totalIssues: filteredIssues.length,
          assignedIssues: filteredIssues.length - unassignedCount,
          unassignedIssues: unassignedCount,
          userStatistics: Array.from(userMap.values())
            .filter(stat => stat.issueCount > 0)
            .sort((a, b) => b.issueCount - a.issueCount)
        };

        if (params.includeUnassigned && unassignedCount > 0) {
          statistics.userStatistics.push({
            id: 0,
            name: "Unassigned",
            email: "",
            issueCount: unassignedCount,
            openIssues: unassignedCount,
            closedIssues: 0,
            issues: unassignedIssues
          });
        }

        return JSON.stringify(statistics, null, 2);
      });
    }
  );

  // Get all users for a project
  server.tool(
    "get_users_by_project_id",
    "Get all users for the given project",
    {
      projectId: z.number().describe("Project ID"),
    },
    async (params) => {
      return withMantisConfigured("get_users_by_project_id", async () => {
        const users = await mantisApi.getUsersByProjectId(params.projectId);
        return JSON.stringify(users, null, 2);
      });
    }
  );

  // Get all users
  server.tool(
    "get_users",
    "Force-fetch all users (brute-force)",
    {},
    async () => {
      return withMantisConfigured("get_users", async () => {
        let notFoundCount = 0;
        let id = 1;
        let users: User[] = [];
        do {
          try {
            const user = await mantisApi.getUser(id);
            users.push(user);
            id++;
            notFoundCount = 0; // Reset counter
          } catch (error) {
            if (error instanceof MantisApiError && error.statusCode === 404) {
              notFoundCount++;
              id++;
            }
          }
        } while (notFoundCount < 10);
        return JSON.stringify(users, null, 2);
      });
    }
  );

  // Create issue
  server.tool(
    "create_issue",
    "Create a Mantis issue",
    {
      summary: z.string().describe("Issue summary"),
      description: z.string().describe("Issue description"),
      projectId: z.number().describe("Project ID"),
      categoryId: z.number().optional().describe("Category ID"),
      handlerId: z.number().optional().describe("Handler ID"),
      priority: z.string().optional().describe("Priority"),
      severity: z.string().optional().describe("Severity"),
      additional_information: z.string().optional().describe("Additional information"),
    },
    async (params) => {
      return withMantisConfigured("create_issue", async () => {
        const issueData = {
          summary: params.summary,
          description: params.description,
          project: { id: params.projectId },
          category: { id: params.categoryId || 1 }, // Default category
          handler: params.handlerId ? { id: params.handlerId } : undefined,
          priority: params.priority ? { name: params.priority } : undefined,
          severity: params.severity ? { name: params.severity } : undefined,
          additional_information: params.additional_information,
        };
        const issue = await mantisApi.createIssue(issueData);
        return JSON.stringify(issue, null, 2);
      });
    }
  );

  // Update issue
  server.tool(
    "update_issue",
    "Update a Mantis issue",
    {
      issueId: z.number().describe("Issue ID"),
      summary: z.string().optional().describe("Issue summary"),
      description: z.string().optional().describe("Issue description"),
      handlerId: z.number().optional().describe("Handler ID"),
      status: z.string().optional().describe("Status"),
      resolution: z.string().optional().describe("Resolution"),
      priority: z.string().optional().describe("Priority"),
      severity: z.string().optional().describe("Severity"),
    },
    async (params) => {
      return withMantisConfigured("update_issue", async () => {
        const updateData = {
          summary: params.summary,
          description: params.description,
          handler: params.handlerId ? { id: params.handlerId } : undefined,
          status: params.status ? { name: params.status } : undefined,
          resolution: params.resolution ? { name: params.resolution } : undefined,
          priority: params.priority ? { name: params.priority } : undefined,
          severity: params.severity ? { name: params.severity } : undefined,
        };
        const issue = await mantisApi.updateIssue(params.issueId, updateData);
        return JSON.stringify(issue, null, 2);
      });
    }
  );

  // Add issue note
  server.tool(
    "add_issue_note",
    "Add a note to a Mantis issue",
    {
      issueId: z.number().describe("Issue ID"),
      text: z.string().describe("Note text"),
      view_state: z.string().optional().default("public").describe("Visibility (public or private)"),
    },
    async (params) => {
      return withMantisConfigured("add_issue_note", async () => {
        const noteData = {
          text: params.text,
          view_state: { name: params.view_state },
        };
        const result = await mantisApi.addIssueNote(params.issueId, noteData);
        return JSON.stringify(result, null, 2);
      });
    }
  );

  return server;
}
