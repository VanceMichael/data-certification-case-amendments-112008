export class PortalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PortalError';
    this.code = code;
    this.details = details;
  }
}

export function errorPayload(error) {
  if (error instanceof PortalError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: 'unexpected', message: error instanceof Error ? error.message : String(error), details: {} };
}
