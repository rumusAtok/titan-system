import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { currentContext, type Logger } from '@titan/observability';
import { ZodError } from 'zod';

/** Business-rule failure with an HTTP status and a stable machine-readable code. */
export class DomainError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  static notFound(what: string): DomainError {
    return new DomainError(404, 'not_found', `${what} not found`);
  }
  static forbidden(message = 'not permitted'): DomainError {
    return new DomainError(403, 'forbidden', message);
  }
  static conflict(code: string, message: string): DomainError {
    return new DomainError(409, code, message);
  }
  static invalid(message: string, details?: unknown): DomainError {
    return new DomainError(400, 'validation_failed', message, details);
  }
}

interface ProblemBody {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  correlation_id?: string;
}

/** Maps a PostgreSQL error to a client-safe problem, or undefined for unexpected ones. */
function fromPgError(err: { code?: string; constraint?: string }): ProblemBody | undefined {
  switch (err.code) {
    case '23505':
      return { status: 409, code: 'conflict', message: 'a record with the same unique value already exists', details: { constraint: err.constraint } };
    case '23503':
      return { status: 409, code: 'reference_violation', message: 'the record references, or is referenced by, another record', details: { constraint: err.constraint } };
    case '23514':
      return { status: 400, code: 'constraint_violation', message: 'value violates a data constraint', details: { constraint: err.constraint } };
    case '22P02':
    case '22007':
    case '22003':
      return { status: 400, code: 'validation_failed', message: 'malformed value' };
    case '40001':
    case '40P01':
      return { status: 409, code: 'concurrent_update', message: 'the record was changed concurrently; retry' };
    case '57014':
      return { status: 504, code: 'timeout', message: 'the operation timed out' };
    default:
      return undefined;
  }
}

export function toProblem(exception: unknown): ProblemBody {
  if (exception instanceof DomainError) {
    return { status: exception.status, code: exception.code, message: exception.message, details: exception.details };
  }
  if (exception instanceof ZodError) {
    return {
      status: 400,
      code: 'validation_failed',
      message: 'request validation failed',
      details: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const res = exception.getResponse();
    const message = typeof res === 'string' ? res : ((res as { message?: unknown }).message ?? exception.message);
    const code =
      status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : 'http_error';
    return { status, code, message: Array.isArray(message) ? message.join('; ') : String(message) };
  }
  if (exception && typeof exception === 'object' && 'code' in exception) {
    const mapped = fromPgError(exception as { code?: string; constraint?: string });
    if (mapped) return mapped;
  }
  if (exception && typeof exception === 'object' && (exception as { type?: string }).type === 'entity.too.large') {
    return { status: 413, code: 'payload_too_large', message: 'request body too large' };
  }
  if (exception instanceof SyntaxError && 'body' in exception) {
    return { status: 400, code: 'validation_failed', message: 'malformed JSON body' };
  }
  return { status: 500, code: 'internal_error', message: 'internal server error' };
}

/** Uniform error responses; internal details never leave the service. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    const problem = toProblem(exception);
    problem.correlation_id = currentContext()?.correlationId;
    if (problem.status >= 500) {
      this.logger.error({ err: exception instanceof Error ? { message: exception.message, stack: exception.stack } : exception }, 'unhandled error');
    }
    if (res.headersSent) return;
    res.status(problem.status).json({ error: problem });
  }
}
