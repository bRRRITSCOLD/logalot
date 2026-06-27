// Domain error taxonomy (pure). Each error carries the HTTP status the transport
// adapter maps it to, plus a stable machine-readable `code`. The domain never
// imports the transport; the HTTP layer reads `status`/`code` to shape responses.
// `expose` marks whether the message is safe to return to the client verbatim.

export class DomainError extends Error {
  readonly status: number;
  readonly code: string;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: { expose?: boolean; details?: unknown },
  ) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.expose = options?.expose ?? true;
    this.details = options?.details;
  }
}

// 400 — input failed a domain/validation invariant the boundary schema did not
// already reject.
export class ValidationError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(400, 'validation_error', message, { details });
  }
}

// 401 — the credential is missing, malformed, or did not verify. The message is
// deliberately generic so it never reveals whether the tenant/user existed.
export class UnauthorizedError extends DomainError {
  constructor(message = 'invalid credentials') {
    super(401, 'unauthorized', message);
  }
}

// 403 — authenticated, but the principal's role does not permit the operation.
export class ForbiddenError extends DomainError {
  constructor(message = 'forbidden') {
    super(403, 'forbidden', message);
  }
}

// 404 — resource not found. Crucially also returned when RLS makes a foreign
// tenant's row invisible, so cross-tenant probing is indistinguishable from a
// genuine miss.
export class NotFoundError extends DomainError {
  constructor(message = 'not found') {
    super(404, 'not_found', message);
  }
}

// 409 — a uniqueness/lifecycle conflict (e.g. duplicate email or slug).
export class ConflictError extends DomainError {
  constructor(message = 'conflict') {
    super(409, 'conflict', message);
  }
}
