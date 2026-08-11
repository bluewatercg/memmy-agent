import type { ApiErrorBody } from "../types.js";

export class MemoryServiceError extends Error {
  readonly code: ApiErrorBody["error"]["code"];
  readonly status: number;
  readonly requestId?: string;
  readonly details?: unknown;
  constructor(
    code: ApiErrorBody["error"]["code"],
    message: string,
    status = statusForCode(code),
    requestId?: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "MemoryServiceError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, requestId: this.requestId }, ...(this.details === undefined ? {} : { details: this.details }) } as ApiErrorBody;
  }
}

export function statusForCode(code: ApiErrorBody["error"]["code"]): number {
  switch (code) {
    case "invalid_argument":
      return 400;
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "rate_limited":
      return 429;
    default:
      return 500;
  }
}
