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
