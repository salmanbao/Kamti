export type AmlHistorySearchParams = {
  where?: Array<{ [key: string]: string | number }>;
  sortBy?: string;
  page: number;
  pageSize?: number;
};

export type AmlRiskStatusError = 'pending' | 'error' | 'failed' | 'unknown';
export type AmlRiskStatus = 'low' | 'medium' | 'high';
export type AmlResponseType = 'sync' | 'async';
export type AmlCheckType = 'address' | 'transaction';
export type AmlEnviornment = 'prod' | 'production' | 'sandbox';

export interface RiskReasonItem {
  key: string;
  score: number;
  description: string;
}

export interface RiskReason {
  low: RiskReasonItem[];
  medium: RiskReasonItem[];
  high: RiskReasonItem[];
  additional: RiskReasonItem[];
}

export interface CounterpartyConnection {
  in: {
    amount: number;
    reasons: RiskReason;
  };
  out: {
    amount: number;
    reasons: RiskReason;
  };
}

export interface AmlAddressReportData {
  type: 'address';
  ticker: string;
  address: string;
  risk_reasons: RiskReason;
  address_connections: RiskReason;
  counterparty_connections: CounterpartyConnection;
  balance: number;
  balance_usd?: number;
  pdf_link: string;
  raw: any;
}

export interface AmlTransactionReportData {
  type: AmlCheckType;
  ticker: string;
  tx_hash: string;
  created_at: string | Date;
  from: string | null;
  to: string | null;
  amount: number;
  fiat_amount: number;
  risk_reasons: RiskReason;
  counterparty_connections: CounterpartyConnection;
  pdf_link: string;
  raw: any;
}

export interface AmlResponseBaseData {
  risk_score: number | null;
  status: AmlRiskStatus | AmlRiskStatusError | 'success';
  uid: string;
  data: AmlAddressReportData | AmlTransactionReportData;
  exists?: boolean;
}

export interface CheckJobData {
  amlCheckId: string;
}

export interface CallbackJobData extends CheckJobData {
  alreadyExists?: boolean;
}
