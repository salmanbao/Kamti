import * as crypto from 'crypto';

/**
 * Generates an HMAC SHA256 signature for a given payload and secret.
 *
 * @param payload - The request body or data to sign
 * @param secret - The company's secret key
 * @returns The generated hex-encoded signature
 */
export function generateSignature(
  payload: Record<string, any>,
  secret: string,
): string {
  if (!secret || typeof secret !== 'string') {
    throw new Error('Secret key is required to generate a signature');
  }

  const canonicalString = JSON.stringify(sortObject(payload));

  return crypto
    .createHmac('sha256', secret)
    .update(canonicalString)
    .digest('hex');
}

/**
 * Recursively sorts an object’s keys alphabetically to ensure deterministic signing.
 */
function sortObject(obj: any): any {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sortObject(item));
  }

  return Object.keys(obj)
    .sort()
    .reduce(
      (result, key) => {
        result[key] = sortObject(obj[key]);
        return result;
      },
      {} as Record<string, any>,
    );
}
