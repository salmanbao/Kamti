import {
  Injectable,
  CanActivate,
  ExecutionContext,
  BadRequestException,
} from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { Reflector } from '@nestjs/core';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import {
  validateInputToken,
  APPROVED_INPUT_TOKENS,
} from '@shared/config/unified-token-configuration.config';
import { isNativeToken } from '@shared/utils/token-address.utils';

/**
 * Custom decorator for token validation configuration
 */
export const SKIP_TOKEN_VALIDATION_KEY = 'skipTokenValidation';
export const SkipTokenValidation =
  () =>
  (target: any, propertyKey?: string, descriptor?: PropertyDescriptor) => {
    if (propertyKey) {
      // Method decorator
      Reflect.defineMetadata(
        SKIP_TOKEN_VALIDATION_KEY,
        true,
        target,
        propertyKey,
      );
    } else {
      // Class decorator
      Reflect.defineMetadata(SKIP_TOKEN_VALIDATION_KEY, true, target);
    }
  };

/**
 * Unified Token Validation Guard
 * Validates tokens using the new unified configuration system
 * Implements hierarchical validation: Chain → Native Currency → Token
 */
@Injectable()
export class TokenValidationGuard implements CanActivate {
  private readonly logger: WinstonLoggerService;

  constructor(
    private readonly winstonLogger: WinstonLoggerService,
    private readonly reflector: Reflector,
    private readonly unifiedConfigService: UnifiedConfigurationService,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(TokenValidationGuard.name);
  }

  canActivate(context: ExecutionContext): boolean {
    // Check if token validation should be skipped for this endpoint
    const skipValidation = this.reflector.getAllAndOverride<boolean>(
      SKIP_TOKEN_VALIDATION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (skipValidation) {
      this.logger.debug('Token validation skipped for this endpoint');
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const body = request.body;

    // Only validate POST requests with body containing token information
    if (request.method !== 'POST' || !body) {
      return true;
    }

    try {
      // Validate different request formats
      if (this.isUniversalSwapRequest(body)) {
        this.validateUniversalSwapRequest(body);
      } else if (this.isLegacySwapRequest(body)) {
        this.validateLegacySwapRequest(body);
      } else if (this.isApprovalRequest(body)) {
        this.validateApprovalRequest(body);
      }

      return true;
    } catch (error) {
      this.logger.warn(`Token validation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if request is universal swap format
   */
  private isUniversalSwapRequest(body: any): boolean {
    return (
      body.sellToken &&
      body.buyToken &&
      typeof body.sellToken === 'object' &&
      typeof body.buyToken === 'object'
    );
  }

  /**
   * Check if request is legacy swap format
   */
  private isLegacySwapRequest(body: any): boolean {
    return (
      (body.sellToken &&
        body.buyToken &&
        typeof body.sellToken === 'string' &&
        typeof body.buyToken === 'string') ||
      (body.sellTokenAddress && body.buyTokenAddress)
    );
  }

  /**
   * Check if request is approval-related
   */
  private isApprovalRequest(body: any): boolean {
    return body.tokenAddress && typeof body.tokenAddress === 'string';
  }

  /**
   * Validate universal swap request using unified service
   */
  private validateUniversalSwapRequest(body: any): void {
    const { sellToken, buyToken } = body;

    // ENFORCE INPUT TOKEN RESTRICTIONS - Only allow approved tokens as sellToken
    if (sellToken.symbol) {
      const inputValidation = validateInputToken(sellToken.symbol);
      if (!inputValidation.isValid) {
        throw new BadRequestException({
          message:
            'Restricted sellToken: Only approved input tokens are allowed',
          error: 'InvalidInputToken',
          details: inputValidation.error,
          approvedInputTokens: inputValidation.approvedTokens,
          providedToken: sellToken.symbol,
          suggestion: `Please use one of the approved input tokens: ${APPROVED_INPUT_TOKENS.join(', ')}`,
        });
      }
    }

    // Validate sell token
    if (sellToken.address && sellToken.chain?.chainId) {
      this.validateTokenByAddress(
        sellToken.address,
        sellToken.chain.chainId,
        'sell token',
      );
    }

    // Validate buy token (no restrictions - can be any supported token)
    if (buyToken.address && buyToken.chain?.chainId) {
      this.validateTokenByAddress(
        buyToken.address,
        buyToken.chain.chainId,
        'buy token',
      );
    }

    // Validate hierarchical swap using unified service
    if (
      sellToken.symbol &&
      buyToken.symbol &&
      sellToken.chain?.chainId &&
      buyToken.chain?.chainId
    ) {
      const swapValidation = this.unifiedConfigService.validateHierarchicalSwap(
        sellToken.chain.chainId,
        sellToken.symbol,
        buyToken.chain.chainId,
        buyToken.symbol,
      );

      if (!swapValidation.isValid) {
        throw new BadRequestException({
          message: 'Invalid hierarchical swap request',
          errors: swapValidation.errors,
          warnings: swapValidation.warnings,
          swapType: swapValidation.swapType,
        });
      }
    }
  }

  /**
   * Validate legacy swap request using unified service
   */
  private validateLegacySwapRequest(body: any): void {
    const { chainId, sellToken, buyToken, sellTokenAddress, buyTokenAddress } =
      body;

    if (!chainId) {
      throw new BadRequestException(
        'Chain ID is required for token validation',
      );
    }

    // ENFORCE INPUT TOKEN RESTRICTIONS - Only allow approved tokens as sellToken
    if (sellToken && typeof sellToken === 'string') {
      const inputValidation = validateInputToken(sellToken);
      if (!inputValidation.isValid) {
        throw new BadRequestException({
          message:
            'Restricted sellToken: Only approved input tokens are allowed',
          error: 'InvalidInputToken',
          details: inputValidation.error,
          approvedInputTokens: inputValidation.approvedTokens,
          providedToken: sellToken,
          suggestion: `Please use one of the approved input tokens: ${APPROVED_INPUT_TOKENS.join(', ')}`,
        });
      }
    }

    // Validate chain support first
    const chainValidation =
      this.unifiedConfigService.validateChainSupport(chainId);
    if (!chainValidation.isValid) {
      throw new BadRequestException({
        message: `Chain ${chainId} is not supported`,
        error: chainValidation.error,
        details: chainValidation.message,
        supportedChains: this.unifiedConfigService
          .getEnabledChains()
          .map((c) => c.chainId),
      });
    }

    // Handle token symbols
    if (sellToken && typeof sellToken === 'string') {
      this.validateTokenBySymbol(sellToken, chainId, 'sell token');
    }

    // Buy token validation (no restrictions - can be any supported token)
    if (buyToken && typeof buyToken === 'string') {
      this.validateTokenBySymbol(buyToken, chainId, 'buy token');
    }

    // Handle token addresses
    if (sellTokenAddress) {
      this.validateTokenByAddress(sellTokenAddress, chainId, 'sell token');
    }

    if (buyTokenAddress) {
      this.validateTokenByAddress(buyTokenAddress, chainId, 'buy token');
    }
  }

  /**
   * Validate approval request using unified service
   */
  private validateApprovalRequest(body: any): void {
    const { chainId, tokenAddress } = body;

    if (!chainId) {
      throw new BadRequestException(
        'Chain ID is required for token validation',
      );
    }

    if (tokenAddress) {
      this.validateTokenByAddress(tokenAddress, chainId, 'token');
    }
  }

  /**
   * Validate token by symbol using unified hierarchical validation
   */
  private validateTokenBySymbol(
    symbol: string,
    chainId: number | string,
    context: string,
  ): void {
    const validation = this.unifiedConfigService.validateTokenOnChain(
      chainId,
      symbol,
    );

    if (!validation.isValid) {
      // Check if it's native currency
      if (this.unifiedConfigService.isTokenNativeCurrency(symbol, chainId)) {
        const nativeValidation =
          this.unifiedConfigService.validateNativeCurrencySupport(chainId);
        if (!nativeValidation.isValid) {
          throw new BadRequestException({
            message: `Native currency ${symbol} validation failed`,
            error: nativeValidation.error,
            details: nativeValidation.message,
          });
        }
        this.logger.debug(
          `✅ Native currency validation passed: ${symbol} on chain ${chainId}`,
        );
        return;
      }

      throw new BadRequestException({
        message: `Invalid ${context}: ${symbol}`,
        error: validation.error,
        details: validation.message,
        supportedTokens: this.unifiedConfigService
          .getTokensForChain(chainId)
          .map((t) => t.symbol),
      });
    }

    this.logger.debug(
      `✅ Token validation passed: ${symbol} on chain ${chainId}`,
    );
  }

  /**
   * Validate token by address using unified configuration
   */
  private validateTokenByAddress(
    address: string,
    chainId: number | string,
    context: string,
  ): void {
    // Special handling for native token addresses
    if (this.isNativeTokenAddress(address)) {
      const nativeValidation =
        this.unifiedConfigService.validateNativeCurrencySupport(chainId);
      if (!nativeValidation.isValid) {
        throw new BadRequestException({
          message: `Native currency is not enabled on chain ${chainId}`,
          error: nativeValidation.error,
          details: nativeValidation.message,
        });
      }
      this.logger.debug(
        `✅ Native token validation passed for ${context} on chain ${chainId}`,
      );
      return;
    }

    // Get tokens for chain and find matching address
    const tokensOnChain = this.unifiedConfigService.getTokensForChain(chainId);
    const matchingToken = tokensOnChain.find((token) => {
      const deployment = token.chainDeployments[chainId.toString()];
      return (
        deployment &&
        deployment.address.toLowerCase() === address.toLowerCase() &&
        deployment.isEnabled
      );
    });

    if (!matchingToken) {
      throw new BadRequestException({
        message: `Invalid ${context} address: ${address}`,
        error: 'UnsupportedToken',
        details: `Token address ${address} is not supported on chain ${chainId}`,
        supportedTokens: tokensOnChain
          .map((t) => {
            const deployment = t.chainDeployments[chainId.toString()];
            return deployment && deployment.isEnabled
              ? {
                  symbol: t.symbol,
                  address: deployment.address,
                }
              : null;
          })
          .filter(Boolean),
      });
    }

    this.logger.debug(
      `✅ Token validation passed: ${matchingToken.symbol} (${address}) on chain ${chainId}`,
    );
  }

  /**
   * Check if address represents a native token
   * Uses centralized implementation from token-address.utils
   */
  private isNativeTokenAddress(address: string): boolean {
    return isNativeToken(address);
  }
}
