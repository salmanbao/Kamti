export enum RequestEnviornment {
  PRODUCTION = 'production',
  SANDBOX = 'sandbox',
}

export enum SwiftRawStatus {
  ACSP = 'ACSP',
  ACSC = 'ACSC',
  ACCC = 'ACCC',
  PDNG = 'PDNG',
  RJCT = 'RJCT',
  CANC = 'CANC',
}

export enum SwiftUnifiedStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
  UNKNOWN = 'unknown',
}

export enum SwiftStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
}
