#!/usr/bin/env node
/**
 * Clear the processed orders from fulfillment state
 * This allows the bot to reprocess orders if needed
 */

import dotenv from 'dotenv';
import { Redis } from '@upstash/redis';

dotenv.config();

async function clearProcessedOrders() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error('KV credentials not found. Set KV_REST_API_URL and KV_REST_API_TOKEN');
    process.exit(1);
  }

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  try {
    const stateKey = 'fulfillment-state';
    const currentState: any = await redis.get(stateKey) || {};
    
    console.log('Current state:', currentState);
    console.log(`Currently has ${currentState.processedOrders?.length || 0} processed orders`);
    
    // Clear processed orders but keep other state
    currentState.processedOrders = [];
    currentState.lastBlock = 0; // Also reset lastBlock to recheck everything
    
    await redis.set(stateKey, JSON.stringify(currentState), {
      ex: 60 * 60 * 24 * 30 // 30 day TTL
    });
    
    console.log('✅ Cleared processed orders list');
    console.log('✅ Reset lastBlock to 0');
    console.log('Bot will now recheck all orders on next run');
    
  } catch (error) {
    console.error('Failed to clear state:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  clearProcessedOrders()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}