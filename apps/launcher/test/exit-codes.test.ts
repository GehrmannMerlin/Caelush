import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../src/exit-codes.js";

describe("product exit codes", () => {
  it("keeps the host contract centralized", () => {
    expect(EXIT_CODES).toEqual({
      SUCCESS: 0,
      DOCTOR_FAILURE: 1,
      USAGE: 2,
      BOOTSTRAP_FAILURE: 3,
      TERMINAL_FAILURE: 4,
      APPROVAL_REQUIRED: 5,
      TRANSPORT_FAILURE: 6,
      CANCELLED: 130,
    });
  });
});
