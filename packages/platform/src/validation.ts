import { BadRequestException, createParamDecorator, type ExecutionContext, type PipeTransform } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { z } from 'zod';

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> | undefined {
  try {
    return z.toJSONSchema(schema, { target: 'openapi-3.0', unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Validates the JSON request body against a Zod schema at runtime and
 * documents the same schema in the service's OpenAPI description.
 * A ZodError is turned into a 400 by ProblemFilter.
 */
export function ZBody<T extends z.ZodType>(schema: T): ParameterDecorator {
  const decorate = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
    schema.parse(ctx.switchToHttp().getRequest().body ?? {}),
  )();
  return (target, key, index) => {
    decorate(target, key, index);
    const doc = jsonSchemaOf(schema);
    const descriptor = key ? Object.getOwnPropertyDescriptor(target, key) : undefined;
    if (doc && key && descriptor) ApiBody({ schema: doc as never })(target, key, descriptor);
  };
}

/** Validates (and coerces) query-string parameters against a Zod schema. */
export function ZQuery<T extends z.ZodType>(schema: T): ParameterDecorator {
  return createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
    schema.parse(ctx.switchToHttp().getRequest().query ?? {}),
  )();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `@Param('id', uuidParam)` — rejects non-UUID path parameters with a 400. */
export const uuidParam: PipeTransform<string, string> = {
  transform(value: string): string {
    if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestException('path parameter must be a UUID');
    return value.toLowerCase();
  },
};

/** Common list pagination. */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
