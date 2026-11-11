export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details);
export const unprocessable = (code: string, msg: string, details?: unknown) => new AppError(422, code, msg, details);
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);

/** Map database errors raised by our triggers/constraints to API errors. */
export function fromPgError(err: any): AppError | undefined {
  switch (err?.code) {
    case 'LG001':
      return conflict('PERIOD_CLOSED', err.message);
    case 'LG002':
      return unprocessable('UNBALANCED_ENTRY', err.message);
    case 'LG003':
      return conflict('IMMUTABLE', err.message);
    case 'LG004':
      return new AppError(500, 'ALLOCATION_INVARIANT', err.message);
    case 'LG005':
      return conflict('ENTRY_COMMITTED', err.message);
    case '23505':
      if (String(err.constraint).includes('reverses_entry_id')) {
        return conflict('ALREADY_REVERSED', 'entry has already been reversed');
      }
      if (String(err.constraint).includes('payment_reversals_pkey')) {
        return conflict('ALREADY_REVERSED', 'payment has already been reversed');
      }
      if (String(err.constraint).includes('payments_loan_id_reference')) {
        return conflict('DUPLICATE_REFERENCE', 'a payment with this bank reference already exists for this loan');
      }
      return conflict('DUPLICATE', err.detail ?? err.message);
    default:
      return undefined;
  }
}
