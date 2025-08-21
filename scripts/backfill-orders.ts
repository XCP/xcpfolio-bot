#!/usr/bin/env node
/**
 * Backfill historical orders from Counterparty blockchain
 * This will populate Vercel KV with past fulfilled orders
 */

import dotenv from 'dotenv';
import { CounterpartyService } from '../src/services/counterparty';
import { Redis } from '@upstash/redis';

dotenv.config();

async function backfillOrders() {
  console.log('Starting order backfill...');
  
  // Check for KV credentials
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('Vercel KV credentials not found. Set KV_REST_API_URL and KV_REST_API_TOKEN');
    process.exit(1);
  }

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  const counterparty = new CounterpartyService();
  const xcpfolioAddress = process.env.XCPFOLIO_ADDRESS;
  
  if (!xcpfolioAddress) {
    console.error('XCPFOLIO_ADDRESS not set');
    process.exit(1);
  }

  try {
    // Get all filled orders
    console.log(`Fetching filled orders for ${xcpfolioAddress}...`);
    const orders = await counterparty.getFilledXCPFOLIOOrders(xcpfolioAddress);
    console.log(`Found ${orders.length} filled orders`);

    const orderIndex: string[] = [];
    let processed = 0;
    let skipped = 0;

    for (const order of orders) {
      try {
        // Get order details
        const matches = await counterparty.getOrderMatches(order.tx_hash);
        if (!matches || matches.length === 0) {
          console.log(`No matches for ${order.tx_hash}, skipping`);
          skipped++;
          continue;
        }

        const match = matches[0];
        const buyer = match.tx0_address === xcpfolioAddress 
          ? match.tx1_address 
          : match.tx0_address;
        
        const assetName = (order.give_asset_info?.asset_longname || order.give_asset)
          .replace('XCPFOLIO.', '');
        
        // Check if transfer exists
        const hasTransfer = await counterparty.isAssetTransferredTo(
          assetName,
          buyer,
          xcpfolioAddress
        );

        let status = 'pending';
        let txid = undefined;
        
        if (hasTransfer) {
          // Check if in mempool or confirmed
          const mempoolTransfers = await counterparty.getMempoolTransfers(xcpfolioAddress);
          const inMempool = mempoolTransfers.some(t => 
            t.params?.asset === assetName && 
            t.params?.transfer_destination === buyer
          );
          
          if (inMempool) {
            status = 'mempool';
            const transfer = mempoolTransfers.find(t => 
              t.params?.asset === assetName && 
              t.params?.transfer_destination === buyer
            );
            txid = transfer?.tx_hash;
          } else {
            status = 'confirmed';
            // Get transfer txid from issuances
            const issuances = await counterparty.getAssetIssuances(assetName);
            const transfer = issuances.find(i => 
              i.transfer === true &&
              i.source === xcpfolioAddress &&
              i.issuer === buyer
            );
            txid = transfer?.tx_hash;
          }
        }

        const orderData: any = {
          orderHash: order.tx_hash,
          asset: assetName,
          price: order.get_quantity / 100000000, // Convert to XCP
          buyer,
          seller: xcpfolioAddress,
          status,
          stage: status === 'confirmed' ? 'confirmed' : 'broadcast',
          purchasedAt: order.block_time || Date.now(),
          lastUpdated: Date.now()
        };

        // Add optional fields only if they have values
        if (order.give_asset_info?.asset_longname) {
          orderData.assetLongname = order.give_asset_info.asset_longname;
        }
        if (status === 'confirmed' && order.block_time) {
          orderData.confirmedAt = order.block_time;
        }
        if (txid) {
          orderData.txid = txid;
        }

        // Save to KV
        await redis.hset(`order:${order.tx_hash}`, orderData);
        await redis.expire(`order:${order.tx_hash}`, 60 * 60 * 24 * 30); // 30 day TTL for backfill
        
        orderIndex.unshift(order.tx_hash);
        processed++;
        
        console.log(`✅ Processed ${order.tx_hash}: ${assetName} -> ${buyer} (${status})`);
        
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`Error processing ${order.tx_hash}:`, error);
        skipped++;
      }
    }

    // Save the index
    if (orderIndex.length > 0) {
      await redis.set('order-index', JSON.stringify(orderIndex.slice(0, 100)), {
        ex: 60 * 60 * 24 * 30
      });
    }

    console.log('\n=== Backfill Complete ===');
    console.log(`Processed: ${processed} orders`);
    console.log(`Skipped: ${skipped} orders`);
    console.log(`Total in KV: ${orderIndex.length} orders`);
    
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  backfillOrders()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}