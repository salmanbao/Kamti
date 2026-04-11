// coins.types.ts

export type Coin =
  | 'ETC'
  | 'ETH'
  | 'BTC'
  | 'TetherOMNI'
  | 'LTC'
  | 'BCH'
  | 'BSV'
  | 'XRP'
  | 'TRX'
  | 'BSC'
  | 'BASE'
  | 'MATIC'
  | 'DOGE'
  | 'ZEC'
  | 'ADA'
  | 'SOL'
  | 'ALGO'
  | 'DOT'
  | 'AVAX'
  | 'ARB'
  | 'XLM'
  | 'TON'
  | 'NEAR'
  | 'XTZ'
  | 'OP'
  | 'APT';

export interface CoinConfigResponse {
  result: boolean;
  coins: Record<string, Coin>;
  limitedCoins: Record<string, Coin>;
  coinsPrecisionRates: Record<Coin, number>;
  modesAssets: {
    advanced: Coin[];
    fast: Coin[];
    lite: Coin[];
  };
}
