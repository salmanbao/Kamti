import { TransactionDirection } from '@aml/services/provider/aml-provider.service';

export type AmlBotResponseStatus = 'success' | 'pending' | 'failed' | 'error';

export interface AmlBotTopLevelResponse {
  result: boolean;
  balance?: number; // Remaining checks
  amlFlow?: string; // e.g., "fast"
  termsConfirmRequired?: boolean;
  proMode?: string; // e.g., "0"
  discount?: number;
  discountDueTime?: number;
  promoFlow?: boolean;
  data: AmlBotData; // Core AML result (pending or success)
}

export type AmlBotData =
  | AmlBotNotSuccessData
  | AmlBotAddressSuccessData
  | AmlBotTransactionSuccessData;

export type AmlBotDataSuccess =
  | AmlBotAddressSuccessData
  | AmlBotTransactionSuccessData;

export interface AmlBotNotSuccessData {
  updated_at?: number;
  address?: string; // Platform address (for TX)
  uid: string; // Use for /recheck
  asset: string; // e.g., "ETH"
  network: string; // e.g., "BSC"
  status: Omit<AmlBotResponseStatus, 'success'>;
  timestamp: string; // e.g., "2025-06-20 09:08:59"
  flow: string; // e.g., "fast"
  _type: number; // 9 for address, 7 for TX
  // TX-specific fields
  created_at?: number;
  tx?: string;
}

export interface AmlBotAddressSuccessData {
  riskscore: number | undefined; // 0.0 - 1.0 (multiply by 100 for %)
  signals: Record<string, number>; // e.g., { "exchange": 0.317, "mixer": 0.0, ... }
  updated_at: number; // Unix timestamp
  address: string; // The checked address
  fiat_code_effective: string; // e.g., "usd"
  counterparty: AmlBotCounterparty | null;
  reportedAddressBalance: null; // Always null?
  addressDetailsData: {
    reported_balance_precision: number;
    balance_approximate: number;
    balance_usd?: number;
  };
  blackListsConnections: boolean | string; // false or e.g., "BlackListIn"
  hasBlackListFlag: boolean;
  pdfReport: string; // Download link or "#"
  memo: string;
  extras?: {
    tags: string[]; // e.g., ["stake.com", "deposit"]
    services: {
      use_platform: string[]; // e.g., ["Binance", "Bybit"]
      malicious_event: string[]; // e.g., ["Fake_Phishing"]
      relation_info: string[]; // e.g., ["MetaMask"]
    };
  };
  customerIsB2B?: boolean;
  uid: string;
  asset: string;
  network: string;
  status: 'success';
  timestamp: string;
  flow: string;
  _type: 9; // Fixed for address
  cost: number; // 1
}

export interface AmlBotTransactionSuccessData {
  riskscore: number; // 0.0 - 1.0 (counterparty risk %)
  signals: Record<string, number>; // TX-related signals
  updated_at: number;
  address: string; // Your platform's address
  created_at: number; // TX creation Unix
  amount: number; // Raw amount (e.g., wei for ETH)
  risky_volume?: number; // Risky amount in native units
  direction: TransactionDirection;
  tx: string; // TX hash
  risky_volume_fiat?: number; // Risky USD cents
  fiat: number; // Total TX USD cents
  fiat_code_effective: string;
  counterparty: AmlBotCounterparty | null;
  tokenDetails?: {
    issuer: string; // Contract address
    code: string; // e.g., "USDT"
    token_id: number;
    precision: number; // e.g., 18
  };
  blackListsConnections: boolean | string;
  hasBlackListFlag: boolean;
  pdfReport: string;
  memo: string;
  extras?: {
    tags: string[];
    services: {
      use_platform: string[];
      malicious_event: string[];
      relation_info: string[];
    };
  };
  customerIsB2B?: boolean;
  confirmed_at?: number; // TX confirmation Unix
  uid: string;
  asset: string;
  network: string;
  status: 'success';
  timestamp: string;
  flow: string;
  _type: 7; // Fixed for TX
  cost: number; // 1
}

export interface AmlBotCounterparty {
  address?: string;
  name?: string; // e.g., "Binance.com"
  type?: string; // e.g., "exchange" (if clustered)
  id?: number; // Internal ID if unnamed cluster
  received_fiat_amount?: number; // USD cents (fully supported chains)
  sent_fiat_amount?: number;
  signals?: {
    in: Record<string, number>; // Incoming to counterparty
    out: Record<string, number>; // Outgoing from counterparty
  };
}

export interface AmlBotErrorResponse {
  result: false;
  description: string; // e.g., "Invalid token"
}

export type AmlBotHistoryResponse = AmlBotErrorResponse | AmlBotHistorySuccess;

// AMLBot History API Response
export interface AmlBotHistorySuccess {
  result: boolean;
  pageLimit: number;
  totalCount: string; // Note: returned as string in API, e.g., "1"
  data: AmlBotHistoryItem[];
  balance: number;
  discount: string; // e.g., "5" (percent as string)
  promoFlow: boolean;
}

// Individual history item (address or transaction check summary)
export interface AmlBotHistoryItem {
  riskscore: number; // 0.0 to 1.0 (e.g., 0.237 = 23.7%)
  signals: {
    atm: number;
    dark_market: number;
    dark_service: number;
    exchange: number;
    gambling: number;
    illegal_service: number;
    marketplace: number;
    miner: number;
    mixer: number;
    payment: number;
    ransom: number;
    scam: number;
    stolen_coins: number;
    trusted_exchange: number;
    wallet: number;
    // Note: This is a **legacy signal set** — newer checks use extended signals
    // (e.g., risky_exchange, p2p_exchange_mlrisk_high, etc.)
    // But this endpoint returns only these older fields.
  };
  updated_at: number; // Unix timestamp (seconds)
  address: string; // The checked address (for address checks)
  tx?: string;
  fiat_code_effective: string; // e.g., "usd"
  blackListsConnections: boolean;
  asset: string; // e.g., "BTC"
  hasBlackListFlag: boolean;
}
