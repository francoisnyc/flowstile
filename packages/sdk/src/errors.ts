export class TaskTimeoutError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Task ${taskId} was not completed within ${timeoutMs}ms`);
    this.name = 'TaskTimeoutError';
  }
}

export class TaskCancelledError extends Error {
  constructor(public readonly taskId: string) {
    super(`Task ${taskId} was cancelled`);
    this.name = 'TaskCancelledError';
  }
}

export class FlowstileApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly path: string,
    message: string,
  ) {
    super(`Flowstile API error ${statusCode} on ${path}: ${message}`);
    this.name = 'FlowstileApiError';
  }
}
