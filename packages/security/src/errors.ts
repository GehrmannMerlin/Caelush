export class SecurityPolicyInputError extends Error {
  constructor(message = "Security policy input is invalid.") {
    super(message);
    this.name = "SecurityPolicyInputError";
  }
}

export class SecurityPolicyInvariantError extends Error {
  constructor(message = "Security policy invariant was violated.") {
    super(message);
    this.name = "SecurityPolicyInvariantError";
  }
}
