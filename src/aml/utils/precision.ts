const ASSET_PRECISION: Record<string, number> = {
  ETC: 1.0e-9,
  ETH: 1.0e-9,
  BTC: 1.0e-8,
  TetherOMNI: 1.0e-8,
  LTC: 1.0e-8,
  BCH: 1.0e-8,
  BSV: 1.0e-8,
  XRP: 1.0e-6,
  TRX: 1.0e-6,
  BSC: 1.0e-9,
  BASE: 1.0e-18,
  MATIC: 1.0e-18,
  DOGE: 1.0e-8,
  ZEC: 1.0e-8,
  ADA: 1.0e-6,
  SOL: 1.0e-9,
  ALGO: 1.0e-6,
  DOT: 1.0e-10,
  AVAX: 1.0e-18,
  ARB: 1.0e-18,
  XLM: 1.0e-7,
  TON: 1.0e-9,
  NEAR: 1.0e-24,
  XTZ: 1.0e-6,
  OP: 1.0e-18,
};

export function convertFractionToReal(
  asset: string,
  fractionAmount: string | number,
): string {
  if (!ASSET_PRECISION[asset]) throw new Error(`Unknown asset: ${asset}`);

  const precision = ASSET_PRECISION[asset];

  // Convert fractionAmount to string to safely handle very large numbers
  const amountStr = fractionAmount.toString();

  // Multiply manually as string to avoid BigInt issue with decimals
  const realAmount = Number(amountStr) * precision;

  // Return as string to preserve precision
  return realAmount.toString();
}

export function centsToUSD(cents) {
  return Number((cents / 100).toFixed(2));
}
