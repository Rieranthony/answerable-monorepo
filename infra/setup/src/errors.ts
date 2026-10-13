/** The command line is wrong: a missing option or variable, or a value that cannot be right. Exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

/** A step failed, or a file or secret is in the way. The message says which and why, never a secret. Exit code 1. */
export class SetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SetupError"
  }
}
