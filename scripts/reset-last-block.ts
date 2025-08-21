#!/usr/bin/env node
/**
 * Reset the lastBlock in fulfillment state to allow reprocessing
 */

import dotenv from 'dotenv';
import { Redis } from '@upstash/redis';

dotenv.config();

async function resetLastBlock(targetBlock?: number) {
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
    const currentState = await redis.get(stateKey);
    
    console.log('Current state:', currentState);
    
    if (targetBlock !== undefined) {
      // Set to specific block
      const newState = currentState || {};
      newState.lastBlock = targetBlock;
      await redis.set(stateKey, JSON.stringify(newState), {
        ex: 60 * 60 * 24 * 30 // 30 day TTL
      });
      console.log(`Reset lastBlock to ${targetBlock}`);
    } else {
      // Reset to 0 to reprocess all
      const newState = currentState || {};
      newState.lastBlock = 0;
      await redis.set(stateKey, JSON.stringify(newState), {
        ex: 60 * 60 * 24 * 30 // 30 day TTL
      });
      console.log('Reset lastBlock to 0 (will reprocess all orders)');
    }
    
    const updatedState = await redis.get(stateKey);
    console.log('Updated state:', updatedState);
    
  } catch (error) {
    console.error('Failed to reset state:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  const targetBlock = process.argv[2] ? parseInt(process.argv[2]) : undefined;
  resetLastBlock(targetBlock)
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}