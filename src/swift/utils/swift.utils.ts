import { SwiftRawStatus, SwiftUnifiedStatus } from '../types/swift.types';

export class SwiftStatusMapper {
  static map(raw: string): SwiftUnifiedStatus {
    const mapping: Record<SwiftRawStatus, SwiftUnifiedStatus> = {
      [SwiftRawStatus.PDNG]: SwiftUnifiedStatus.PENDING,
      [SwiftRawStatus.ACSP]: SwiftUnifiedStatus.IN_PROGRESS,
      [SwiftRawStatus.ACSC]: SwiftUnifiedStatus.COMPLETED,
      [SwiftRawStatus.ACCC]: SwiftUnifiedStatus.COMPLETED,
      [SwiftRawStatus.RJCT]: SwiftUnifiedStatus.REJECTED,
      [SwiftRawStatus.CANC]: SwiftUnifiedStatus.CANCELLED,
    };

    return mapping[raw as SwiftRawStatus] ?? SwiftUnifiedStatus.UNKNOWN;
  }

  static description(unified: SwiftUnifiedStatus): string {
    const descriptions = {
      [SwiftUnifiedStatus.PENDING]:
        'Transaction is pending and awaiting next steps.',
      [SwiftUnifiedStatus.IN_PROGRESS]:
        'Transaction accepted and being processed through banks.',
      [SwiftUnifiedStatus.COMPLETED]: 'Funds have been fully settled.',
      [SwiftUnifiedStatus.REJECTED]: 'Transaction was rejected by the bank.',
      [SwiftUnifiedStatus.CANCELLED]: 'Transaction has been cancelled.',
      [SwiftUnifiedStatus.UNKNOWN]: 'Unknown status received from SWIFT.',
    };

    return descriptions[unified];
  }

  static isFinalStatus(unified: SwiftUnifiedStatus): boolean {
    return (
      unified === SwiftUnifiedStatus.COMPLETED ||
      unified === SwiftUnifiedStatus.REJECTED ||
      unified === SwiftUnifiedStatus.CANCELLED
    );
  }
}

export function getSwiftJobId(jobName: string, swiftCheckId: string) {
  return `${jobName}|${swiftCheckId}`;
}
