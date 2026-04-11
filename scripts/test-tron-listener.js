/**
 * Test Tron Chain Listener with actual transaction
 * Tests the transaction that failed in ETH-TRX-ETH swap
 */

const TronWebModule = require('tronweb');
const TronWeb = TronWebModule.TronWeb || TronWebModule.default || TronWebModule;

const TRON_RPC = 'https://api.trongrid.io';
const TRON_SHASTA_RPC = 'https://api.shasta.trongrid.io';

// Test transaction from failed ETH-TRX-ETH swap
const TEST_TX_HASH = '1d7d63a01d9ce69328c19ea8a923e4045a9865e38b217209a3d9bbdfae07b068';

async function testTronListener() {
  console.log('🧪 Testing Tron Chain Listener...\n');

  try {
    // Initialize TronWeb
    const tronWeb = new TronWeb({
      fullHost: TRON_RPC,
    });

    console.log('✅ TronWeb initialized');

    // Test 1: getTransaction
    console.log(`\n📋 Test 1: Fetching transaction ${TEST_TX_HASH}`);
    const transaction = await tronWeb.trx.getTransaction(TEST_TX_HASH);
    
    if (!transaction) {
      console.log('❌ Transaction not found');
      return;
    }

    console.log('✅ Transaction fetched');
    console.log('   Contract type:', transaction.raw_data?.contract?.[0]?.type);
    
    // Test 2: getTransactionInfo
    console.log('\n📋 Test 2: Fetching transaction info (receipt details)');
    const txInfo = await tronWeb.trx.getTransactionInfo(TEST_TX_HASH);
    
    if (!txInfo) {
      console.log('❌ Transaction info not found');
      return;
    }

    console.log('✅ Transaction info fetched');
    console.log('   Block number:', txInfo.blockNumber);
    console.log('   Timestamp:', new Date(txInfo.blockTimeStamp).toISOString());
    console.log('   Fee:', txInfo.fee, 'SUN');
    console.log('   Receipt result:', txInfo.receipt?.result || 'N/A');
    console.log('   Receipt keys:', Object.keys(txInfo.receipt || {}).join(', '));
    console.log('   Has logs:', (txInfo.log || []).length > 0);

    // Test 3: Verify blockHash doesn't exist
    console.log('\n📋 Test 3: Verifying response structure');
    console.log('   Has blockHash:', 'blockHash' in txInfo);
    console.log('   Has id:', 'id' in txInfo);
    console.log('   Has blockNumber:', 'blockNumber' in txInfo);
    console.log('   Has blockTimeStamp:', 'blockTimeStamp' in txInfo);
    console.log('   Has receipt:', 'receipt' in txInfo);
    console.log('   Has log:', 'log' in txInfo);

    // Test 4: Parse contract details
    console.log('\n📋 Test 4: Parsing contract details');
    const contract = transaction.raw_data?.contract?.[0];
    const contractValue = contract?.parameter?.value || {};
    
    if (contract?.type === 'TransferContract') {
      const amount = contractValue.amount;
      console.log('   ✅ Native TRX transfer detected');
      console.log('   Amount:', amount, 'SUN');
      console.log('   Amount in TRX:', amount / 1000000, 'TRX');
    } else if (contract?.type === 'TriggerSmartContract') {
      console.log('   ✅ Smart contract call detected');
      console.log('   Has logs:', (txInfo.log || []).length);
    } else {
      console.log('   Contract type:', contract?.type);
    }

    // Test 5: Parse logs
    if (txInfo.log && txInfo.log.length > 0) {
      console.log('\n📋 Test 5: Parsing transaction logs');
      const logs = txInfo.log;
      console.log(`   Found ${logs.length} logs`);
      
      for (let i = 0; i < Math.min(3, logs.length); i++) {
        const log = logs[i];
        console.log(`\n   Log ${i + 1}:`);
        console.log('     Address:', log.address);
        console.log('     Topics:', log.topics?.length || 0);
        if (log.topics && log.topics.length > 0) {
          console.log('       Topic[0]:', log.topics[0]?.substring(0, 16) + '...');
        }
        console.log('     Data length:', log.data?.length || 0);
        console.log('     Has caller_address:', 'caller_address' in log);
        console.log('     Has transferTo_address:', 'transferTo_address' in log);
      }
    }

    // Test 6: Get current block
    console.log('\n📋 Test 6: Getting current block information');
    const currentBlock = await tronWeb.trx.getCurrentBlock();
    console.log('   Current block number:', currentBlock.block_header.raw_data.number);
    console.log('   Timestamp:', new Date(currentBlock.block_header.raw_data.timestamp).toISOString());

    // Test 7: Calculate confirmations
    if (txInfo.blockNumber && currentBlock.block_header.raw_data.number) {
      const confirmations = currentBlock.block_header.raw_data.number - txInfo.blockNumber;
      console.log('\n📋 Test 7: Confirmation calculation');
      console.log('   TX block:', txInfo.blockNumber);
      console.log('   Current block:', currentBlock.block_header.raw_data.number);
      console.log('   Confirmations:', confirmations);
    }

    console.log('\n✅ All tests passed!');

  } catch (error) {
    console.error('❌ Error during testing:', error.message);
    console.error(error);
  }
}

// Run tests
testTronListener().catch(console.error);
