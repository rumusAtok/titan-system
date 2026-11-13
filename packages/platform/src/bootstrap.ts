import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import type { INestApplication, LoggerService, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createLogger, httpObservability, type Logger, startDefaultMetrics } from '@titan/observability';
import { loadConfig } from './config.js';
import { ProblemFilter } from './errors.js';
import { runMigrations } from './migrate.js';

export interface BootstrapOptions {
  module: Type<unknown>;
  title: string;
  description: string;
  /** `new URL('../migrations', import.meta.url)` of the service, when it owns a database. */
  migrations?: URL;
  /** JSON body size limit (default 256kb). */
  jsonLimit?: string;
  /** false leaves request bodies unparsed (the gateway forwards them as-is). */
  jsonBody?: boolean;
  /** Hook to add middleware before the app starts listening. */
  configure?: (app: NestExpressApplication) => void | Promise<void>;
}

class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}
  log(message: unknown, context?: string) {
    this.logger.debug({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    this.logger.trace({ context }, String(message));
  }
}

/** Builds the OpenAPI document of a running application. */
export function buildOpenApi(app: INestApplication, title: string, description: string) {
  const doc = new DocumentBuilder().setTitle(title).setDescription(description).setVersion('0.1.0').addBearerAuth().build();
  const document = SwaggerModule.createDocument(app, doc);
  document.security = [{ bearer: [] }];
  return document;
}

/** Starts a TITAN service: migrations, HTTP server, observability, OpenAPI, graceful shutdown. */
export async function bootstrapService(options: BootstrapOptions): Promise<NestExpressApplication> {
  const config = loadConfig();
  const logger = createLogger(config.SERVICE_NAME);
  startDefaultMetrics(config.SERVICE_NAME);

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason }, 'unhandled promise rejection');
  });

  if (options.migrations && config.MIGRATE_ON_START) {
    if (!config.DATABASE_OWNER_URL) throw new Error('DATABASE_OWNER_URL is required to run migrations');
    const applied = await runMigrations({
      ownerUrl: config.DATABASE_OWNER_URL,
      serviceDir: fileURLToPath(options.migrations),
      appRole: config.DB_APP_ROLE,
      logger,
    });
    logger.info({ applied: applied.length }, 'database migrations up to date');
  }

  const app = await NestFactory.create<NestExpressApplication>(options.module, {
    logger: new NestPinoLogger(logger),
    bodyParser: false,
  });
  app.disable('x-powered-by');
  app.use(httpObservability(logger));
  if (options.jsonBody ?? true) app.useBodyParser('json', { limit: options.jsonLimit ?? '256kb' });
  app.useGlobalFilters(new ProblemFilter(logger));
  app.enableShutdownHooks();
  if (options.configure) await options.configure(app);

  SwaggerModule.setup('docs', app, buildOpenApi(app, options.title, options.description), { jsonDocumentUrl: 'docs-json' });

  await app.listen(config.PORT, '0.0.0.0');
  logger.info({ port: config.PORT }, `${config.SERVICE_NAME} listening`);
  return app;
}
