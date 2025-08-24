#!/usr/bin/env node
/**
 * Drop and rebuild order history with new structure
 * This script:
 * 1. Drops all existing order history from Redis/KV
 * 2. Rebuilds with new structure (orderHash = sell order, matchHash = buy order)
 */

import dotenv from 'dotenv';
import { CounterpartyService } from '../src/services/counterparty';
import { Redis } from '@upstash/redis';

dotenv.config();

async function rebuildOrderHistory() {
  console.log('🔄 Starting order history rebuild with new structure...\n');
  
  // Check for KV credentials
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('❌ Vercel KV credentials not found. Set KV_REST_API_URL and KV_REST_API_TOKEN');
    process.exit(1);
  }

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  const counterparty = new CounterpartyService();
  const xcpfolioAddress = process.env.XCPFOLIO_ADDRESS;
  
  if (!xcpfolioAddress) {
    console.error('❌ XCPFOLIO_ADDRESS not set');
    process.exit(1);
  }

  try {
    // Step 1: Drop all existing order history
    console.log('🗑️  Dropping existing order history...');
    const existingIndex = await redis.get<string[]>('order-index');
    if (existingIndex && Array.isArray(existingIndex)) {
      for (const hash of existingIndex) {
        await redis.del(`order:${hash}`);
      }
      console.log(`  Deleted ${existingIndex.length} existing orders`);
    }
    await redis.del('order-index');
    console.log('  Cleared order index\n');

    // Step 2: Fetch all filled orders
    console.log(`📋 Fetching filled orders for ${xcpfolioAddress}...`);
    const orders = await counterparty.getFilledXCPFOLIOOrders(xcpfolioAddress);
    console.log(`  Found ${orders.length} filled orders\n`);

    const orderIndex: string[] = [];
    let processed = 0;
    let skipped = 0;

    console.log('🔨 Processing orders with new structure...\n');

    for (const order of orders) {
      try {
        // Get order matches to find buyer and buyer's order hash
        const matches = await counterparty.getOrderMatches(order.tx_hash);
        if (!matches || matches.length === 0) {
          console.log(`  ⚠️  No matches for ${order.tx_hash}, skipping`);
          skipped++;
          continue;
        }

        const match = matches[0];
        
        // Determine buyer and buyer's order hash
        let buyer: string;
        let buyerOrderHash: string;
        
        if (match.tx0_address === xcpfolioAddress) {
          // We are tx0 (sell order creator), buyer is tx1
          buyer = match.tx1_address;
          buyerOrderHash = match.tx1_hash;
        } else {
          // We are tx1 (shouldn't happen for our sell orders)
          buyer = match.tx0_address;
          buyerOrderHash = match.tx0_hash;
        }
        
        const assetLongname = order.give_asset_info?.asset_longname || order.give_asset;
        const assetName = assetLongname.replace('XCPFOLIO.', '');
        
        // Check if transfer exists by seeing if buyer now owns the asset
        const assetInfo = await counterparty.getAssetInfo(assetName);
        const hasTransfer = assetInfo.owner === buyer;

        let status: string = 'pending';
        let stage: string = 'broadcast';
        let txid: string | undefined;
        let deliveryBlock: number | undefined;
        let deliveryTime: number | undefined;
        
        if (hasTransfer) {
          // If buyer owns it, it's confirmed
          status = 'confirmed';
          stage = 'confirmed';
          
          // Try to get the transfer txid and block info from issuances
          const issuances = await counterparty.getAssetIssuances(assetName);
          const transfer = issuances.find(i => 
            i.transfer === true &&
            i.source === xcpfolioAddress &&
            i.issuer === buyer
          );
          
          if (transfer) {
            txid = transfer.tx_hash;
            deliveryBlock = transfer.block_index;
            // Transfer block_time is when the transfer was confirmed
            if (transfer.block_time) {
              deliveryTime = transfer.block_time * 1000; // Convert to ms
            }
          }
        }

        // Build order data with new structure
        const orderData: any = {
          orderHash: order.tx_hash,        // Our sell order (primary key)
          matchHash: buyerOrderHash,        // Buyer's buy order
          asset: assetName,
          price: (order.get_quantity / 100000000).toFixed(8), // Format to 8 decimals
          buyer,
          seller: xcpfolioAddress,
          status,
          stage,
          purchasedAt: order.block_time ? order.block_time * 1000 : Date.now(), // Convert seconds to ms
          purchasedBlock: order.block_index,
          confirmations: 1, // All these are confirmed on blockchain
          orderType: 'filled',
          lastUpdated: Date.now()
        };

        // Add optional fields only if they have values
        if (assetLongname && assetLongname.startsWith('XCPFOLIO.')) {
          orderData.assetLongname = assetLongname;
        }
        
        if (status === 'confirmed') {
          // For confirmed orders where the asset is now owned by buyer
          if (deliveryBlock) {
            orderData.confirmedBlock = deliveryBlock; // Block where transfer confirmed
          }
          
          // Set delivery time if we have it from the transfer
          if (deliveryTime) {
            orderData.deliveredAt = deliveryTime; // When transfer tx confirmed
            orderData.confirmedAt = deliveryTime; // Also set confirmedAt
            orderData.broadcastAt = deliveryTime - 60000; // Estimate broadcast ~1 min before confirmation
          } else if (order.block_time) {
            // Fallback: use order time if we don't have transfer time
            orderData.confirmedAt = order.block_time * 1000;
            orderData.deliveredAt = order.block_time * 1000;
          }
        }
        
        if (txid) {
          orderData.txid = txid; // The asset transfer transaction
        }

        // Save to KV with new structure
        await redis.hset(`order:${order.tx_hash}`, orderData);
        await redis.expire(`order:${order.tx_hash}`, 60 * 60 * 24 * 30); // 30 day TTL
        
        orderIndex.push(order.tx_hash);
        processed++;
        
        const statusEmoji = status === 'confirmed' ? '✅' : '⏳';
        console.log(`  ${statusEmoji} ${order.tx_hash.slice(0, 8)}... → ${buyerOrderHash.slice(0, 8)}... : ${assetName} → ${buyer.slice(0, 8)}... (${status})`);
        
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`  ❌ Error processing ${order.tx_hash}:`, error);
        skipped++;
      }
    }

    // Save the index - newest first
    if (orderIndex.length > 0) {
      // Reverse the array since we pushed in order but want newest first
      const reversedIndex = orderIndex.reverse();
      await redis.set('order-index', JSON.stringify(reversedIndex.slice(0, 100)), {
        ex: 60 * 60 * 24 * 30
      });
    }

    console.log('\n' + '='.repeat(50));
    console.log('✨ Order History Rebuild Complete!');
    console.log('='.repeat(50));
    console.log(`📊 Processed: ${processed} orders`);
    console.log(`⚠️  Skipped: ${skipped} orders`);
    console.log(`💾 Total in KV: ${orderIndex.length} orders`);
    console.log('\n📝 New structure:');
    console.log('  - orderHash: Our sell order (primary key)');
    console.log('  - matchHash: Buyer\'s order');
    console.log('  - txid: Asset transfer transaction');
    
  } catch (error) {
    console.error('❌ Rebuild failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  rebuildOrderHistory()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}