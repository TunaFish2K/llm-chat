export class StoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

