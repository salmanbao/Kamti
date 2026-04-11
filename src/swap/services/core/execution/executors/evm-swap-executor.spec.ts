import { EvmSwapExecutor } from './evm-swap-executor';

describe('EvmSwapExecutor (Odos assemble + approval spender)', () => {
  const walletService: any = {
    getBalance: jest.fn().mockResolvedValue({
      tokenAddress: '0xToken',
      balance: (10n ** 30n).toString(), // very large balance
      formattedBalance: '1000000',
      decimals: 18,
      symbol: 'ETH',
    }),
    estimateGas: jest.fn().mockResolvedValue('21000'),
    estimateFees: jest
      .fn()
      .mockResolvedValue({ type: 'legacy', gasPrice: '1' }),
  };

  const approvalService: any = {
    getApprovalStatus: jest.fn().mockResolvedValue({
      currentAllowance: '0',
      isApprovalNeeded: false,
      tokenInfo: null,
    }),
  };

  const aggregatorManager: any = {};

  const odosService: any = {
    assembleTransactionPublic: jest.fn().mockResolvedValue({
      transaction: {
        to: '0x000000000000000000000000000000000000dEaD',
        data: '0xdeadbeef',
        value: '0',
        gas: '123456',
      },
    }),
  };

  const baseContext = () => ({
    request: {
      userWallet: '0x1111111111111111111111111111111111111111',
      privateKey:
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      route: {
        steps: [{ chainId: 1 }],
        providerRef: {},
      },
    },
  });

  const mockGasTracker = {
    recordGasUsage: jest.fn(),
    getCorrectedGasEstimate: jest.fn(),
    getMetrics: jest.fn(),
  } as any;

  const mockWinstonLogger = {
    setContext: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    audit: jest.fn(),
    logTransaction: jest.fn(),
  } as any;

  const mockGasEstimationService: any = undefined;

  const mockGaslessService = {
    isGaslessRequest: jest.fn().mockReturnValue(false),
    executeGaslessSwap: jest.fn(),
  } as any;

  const makeExecutor = () =>
    new EvmSwapExecutor(
      walletService, // WalletService
      approvalService, // ApprovalService
      odosService, // OdosService
      mockGasTracker, // GasEstimationTrackerService
      mockWinstonLogger, // WinstonLoggerService
      aggregatorManager, // AggregatorManagerService
      mockGaslessService, // GaslessTransactionService
      mockGasEstimationService, // GasEstimationService (optional)
    );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('assembles Odos tx on-the-fly when providerRef contains only pathId', async () => {
    const executor = makeExecutor();
    const ctx: any = baseContext();
    ctx.request.route.providerRef = {
      aggregator: 'odos',
      pathId: 'test-path-id',
      timestamp: Date.now(),
      sellToken: '0xToken',
      buyToken: '0xBuy',
      sellAmount: '1000000000000000000',
      buyAmount: '500000000000000000',
      // intentionally missing to/data
    };

    const errors = await (executor as any).validateSpecific(ctx);

    // Should produce no structural errors (to/data now present after assembly)
    expect(errors).toBeInstanceOf(Array);
    expect(
      errors.find((e: string) => e.toLowerCase().includes('missing "to"')),
    ).toBeUndefined();
    expect(
      errors.find((e: string) =>
        e.toLowerCase().includes('missing transaction "data"'),
      ),
    ).toBeUndefined();

    // providerRef should now be enriched with assembled tx fields
    const pref: any = ctx.request.route.providerRef;
    expect(pref.to).toBe('0x000000000000000000000000000000000000dEaD');
    expect(pref.data).toBe('0xdeadbeef');
    expect(pref.gas).toBe('123456');
    // allowanceTarget should default to router `to`
    expect(pref.allowanceTarget).toBe(pref.to);
    // assemble was invoked
    expect(odosService.assembleTransactionPublic).toHaveBeenCalled();
  });

  it('falls back to tx.to as approval spender when allowanceTarget is absent', async () => {
    const executor = makeExecutor();
    const ctx: any = baseContext();
    ctx.request.route.providerRef = {
      aggregator: 'odos',
      // already assembled-like
      to: '0x000000000000000000000000000000000000CaFe',
      data: '0x1234',
      gas: '21000',
      value: '0',
      sellToken: '0xToken',
      buyToken: '0xBuy',
      sellAmount: '1000',
      buyAmount: '500',
      // no allowanceTarget provided
    };

    await (executor as any).preExecute(ctx);

    // Approval status should be checked against the tx.to as spender
    expect(approvalService.getApprovalStatus).toHaveBeenCalledWith(
      1,
      '0xToken',
      ctx.request.userWallet,
      '0x000000000000000000000000000000000000CaFe',
      '1000',
    );
  });

  it('formats insufficient balance using token decimals (6-decimals token)', async () => {
    const executor = makeExecutor();
    const ctx: any = baseContext();

    // Mock a 6-decimals token balance (USDC-like)
    walletService.getBalance.mockResolvedValueOnce({
      tokenAddress: '0xUSDC',
      balance: '1234567', // 1.234567 with 6 decimals
      formattedBalance: '1.234567',
      decimals: 6,
      symbol: 'USDC',
    });

    ctx.request.route.providerRef = {
      aggregator: 'odos',
      to: '0x000000000000000000000000000000000000BeEf',
      data: '0x1234',
      gas: '21000',
      value: '0',
      sellToken: '0xUSDC',
      buyToken: '0xBuy',
      sellAmount: '5000000', // 5.000000 USDC (6 decimals)
      buyAmount: '1000',
    };

    const errors = await (executor as any).validateSpecific(ctx);

    // Expect an insufficient balance error with correctly formatted decimals
    const msg = errors.find((e: string) =>
      e.includes('Insufficient balance'),
    ) as string;
    expect(msg).toBeDefined();
    expect(msg).toContain('have 1.234567 USDC');
    expect(msg).toContain('need 5.000000');
  });
});
