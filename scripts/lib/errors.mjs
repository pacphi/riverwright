export class RiverwrightError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RiverwrightError';
    this.code = code;
    this.details = details;
  }
}
