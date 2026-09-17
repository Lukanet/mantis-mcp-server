import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isMantisConfigured } from "./config/index.js";
import mantisApi, { MantisApiError, User } from "./services/mantisApi.js";
import { log } from "./utils/logger.js";
import { gzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);

const STATUS_IDS =
  "Status IDs: 10=new, 20=feedback, 30=acknowledged, 40=confirmed, 50=assigned, " +
  "60=wait_for_information, 80=resolved, 85=wait_for_update, 90=closed.";

const RESOLUTION_IDS =
  "Resolution IDs: 10=open, 20=fixed, 30=reopened, 40=unable to duplicate, 50=not fixable, " +
  "60=duplicate, 70=not a bug, 80=suspended, 90=wont fix.";

// The names the tracker accepts. A name outside these lists used to be silently
// resolved to 0 by the API and written to the issue, so it is rejected here.
const STATUS_NAMES = [
  'new', 'feedback', 'acknowledged', 'confirmed', 'assigned',
  'wait_for_information', 'resolved', 'wait_for_update', 'closed',
] as const;

const RESOLUTION_NAMES = [
  'open', 'fixed', 'reopened', 'unable to duplicate', 'not fixable',
  'duplicate', 'not a bug', 'suspended', 'wont fix',
] as const;

// Max number of issues the REST bulk endpoints accept in one request.
const BULK_MAX_ISSUES = 100;

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
    "List issues with server-side filters, newest first. " +
    "COST: cheap with countOnly (a count over the whole tracker takes well under a second) or " +
    "idsOnly (hundreds of ids in a fraction of a second) or a narrow select; " +
    "EXPENSIVE without select - each issue is returned in full, with every note and attachment record " +
    "attached, so one page of 50 issues can be hundreds of KB and overflow the response. " +
    "Always pass select (e.g. ['id','summary','status']) unless you genuinely need whole issues. " +
    "Workflow for large result sets: countOnly first to size the query, then idsOnly, then fetch details. " +
    "Returns total_count and page_count next to issues, plus warnings if the server ignored a parameter. " +
    "CANNOT: create or link issues, add notes, read or search attachment contents, or filter by custom fields " +
    "or tags - use create_issue / add_issue_relationship / get_issue_by_id for those.",
    {
      projectId: z.number().optional().describe("Project ID. Omit to search every project the token can see."),
      statusId: z.union([z.number(), z.string()]).optional().describe(
        STATUS_IDS + " Comma-separated string for several at once: '10,50'."
      ),
      handlerId: z.number().optional().describe("Handler (assignee) user ID. No value matches 'unassigned'; filter that client-side."),
      reporterId: z.number().optional().describe("Reporter user ID"),
      category: z.string().optional().describe("Category NAME as shown in get_projects (not the id), e.g. 'Грешка'"),
      resolutionId: z.number().optional().describe(RESOLUTION_IDS),
      search: z.string().optional().describe(
        "Free-text over summary, description and notes, matched with SQL LIKE - correct but slow (tens of " +
        "seconds on the whole tracker). Multiple words are ANDed: 'print error' matches only issues containing " +
        "both words (in any order, anywhere in the text), not either one. There is no OR, no phrase quoting, " +
        "no wildcard and no relevance ranking. PREFER search_issues for any text search: it is the same corpus " +
        "through a full-text index, ~50x faster, ranked, and it understands phrases, fields and boolean operators. " +
        "Use this one only to combine a text fragment with a filter search_issues does not offer (e.g. reporter_id), " +
        "or when you need whole issue objects back via select."
      ),
      createdAfter: z.string().optional().describe("Only issues created on/after this date, 'YYYY-MM-DD'. Can be used alone."),
      createdBefore: z.string().optional().describe("Only issues created before this date, 'YYYY-MM-DD'. Can be used alone."),
      updatedAfter: z.string().optional().describe("Only issues last modified on/after this date, 'YYYY-MM-DD'. Can be used alone."),
      updatedBefore: z.string().optional().describe(
        "Only issues last modified before this date, 'YYYY-MM-DD'. Use this to find stale issues - " +
        "never page through the whole tracker to filter by date yourself."
      ),
      pageSize: z.number().optional().default(20).describe("Issues per page. Keep it small unless select is set."),
      page: z.number().optional().default(1).describe("Page number, starting at 1"),
      select: z.array(z.string()).optional().describe(
        "Fields to return, e.g. ['id','summary','status','updated_at']. An unknown field is an error and the " +
        "response lists the valid ones. Strongly recommended - see the cost note above."
      ),
      countOnly: z.boolean().optional().describe(
        "Return only {total_count, page_count} and no issues. The cheapest way to size a query before running it."
      ),
      idsOnly: z.boolean().optional().describe(
        "Return only issue ids. Orders of magnitude faster than full objects for large pages. Overridden by countOnly. " +
        "Ids always come back ordered by id descending (newest first), not in the order a filter would sort them, " +
        "and select is ignored."
      ),
    },
    async (params) => {
      return withMantisConfigured("get_issues", async () => {
        const result = await mantisApi.getIssues(params);
        const jsonString = JSON.stringify(result);

        if (jsonString.length < COMPRESSION_THRESHOLD) {
          return jsonString;
        }

        const compressed = await gzipAsync(Buffer.from(jsonString));
        const base64Data = compressed.toString('base64');

        return JSON.stringify({
          compressed: true,
          data: base64Data,
          originalSize: jsonString.length,
          compressedSize: base64Data.length,
          total_count: result.total_count,
          page_count: result.page_count,
          warnings: result.warnings,
          hint: "Response was too large and had to be gzipped. Re-run with select or idsOnly instead."
        });
      });
    }
  );

  // Full-text search (Sphinx)
  server.tool(
    "search_issues",
    "Full-text search over issue titles, descriptions, notes and custom fields, ranked by relevance. " +
    "This is the fast way to find issues by what they SAY: the whole tracker is answered from a Sphinx index in " +
    "hundredths of a second, where get_issues with `search` runs a SQL LIKE and takes tens of seconds. " +
    "Prefer it for every 'find issues about X' question; fall back to get_issues only for pure metadata queries " +
    "(status/handler/date with no text) or filters this tool lacks. " +
    "QUERY SYNTAX (Sphinx extended): words are ANDed by default; \"exact phrase\" in double quotes; " +
    "field-scoped search with @title, @content, @custom_fields, @category_name, @username, @project_name; " +
    "`a | b` for OR and `-word` to exclude. Example: '@title фактура | сметка -тест'. " +
    "@custom_fields searches the client name attached to the issue, which is the quickest way to pull up " +
    "everything reported for one customer, e.g. '@custom_fields Вълшебна'. " +
    "RETURNS: summary rows (id, summary, status, project, handler, client, last note excerpt), not full issues - " +
    "follow up with get_issue_by_id for notes and relationships. Also returns total_count and a sphinx block; " +
    "when sphinx.truncated is true the daemon scored more documents (sphinx.total_found) than it returned, " +
    "so narrow the query instead of paging. " +
    "CANNOT: match substrings inside a word, filter by reporter, or return arbitrary issue fields.",
    {
      q: z.string().describe(
        "Full-text query in Sphinx extended syntax - see the syntax notes above. Required and must not be empty."
      ),
      projectId: z.union([z.number(), z.string()]).optional().describe(
        "Project ID, or a comma-separated list. Omit to search every project the token can see; " +
        "projects the user has no access to are dropped, never returned."
      ),
      statusId: z.union([z.number(), z.string()]).optional().describe(
        STATUS_IDS + " Comma-separated string for several at once: '10,50'."
      ),
      handlerId: z.union([z.number(), z.string()]).optional().describe("Handler (assignee) user ID, or a comma-separated list."),
      category: z.string().optional().describe("Category NAME as shown in get_projects, or a comma-separated list."),
      tagId: z.union([z.number(), z.string()]).optional().describe("Tag ID, or a comma-separated list."),
      clientName: z.string().optional().describe(
        "Exact value of the client custom field. For a partial or fuzzy client match use '@custom_fields <name>' in q instead."
      ),
      clientId: z.string().optional().describe("Exact client ID custom field value."),
      dateFrom: z.string().optional().describe("Lower bound for the date selected by dateType, 'YYYY-MM-DD'."),
      dateTo: z.string().optional().describe("Upper bound for the date selected by dateType, 'YYYY-MM-DD' (inclusive)."),
      dateType: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe(
        "Which date dateFrom/dateTo apply to: 1=created (default), 2=last updated, 3=note date."
      ),
      lastUpdatedFrom: z.string().optional().describe("Only issues last modified on/after this date, 'YYYY-MM-DD'."),
      lastUpdatedTo: z.string().optional().describe("Only issues last modified on/before this date, 'YYYY-MM-DD'."),
      sortBy: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe(
        "1=status then last update, 2=status then priority then last update (default), 3=full-text relevance. " +
        "Use 3 when the question is 'which issue is most about X'."
      ),
      page: z.number().optional().default(1).describe("Page number, starting at 1"),
      pageSize: z.number().optional().default(25).describe("Hits per page, capped at 1000 by the server."),
    },
    async (params) => {
      return withMantisConfigured("search_issues", async () => {
        const result = await mantisApi.searchIssues(params);
        return JSON.stringify(result, null, 2);
      });
    }
  );

  // Get issue details by ID
  server.tool(
    "get_issue_by_id",
    "Get one issue in full: all fields, every note, attachment metadata and relationships. " +
    "This is the only tool that shows an issue's relationships and note ids. " +
    "COST: proportional to the issue's history - a long-lived issue with many notes can exceed 100 KB, " +
    "so do not loop it over a list. For a few fields across many issues use get_issues with select.",
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
    "Resolve a single user by login name to their id, real name and access level. Cheap and cached. " +
    "CANNOT list or search users - use get_users_by_project_id for a project's members.",
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
    "List the projects the token can see, each with its categories, versions and custom field definitions. " +
    "Cheap and cached. Use it to resolve project and category ids before create_issue, and category NAMES " +
    "for the get_issues category filter.",
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
    "Count issues grouped by status, priority, severity, handler or reporter. " +
    "COST: high - it downloads up to 1000 full issues and aggregates them in the client, and the period " +
    "filter is applied after that download. It also silently truncates at 1000 issues, so on a big project " +
    "the numbers are a sample, not a total. For an exact total prefer get_issues with countOnly per group.",
    {
      projectId: z.number().optional().describe("Project ID"),
      groupBy: z.enum(['status', 'priority', 'severity', 'handler', 'reporter']).describe("Group by"),
      period: z.enum(['all', 'today', 'week', 'month']).default('all').describe("Time range: all, today, week, month"),
    },
    async (params) => {
      return withMantisConfigured("get_issue_statistics", async () => {
        // Fetch issues from Mantis API and compute statistics
        const issues = (await mantisApi.getIssues({
          projectId: params.projectId,
          pageSize: 1000 // Fetch large dataset for statistics
        })).issues ?? [];

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
    "Per-user workload: how many issues each handler holds, split open vs resolved/closed, plus the issue ids. " +
    "COST: high - downloads up to 1000 full issues and then one request per distinct handler; truncates at " +
    "1000 issues, so treat it as a sample on large projects.",
    {
      projectId: z.number().optional().describe("Project ID"),
      includeUnassigned: z.boolean().default(true).describe("Include unassigned issues"),
      statusFilter: z.array(z.number()).optional().describe("Status filter: only count issues in these statuses"),
    },
    async (params) => {
      return withMantisConfigured("get_assignment_statistics", async () => {
        // Get issues
        const issues = (await mantisApi.getIssues({
          projectId: params.projectId,
          pageSize: 1000 // Fetch large dataset for statistics
        })).issues ?? [];

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
    "List the users assigned to a project, with access levels. Cheap and cached - this is the right way to " +
    "find who can be a handler. Prefer it over get_users.",
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
    "Enumerate every user by probing user ids 1,2,3,... until 10 consecutive ids are missing, because the REST " +
    "API has no 'list users' endpoint. VERY EXPENSIVE: one sequential HTTP request per id - hundreds of " +
    "requests and tens of seconds on a real tracker - and it stops early at any gap of 10 deleted ids, so the " +
    "list can be incomplete. Use get_user or get_users_by_project_id instead whenever you can.",
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
    "Create an issue. Returns only the new issue's id and summary - read it back with get_issue_by_id if you " +
    "need the whole object. projectId and categoryId must come from get_projects; a wrong category is rejected.",
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
        // Deliberately terse: the API echoes the whole issue, which is large and rarely needed here.
        return JSON.stringify({
          ok: true,
          id: issue?.id,
          summary: issue?.summary,
          project_id: params.projectId,
          hint: "Use get_issue_by_id for the full issue."
        }, null, 2);
      });
    }
  );

  // Update issue
  server.tool(
    "update_issue",
    "Change fields on one issue. Only the parameters you pass are touched. " +
    "Returns a short confirmation (id, status, which fields changed), not the issue - fetch it with " +
    "get_issue_by_id if you need the full object. " +
    "For the same change across many issues use bulk_update_issues instead of looping. " + STATUS_IDS,
    {
      issueId: z.number().describe("Issue ID"),
      summary: z.string().optional().describe("Issue summary"),
      description: z.string().optional().describe("Issue description"),
      handlerId: z.number().optional().describe("Handler ID"),
      status: z.enum(STATUS_NAMES).optional().describe("New status name"),
      resolution: z.enum(RESOLUTION_NAMES).optional().describe("New resolution name"),
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
        const changed = Object.entries(updateData)
          .filter(([, value]) => value !== undefined)
          .map(([field]) => field);
        // Deliberately terse: the API echoes the whole issue including all notes and attachments.
        return JSON.stringify({
          ok: true,
          id: params.issueId,
          updated: changed,
          status: issue?.status?.name,
          hint: "Use get_issue_by_id for the full issue."
        }, null, 2);
      });
    }
  );

  // Add issue note
  server.tool(
    "add_issue_note",
    "Append a note (comment) to an issue. Returns a short confirmation (note id, issue id, visibility), not the " +
    "issue - the full issue with all its notes is only available via get_issue_by_id. " +
    "Notes cannot be edited or deleted through this server. For the same note on many issues use bulk_add_note.",
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
        // Deliberately terse: the API echoes the whole issue including all notes and attachments.
        return JSON.stringify({
          ok: true,
          issue_id: params.issueId,
          note_id: result?.note?.id,
          view_state: result?.note?.view_state?.name ?? params.view_state,
          hint: "Use get_issue_by_id for the full issue."
        }, null, 2);
      });
    }
  );

  // Link two issues
  server.tool(
    "add_issue_relationship",
    "Link two issues (duplicate-of, related-to, parent-of, ...). Cheap. " +
    "The relationship is created on both issues; read the resulting relationship id back with get_issue_by_id, " +
    "which is also the only way to list existing relationships.",
    {
      issueId: z.number().describe("Issue the relationship is added to (the source side)"),
      targetIssueId: z.number().describe("The other issue"),
      type: z.string().default("related-to").describe(
        "Relationship type as seen from issueId: 'related-to', 'duplicate-of', 'has-duplicate', " +
        "'parent-of', 'child-of'"
      ),
    },
    async (params) => {
      return withMantisConfigured("add_issue_relationship", async () => {
        const result = await mantisApi.addRelationship(params.issueId, params.targetIssueId, params.type);
        // The API answers with the whole issue; pick out just the relationship we created.
        const created = (result?.issue?.relationships ?? []).find(
          (rel: any) => rel?.issue?.id === params.targetIssueId && rel?.type?.name === params.type
        );
        return JSON.stringify({
          ok: true,
          issue_id: params.issueId,
          target_issue_id: params.targetIssueId,
          type: params.type,
          relationship_id: created?.id,
          hint: "Pass relationship_id to delete_issue_relationship to undo this."
        }, null, 2);
      });
    }
  );

  // Unlink two issues
  server.tool(
    "delete_issue_relationship",
    "Remove a link between two issues. Cheap. " +
    "Needs the relationship id, not the other issue's id - get it from get_issue_by_id.",
    {
      issueId: z.number().describe("Issue the relationship belongs to"),
      relationshipId: z.number().describe("Relationship ID from get_issue_by_id (NOT the related issue's ID)"),
    },
    async (params) => {
      return withMantisConfigured("delete_issue_relationship", async () => {
        await mantisApi.deleteRelationship(params.issueId, params.relationshipId);
        return JSON.stringify({
          ok: true,
          issue_id: params.issueId,
          relationship_id: params.relationshipId,
          deleted: true,
        }, null, 2);
      });
    }
  );

  // Bulk field update
  server.tool(
    "bulk_update_issues",
    `Apply the same field change to up to ${BULK_MAX_ISSUES} issues in ONE request. ` +
    "Much cheaper than looping update_issue, and suppressNotifications avoids a mail storm on big batches. " +
    "Returns per-issue ok/error plus counts - always check error_count, a partial failure is normal. " +
    "NOT atomic: if the request is interrupted the issues already processed stay changed. " +
    "Get the ids from get_issues with idsOnly. " + STATUS_IDS,
    {
      issueIds: z.array(z.number()).max(BULK_MAX_ISSUES).describe(`Issue IDs, max ${BULK_MAX_ISSUES} per call`),
      status: z.enum(STATUS_NAMES).optional().describe("New status name, e.g. 'closed'"),
      resolution: z.enum(RESOLUTION_NAMES).optional().describe("New resolution name, e.g. 'fixed'"),
      handlerId: z.number().optional().describe("New handler user ID"),
      priority: z.string().optional().describe("New priority name"),
      severity: z.string().optional().describe("New severity name"),
      suppressNotifications: z.boolean().optional().default(false).describe(
        "Do not send e-mail for these changes. Recommended for large batches."
      ),
    },
    async (params) => {
      return withMantisConfigured("bulk_update_issues", async () => {
        const issue = {
          status: params.status ? { name: params.status } : undefined,
          resolution: params.resolution ? { name: params.resolution } : undefined,
          handler: params.handlerId ? { id: params.handlerId } : undefined,
          priority: params.priority ? { name: params.priority } : undefined,
          severity: params.severity ? { name: params.severity } : undefined,
        };
        const result = await mantisApi.bulkUpdateIssues(
          params.issueIds,
          issue,
          params.suppressNotifications
        );
        return JSON.stringify(result, null, 2);
      });
    }
  );

  // Bulk note
  server.tool(
    "bulk_add_note",
    `Add the same note to up to ${BULK_MAX_ISSUES} issues in ONE request. ` +
    "Much cheaper than looping add_issue_note. Returns per-issue ok/error plus counts - check error_count. " +
    "NOT atomic: if the request is interrupted the notes already added stay.",
    {
      issueIds: z.array(z.number()).max(BULK_MAX_ISSUES).describe(`Issue IDs, max ${BULK_MAX_ISSUES} per call`),
      text: z.string().describe("Note text, added verbatim to every issue"),
      view_state: z.enum(['public', 'private']).optional().default("public").describe("Visibility"),
      suppressNotifications: z.boolean().optional().default(false).describe(
        "Do not send e-mail for these notes. Recommended for large batches."
      ),
    },
    async (params) => {
      return withMantisConfigured("bulk_add_note", async () => {
        const result = await mantisApi.bulkAddNote(
          params.issueIds,
          {
            text: params.text,
            view_state: { name: params.view_state },
          },
          params.suppressNotifications
        );
        return JSON.stringify(result, null, 2);
      });
    }
  );

  return server;
}
