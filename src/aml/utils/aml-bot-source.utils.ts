export const AmlSourceDescriptions: Record<string, Record<string, string>> = {
  // danger
  high: {
    child_exploitation: 'Entities associated with child exploitation.',
    dark_market: 'Coins associated with illegal activities.',
    dark_service:
      'Coins related to child abuse, terrorist financing or drug trafficking.',
    enforcement_action:
      'The entity is subject to legal proceedings with judicial authorities.',
    exchange_fraudulent:
      'Exchanges involved in exit scams or confiscated funds.',
    gambling: 'Coins associated with unlicensed online games.',
    illegal_service: 'Coins associated with illegal services.',
    mixer: 'Coins that passed via a mixer, often for money laundering.',
    ransom: 'Coins obtained by extortion or blackmail.',
    sanctions: 'Entities subject to sanctions.',
    scam: 'Coins obtained by deception or fraud.',
    stolen_coins: 'Coins obtained by theft.',
    terrorism_financing: 'Entities associated with terrorism financing.',
  },
  // Suspicious
  medium: {
    atm: 'Coins obtained via cryptocurrency ATM operator.',
    risky_exchange:
      'High-risk exchanges (no KYC, criminal ties, weak jurisdiction).',
    liquidity_pools: 'Tokens locked in liquidity pool smart contracts.',
    p2p_exchange_mlrisk_high:
      'High-risk P2P exchanges (no license or weak compliance).',
    unnamed_service: 'Unidentified clusters behaving like a service.',
  },
  // Trusted
  low: {
    exchange: 'Licensed crypto exchanges offering trading services.',
    ico: 'Coins obtained from an Initial Coin Offering (ICO).',
    marketplace: 'Coins used to pay for legal activities.',
    merchant_services:
      'Payment processors enabling crypto payments for businesses.',
    miner: 'Coins newly mined and not forwarded yet.',
    other: 'Coins from airdrops, token sales, or other miscellaneous sources.',
    p2p_exchange: 'Licensed P2P exchanges.',
    payment: 'Coins related to payment services.',
    seized_assets: 'Crypto assets seized by government.',
    wallet: 'Online hosted wallet services.',
  },
  // Additional
  additional: {
    infrastructure_as_a_service: 'Infrastructure-as-a-Service provider.',
    decentralized_exchange_contract: 'Automated smart contract of a DEX.',
    malware: 'Coins associated with malware operations.',
  },
};

export function mapAmlSignals(providerData: Record<string, number>) {
  return Object.entries(providerData)
    .filter(([_, value]) => value > 0) // only include relevant sources
    .map(([key, value]) => ({
      key,
      score: value,
      label: AmlSourceDescriptions[key],
    }));
}

export function classifyAmlScores(scores: Record<string, number>) {
  const result = {
    low: [] as any[],
    medium: [] as any[],
    high: [] as any[],
    additional: [] as any[],
  };

  // Iterate over every score key
  for (const [key, value] of Object.entries(scores)) {
    if (value <= 0) continue; // ignore zero scores

    // Find category where the key exists
    for (const [category, items] of Object.entries(AmlSourceDescriptions)) {
      if (items[key]) {
        result[category].push({
          key,
          score: formatNumber(value),
          description: items[key],
        });
      }
    }
  }

  return result;
}

function formatNumber(value: number): number {
  const num = value * 100;

  // Check if it's an integer
  if (Number.isInteger(num)) {
    return num; // return without decimals
  }

  // Otherwise, keep 2 decimal places
  return parseFloat(num.toFixed(2));
}

export function generateRandomAmlSignals() {
  const result: Record<string, number> = {
    exchange: 0.317,
    risky_exchange: 0.017,
    p2p_exchange: 0,
    enforcement_action: 0,
    atm: 0,
    child_exploitation: 0,
    dark_market: 0,
    dark_service: 0,
    exchange_fraudulent: 0,
    gambling: 0.594,
    illegal_service: 0,
    liquidity_pools: 0.002,
    marketplace: 0,
    miner: 0,
    mixer: 0,
    other: 0.009,
    p2p_exchange_mlrisk_high: 0.005,
    payment: 0.047,
    ransom: 0,
    sanctions: 0.002,
    scam: 0,
    seized_assets: 0,
    stolen_coins: 0,
    terrorism_financing: 0,
    wallet: 0.005,
    infrastructure_as_a_service: 0,
    decentralized_exchange_contract: 0,
    merchant_services: 0,
    unnamed_service: 0,
    malware: 0,
  };

  const generated: Record<string, number> = {};

  const count = Math.floor(Math.random() * 5) + 1;

  const keys = [...Object.keys(result)].sort(() => 0.5 - Math.random());

  for (let i = 0; i < count; i++) {
    const key = keys[i];
    generated[key] = Number((Math.random() * 0.5).toFixed(3));
  }

  // now we have random signals return sources
  return generated;
}
