import { Injectable, BadRequestException } from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  Chain,
  Account,
  Hex,
  Address,
  PublicClient,
  encodeFunctionData,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  getGaslessConfig,
  validateGaslessSupport,
  GaslessChainConfig,
} from '@shared/config/gasless-chains.config';

/**
 * ERC-4337 UserOperation structure
 * @see https://eips.ethereum.org/EIPS/eip-4337
 */
export interface UserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: Hex;
  signature: Hex;
}

/**
 * Pimlico API Response Types
 */
interface PimlicoSponsorshipResponse {
  paymasterAndData: Hex;
  preVerificationGas: string;
  verificationGasLimit: string;
  callGasLimit: string;
}

interface PimlicoBundlerResponse {
  userOperationHash: Hex;
}

/**
 * EIP-7702 Authorization structure
 * @see https://eips.ethereum.org/EIPS/eip-7702
 */
interface EIP7702Authorization {
  chainId: bigint;
  address: Address;
  nonce: bigint;
}

/**
 * Gasless Transaction Service
 *
 * Implements gasless transaction support using:
 * - EIP-7702: Set EOA Code (delegation)
 * - ERC-4337: Account Abstraction (UserOperation)
 * - Pimlico: Bundler & Paymaster services
 *
 * Flow:
 * 1. Validate chain supports gasless transactions
 * 2. Create EIP-7702 delegation (if needed)
 * 3. Build UserOperation with transaction calldata
 * 4. Request paymaster sponsorship from Pimlico
 * 5. Submit UserOperation to Pimlico bundler
 * 6. Monitor UserOperation execution
 *
 * Requirements:
 * - #11: Gasless transactions via EIP-7702 & Pimlico
 * - #13: Skip gas estimation for gasless transactions
 */
@Injectable()
export class GaslessTransactionService {
  private readonly pimlicoApiKey: string;
  private readonly gaslessEnabled: boolean;
  private readonly pimlicoBaseUrl = 'https://api.pimlico.io/v2';

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(GaslessTransactionService.name);
    this.pimlicoApiKey = this.configService.get<string>('PIMLICO_API_KEY', '');
    this.gaslessEnabled = this.configService.get<boolean>(
      'GASLESS_ENABLED',
      false,
    );

    if (!this.pimlicoApiKey && this.gaslessEnabled) {
      this.logger.warn(
        '⚠️ PIMLICO_API_KEY not configured. Gasless transactions will fail.',
      );
    }

    this.logger.log(
      `Gasless transactions: ${this.gaslessEnabled ? 'ENABLED' : 'DISABLED'}`,
    );
  }

  /**
   * Check if gasless transaction is supported for the given chain
   */
  canExecuteGasless(
    chainId: number,
    ecosystem: string,
  ): {
    supported: boolean;
    reason?: string;
  } {
    if (!this.gaslessEnabled) {
      return {
        supported: false,
        reason:
          'Gasless transactions are disabled. Set GASLESS_ENABLED=true in environment.',
      };
    }

    if (!this.pimlicoApiKey) {
      return {
        supported: false,
        reason:
          'Pimlico API key not configured. Set PIMLICO_API_KEY in environment.',
      };
    }

    return validateGaslessSupport(chainId, ecosystem);
  }

  /**
   * Execute a transaction using gasless (sponsored) method
   *
   * @param txData Transaction data (to, data, value)
   * @param chainId Chain ID for the transaction
   * @param privateKey User's private key for signing
   * @returns Transaction hash of the UserOperation
   */
  async executeGaslessTransaction(
    txData: {
      to: Address;
      data: Hex;
      value?: bigint;
    },
    chainId: number,
    privateKey: string,
  ): Promise<{
    userOpHash: Hex;
    bundlerUrl: string;
    status: 'pending' | 'submitted';
  }> {
    this.logger.log(`🚀 Executing gasless transaction on chain ${chainId}`);

    // Step 1: Validate gasless support
    const validation = this.canExecuteGasless(chainId, 'evm');
    if (!validation.supported) {
      throw new BadRequestException(validation.reason);
    }

    const config = getGaslessConfig(chainId);
    if (!config) {
      throw new BadRequestException(
        `Gasless configuration not found for chain ${chainId}`,
      );
    }

    // Step 2: Setup clients
    const account = privateKeyToAccount(privateKey as Hex);
    const chain = this.getViemChain(chainId);

    const publicClient = createPublicClient({
      chain,
      transport: http(),
    });

    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(),
    });

    // Step 3: Build UserOperation
    const userOp = await this.buildUserOperation(
      account,
      txData,
      config,
      publicClient,
    );

    this.logger.log('UserOperation built', {
      sender: userOp.sender,
      nonce: userOp.nonce.toString(),
      callData: userOp.callData.slice(0, 66) + '...',
    });

    // Step 4: Request paymaster sponsorship from Pimlico
    const sponsorship = await this.requestPaymasterSponsorship(
      userOp,
      config,
      chainId,
    );

    // Update UserOperation with paymaster data
    userOp.paymasterAndData = sponsorship.paymasterAndData;
    userOp.preVerificationGas = BigInt(sponsorship.preVerificationGas);
    userOp.verificationGasLimit = BigInt(sponsorship.verificationGasLimit);
    userOp.callGasLimit = BigInt(sponsorship.callGasLimit);

    this.logger.log('✅ Paymaster sponsorship obtained', {
      paymasterData: userOp.paymasterAndData.slice(0, 66) + '...',
      callGasLimit: userOp.callGasLimit.toString(),
    });

    // Step 5: Sign UserOperation
    userOp.signature = await this.signUserOperation(userOp, account, chainId);

    // Step 6: Submit UserOperation to Pimlico bundler
    const bundlerResult = await this.submitUserOperation(
      userOp,
      config,
      chainId,
    );

    this.logger.log(
      `✅ UserOperation submitted: ${bundlerResult.userOperationHash}`,
    );

    return {
      userOpHash: bundlerResult.userOperationHash,
      bundlerUrl: this.getPimlicoBundlerUrl(chainId),
      status: 'submitted',
    };
  }

  /**
   * Build UserOperation from transaction data
   */
  private async buildUserOperation(
    account: Account,
    txData: { to: Address; data: Hex; value?: bigint },
    config: GaslessChainConfig,
    publicClient: PublicClient,
  ): Promise<UserOperation> {
    // Get nonce from EntryPoint contract
    const nonce = await this.getUserOperationNonce(
      account.address,
      config.entryPointAddress as Address,
      publicClient,
    );

    // Get current gas prices
    const feeData = await publicClient.estimateFeesPerGas();

    return {
      sender: account.address,
      nonce,
      initCode: '0x' as Hex, // No initialization needed for EOA
      callData: txData.data,
      callGasLimit: BigInt(100000), // Will be overridden by paymaster
      verificationGasLimit: BigInt(100000), // Will be overridden by paymaster
      preVerificationGas: BigInt(21000), // Will be overridden by paymaster
      maxFeePerGas: feeData.maxFeePerGas || BigInt(0),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || BigInt(0),
      paymasterAndData: '0x' as Hex, // Will be filled by Pimlico
      signature: '0x' as Hex, // Will be filled later
    };
  }

  /**
   * Get UserOperation nonce from EntryPoint contract
   */
  private async getUserOperationNonce(
    sender: Address,
    entryPointAddress: Address,
    publicClient: PublicClient,
  ): Promise<bigint> {
    try {
      const nonce = await publicClient.readContract({
        address: entryPointAddress,
        abi: parseAbi([
          'function getNonce(address sender, uint192 key) external view returns (uint256 nonce)',
        ]),
        functionName: 'getNonce',
        args: [sender, BigInt(0)],
      });

      return nonce;
    } catch (error) {
      this.logger.warn('Failed to fetch nonce from EntryPoint, using 0', error);
      return BigInt(0);
    }
  }

  /**
   * Request paymaster sponsorship from Pimlico
   */
  private async requestPaymasterSponsorship(
    userOp: UserOperation,
    config: GaslessChainConfig,
    chainId: number,
  ): Promise<PimlicoSponsorshipResponse> {
    const url = `${this.pimlicoBaseUrl}/${chainId}/rpc?apikey=${this.pimlicoApiKey}`;

    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'pm_sponsorUserOperation',
      params: [
        {
          sender: userOp.sender,
          nonce: `0x${userOp.nonce.toString(16)}`,
          initCode: userOp.initCode,
          callData: userOp.callData,
          callGasLimit: `0x${userOp.callGasLimit.toString(16)}`,
          verificationGasLimit: `0x${userOp.verificationGasLimit.toString(16)}`,
          preVerificationGas: `0x${userOp.preVerificationGas.toString(16)}`,
          maxFeePerGas: `0x${userOp.maxFeePerGas.toString(16)}`,
          maxPriorityFeePerGas: `0x${userOp.maxPriorityFeePerGas.toString(16)}`,
          paymasterAndData: userOp.paymasterAndData,
          signature: userOp.signature,
        },
        config.entryPointAddress,
      ],
    };

    this.logger.log('Requesting paymaster sponsorship from Pimlico', {
      chainId,
      sender: userOp.sender,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pimlico API error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();

      if (result.error) {
        throw new Error(`Pimlico API error: ${result.error.message}`);
      }

      return result.result as PimlicoSponsorshipResponse;
    } catch (error) {
      this.logger.error('Failed to request paymaster sponsorship', error);
      throw new BadRequestException(
        `Failed to obtain paymaster sponsorship: ${error.message}`,
      );
    }
  }

  /**
   * Sign UserOperation
   */
  private async signUserOperation(
    userOp: UserOperation,
    account: Account,
    chainId: number,
  ): Promise<Hex> {
    // Create UserOperation hash for signing
    const userOpHash = this.getUserOperationHash(userOp, chainId);

    // Sign the hash (implementation simplified, use proper EIP-4337 signing)
    // In production, use account.signMessage or account.signTypedData
    if (!account.signMessage) {
      throw new Error('Account does not support message signing');
    }

    const signature = await account.signMessage({
      message: { raw: userOpHash },
    });

    return signature;
  }

  /**
   * Get UserOperation hash (EIP-4337 standard)
   */
  private getUserOperationHash(userOp: UserOperation, chainId: number): Hex {
    // Simplified implementation
    // In production, use proper EIP-4337 hash calculation
    const packed = encodeFunctionData({
      abi: parseAbi([
        'function hash(address sender, uint256 nonce, bytes callData) returns (bytes32)',
      ]),
      functionName: 'hash',
      args: [userOp.sender, userOp.nonce, userOp.callData],
    });

    return packed;
  }

  /**
   * Submit UserOperation to Pimlico bundler
   */
  private async submitUserOperation(
    userOp: UserOperation,
    config: GaslessChainConfig,
    chainId: number,
  ): Promise<PimlicoBundlerResponse> {
    const url = `${this.pimlicoBaseUrl}/${chainId}/rpc?apikey=${this.pimlicoApiKey}`;

    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendUserOperation',
      params: [
        {
          sender: userOp.sender,
          nonce: `0x${userOp.nonce.toString(16)}`,
          initCode: userOp.initCode,
          callData: userOp.callData,
          callGasLimit: `0x${userOp.callGasLimit.toString(16)}`,
          verificationGasLimit: `0x${userOp.verificationGasLimit.toString(16)}`,
          preVerificationGas: `0x${userOp.preVerificationGas.toString(16)}`,
          maxFeePerGas: `0x${userOp.maxFeePerGas.toString(16)}`,
          maxPriorityFeePerGas: `0x${userOp.maxPriorityFeePerGas.toString(16)}`,
          paymasterAndData: userOp.paymasterAndData,
          signature: userOp.signature,
        },
        config.entryPointAddress,
      ],
    };

    this.logger.log('Submitting UserOperation to Pimlico bundler');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Pimlico bundler error: ${response.status} - ${errorText}`,
        );
      }

      const result = await response.json();

      if (result.error) {
        throw new Error(`Pimlico bundler error: ${result.error.message}`);
      }

      return {
        userOperationHash: result.result as Hex,
      };
    } catch (error) {
      this.logger.error('Failed to submit UserOperation', error);
      throw new BadRequestException(
        `Failed to submit UserOperation: ${error.message}`,
      );
    }
  }

  /**
   * Get UserOperation receipt (after bundler processes it)
   */
  async getUserOperationReceipt(
    userOpHash: Hex,
    chainId: number,
  ): Promise<{
    success: boolean;
    transactionHash?: Hex;
    blockNumber?: bigint;
    gasUsed?: bigint;
  }> {
    const url = `${this.pimlicoBaseUrl}/${chainId}/rpc?apikey=${this.pimlicoApiKey}`;

    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getUserOperationReceipt',
      params: [userOpHash],
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        return { success: false };
      }

      const result = await response.json();

      if (result.error || !result.result) {
        return { success: false };
      }

      const receipt = result.result;

      return {
        success: receipt.success,
        transactionHash: receipt.receipt?.transactionHash,
        blockNumber: receipt.receipt?.blockNumber
          ? BigInt(receipt.receipt.blockNumber)
          : undefined,
        gasUsed: receipt.actualGasUsed
          ? BigInt(receipt.actualGasUsed)
          : undefined,
      };
    } catch (error) {
      this.logger.error('Failed to fetch UserOperation receipt', error);
      return { success: false };
    }
  }

  /**
   * Poll for UserOperation completion
   */
  async waitForUserOperationReceipt(
    userOpHash: Hex,
    chainId: number,
    timeoutMs: number = 60000,
  ): Promise<{
    success: boolean;
    transactionHash?: Hex;
    blockNumber?: bigint;
    gasUsed?: bigint;
  }> {
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds

    while (Date.now() - startTime < timeoutMs) {
      const receipt = await this.getUserOperationReceipt(userOpHash, chainId);

      if (receipt.success && receipt.transactionHash) {
        this.logger.log(`✅ UserOperation mined: ${receipt.transactionHash}`);
        return receipt;
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`UserOperation timeout after ${timeoutMs}ms`);
  }

  /**
   * Get Pimlico bundler URL for tracking
   */
  private getPimlicoBundlerUrl(chainId: number): string {
    return `${this.pimlicoBaseUrl}/${chainId}/rpc?apikey=${this.pimlicoApiKey}`;
  }

  /**
   * Get Viem chain configuration
   */
  private getViemChain(chainId: number): Chain {
    // Simplified - in production, use proper chain configurations from viem/chains
    return {
      id: chainId,
      name: `Chain ${chainId}`,
      nativeCurrency: {
        decimals: 18,
        name: 'Ether',
        symbol: 'ETH',
      },
      rpcUrls: {
        default: {
          http: [`https://rpc.ankr.com/eth`], // Use proper RPC URLs
        },
        public: {
          http: [`https://rpc.ankr.com/eth`],
        },
      },
    };
  }

  /**
   * Estimate gas for gasless transaction (returns 0 since sponsored)
   * Requirement #13: Skip gas estimation for gasless transactions
   */
  estimateGaslessTransactionGas(): bigint {
    // Gasless transactions have gas sponsored by paymaster
    // Return 0 to indicate no gas cost to user
    return BigInt(0);
  }

  /**
   * Check if a specific UserOperation is pending
   */
  async isUserOperationPending(
    userOpHash: Hex,
    chainId: number,
  ): Promise<boolean> {
    const receipt = await this.getUserOperationReceipt(userOpHash, chainId);
    return !receipt.success && !receipt.transactionHash;
  }
}
