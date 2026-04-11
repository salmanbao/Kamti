export class RetryPendingException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryPendingException';
  }
}
