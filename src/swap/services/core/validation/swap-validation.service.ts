import { Injectable, BadRequestException } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { UnifiedConfigurationService } from '@shared/services/unified-configuration.service';
import {
  validateInputToken,
  APPROVED_INPUT_TOKENS,
} from '@shared/config/unified-token-configuration.config';
import { validateRecipientAddress } from '@shared/utils/validation.utils';
import { normalizeTokenAddress } from '@shared/utils/ethereum.utils';
import { UniversalSwapRequestDto } from '@swap/dto/universal-swap-request.dto';
import { CapabilityCheckRequestDto } from '@swap/dto/capability-check.dto';
import { CapabilityCheckData } from '@swap/dto/universal-response.dto';

/**
 * Swap Validation Service
 * Handles all swap-related validation logic
 *
 * Responsibilities:
 * - Token validation (input tokens, token deployment)
 * - Chain validation (source/destination chain support)
 * - Recipient address validation
 * - Input sanitization
 */
@Injectable()
export class SwapValidationService {
  constructor(
    private readonly unifiedConfigService: UnifiedConfigurationService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(SwapValidationService.name);
  }

  /**
   * Validate input token is in approved list
   */
  validateInputToken(symbol: string): { isValid: boolean; error?: string } {
    return validateInputToken(symbol);
  }

  /**
   * Validate source chain is supported and enabled
   */
  validateSourceChain(chainId: number | string): {
    isValid: boolean;
    error?: string;
    details?: any;
  } {
    const chainConfig =
      this.unifiedConfigService.getChainConfiguration(chainId);
    const isSupported = chainConfig !== null && chainConfig.isEnabled;

    if (!isSupported) {
      return {
        isValid: false,
        error: `Source chain ${chainId} is not supported or disabled`,
        details: {
          chainId,
          availableChains: this.unifiedConfigService
            .getEnabledChains()
            .map((c) => ({
              chainId: c.chainId,
              name: c.name,
            })),
        },
      };
    }

    return { isValid: true };
  }

  /**
   * Validate destination chain is supported and enabled
   */
  validateDestinationChain(chainId: number | string): {
    isValid: boolean;
    error?: string;
    details?: any;
  } {
    const chainConfig =
      this.unifiedConfigService.getChainConfiguration(chainId);
    const isSupported = chainConfig !== null && chainConfig.isEnabled;

    if (!isSupported) {
      return {
        isValid: false,
        error: `Destination chain ${chainId} is not supported or disabled`,
        details: {
          chainId,
          availableChains: this.unifiedConfigService
            .getEnabledChains()
            .map((c) => ({
              chainId: c.chainId,
              name: c.name,
            })),
        },
      };
    }

    return { isValid: true };
  }

  /**
   * Validate token is deployed and enabled on chain
   */
  validateTokenOnChain(
    symbol: string,
    chainId: number | string,
  ): {
    isValid: boolean;
    error?: string;
    details?: any;
  } {
    const tokenDeployment =
      this.unifiedConfigService.getTokenConfiguration(symbol);
    const tokenOnChain = tokenDeployment?.chainDeployments?.[chainId];
    const isAvailable = tokenOnChain?.isEnabled === true;

    if (!isAvailable) {
      return {
        isValid: false,
        error: `Token ${symbol} is not available on chain ${chainId}`,
        details: {
          token: symbol,
          chainId,
          availableOn: tokenDeployment
            ? Object.keys(tokenDeployment.chainDeployments)
            : [],
        },
      };
    }

    return { isValid: true };
  }

  /**
   * Validate recipient address format for ecosystem
   */
  validateRecipient(
    ecosystem: string,
    chainId: number | string,
    address: string,
  ): void {
    validateRecipientAddress(ecosystem, chainId, address);
  }

  /**
   * Validate taker address format for source chain ecosystem
   */
  validateTaker(
    ecosystem: string,
    chainId: number | string,
    address: string,
  ): void {
    if (!address || typeof address !== 'string') {
      throw new BadRequestException('Taker address is required');
    }
    try {
      validateRecipientAddress(ecosystem, chainId, address);
    } catch (e) {
      throw new BadRequestException(
        `Invalid taker address for ${ecosystem}:${chainId} — ${e.message}`,
      );
    }
  }

  /**
   * Normalize and validate token address
   */
  normalizeAndValidateTokenAddress(address: string, ecosystem: string): string {
    if (ecosystem === 'evm') {
      return normalizeTokenAddress(address, false);
    }
    return address;
  }

  /**
   * Validate capability check request
   */
  validateCapabilityRequest(request: CapabilityCheckRequestDto): {
    isValid: boolean;
    error?: { code: string; message: string; details?: any };
  } {
    // Step 1: Input token validation
    const inputTokenValidation = this.validateInputToken(
      request.sellToken.symbol,
    );
    if (!inputTokenValidation.isValid) {
      return {
        isValid: false,
        error: {
          code: 'UNSUPPORTED_INPUT_TOKEN',
          message:
            inputTokenValidation.error ||
            `Token ${request.sellToken.symbol} is not in the approved input token list`,
          details: { approvedTokens: APPROVED_INPUT_TOKENS },
        },
      };
    }

    // Step 2: Validate source chain
    const sourceChainValidation = this.validateSourceChain(
      request.sellToken.chain.chainId,
    );
    if (!sourceChainValidation.isValid) {
      return {
        isValid: false,
        error: {
          code: 'UNSUPPORTED_SOURCE_CHAIN',
          message: sourceChainValidation.error!,
          details: sourceChainValidation.details,
        },
      };
    }

    // Step 3: Validate destination chain
    const destChainValidation = this.validateDestinationChain(
      request.buyToken.chain.chainId,
    );
    if (!destChainValidation.isValid) {
      return {
        isValid: false,
        error: {
          code: 'UNSUPPORTED_DESTINATION_CHAIN',
          message: destChainValidation.error!,
          details: destChainValidation.details,
        },
      };
    }

    // Step 4: Validate sell token deployment on source chain
    const sellTokenValidation = this.validateTokenOnChain(
      request.sellToken.symbol,
      request.sellToken.chain.chainId,
    );
    if (!sellTokenValidation.isValid) {
      return {
        isValid: false,
        error: {
          code: 'TOKEN_NOT_ON_SOURCE_CHAIN',
          message: sellTokenValidation.error!,
          details: sellTokenValidation.details,
        },
      };
    }

    return { isValid: true };
  }

  /**
   * Validate swap execution request
   */
  validateSwapRequest(request: UniversalSwapRequestDto): void {
    // Validate required fields
    if (!request.sellToken || !request.buyToken) {
      throw new BadRequestException(
        'Missing required fields: sellToken and buyToken objects are required. ' +
          'Each must contain: symbol, address, and chain (with ecosystem and chainId)',
      );
    }

    if (!request.sellAmount) {
      throw new BadRequestException('Missing required field: sellAmount');
    }

    if (!request.taker) {
      throw new BadRequestException('Missing required field: taker (wallet address)');
    }

    // Validate token addresses are resolved
    if (!request.sellToken.address || !request.buyToken.address) {
      throw new BadRequestException(
        'Could not resolve token addresses (provide valid token symbols or explicit contract addresses)',
      );
    }

    // Normalize and validate token addresses
    try {
      if (request.sellToken.chain.ecosystem === 'evm') {
        request.sellToken.address = this.normalizeAndValidateTokenAddress(
          request.sellToken.address,
          request.sellToken.chain.ecosystem,
        );
      }
      if (request.buyToken.chain.ecosystem === 'evm') {
        request.buyToken.address = this.normalizeAndValidateTokenAddress(
          request.buyToken.address,
          request.buyToken.chain.ecosystem,
        );
      }
    } catch (e) {
      throw new BadRequestException(
        `Invalid token address format: ${e.message}`,
      );
    }

    // Validate taker address (source chain - required)
    try {
      this.validateTaker(
        request.sellToken.chain.ecosystem,
        request.sellToken.chain.chainId,
        request.taker,
      );
    } catch (e) {
      throw new BadRequestException(
        `Invalid taker address for ${request.sellToken.chain.ecosystem}:${request.sellToken.chain.chainId} — ${e.message}`,
      );
    }

    // Validate recipient if provided (destination chain - optional)
    if (request.recipient) {
      try {
        this.validateRecipient(
          request.buyToken.chain.ecosystem,
          request.buyToken.chain.chainId,
          request.recipient,
        );
      } catch (e) {
        throw new BadRequestException(
          `Invalid recipient for ${request.buyToken.chain.ecosystem}:${request.buyToken.chain.chainId} — ${e.message}`,
        );
      }
    }
  }
}
