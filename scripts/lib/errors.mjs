export class UpfError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'UpfError';
    this.code = code;
    this.details = details;
  }
}
