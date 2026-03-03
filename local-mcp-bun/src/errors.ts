import { generate_correlation_id } from "./id";
import type { error_code, tool_error_payload } from "./types";

export class tool_error extends Error {
  public readonly code: error_code;
  public readonly retryable: boolean;
  public readonly details?: Record<string, unknown>;
  public readonly correlation_id: string;

  public constructor(
    code: error_code,
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>,
    correlation_id?: string,
  ) {
    super(message);
    this.name = "tool_error";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.correlation_id = correlation_id ?? generate_correlation_id();
  }

  public to_payload(): tool_error_payload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
      correlation_id: this.correlation_id,
    };
  }
}

export function to_tool_error(error: unknown): tool_error {
  if (error instanceof tool_error) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new tool_error("ATTACH_FAILED", message, false);
}
