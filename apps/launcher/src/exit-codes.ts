export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  DOCTOR_FAILURE: 1,
  USAGE: 2,
  BOOTSTRAP_FAILURE: 3,
  TERMINAL_FAILURE: 4,
  APPROVAL_REQUIRED: 5,
  TRANSPORT_FAILURE: 6,
  CANCELLED: 130,
});

export type ProductExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
