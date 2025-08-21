#!/usr/bin/env node
/**
 * Fix incorrect timestamps in existing order history
 */

import dotenv from 'dotenv';
import { Redis } from '@upstash/redis';
import { CounterpartyService } from '../src/services/counterparty';

dotenv.config();

async function fixTimestamps() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('KV credentials not found. Set KV_REST_API_URL and KV_REST_API_TOKEN');
    process.exit(1);
  }

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  const counterparty = new CounterpartyService();

  try {
    // Get order index
    const orderIndex = await redis.get<string[]>('order-index');
    if (!orderIndex || !Array.isArray(orderIndex)) {
      console.log('No orders found in index');
      return;
    }

    console.log(`Found ${orderIndex.length} orders in index`);
    let fixed = 0;

    for (const orderHash of orderIndex) {
      const order = await redis.hgetall(`order:${orderHash}`);
      if (!order) continue;

      // Check if purchasedAt looks wrong (too small or missing)
      const purchasedAt = parseInt(order.purchasedAt as string);
      
      // If timestamp is suspiciously small (less than year 2020 in milliseconds)
      if (!purchasedAt || purchasedAt < 1577836800000) {
        console.log(`\nFixing order ${orderHash}:`);
        console.log(`  Current purchasedAt: ${purchasedAt} (${new Date(purchasedAt).toISOString()})`);
        
        // Try to get the actual order from Counterparty to get block_time
        try {
          const cpOrders = await counterparty.getOrdersByAddress(
            process.env.XCPFOLIO_ADDRESS!,
            'filled',
            100,
            0
          );
          
          const cpOrder = cpOrders.find(o => o.tx_hash === orderHash);
          if (cpOrder && cpOrder.block_time) {
            // block_time is in seconds, convert to milliseconds
            const correctTime = cpOrder.block_time * 1000;
            console.log(`  Fixed purchasedAt: ${correctTime} (${new Date(correctTime).toISOString()})`);
            
            // Update the order with correct timestamp
            order.purchasedAt = correctTime;
            
            // Clean nulls and save
            const cleanedOrder: any = {};
            for (const [key, value] of Object.entries(order)) {
              if (value !== null && value !== undefined && value !== '') {
                cleanedOrder[key] = value;
              }
            }
            
            await redis.hset(`order:${orderHash}`, cleanedOrder);
            fixed++;
          } else {
            // If we can't find the order, use current time as fallback
            const fallbackTime = Date.now();
            console.log(`  Using fallback time: ${fallbackTime} (${new Date(fallbackTime).toISOString()})`);
            
            order.purchasedAt = fallbackTime;
            
            // Clean nulls and save
            const cleanedOrder: any = {};
            for (const [key, value] of Object.entries(order)) {
              if (value !== null && value !== undefined && value !== '') {
                cleanedOrder[key] = value;
              }
            }
            
            await redis.hset(`order:${orderHash}`, cleanedOrder);
            fixed++;
          }
        } catch (error) {
          console.error(`  Error fetching order from Counterparty:`, error);
          
          // Use current time as fallback
          const fallbackTime = Date.now();
          order.purchasedAt = fallbackTime;
          
          // Clean nulls and save
          const cleanedOrder: any = {};
          for (const [key, value] of Object.entries(order)) {
            if (value !== null && value !== undefined && value !== '') {
              cleanedOrder[key] = value;
            }
          }
          
          await redis.hset(`order:${orderHash}`, cleanedOrder);
          fixed++;
        }
      }
    }

    console.log(`\n✅ Fixed ${fixed} orders with incorrect timestamps`);
    
  } catch (error) {
    console.error('Error fixing timestamps:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  fixTimestamps()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}