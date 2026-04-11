export const SWIFT_APP_NAME = 'Swift Service';

export const SWIFT_QUEUE_NAME = 'swift-check';
export const SWIFT_JOBS = {
  CHECK_SWIFT: 'check-swift',
} as const;

export const SWIFT_CALLBACK_QUEUE_NAME = 'swift-callback';
export const SWIFT_CALLBACK_JOBS = {
  SEND_SWIFT_CALLBACK: 'send-swift-callback',
} as const;

export const DEFAULT_QUEUE_OPTIONS = {
  attempts: 3,
  removeOnComplete: true,
  removeOnFail: true,
} as const;

export const SWIFT_QUEUE_OPTIONS = DEFAULT_QUEUE_OPTIONS;
export const SWIFT_CALLBACK_QUEUE_OPTIONS = {
  backoff: { type: 'exponential', delay: 5000 },
  ...DEFAULT_QUEUE_OPTIONS,
} as const;
