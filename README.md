# Mantis MCP Server

[![smithery badge](https://smithery.ai/badge/@lukanet/mantis-mcp-server)](https://smithery.ai/server/@lukanet/mantis-mcp-server)

Mantis MCP Server is an MCP (Model Context Protocol) service that integrates with Mantis Bug Tracker. It provides tools to query and analyze Mantis data over the MCP protocol.

<a href="https://glama.ai/mcp/servers/@lukanet/mantis-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@lukanet/mantis-mcp-server/badge" alt="Mantis Server MCP server" />
</a>

## Features

- **Issue management**
  - Get issue list (multiple filters)
  - Get issue details by ID
- **User management**
  - Get user by username
  - Get all users
- **Project management**
  - Get project list
- **Statistics**
  - Issue statistics (multiple dimensions)
  - Assignment statistics
- **Performance**
  - Field selection (reduce payload)
  - Pagination
  - Automatic compression for large responses
- Error handling and logging

## Installation

### Installing via Smithery

To install Mantis Bug Tracker Integration for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@lukanet/mantis-mcp-server):

```bash
npx -y @smithery/cli install @lukanet/mantis-mcp-server --client claude
```

### Manual Installation
```bash
npm install mantis-mcp-server
```

## Configuration

1. Create a `.env` file in the project root:

```bash
# Mantis API
MANTIS_API_URL=https://your-mantis-instance.com/api/rest
MANTIS_API_KEY=your_api_key_here

# Application
NODE_ENV=development  # development, production, test
LOG_LEVEL=info       # error, warn, info, debug

# Cache
CACHE_ENABLED=true
CACHE_TTL_SECONDS=300  # 5 minutes

# Logging
LOG_DIR=logs
ENABLE_FILE_LOGGING=false
```

### How to get a MantisBT API Key

1. Log in to your MantisBT account
2. Click your username (top right) and choose "My Account"
3. Open the "API Tokens" tab
4. Click "Create New Token"
5. Enter a token name (e.g. MCP Server)
6. Copy the API token and set it as `MANTIS_API_KEY` in `.env`

## MCP Configuration

### Global install

Install mantis-mcp-server globally:

```bash
npm install -g mantis-mcp-server
```

### Windows

Edit `%USERPROFILE%\.cursor\mcp.json` (e.g. `C:\Users\YourUsername\.cursor\mcp.json`) and add:

```json
{
  "mcpServers": {
    "mantis-mcp-server": {
      "type": "stdio",
      "command": "cmd",
      "args": [
        "/c",
        "node",
        "%APPDATA%\\npm\\node_modules\\mantis-mcp-server\\dist\\index.js"
      ],
      "env": {
        "MANTIS_API_URL": "YOUR_MANTIS_API_URL",
        "MANTIS_API_KEY": "YOUR_MANTIS_API_KEY",
        "NODE_ENV": "production",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### macOS/Linux

Edit `~/.cursor/mcp.json` and add:

```json
{
  "mcpServers": {
    "mantis-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "mantis-mcp-server@latest",
      ],
      "env": {
        "MANTIS_API_URL": "YOUR_MANTIS_API_URL",
        "MANTIS_API_KEY": "YOUR_MANTIS_API_KEY",
        "NODE_ENV": "production",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

> On macOS/Linux, using npx runs the latest mantis-mcp-server without a global install.

### Environment variables

- `MANTIS_API_URL`: Your Mantis API URL
- `MANTIS_API_KEY`: Your Mantis API key
- `NODE_ENV`: Environment; "production" recommended
- `LOG_LEVEL`: error, warn, info, debug

### Verify configuration

After configuring:

1. Reload Cursor MCP
2. Open Command Palette (Windows: Ctrl+Shift+P, Mac: Cmd+Shift+P)

## Cursor setup

1. Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "mantis-mcp-server": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/index.js"]
    }
  }
}
```

2. Add to `.vscode/launch.json` for debugging:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug MCP Server",
      "skipFiles": ["<node_internals>/**"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "runtimeExecutable": "npx",
      "runtimeArgs": [
        "-y",
        "@modelcontextprotocol/inspector",
        "node",
        "dist/index.js"
      ],
      "console": "integratedTerminal",
      "preLaunchTask": "npm: watch",
      "serverReadyAction": {
        "action": "openExternally",
        "pattern": "running at (https?://\\S+)",
        "uriFormat": "%s?timeout=60000"
      },
      "envFile": "${workspaceFolder}/.env"
    }
  ]
}
```

## API Tools

### 1. Get issues (get_issues)

Get Mantis issues with optional filters.

**Parameters:**
- `projectId` (optional): Project ID
- `statusId` (optional): Status ID
- `handlerId` (optional): Handler ID
- `reporterId` (optional): Reporter ID
- `search` (optional): Search keyword
- `pageSize` (optional, default 20): Page size
- `page` (optional, default 0): Pagination offset (from 1)
- `select` (optional): Fields to return, e.g. `['id', 'summary', 'description']` to reduce payload

### 2. Get issue by ID (get_issue_by_id)

Get Mantis issue details by ID.

**Parameters:**
- `issueId`: Issue ID

### 3. Get user (get_user)

Get Mantis user by username.

**Parameters:**
- `username`: Username

### 4. Get projects (get_projects)

Get Mantis project list.

**Parameters:** None

### 5. Get issue statistics (get_issue_statistics)

Get Mantis issue statistics by dimension.

**Parameters:**
- `projectId` (optional): Project ID
- `groupBy`: status, priority, severity, handler, reporter
- `period` (default 'all'): all, today, week, month

### 6. Get assignment statistics (get_assignment_statistics)

Get Mantis assignment statistics per user.

**Parameters:**
- `projectId` (optional): Project ID
- `includeUnassigned` (default true): Include unassigned issues
- `statusFilter` (optional): Only count issues in these statuses

### 7. Get all users (get_users)

Fetch all users (brute-force).

**Parameters:** None

## Code structure

### Higher-order function
The server uses `withMantisConfigured` to:
- Check Mantis API configuration
- Handle errors consistently
- Return a standard response shape
- Log automatically

### Error handling
- Mantis API errors (including HTTP status)
- Generic errors
- Structured error responses
- Detailed error logs

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run watch

# Run
npm start
```

## Logging

When file logging is enabled (`ENABLE_FILE_LOGGING=true`), logs are written to:

- `logs/mantis-mcp-server-combined.log`: all levels
- `logs/mantis-mcp-server-error.log`: errors only

Log files are rotated at 5MB, up to 5 files.

## License

MIT

## Reference

@https://documenter.getpostman.com/view/29959/7Lt6zkP#c0c24256-341e-4649-95cb-ad7bdc179399


# Publishing
npm login --registry=https://registry.npmjs.org/
npm run build
npm publish --access public --registry=https://registry.npmjs.org/

# Version
npm version patch  # 0.0.x
npm version minor  # 0.x.0
npm version major  # x.0.0

# Republish
npm publish
