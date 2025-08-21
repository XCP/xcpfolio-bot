import 'dotenv/config';
import { CounterpartyService } from '../services/counterparty';
import { BitcoinService } from '../services/bitcoin';
import { StateManager } from '../services/state';

async function checkOrders() {
  const xcpfolioAddress = process.env.XCPFOLIO_ADDRESS || '1BoTXcPiDFJgXMbydpRPDKKaqM1MbaEuSe';
  
  console.log('='.repeat(60));
  console.log('XCPFOLIO Order Check');
  console.log('='.repeat(60));
  console.log(`Address: ${xcpfolioAddress}`);
  console.log();

  const counterparty = new CounterpartyService();
  const bitcoin = new BitcoinService();
  const state = new StateManager();

  try {
    // Get current block
    const currentBlock = await bitcoin.getCurrentBlockHeight();
    console.log(`Current Bitcoin Block: ${currentBlock}`);
    
    // Get Counterparty block
    const cpBlock = await counterparty.getCurrentBlock();
    console.log(`Current Counterparty Block: ${cpBlock.block_index}`);
    console.log();

    // Get current state
    const currentState = state.getState();
    console.log('Current State:');
    console.log(`  Last Block Checked: ${currentState.lastBlock}`);
    console.log(`  Last Order Hash: ${currentState.lastOrderHash || 'none'}`);
    console.log(`  Processed Orders: ${currentState.processedOrders.size}`);
    console.log(`  Last Checked: ${currentState.lastChecked ? new Date(currentState.lastChecked).toISOString() : 'never'}`);
    console.log();

    // Get all orders
    console.log('Fetching orders...');
    const allOrders = await counterparty.getOrdersByAddress(xcpfolioAddress, 'all', true);
    console.log(`Total Orders: ${allOrders.length}`);
    
    // Get filled XCPFOLIO orders
    const filledOrders = await counterparty.getFilledXCPFOLIOOrders(xcpfolioAddress);
    console.log(`Filled XCPFOLIO Orders: ${filledOrders.length}`);
    console.log();

    if (filledOrders.length > 0) {
      console.log('Recent Filled Orders:');
      console.log('-'.repeat(60));
      
      for (const order of filledOrders.slice(0, 5)) {
        const assetName = order.give_asset.replace('XCPFOLIO.', '');
        const buyerAddress = order.source;
        
        console.log(`Order: ${order.tx_hash}`);
        console.log(`  Asset: ${assetName}`);
        console.log(`  Buyer: ${buyerAddress}`);
        console.log(`  Block: ${order.block_index}`);
        console.log(`  Status: ${order.status}`);
        console.log(`  Confirmed: ${order.confirmed}`);
        
        // Check if already transferred
        const transferred = await counterparty.isAssetTransferredTo(
          assetName,
          buyerAddress,
          xcpfolioAddress
        );
        
        const processed = state.isOrderProcessed(order.tx_hash);
        
        console.log(`  Transferred: ${transferred ? '✅' : '❌'}`);
        console.log(`  Processed: ${processed ? '✅' : '❌'}`);
        console.log();
      }
    }

    // Check for pending work
    const hasNewBlock = currentBlock > currentState.lastBlock;
    const hasNewOrders = filledOrders.length > 0 && 
      filledOrders[0].tx_hash !== currentState.lastOrderHash;

    console.log('Status:');
    console.log(`  New Block Available: ${hasNewBlock ? 'YES' : 'NO'}`);
    console.log(`  New Orders Available: ${hasNewOrders ? 'YES' : 'NO'}`);
    
    if (hasNewOrders && filledOrders.length > 0) {
      let newOrderCount = 0;
      for (const order of filledOrders) {
        if (order.tx_hash === currentState.lastOrderHash) break;
        if (!state.isOrderProcessed(order.tx_hash)) {
          newOrderCount++;
        }
      }
      console.log(`  Orders to Process: ${newOrderCount}`);
    }

    // Get fee recommendation
    console.log();
    console.log('Current Fee Rates (sat/vB):');
    const fees = await bitcoin.getFeeRecommendation();
    console.log(`  Next Block: ${fees.fastestFee}`);
    console.log(`  30 Minutes: ${fees.halfHourFee}`);
    console.log(`  1 Hour: ${fees.hourFee}`);
    console.log(`  Economy: ${fees.economyFee}`);

  } catch (error) {
    console.error('Error:', error);
  }
}

// Run the check
checkOrders().catch(console.error);