const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "error", "cancelled"]);
const WAITING_JOB_STATUSES = new Set(["queued", "running"]);
const FAILED_JOB_STATUSES = new Set(["failed", "error"]);

export const WAIT_EXIT_CODES = Object.freeze({
  completed: 0,
  failed: 1,
  error: 1,
  invalid: 2,
  timeout: 124,
  cancelled: 130
});

export function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}

export function isWaitingJobStatus(status) {
  return WAITING_JOB_STATUSES.has(status);
}

export function isFailedJobStatus(status) {
  return FAILED_JOB_STATUSES.has(status);
}
