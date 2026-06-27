import { z } from 'zod';
import { uuidSchema } from './ids.js';
import { membershipRoleSchema } from './roles.js';

export const userStatusSchema = z.enum(['active', 'suspended']);
export type UserStatus = z.infer<typeof userStatusSchema>;

/**
 * Human password (low-entropy) — hashed with bcrypt/argon2id server-side, NEVER
 * sha256 (that is reserved for high-entropy API-key secrets, ADR-0007).
 */
export const passwordSchema = z.string().min(8).max(200);

export const createUserRequestSchema = z
  .object({
    email: z.string().email().max(320),
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(200).optional(),
    role: membershipRoleSchema.default('member'),
  })
  .strict();
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    status: userStatusSchema.optional(),
    role: membershipRoleSchema.optional(),
    password: passwordSchema.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'at least one field is required',
  });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const userResponseSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  email: z.string().email(),
  displayName: z.string().nullable(),
  status: userStatusSchema,
  role: membershipRoleSchema,
  isPlatformOperator: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UserResponse = z.infer<typeof userResponseSchema>;
