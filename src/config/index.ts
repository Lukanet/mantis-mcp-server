import dotenv from 'dotenv';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';

// Get current file's directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define config schema
const ConfigSchema = z.object({
  // Mantis API config
  MANTIS_API_URL: z.string().url().default('https://mantisbt.org/bugs/api/rest'),
  MANTIS_API_KEY: z.string().optional(),

  // Application config
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // Cache config
  CACHE_ENABLED: z.coerce.boolean().default(true),
  CACHE_TTL_SECONDS: z.coerce.number().default(300), // 5 minutes

  // Logging config
  LOG_DIR: z.string().default(path.join(__dirname, '../../logs')),
  ENABLE_FILE_LOGGING: z.coerce.boolean().default(false),
});

// Try to load .env file; not required
try {
  dotenv.config();
} catch (error: unknown) {
  log.warn('Could not load .env file, using default config', {
    error: error instanceof Error ? error.message : String(error)
  });
}

// Parse environment variables
const parseConfig = () => {
  try {
    const parsedConfig = ConfigSchema.parse({
      MANTIS_API_URL: process.env.MANTIS_API_URL,
      MANTIS_API_KEY: process.env.MANTIS_API_KEY,
      NODE_ENV: process.env.NODE_ENV,
      LOG_LEVEL: process.env.LOG_LEVEL,
      CACHE_ENABLED: process.env.CACHE_ENABLED,
      CACHE_TTL_SECONDS: process.env.CACHE_TTL_SECONDS,
      LOG_DIR: process.env.LOG_DIR,
      ENABLE_FILE_LOGGING: process.env.ENABLE_FILE_LOGGING,
    });

    // If file logging is enabled, ensure log directory exists
    if (parsedConfig.ENABLE_FILE_LOGGING) {
      try {
        const logDir = path.resolve(parsedConfig.LOG_DIR);
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
      } catch (error: unknown) {
        log.warn('Could not create log directory; file logging will be disabled', {
          dir: parsedConfig.LOG_DIR,
          error: error instanceof Error ? error.message : String(error)
        });
        parsedConfig.ENABLE_FILE_LOGGING = false;
      }
    }

    // Log warnings but do not stop the program
    if (!parsedConfig.MANTIS_API_KEY) {
      log.warn('MANTIS_API_KEY not set; some API features may be unavailable');
    }

    if (parsedConfig.MANTIS_API_URL === 'https://mantisbt.org/bugs/api/rest') {
      log.warn('Using default MANTIS_API_URL; confirm if it needs to be changed');
    }

    return parsedConfig;
  } catch (error: unknown) {
    // Use defaults when config validation fails
    if (error instanceof z.ZodError) {
      log.warn('Config validation failed, using defaults:', {
        errors: error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
      });
      return ConfigSchema.parse({}); // Use all default values
    }

    // On other errors, use defaults
    log.error('Config parsing failed, using defaults', {
      error: error instanceof Error ? error.message : String(error)
    });
    return ConfigSchema.parse({});
  }
};

// Export config
export const config = parseConfig();

// Check if API Key is set
export const isMantisConfigured = () => {
  return !!config.MANTIS_API_KEY;
};

export default config;
