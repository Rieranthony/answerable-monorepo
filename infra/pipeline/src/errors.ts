/** The command line is wrong: a missing option or variable, or a value that cannot be right. Exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

/** A step of the pipeline failed. The message says which and why. Exit code 1. */
export class PipelineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PipelineError"
  }
}
