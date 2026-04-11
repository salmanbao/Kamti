/**
 * Configuration for chains supporting gasless transactions via Pimlico/EIP-7702
 *
 * Pimlico supports ERC-4337 account abstraction and EIP-7702 delegation on select chains.
 * This configuration defines which chains have gasless transaction support.
 *
 * @see https://docs.pimlico.io/reference/supported-chains
 */

export interface GaslessChainConfig {
  chainId: number;
  name: string;
  ecosystem: 'evm';
  pimlicoSupported: boolean;
  entryPointAddress: string; // ERC-4337 EntryPoint contract
  paymasterType: 'verifying' | 'token' | 'sponsored';
  notes?: string;
}

/**
 * Chains with gasless transaction support (EIP-7702 & Pimlico)
 */
export const GASLESS_SUPPORTED_CHAINS: GaslessChainConfig[] = [
  {
    chainId: 1,
    name: 'Ethereum Mainnet',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
  {
    chainId: 5,
    name: 'Goerli Testnet',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
  {
    chainId: 11155111,
    name: 'Sepolia Testnet',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
  {
    chainId: 137,
    name: 'Polygon Mainnet',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
  {
    chainId: 80001,
    name: 'Polygon Mumbai Testnet',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
  {
    chainId: 10,
    name: 'Optimism Mainnet',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
  {
    chainId: 420,
    name: 'Optimism Goerli Testnet',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
  {
    chainId: 42161,
    name: 'Arbitrum One Mainnet',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
  {
    chainId: 421613,
    name: 'Arbitrum Goerli Testnet',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
  {
    chainId: 56,
    name: 'BSC Mainnet',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
  {
    chainId: 97,
    name: 'BSC Testnet',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
  {
    chainId: 43114,
    name: 'Avalanche C-Chain',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
  {
    chainId: 8453,
    name: 'Base Mainnet',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
  {
    chainId: 84531,
    name: 'Base Goerli Testnet',
    ecosystem: 'evm',
    pimlicoSupported: true,
    entryPointAddress: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    paymasterType: 'verifying',
  },
];

/**
 * Check if a chain supports gasless transactions
 */
export function isGaslessSupported(chainId: number): boolean {
  return GASLESS_SUPPORTED_CHAINS.some(
    (chain) => chain.chainId === chainId && chain.pimlicoSupported,
  );
}

/**
 * Get gasless configuration for a specific chain
 */
export function getGaslessConfig(
  chainId: number,
): GaslessChainConfig | undefined {
  return GASLESS_SUPPORTED_CHAINS.find((chain) => chain.chainId === chainId);
}

/**
 * Get all supported gasless chain IDs
 */
export function getGaslessSupportedChainIds(): number[] {
  return GASLESS_SUPPORTED_CHAINS.filter((chain) => chain.pimlicoSupported).map(
    (chain) => chain.chainId,
  );
}

/**
 * Validate if gasless transaction is possible for given chain and ecosystem
 */
export function validateGaslessSupport(
  chainId: number | string,
  ecosystem: string,
): { supported: boolean; reason?: string } {
  // Only EVM chains support gasless transactions via EIP-7702/ERC-4337
  if (ecosystem !== 'evm') {
    return {
      supported: false,
      reason: `Gasless transactions only supported on EVM chains. ${ecosystem} not supported.`,
    };
  }

  // Convert chainId to number if string
  const numericChainId =
    typeof chainId === 'string' ? parseInt(chainId, 10) : chainId;

  if (isNaN(numericChainId)) {
    return {
      supported: false,
      reason: `Invalid chain ID: ${chainId}`,
    };
  }

  const config = getGaslessConfig(numericChainId);
  if (!config) {
    return {
      supported: false,
      reason: `Chain ${chainId} not configured for gasless transactions. Supported chains: ${getGaslessSupportedChainIds().join(', ')}`,
    };
  }

  return { supported: true };
}
