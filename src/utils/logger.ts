import winston from 'winston';
import path from 'path';
import { config } from '../config/index.js';

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);
const logLevel = process.env.LOG_LEVEL || 'info';
const enableFileLogging = process.env.ENABLE_FILE_LOGGING === 'true';
const logDir = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
/**
 * If ENABLE_FILE_LOGGING is false, logs are not written to files.
 * If LOG_DIR is set, logs are written to that directory.
 * If LOG_DIR is not set, logs are written to the logs directory.
 * If LOG_LEVEL is not set, info level is used.
 * If NODE_ENV is not set, development is used.
 */

// Create logger instance
export const log = winston.createLogger({
  level: logLevel || 'info',
  format: logFormat,
  transports: []  // Do not add any console output
});

// If file logging is enabled, add file transports
if (enableFileLogging) {

  // Add combined log file
  log.add(
    new winston.transports.File({
      filename: path.join(logDir, 'mantis-mcp-server-combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  );

  // Add error log file - handle error-level logs only
  log.add(
    new winston.transports.File({
      filename: path.join(logDir, 'mantis-mcp-server-error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  );
}
