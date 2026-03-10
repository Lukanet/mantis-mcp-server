#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config, isMantisConfigured } from "./config/index.js";
import { createServer } from "./server.js";
import { log } from "./utils/logger.js";

async function main() {
  // Output environment config
  log.info("=== Mantis MCP Server config ===", {
    api_url: config.MANTIS_API_URL,
    api_configured: isMantisConfigured(),
    environment: config.NODE_ENV,
    log_level: config.LOG_LEVEL,
    cache_enabled: config.CACHE_ENABLED,
    cache_ttl: config.CACHE_TTL_SECONDS,
    file_logging: config.ENABLE_FILE_LOGGING ? `Enabled (${config.LOG_DIR})` : 'Disabled'
  });

  if (!isMantisConfigured()) {
    log.warn("Mantis API not fully configured; some features may be unavailable");
  }

  const server: McpServer = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("Mantis MCP Server started on stdio");
}

main().catch((error) => {
  log.error("Fatal error in main process", { error: error.message, stack: error.stack });
  process.exit(1);
});
