import { z } from 'zod';

/**
 * Permissive UUID: any 8-4-4-4-12 hex string. zod v4's `z.uuid()` enforces an
 * RFC-4122 version nibble, which rejects the all-zero / structured ids used by
 * dev seeds and tests (and which Postgres' `uuid` type accepts perfectly well).
 * We only need "is this a uuid-shaped id", so this is the right strictness.
 */
export const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    'must be a UUID',
  );
