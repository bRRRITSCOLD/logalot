import type { ZodType, z } from 'zod';
import { ValidationError } from '../../domain/errors';

// parse validates untrusted input at the boundary with a zod schema and converts
// a failure into a domain ValidationError (→ 400). Centralizing this keeps every
// route's validation behavior identical (DRY) and ensures no unvalidated body ever
// reaches the application core.
export function parse<S extends ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError('request validation failed', result.error.issues);
  }
  return result.data;
}
