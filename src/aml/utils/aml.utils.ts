import { AmlCheckResponse } from '@aml/services/aml.service';
import { AmlRiskStatus, AmlRiskStatusError } from '@aml/types/aml';
import { HttpStatus } from '@nestjs/common';

export const AML_RISK_SCORE_LOW_THRESHOLD = 50;
export const AML_RISK_SCORE_MEDIUM_THRESHOLD = 70;

const amlRiskStatuses = ['low', 'medium', 'high'] as const;

/**
 * ✅ Determine AML risk status based on risk score.
 *
 * @param {number|null} score - Risk score from API
 * @returns {"low"|"medium"|"high"|"unknown"}
 */
export function getAmlRiskStatus(
  score: number | null,
): AmlRiskStatus | 'unknown' {
  if (score === null || typeof score !== 'number') {
    return 'unknown';
  }

  if (score < AML_RISK_SCORE_LOW_THRESHOLD) return 'low'; // ✅ Safe
  if (score <= AML_RISK_SCORE_MEDIUM_THRESHOLD) return 'medium'; // ⚠️ Medium risk
  return 'high'; // 🔴 High risk
}

/**
 * Determines whether the given AML risk status should be considered a success.
 *
 * @param {string} status - AML risk status
 * @returns {boolean} - Whether the given status is a success
 */
export function getAmlSuccess(
  status: AmlRiskStatus | 'unknown' | 'error',
): boolean {
  switch (status) {
    case 'low':
    case 'medium':
      return true;
    default:
      return false;
  }
}

export function isAmlRiskStatus(status: string): status is AmlRiskStatus {
  return amlRiskStatuses.includes(status as any);
}

export function isFinalAmlStatus(status: string): status is AmlRiskStatus {
  return [...amlRiskStatuses, 'failed', 'error'].includes(status as any);
}

export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function _buildNonSuccessResponse(
  success = false,
  risk_status = 'error',
  message = 'AML check failed',
  statusCode = HttpStatus.BAD_REQUEST,
): AmlCheckResponse {
  return {
    success,
    score: null,
    risk_status: risk_status as AmlRiskStatusError,
    data: null,
    message,
    statusCode,
  };
}
