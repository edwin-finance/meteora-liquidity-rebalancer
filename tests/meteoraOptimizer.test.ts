import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { MeteoraOptimizer } from '../src/meteoraOptimizer';
import { EdwinSolanaWallet } from 'edwin-sdk';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Ensure we have required environment variables for tests
const requiredEnvVars = [
  'SOLANA_PRIVATE_KEY',
  'SOLANA_RPC_URL',
  'METEORA_POSITION_RANGE_PER_SIDE_RELATIVE',
];

// Define pools for testing
const POOLS = {
  SOL_USDC: '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',
  EDWIN_SOL: 'FCm4NWb9ko9FAP2qLUjXccxgGnVEBahRoy8hh93biQuT',
};

// Allow tests to be skipped when not in a suitable environment
const skipTests = !requiredEnvVars.every(envVar => !!process.env[envVar]);

describe('MeteoraOptimizer Real-world Tests', () => {
  let wallet: EdwinSolanaWallet;
  let optimizer: MeteoraOptimizer;
  let originalEnv: NodeJS.ProcessEnv;
  
  beforeAll(() => {
    // Check for required environment variables
    if (skipTests) {
      console.warn('Skipping real-world tests due to missing environment variables. Required:', requiredEnvVars);
    }
  });

  beforeEach(() => {
    // Store original environment variables
    originalEnv = { ...process.env };
    
    // Only create wallet and optimizer if tests aren't being skipped
    if (!skipTests) {
      wallet = new EdwinSolanaWallet(process.env.SOLANA_PRIVATE_KEY!);
    }
  });

  afterEach(() => {
    // Restore original environment variables
    process.env = originalEnv;
  });

  describe('SOL/USDC Asset Pair', () => {
    it('should initialize with SOL/USDC pool', async () => {
      if (skipTests) return;

      optimizer = new MeteoraOptimizer(wallet, POOLS.SOL_USDC);
      
      // Just check that it initializes without throwing
      await expect(optimizer.loadInitialState()).resolves.not.toThrow();
    });
    
    it('should check if optimization is needed based on price movement', async () => {
      if (skipTests) return;

      optimizer = new MeteoraOptimizer(wallet, POOLS.SOL_USDC);
      
      // Initialize first
      await optimizer.loadInitialState();
      
      // Check optimization - should not throw
      await expect(optimizer.optimize()).resolves.not.toThrow();
    });
  });

  describe('Different Asset Pairs', () => {
    it('should initialize with EDWIN/SOL pool', async () => {
      if (skipTests) return;

      optimizer = new MeteoraOptimizer(wallet, POOLS.EDWIN_SOL);
      
      // Just check that it initializes without throwing
      await expect(optimizer.loadInitialState()).resolves.not.toThrow();
    });
    
    it('should throw error for invalid pool address', () => {
      if (skipTests) return;
      
      expect(() => {
        new MeteoraOptimizer(wallet, 'invalid-pool-address');
      }).toThrow();
    });
  });

  describe('Different Position Range Configurations', () => {
    it('should work with different position range settings', async () => {
      if (skipTests) return;

      // Test with a higher position range
      process.env.METEORA_POSITION_RANGE_PER_SIDE_RELATIVE = '0.1'; // 10% range
      optimizer = new MeteoraOptimizer(wallet, POOLS.SOL_USDC);
      
      // Should initialize successfully with higher range
      await expect(optimizer.loadInitialState()).resolves.not.toThrow();
      
      // Test with a lower position range
      process.env.METEORA_POSITION_RANGE_PER_SIDE_RELATIVE = '0.02'; // 2% range
      optimizer = new MeteoraOptimizer(wallet, POOLS.SOL_USDC);
      
      // Should initialize successfully with lower range
      await expect(optimizer.loadInitialState()).resolves.not.toThrow();
    });
  });

  describe('Native Token Fee Buffer', () => {
    it('should respect different native token fee buffer settings', async () => {
      if (skipTests) return;

      // Test with a higher fee buffer
      process.env.NATIVE_TOKEN_FEE_BUFFER = '0.2'; // Higher buffer
      optimizer = new MeteoraOptimizer(wallet, POOLS.SOL_USDC);
      
      // Should initialize successfully
      await expect(optimizer.loadInitialState()).resolves.not.toThrow();
    });
  });
}); 