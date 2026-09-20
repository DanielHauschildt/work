export class WorkError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export function fail(message: string, exitCode = 1): never {
  throw new WorkError(message, exitCode);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
