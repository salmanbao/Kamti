import { Logger } from '@nestjs/common';

/**
 * Standardized error handling utilities
 * Provides consistent error logging and handling patterns across services
 */

export interface ErrorContext {
  method: string;
  chainId?: number;
  address?: string;
  txHash?: string;
  [key: string]: any;
}

/**
 * Enhanced error logging with consistent format
 */
export function logError(
  logger: Logger,
  message: string,
  error: any,
  context?: ErrorContext,
): void {
  const errorDetails = {
    message: error?.message || 'Unknown error',
    stack: error?.stack,
    ...context,
  };

  logger.error(message, errorDetails);
}

/**
 * Standard try-catch wrapper with error logging
 */
export async function executeWithErrorHandling<T>(
  operation: () => Promise<T>,
  logger: Logger,
  errorMessage: string,
  context?: ErrorContext,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logError(logger, errorMessage, error, context);
    throw new Error(`${errorMessage}: ${error.message}`);
  }
}

/**
 * Validation wrapper with consistent error handling
 */
export function validateWithErrorHandling(
  validationFn: () => void,
  logger: Logger,
  context?: ErrorContext,
): void {
  try {
    validationFn();
  } catch (error) {
    logError(logger, 'Validation failed', error, context);
    throw error;
  }
}

/**
 * API error handling utility
 */
export function handleApiError(error: any, operation: string): never {
  if (error.response) {
    const statusCode = error.response.status;
    const data = error.response.data;
    throw new Error(
      `API error [${statusCode}] in ${operation}: ${data?.message || data || 'Unknown error'}`,
    );
  } else if (error.request) {
    throw new Error(`Network error in ${operation}: Request failed`);
  } else {
    throw new Error(`Error in ${operation}: ${error.message}`);
  }
}
