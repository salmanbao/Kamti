import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { parseSwap } from '@0x/0x-parser';
import { formatUnits, isAddress } from 'viem';
import {
  TransactionParseRequestDto,
  TransactionParseResponseDto,
} from '@swap/dto/transaction-parse-request.dto';
import { createViemPublicClient } from '@shared/utils/viem.utils';
import { ChainUtilsService } from '@shared/utils/chain.utils';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';

@Injectable()
export class TransactionParserService {
  constructor(
    private readonly chainUtils: ChainUtilsService,
    private readonly winstonLogger: WinstonLoggerService,
  ) {
    this.winstonLogger.setContext('TransactionParserService');
  }

  /**
   * Ecosystem detection based on chainId
   */
  private detectEcosystem(
    chainId: number,
  ): 'evm' | 'solana' | 'cosmos' | 'bitcoin' | 'unknown' {
    if ([1, 137, 56, 42161, 10, 8453, 43114].includes(chainId)) return 'evm';
    if ([101, 102, 103].includes(chainId)) return 'solana'; // Example Solana chainIds
    if ([2000, 2001].includes(chainId)) return 'cosmos'; // Example Cosmos chainIds
    if ([0, 100].includes(chainId)) return 'bitcoin'; // Example Bitcoin chainIds
    return 'unknown';
  }

  /**
   * Main entry: Parse transaction and extract swap information (cross-ecosystem)
   */
  async parseTransaction(
    request: TransactionParseRequestDto,
  ): Promise<TransactionParseResponseDto> {
    const startTime = Date.now();

    try {
      this.winstonLogger.log(`Parsing transaction: ${request.transactionHash}`);

      // Validate transaction hash format
      if (!request.transactionHash.match(/^0x[a-fA-F0-9]{64}$/)) {
        throw new BadRequestException('Invalid transaction hash format');
      }

      // Default to Ethereum mainnet if no chain ID provided
      const chainId = request.chainId || 1;
      const ecosystem = this.detectEcosystem(chainId);
      this.winstonLogger.debug(`Detected ecosystem: ${ecosystem}`);

      let result: TransactionParseResponseDto;

      switch (ecosystem) {
        case 'evm':
          result = await this.parseEvmTransaction(request, chainId);
          break;
        case 'solana':
          result = await this.parseSolanaTransaction(request, chainId);
          break;
        case 'cosmos':
          result = await this.parseCosmosTransaction(request, chainId);
          break;
        case 'bitcoin':
          result = await this.parseBitcoinTransaction(request, chainId);
          break;
        default:
          result = this.minimalUnknownResponse(request, chainId, ecosystem);
      }

      const duration = Date.now() - startTime;

      // Audit log successful parsing
      this.winstonLogger.audit('TRANSACTION_PARSED', {
        transactionHash: request.transactionHash,
        chainId,
        ecosystem,
        status: result.status,
        hasSwapData: !!result.swapData,
        protocol: result.swapData?.protocol,
        duration,
        timestamp: new Date().toISOString(),
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Audit log parsing failure
      this.winstonLogger.audit('TRANSACTION_PARSE_FAILED', {
        transactionHash: request.transactionHash,
        chainId: request.chainId || 1,
        error: error.message,
        duration,
        timestamp: new Date().toISOString(),
      });

      this.winstonLogger.error(
        `Error parsing transaction: ${error.message}`,
        error.stack,
      );
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Failed to parse transaction: ${error.message}`,
      );
    }
  }

  /**
   * EVM transaction parsing (existing logic)
  /**
   * Get public client for blockchain interactions
   */
  private getPublicClient(chainId: number) {
    const chainConfig = this.chainUtils.getChainConfig(chainId);
    return createViemPublicClient(chainId, chainConfig.rpcUrl);
  }

  /**
   * Solana transaction parsing (stub)
   * TODO: Implement Solana transaction parsing logic here.
   * Should fetch transaction details from Solana RPC, decode instructions, and extract swap info.
   */
  private async parseSolanaTransaction(
    request: TransactionParseRequestDto,
    chainId: number,
  ): Promise<TransactionParseResponseDto> {
    this.winstonLogger.warn('Solana transaction parsing not yet implemented');
    // TODO: Use Solana web3.js or similar to fetch and decode transaction
    return this.minimalUnknownResponse(request, chainId, 'solana');
  }

  /**
   * Cosmos transaction parsing (stub)
   * TODO: Implement Cosmos transaction parsing logic here.
   * Should fetch transaction details from Cosmos REST/RPC, decode messages, and extract swap info.
   */
  private async parseCosmosTransaction(
    request: TransactionParseRequestDto,
    chainId: number,
  ): Promise<TransactionParseResponseDto> {
    this.winstonLogger.warn('Cosmos transaction parsing not yet implemented');
    // TODO: Use Cosmos SDK or REST API to fetch and decode transaction
    return this.minimalUnknownResponse(request, chainId, 'cosmos');
  }

  /**
   * Bitcoin transaction parsing (stub)
   * TODO: Implement Bitcoin transaction parsing logic here.
   * Should fetch transaction details from Bitcoin RPC, decode inputs/outputs, and extract swap info.
   */
  private async parseBitcoinTransaction(
    request: TransactionParseRequestDto,
    chainId: number,
  ): Promise<TransactionParseResponseDto> {
    this.winstonLogger.warn('Bitcoin transaction parsing not yet implemented');
    // TODO: Use Bitcoin RPC or block explorer API to fetch and decode transaction
    return this.minimalUnknownResponse(request, chainId, 'bitcoin');
  }

  /**
   * Minimal response for unknown or unsupported ecosystems
   */
  private minimalUnknownResponse(
    request: TransactionParseRequestDto,
    chainId: number,
    ecosystem: string,
  ): TransactionParseResponseDto {
    return {
      transactionHash: request.transactionHash,
      chainId,
      blockNumber: 0,
      status: 'unknown',
      gasUsed: '0',
      gasPrice: '0',
      from: '',
      to: '',
      value: '0',
      swapData: undefined,
      rawParsedData: {
        message: `Parsing not implemented for ecosystem: ${ecosystem}`,
      },
    };
  }

  /**
   * EVM transaction parsing (existing logic)
   */
  private async parseEvmTransaction(
    request: TransactionParseRequestDto,
    chainId: number,
  ): Promise<TransactionParseResponseDto> {
    try {
      this.winstonLogger.log(
        `Parsing EVM transaction: ${request.transactionHash}`,
      );
      const publicClient = this.getPublicClient(chainId);
      const transaction = await publicClient.getTransaction({
        hash: request.transactionHash as `0x${string}`,
      });
      if (!transaction) {
        throw new NotFoundException(
          `Transaction not found: ${request.transactionHash}`,
        );
      }
      const receipt = await publicClient.getTransactionReceipt({
        hash: request.transactionHash as `0x${string}`,
      });
      if (!receipt) {
        throw new NotFoundException(
          `Transaction receipt not found: ${request.transactionHash}`,
        );
      }
      const responseData: TransactionParseResponseDto = {
        transactionHash: request.transactionHash,
        chainId,
        blockNumber: Number(transaction.blockNumber),
        status: receipt.status === 'success' ? 'success' : 'failed',
        gasUsed: receipt.gasUsed.toString(),
        gasPrice: transaction.gasPrice?.toString() || '0',
        from: transaction.from,
        to: transaction.to || '',
        value: transaction.value.toString() || '0',
      };
      try {
        if (transaction.input && transaction.input !== '0x') {
          const compatibleClient = publicClient as any;
          const swapData = await parseSwap({
            publicClient: compatibleClient,
            transactionHash: request.transactionHash as `0x${string}`,
          });
          if (swapData) {
            this.winstonLogger.log(`Successfully parsed swap with 0x parser`);

            // Audit log 0x parser success
            this.winstonLogger.audit('TRANSACTION_PARSED_0X_PARSER', {
              transactionHash: request.transactionHash,
              chainId,
              protocol: '0x Protocol',
              tokenIn: swapData.tokenIn.symbol,
              tokenOut: swapData.tokenOut.symbol,
              timestamp: new Date().toISOString(),
            });

            responseData.swapData = {
              inputToken: {
                address: swapData.tokenIn.address,
                symbol: swapData.tokenIn.symbol,
                amount: swapData.tokenIn.amount,
                amountFormatted: swapData.tokenIn.amount,
              },
              outputToken: {
                address: swapData.tokenOut.address,
                symbol: swapData.tokenOut.symbol,
                amount: swapData.tokenOut.amount,
                amountFormatted: swapData.tokenOut.amount,
              },
              trader: transaction.from,
              protocol: '0x Protocol',
              source: '0x-parser',
            };
            responseData.rawParsedData = swapData;
          } else {
            throw new Error('0x parser returned null');
          }
        }
      } catch (parseError) {
        this.winstonLogger.warn(
          `Failed to parse transaction with 0x parser: ${parseError.message}`,
        );
        try {
          if (transaction.input && transaction.input !== '0x') {
            const functionSelector = transaction.input.slice(0, 10);
            const parsedData = this.parseTransactionBasic(
              transaction,
              functionSelector,
            );
            if (parsedData) {
              this.winstonLogger.log(
                `Successfully parsed transaction data with fallback method`,
              );

              // Audit log fallback parser success
              this.winstonLogger.audit('TRANSACTION_PARSED_FALLBACK', {
                transactionHash: request.transactionHash,
                chainId,
                functionSelector,
                functionName: parsedData.functionName,
                isSwap: this.isSwapTransaction(parsedData),
                timestamp: new Date().toISOString(),
              });

              if (this.isSwapTransaction(parsedData)) {
                responseData.swapData = await this.extractSwapData(
                  parsedData,
                  chainId,
                );
              }
              responseData.rawParsedData = parsedData;
            }
          }
        } catch (fallbackError) {
          this.winstonLogger.warn(
            `Fallback parsing also failed: ${fallbackError.message}`,
          );

          // Audit log both parsers failed
          this.winstonLogger.audit('TRANSACTION_PARSING_ALL_METHODS_FAILED', {
            transactionHash: request.transactionHash,
            chainId,
            zeroXParserError: parseError.message,
            fallbackError: fallbackError.message,
            timestamp: new Date().toISOString(),
          });
        }
      }
      return responseData;
    } catch (error) {
      this.winstonLogger.error(
        `Error parsing EVM transaction: ${error.message}`,
        error.stack,
      );
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Failed to parse EVM transaction: ${error.message}`,
      );
    }
  }

  /**
   * Get token information
   */
  private async getTokenInfo(
    tokenAddress: string,
    amount: string | number,
    chainId: number,
    publicClient: any,
  ) {
    try {
      if (!isAddress(tokenAddress)) {
        return {
          address: tokenAddress,
          amount: amount?.toString() || '0',
        };
      }

      // For ETH/native token (usually 0x0 or 0xEeeee...)
      if (
        tokenAddress === '0x0000000000000000000000000000000000000000' ||
        tokenAddress.toLowerCase() ===
          '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      ) {
        return {
          address: tokenAddress,
          symbol: this.getNativeTokenSymbol(chainId),
          decimals: 18,
          amount: amount?.toString() || '0',
          amountFormatted: formatUnits(BigInt(amount?.toString() || '0'), 18),
        };
      }

      // Try to get ERC20 token info
      try {
        const [symbol, decimals] = await Promise.all([
          publicClient.readContract({
            address: tokenAddress,
            abi: [
              {
                constant: true,
                inputs: [],
                name: 'symbol',
                outputs: [{ name: '', type: 'string' }],
                type: 'function',
              },
            ],
            functionName: 'symbol',
          }),
          publicClient.readContract({
            address: tokenAddress,
            abi: [
              {
                constant: true,
                inputs: [],
                name: 'decimals',
                outputs: [{ name: '', type: 'uint8' }],
                type: 'function',
              },
            ],
            functionName: 'decimals',
          }),
        ]);

        return {
          address: tokenAddress,
          symbol,
          decimals,
          amount: amount?.toString() || '0',
          amountFormatted: formatUnits(
            BigInt(amount?.toString() || '0'),
            decimals,
          ),
        };
      } catch (contractError) {
        // If contract calls fail, return basic info
        return {
          address: tokenAddress,
          amount: amount?.toString() || '0',
        };
      }
    } catch (error) {
      this.winstonLogger.warn(
        `Failed to get token info for ${tokenAddress}: ${error.message}`,
      );
      return {
        address: tokenAddress,
        amount: amount?.toString() || '0',
      };
    }
  }

  /**
   * Get native token symbol for chain
   */
  private getNativeTokenSymbol(chainId: number): string {
    switch (chainId) {
      case 1:
        return 'ETH';
      case 137:
        return 'MATIC';
      case 56:
        return 'BNB';
      case 42161:
      case 10:
      case 8453:
        return 'ETH';
      case 43114:
        return 'AVAX';
      default:
        return 'ETH';
    }
  }

  /**
   * Basic transaction parsing using function selectors
   */
  private parseTransactionBasic(
    transaction: any,
    functionSelector: string,
  ): any {
    const functionSignatures: Record<string, string> = {
      '0xd9627aa4': 'sellToUniswap', // 0x Protocol
      '0x415565b0': 'transformERC20', // 0x Protocol
      '0x3598d8ab': 'executeTransaction', // 0x Protocol
      '0x7c025200': 'swap', // Uniswap V3
      '0x38ed1739': 'swapExactTokensForTokens', // Uniswap V2
      '0x8803dbee': 'swapTokensForExactTokens', // Uniswap V2
      '0x7ff36ab5': 'swapExactETHForTokens', // Uniswap V2
      '0x4a25d94a': 'swapTokensForExactETH', // Uniswap V2
      '0x18cbafe5': 'swapExactTokensForETH', // Uniswap V2
      '0xfb3bdb41': 'swapETHForExactTokens', // Uniswap V2
    };
    const functionName = functionSignatures[functionSelector] || 'unknown';
    return {
      functionSelector,
      functionName,
      method: functionName,
      to: transaction.to,
      from: transaction.from,
      value: transaction.value.toString(),
      input: transaction.input,
      isSwap: functionName !== 'unknown',
    };
  }

  /**
   * Check if the parsed transaction is a swap
   */
  private isSwapTransaction(parsedData: any): boolean {
    if (!parsedData) return false;
    const swapFunctions = [
      'swap',
      'swapExactTokensForTokens',
      'swapTokensForExactTokens',
      'swapExactETHForTokens',
      'swapTokensForExactETH',
      'swapExactTokensForETH',
      'swapETHForExactTokens',
      'fillOrder',
      'fillOrKillOrder',
      'marketSellOrdersNoThrow',
      'marketBuyOrdersNoThrow',
      'transformERC20',
    ];
    const functionName = parsedData.functionName || parsedData.method || '';
    return swapFunctions.some((fn) =>
      functionName.toLowerCase().includes(fn.toLowerCase()),
    );
  }

  /**
   * Extract swap data from parsed transaction
   */
  private async extractSwapData(
    parsedData: any,
    chainId: number,
  ): Promise<any> {
    try {
      const publicClient = this.getPublicClient(chainId);
      const swapData: any = {
        trader: parsedData.from || '',
        protocol: this.identifyProtocol(parsedData),
        functionName: parsedData.functionName || parsedData.method || 'unknown',
      };
      if (parsedData.value && parsedData.value !== '0') {
        swapData.ethValue = {
          amount: parsedData.value,
          amountFormatted: formatUnits(BigInt(parsedData.value), 18),
          symbol: this.getNativeTokenSymbol(chainId),
        };
      }
      if (parsedData.args) {
        if (parsedData.args.tokenIn && parsedData.args.tokenOut) {
          swapData.inputToken = await this.getTokenInfo(
            parsedData.args.tokenIn,
            parsedData.args.amountIn,
            chainId,
            publicClient,
          );
          swapData.outputToken = await this.getTokenInfo(
            parsedData.args.tokenOut,
            parsedData.args.amountOut,
            chainId,
            publicClient,
          );
        } else if (
          parsedData.args.path &&
          Array.isArray(parsedData.args.path)
        ) {
          const path = parsedData.args.path;
          if (path.length >= 2) {
            swapData.inputToken = await this.getTokenInfo(
              path[0],
              parsedData.args.amountIn,
              chainId,
              publicClient,
            );
            swapData.outputToken = await this.getTokenInfo(
              path[path.length - 1],
              parsedData.args.amountOut,
              chainId,
              publicClient,
            );
          }
        } else if (parsedData.args.sellToken && parsedData.args.buyToken) {
          swapData.inputToken = await this.getTokenInfo(
            parsedData.args.sellToken,
            parsedData.args.sellAmount,
            chainId,
            publicClient,
          );
          swapData.outputToken = await this.getTokenInfo(
            parsedData.args.buyToken,
            parsedData.args.buyAmount,
            chainId,
            publicClient,
          );
        }
        if (parsedData.args.to || parsedData.args.recipient) {
          swapData.recipient = parsedData.args.to || parsedData.args.recipient;
        }
      }
      return swapData;
    } catch (error) {
      this.winstonLogger.warn(`Failed to extract swap data: ${error.message}`);
      return {
        trader: parsedData.from || '',
        protocol: this.identifyProtocol(parsedData),
      };
    }
  }

  /**
   * Identify the protocol based on parsed data
   */
  private identifyProtocol(parsedData: any): string {
    const to = parsedData.to?.toLowerCase() || '';
    const functionName = parsedData.functionName || parsedData.method || '';
    if (to.includes('0xdef1c0ded9bec7f1a1670819833240f027b25eff')) {
      return '0x Protocol';
    }
    if (functionName.includes('uniswap') || to.includes('uniswap')) {
      return 'Uniswap';
    }
    if (functionName.includes('sushi') || to.includes('sushi')) {
      return 'SushiSwap';
    }
    if (functionName.includes('pancake') || to.includes('pancake')) {
      return 'PancakeSwap';
    }
    return 'Unknown';
  }
}
