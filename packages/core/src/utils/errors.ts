// packages/core/src/utils/errors.ts

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ModelError extends Error {
  constructor(
    message: string,
    public readonly provider?: string,
    public readonly model?: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }

  get isRateLimit(): boolean {
    return this.statusCode === 429;
  }

  get isTimeout(): boolean {
    return this.message.includes('timeout') || this.message.includes('ETIMEDOUT');
  }

  get isServerError(): boolean {
    return this.statusCode !== undefined && this.statusCode >= 500;
  }
}

export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly stepId?: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly operation?: string,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}
