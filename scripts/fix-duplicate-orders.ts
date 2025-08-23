/**
 * Script to fix duplicate orders in the database
 * Merges duplicate orders for the same asset and buyer
 */

import { OrderHistoryService } from '../src/services/order-history';
import { CounterpartyService } from '../src/services/counterparty';
import * as dotenv from 'dotenv';

dotenv.config();

async function fixDuplicateOrders() {
  console.log('Starting duplicate order fix...\n');
  
  // Initialize services
  const orderHistory = new OrderHistoryService();
  const counterparty = new CounterpartyService();
  
  // Get all orders
  const allOrders = await orderHistory.getOrders();
  console.log(`Found ${allOrders.length} total orders\n`);
  
  // Group orders by asset and buyer
  const orderGroups = new Map<string, any[]>();
  
  for (const order of allOrders) {
    const key = `${order.asset}:${order.buyer}`;
    if (!orderGroups.has(key)) {
      orderGroups.set(key, []);
    }
    orderGroups.get(key)!.push(order);
  }
  
  // Find and fix duplicates
  for (const [key, orders] of orderGroups.entries()) {
    if (orders.length > 1) {
      console.log(`Found ${orders.length} orders for ${key}`);
      
      // Sort by purchase time (newest first)
      orders.sort((a, b) => {
        if (a.purchasedBlock && b.purchasedBlock) {
          return b.purchasedBlock - a.purchasedBlock;
        }
        return b.purchasedAt - a.purchasedAt;
      });
      
      // The most recent confirmed order is the one we want to keep
      let primaryOrder = orders.find(o => o.status === 'confirmed') || orders[0];
      
      // Check actual asset ownership
      const [asset, buyer] = key.split(':');
      try {
        const assetInfo = await counterparty.getAssetInfo(asset);
        const isDelivered = assetInfo.owner === buyer;
        
        console.log(`  Asset ${asset} owner: ${assetInfo.owner}`);
        console.log(`  Expected buyer: ${buyer}`);
        console.log(`  Delivered: ${isDelivered}`);
        
        if (isDelivered) {
          // Update the primary order to show it's delivered
          primaryOrder.status = 'confirmed';
          primaryOrder.stage = 'confirmed';
          if (!primaryOrder.deliveredAt) {
            primaryOrder.deliveredAt = Date.now();
          }
          if (!primaryOrder.confirmedAt) {
            primaryOrder.confirmedAt = Date.now();
          }
          
          // Merge any useful data from other orders
          for (const order of orders) {
            if (order.orderHash === primaryOrder.orderHash) continue;
            
            // Keep earliest purchase time
            if (order.purchasedAt < primaryOrder.purchasedAt) {
              primaryOrder.purchasedAt = order.purchasedAt;
            }
            
            // Keep txid if missing
            if (!primaryOrder.txid && order.txid) {
              primaryOrder.txid = order.txid;
            }
            
            // Keep block info if missing
            if (!primaryOrder.purchasedBlock && order.purchasedBlock) {
              primaryOrder.purchasedBlock = order.purchasedBlock;
            }
            if (!primaryOrder.confirmedBlock && order.confirmedBlock) {
              primaryOrder.confirmedBlock = order.confirmedBlock;
            }
          }
          
          // Update the primary order
          await orderHistory.upsertOrder(primaryOrder);
          console.log(`  ✅ Updated primary order ${primaryOrder.orderHash.slice(0,8)}... as delivered\n`);
          
          // Remove duplicate orders (keep only the primary)
          for (const order of orders) {
            if (order.orderHash !== primaryOrder.orderHash) {
              // Delete from Redis
              const redis = (orderHistory as any).redis;
              await redis.del(`order:${order.orderHash}`);
              console.log(`  🗑️  Removed duplicate order ${order.orderHash.slice(0,8)}...`);
            }
          }
        } else {
          console.log(`  ⏳ Asset not yet delivered, keeping status as-is\n`);
        }
      } catch (error) {
        console.error(`  ❌ Error checking asset ${asset}:`, error);
      }
    }
  }
  
  console.log('\nDuplicate order fix complete!');
}

// Run the script
fixDuplicateOrders().catch(console.error);