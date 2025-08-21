#!/usr/bin/env node
/**
 * Update delivery times and blocks for confirmed orders
 */

import dotenv from 'dotenv';
import { Redis } from '@upstash/redis';
import { CounterpartyService } from '../src/services/counterparty';
import { BitcoinService } from '../src/services/bitcoin';

dotenv.config();

async function updateDeliveryTimes() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('KV credentials not found. Set KV_REST_API_URL and KV_REST_API_TOKEN');
    process.exit(1);
  }

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  const counterparty = new CounterpartyService();
  const bitcoin = new BitcoinService('mainnet');
  const xcpfolioAddress = process.env.XCPFOLIO_ADDRESS!;

  try {
    // Get order index
    const orderIndex = await redis.get<string[]>('order-index');
    if (!orderIndex || !Array.isArray(orderIndex)) {
      console.log('No orders found in index');
      return;
    }

    console.log(`Found ${orderIndex.length} orders in index`);
    console.log('Updating delivery times for confirmed orders...\n');
    
    let updated = 0;

    for (const orderHash of orderIndex) {
      const order: any = await redis.hgetall(`order:${orderHash}`);
      if (!order) continue;

      // Only process confirmed orders that are missing delivery info
      if (order.status === 'confirmed' || order.status === 'confirming') {
        console.log(`\nChecking order ${orderHash}:`);
        console.log(`  Asset: ${order.asset}`);
        console.log(`  Buyer: ${order.buyer}`);
        console.log(`  Current deliveredAt: ${order.deliveredAt || 'MISSING'}`);
        
        try {
          // Get asset issuances to find the transfer transaction
          const issuances = await counterparty.getAssetIssuances(order.asset);
          
          // Find the transfer to the buyer
          const transfer = issuances.find(i => 
            i.transfer === true &&
            i.source === xcpfolioAddress &&
            i.issuer === order.buyer  // issuer is the new owner for transfers
          );
          
          if (transfer) {
            console.log(`  Found transfer: ${transfer.tx_hash}`);
            console.log(`  Block: ${transfer.block_index}`);
            console.log(`  Block time: ${transfer.block_time ? new Date(transfer.block_time * 1000).toISOString() : 'Unknown'}`);
            
            // Update order with delivery details
            if (!order.txid || order.txid === 'undefined') {
              order.txid = transfer.tx_hash;
            }
            
            if (transfer.block_index) {
              order.confirmedBlock = transfer.block_index;
            }
            
            if (transfer.block_time) {
              // Convert from seconds to milliseconds
              const deliveryTime = transfer.block_time * 1000;
              order.deliveredAt = deliveryTime;
              order.confirmedAt = deliveryTime;
              console.log(`  ✅ Updated delivery time: ${new Date(deliveryTime).toISOString()}`);
            }
            
            // Ensure status is confirmed
            order.status = 'confirmed';
            order.stage = 'confirmed';
            
            // Clean nulls and save
            const cleanedOrder: any = {};
            for (const [key, value] of Object.entries(order)) {
              if (value !== null && value !== undefined && value !== '' && value !== 'undefined') {
                cleanedOrder[key] = value;
              }
            }
            
            await redis.hset(`order:${orderHash}`, cleanedOrder);
            updated++;
            
          } else {
            // Try to check if asset is owned by buyer (confirmed but no transfer record found)
            const assetInfo = await counterparty.getAssetInfo(order.asset);
            if (assetInfo.owner === order.buyer) {
              console.log(`  Asset confirmed owned by buyer, but no transfer record found`);
              
              // At least mark it as confirmed with current time if no delivery time
              if (!order.deliveredAt || order.deliveredAt === 'undefined') {
                const now = Date.now();
                order.deliveredAt = now;
                order.confirmedAt = now;
                order.status = 'confirmed';
                order.stage = 'confirmed';
                
                // Clean and save
                const cleanedOrder: any = {};
                for (const [key, value] of Object.entries(order)) {
                  if (value !== null && value !== undefined && value !== '' && value !== 'undefined') {
                    cleanedOrder[key] = value;
                  }
                }
                
                await redis.hset(`order:${orderHash}`, cleanedOrder);
                updated++;
                console.log(`  ✅ Set delivery time to current time (no transfer record found)`);
              }
            } else {
              console.log(`  ⚠️ Asset not owned by buyer, may still be pending`);
            }
          }
          
        } catch (error) {
          console.error(`  Error processing order:`, error);
        }
      }
    }

    console.log(`\n✅ Updated ${updated} orders with delivery information`);
    
  } catch (error) {
    console.error('Error updating delivery times:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  updateDeliveryTimes()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}