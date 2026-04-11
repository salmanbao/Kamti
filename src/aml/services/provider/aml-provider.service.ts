import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  AmlBotAddressSuccessData,
  AmlBotDataSuccess,
  AmlBotErrorResponse,
  AmlBotHistoryResponse,
  AmlBotHistorySuccess,
  AmlBotNotSuccessData,
  AmlBotResponseStatus,
  AmlBotTopLevelResponse,
  AmlBotTransactionSuccessData,
} from '@aml/types/provider/aml-bot';
import {
  AmlAddressReportData,
  type AmlCheckType,
  AmlResponseBaseData,
  AmlTransactionReportData,
  RiskReason,
} from '@aml/types/aml';
import {
  classifyAmlScores,
  mapAmlSignals,
} from '@aml/utils/aml-bot-source.utils';
import { CoinConfigResponse } from '@aml/types/provider/aml-bot-coins';
import { safeStringify, stringLogLimit } from '@shared/utils/index.utils';
import { CustomHttpService } from '@shared/services/http.service';
import { centsToUSD, convertFractionToReal } from '@aml/utils/precision';

export type TransactionDirection = 'deposit' | 'withdrawal';

export type AmlBotTransactionReportParams = {
  ticker: string;
  tx_hash: string;
  address: string; // REQUIRED: Your platform's address involved in the TX
  direction: TransactionDirection; // REQUIRED: deposit = incoming, withdrawal = outgoing
  token?: string; // Optional: e.g., 'USDT' – AMLBot auto-detects most tokens
};

export type AmlBotAddressReportParams = {
  ticker: string;
  address: string;
  token?: string; // Optional
};

@Injectable()
export class AmlProviderService {
  private readonly logger = new Logger(AmlProviderService.name);
  private readonly baseUrl = 'https://extrnlapiendpoint.silencatech.com';
  private readonly accessId: string;
  private readonly accessKey: string;
  public readonly name = 'AMLBot (External API)';

  constructor(
    private readonly httpService: CustomHttpService,
    private readonly configService: ConfigService,
  ) {
    this.accessId = this.configService.get<string>('AMLBOT_ACCESS_ID') ?? '';
    this.accessKey = this.configService.get<string>('AMLBOT_ACCESS_KEY') ?? '';

    if (!this.accessId) {
      throw new Error('[AmlProviderService] Missing AMLBOT_ACCESS_ID');
    }
    if (!this.accessKey) {
      throw new Error('[AmlProviderService] Missing AMLBOT_ACCESS_KEY');
    }
  }

  public getAsset(ticker: string): string {
    // Normalize input
    const key = ticker.trim().toLowerCase();

    // === 1. Direct Asset Mapping (Native + Token Chains) ===
    const assetMap: Record<string, string> = {
      // Native coins
      btc: 'BTC',
      eth: 'ETH',
      ltc: 'LTC',
      bch: 'BCH',
      xrp: 'XRP',
      etc: 'ETC',
      ada: 'ADA',
      trx: 'TRX',
      algo: 'ALGO',
      xlm: 'XLM',
      matic: 'MATIC',
      op: 'OP',
      base: 'BASE',
      zec: 'ZEC',
      doge: 'DOGE',
      sol: 'SOL',
      bsv: 'BSV',
      avax: 'AVAX',
      dot: 'DOT',
      ton: 'TON',
      xtz: 'XTZ',
      near: 'NEAR',
      apt: 'APT',
      tetheromni: 'TetherOMNI', // Special case

      // === 2. Token Chain Aliases (for token verification) ===
      // ERC-20 → ETH
      // erc20: 'ETH',
      'erc-20': 'ETH',
      // usdt: 'ETH',      // USDT on Ethereum
      // usdc: 'ETH',      // USDC on Ethereum
      usdterc20: 'ETH', // USDT on Ethereum
      shib: 'ETH', // SHIB on Ethereum

      // BEP-20 → BSC
      bep20: 'BSC',
      'bep-20': 'BSC',
      'usdt-bep20': 'BSC',
      'usdc-bep20': 'BSC',
      bep20usdt: 'BSC',
      bep20usdc: 'BSC',

      // Polygon ERC-20 → MATIC
      polygon: 'MATIC',
      'erc20-polygon': 'MATIC',
      'matic-erc20': 'MATIC',

      // TRC-20 → TRX
      trc20: 'TRX',
      'trc-20': 'TRX',
      'usdt-trc20': 'TRX',
      trc20usdt: 'TRX',

      // Ripple tokens → XRP
      ripple: 'XRP',
      xrp_token: 'XRP',

      // Arbitrum ERC-20 → ARB
      arbitrum: 'ARB',
      arb: 'ARB',
      'erc20-arbitrum': 'ARB',

      // XLM tokens → XLM
      stellar: 'XLM',
      'xlm-token': 'XLM',

      // Optimism ERC-20 → OP
      optimism: 'OP',
      'erc20-optimism': 'OP',

      // Base ERC-20 → BASE
      'base-chain': 'BASE',
      'erc20-base': 'BASE',

      // Avalanche ERC-20 → AVAX
      avalanche: 'AVAX',
      'avax-erc20': 'AVAX',
      cchainavax: 'AVAX',

      // TON tokens → TON
      'ton-token': 'TON',
      toncoin: 'TON',

      // Aptos tokens → APT
      aptos: 'APT',
      'apt-token': 'APT',

      // === 3. Legacy / Common Aliases ===
      bitcoin: 'BTC',
      ethereum: 'ETH',
      binancecoin: 'BSC',
      'binance-smart-chain': 'BSC',
      bnb: 'BSC',
      bnb1: 'BSC',
      cardano: 'ADA',
      matic1: 'MATIC',
      solana: 'SOL',
      solusdt: 'SOL',
      polkadot: 'DOT',
      tezos: 'XTZ',
      nearprotocol: 'NEAR',
    };

    const asset = assetMap[key];

    if (asset === undefined) {
      throw new Error(`Unsupported asset (ticker): ${ticker}`);
    }

    return asset;
  }

  private computeToken(value: string): string {
    const str = `${value}:${this.accessKey}:${this.accessId}`;
    return crypto.createHash('md5').update(str).digest('hex');
  }

  async pollRecheck(
    type: AmlCheckType,
    uid: string,
  ): Promise<AmlResponseBaseData> {
    const form = new URLSearchParams();
    form.append('accessId', this.accessId);
    form.append('uid', uid);
    form.append('token', this.computeToken(uid));

    try {
      const data = await this.httpService.post<AmlBotTopLevelResponse>(
        `${this.baseUrl}/recheck`,
        form,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

      if (!data.result) {
        throw new Error(
          (data as unknown as AmlBotErrorResponse).description ||
            'Recheck failed',
        );
      }

      const amlData = data.data;

      if (!amlData) {
        this.logger.error(
          `Could not get the AML report. Data: ${JSON.stringify(data)}`,
        );

        throw new Error('Something went wrong. Could not get AML report.');
      }

      if (!['success', 'failed', 'error'].includes(amlData.status as string)) {
        this.logger.error(
          `Could not get the AML report. Data: ${JSON.stringify(data)}`,
        );

        throw new Error('Not a valid AML report.');
      }

      return this.transformReport(type, amlData);
    } catch (err) {
      this.logger.warn(`Recheck failed: ${err.message}`);

      throw err;
    }
  }

  private transformReport(
    type: AmlCheckType,
    amlData: AmlBotNotSuccessData | AmlBotDataSuccess | null | undefined,
  ): AmlResponseBaseData {
    if (!amlData) {
      return {
        risk_score: null,
        status: 'error' as AmlBotResponseStatus,
        uid: '',
        data: {} as AmlAddressReportData,
      };
    }

    let riskscore: number | undefined = undefined;
    let data: AmlAddressReportData | AmlTransactionReportData;
    const riskReasons: RiskReason = {
      low: [],
      medium: [],
      high: [],
      additional: [],
    };
    const counterparty = {
      in: {
        amount: 0,
        reasons: riskReasons,
      },
      out: {
        amount: 0,
        reasons: riskReasons,
      },
    };

    // Safe type determination with fallback
    const safeType = type === 'address' ? 'address' : 'transaction';

    if (safeType === 'address') {
      let balance = 0;
      let balanceUsd = 0;

      try {
        if ((amlData as AmlBotAddressSuccessData).addressDetailsData) {
          balance =
            (amlData as AmlBotAddressSuccessData).addressDetailsData
              .balance_approximate ?? 0;
          balanceUsd =
            (amlData as AmlBotAddressSuccessData).addressDetailsData
              ?.balance_usd ?? 0;
        }
      } catch (error) {
        this.logger.error(`Could not get the AML report.`);
      }

      data = {
        type: safeType,
        ticker: amlData.asset || '',
        address: (amlData.address as string) || '',
        balance,
        balance_usd: balanceUsd,
        risk_reasons: riskReasons,
        address_connections: riskReasons,
        counterparty_connections: counterparty,
        pdf_link: '',
        raw: amlData,
      };
    } else {
      // Safe date conversion with validation
      let safeCreatedAt = '';
      const rawCreatedAt = (amlData as AmlBotNotSuccessData).created_at;
      if (typeof rawCreatedAt === 'number' && !isNaN(rawCreatedAt)) {
        const dateObj = new Date(rawCreatedAt * 1000); // rawCreatedAt is in seconds
        if (!isNaN(dateObj.getTime())) {
          // Valid date check
          safeCreatedAt = dateObj.toISOString();
        }
      }

      data = {
        type: safeType,
        tx_hash: ((amlData as AmlBotNotSuccessData).tx as string) || '',
        ticker: amlData.asset || '',
        created_at: safeCreatedAt,
        to: null,
        from: null,
        amount: 0,
        fiat_amount: 0,
        risk_reasons: riskReasons,
        counterparty_connections: counterparty,
        pdf_link: '',
        raw: amlData,
      };
    }

    // Type guard for 'success' status before accessing success-specific properties
    const isSuccess = amlData.status === 'success';
    if (isSuccess) {
      const successData = amlData as AmlBotDataSuccess;
      const rawRiskScore = successData.riskscore;

      // Safe numeric conversion for riskscore
      if (typeof rawRiskScore === 'number' && !isNaN(rawRiskScore)) {
        riskscore = rawRiskScore * 100;
      } else if (typeof rawRiskScore === 'string') {
        const parsed = parseFloat(rawRiskScore);
        if (!isNaN(parsed)) {
          riskscore = parsed * 100;
        }
      }

      const pdfLink = successData.pdfReport ?? null;
      if (pdfLink) {
        data = {
          ...data,
          pdf_link: pdfLink,
        };
      }

      // safhe risk reasons
      const signals = successData.signals;
      if (signals) {
        const modifiedSignals = classifyAmlScores(signals);
        data = {
          ...data,
          risk_reasons: modifiedSignals,
          ...(safeType === 'address'
            ? { address_connections: modifiedSignals }
            : {}),
        };
      }

      try {
        const counterparty = successData.counterparty;
        if (counterparty) {
          const inputSignals = counterparty.signals?.in ?? {};
          const outputSignals = counterparty.signals?.out ?? {};
          const amountIn = counterparty?.received_fiat_amount ?? 0;
          const amountOut = counterparty?.sent_fiat_amount ?? 0;

          data = {
            ...data,
            counterparty_connections: {
              in: {
                amount: amountIn === 0 ? centsToUSD(amountIn) : amountIn,
                reasons: classifyAmlScores(inputSignals),
              },
              out: {
                amount: amountOut === 0 ? centsToUSD(amountOut) : amountOut,
                reasons: classifyAmlScores(outputSignals),
              },
            },
          };
        }
      } catch (error) {
        this.logger.error(
          `Error processing counterparty data: ${error.message}`,
        );
      }

      // Safe check for blackListFlag (assume boolean)
      const hasBlackList = successData.hasBlackListFlag === true; // Strict boolean check
      if (hasBlackList && riskscore) {
        riskscore = Math.max(riskscore, 90);
      }

      // Type guard for transaction success data
      if (safeType === 'transaction') {
        const txSuccessData = successData as AmlBotTransactionSuccessData;
        const direction = (txSuccessData.direction as string) || '';
        const txAmount = (() => {
          const rawAmount = txSuccessData.amount;
          if (typeof rawAmount === 'number' && !isNaN(rawAmount)) {
            return rawAmount;
          } else if (typeof rawAmount === 'string') {
            const parsed = parseFloat(rawAmount);
            return isNaN(parsed) ? 0 : parsed;
          }
          return 0;
        })();

        let realAmount = 0;
        const fiatAmount = txSuccessData.fiat ?? 0;

        try {
          realAmount = Number(
            convertFractionToReal(txSuccessData.asset, txAmount),
          );
        } catch (error) {
          this.logger.error(
            `Error converting fraction to real: ${error.message}`,
          );
        }

        data = {
          ...data,
          from:
            direction === 'withdrawal' ? txSuccessData.address || null : null,
          to: direction === 'deposit' ? txSuccessData.address || null : null,
          amount: realAmount,
          fiat_amount: fiatAmount === 0 ? centsToUSD(fiatAmount) : fiatAmount,
        };
      }
    }

    // Safe uid extraction (fallback to empty string)
    const safeUid = (typeof amlData.uid === 'string' ? amlData.uid : '') || '';

    // Safe status extraction (ensure it's a valid enum value if possible)
    const safeStatus = (amlData.status as AmlBotResponseStatus) || 'error';

    return {
      risk_score:
        riskscore !== null && riskscore !== undefined
          ? Number(Math.max(0, Math.min(100, riskscore)).toFixed(2))
          : null, // Clamp to 0-100 for sanity
      status: safeStatus,
      uid: safeUid,
      data,
    };
  }

  private async performCheck(
    hash: string,
    asset: string,
    extraParams?: Record<string, string>,
  ): Promise<any> {
    const form = new URLSearchParams();
    form.append('accessId', this.accessId);
    form.append('hash', hash);
    form.append('asset', asset);
    form.append('flow', 'fast');
    form.append('token', this.computeToken(hash));

    if (extraParams) {
      Object.entries(extraParams).forEach(([k, v]) => form.append(k, v));
    }

    try {
      const data = await this.httpService.post<AmlBotTopLevelResponse>(
        this.baseUrl,
        form,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

      if (!data.result) {
        this.logger.error(
          'AMLBot error: =>' +
            (data as unknown as AmlBotErrorResponse).description,
        );
        throw new Error('Something went wrong. Could not get AML report.');
      }

      // "balance": number of remaining requests on the balance
      if (data.balance !== undefined && data.balance < 1) {
        throw new Error('AMLBot balance exhausted');
      }

      const amlData = data.data;

      if (!amlData) {
        this.logger.error(
          `Could not get the AML report. Data: ${JSON.stringify(data)}`,
        );

        throw new Error('Something went wrong. Could not get AML report.');
      }

      const check_type =
        extraParams && extraParams.direction !== undefined
          ? 'transaction'
          : 'address';

      return this.transformReport(
        check_type as AmlCheckType,
        amlData as AmlBotNotSuccessData | AmlBotDataSuccess,
      );
    } catch (err) {
      this.logger.warn(`AMLBot request failed: ${err.message}`);

      throw err;
    }
  }

  async checkAddressReport(
    params: AmlBotAddressReportParams,
  ): Promise<AmlResponseBaseData> {
    this.logger.log(`AML address check: ${params.address} on ${params.ticker}`);
    const asset = this.getAsset(params.ticker);
    return this.performCheck(params.address, asset);
  }

  async checkTransactionReport(
    params: AmlBotTransactionReportParams,
  ): Promise<AmlResponseBaseData> {
    this.logger.log(
      `AML TX check: ${params.tx_hash} on ${params.ticker} (direction: ${params.direction})`,
    );
    const asset = this.getAsset(params.ticker);

    const extra = {
      address: params.address,
      direction: params.direction,
    };

    return this.performCheck(params.tx_hash, asset, extra);
  }
}
