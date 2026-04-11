import { normalizeChainId } from '../config/unified-token-configuration.config';

describe('normalizeChainId', () => {
  it('normalizes Rubic numeric Solana chainId 1399811149 to solana-mainnet', () => {
    expect(normalizeChainId(1399811149)).toBe('solana-mainnet');
    expect(normalizeChainId('1399811149')).toBe('solana-mainnet');
  });

  it('normalizes Stargate numeric Solana chainId 7565164 to solana-mainnet', () => {
    expect(normalizeChainId(7565164)).toBe('solana-mainnet');
    expect(normalizeChainId('7565164')).toBe('solana-mainnet');
  });

  it('normalizes common string aliases to solana-mainnet', () => {
    expect(normalizeChainId('sol')).toBe('solana-mainnet');
    expect(normalizeChainId('solana')).toBe('solana-mainnet');
    expect(normalizeChainId('mainnet-beta')).toBe('solana-mainnet');
  });

  it('passes through standard EVM numeric chain IDs unchanged', () => {
    expect(normalizeChainId(1)).toBe(1); // Ethereum
    expect(normalizeChainId(56)).toBe(56); // BSC
    expect(normalizeChainId(43114)).toBe(43114); // Avalanche
  });

  it('does not change unknown string IDs', () => {
    expect(normalizeChainId('my-custom-chain')).toBe('my-custom-chain');
  });
});
