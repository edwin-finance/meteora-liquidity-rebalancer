import * as dotenv from 'dotenv';
dotenv.config();

import { MeteoraOptimizer } from '../src/index';
import { EdwinSolanaWallet } from 'edwin-sdk';

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupAndExit(code = 0) {
    process.exit(code);
}

async function main() {
    if (!process.env.SOLANA_PRIVATE_KEY) {
        throw new Error('SOLANA_PRIVATE_KEY is not set');
    }
    if (!process.env.METEORA_POOL_ADDRESS) {
        throw new Error('METEORA_POOL_ADDRESS is not set');
    }
    // Set up cleanup on process termination
    process.on('SIGINT', () => cleanupAndExit());
    process.on('SIGTERM', () => cleanupAndExit());

    const wallet = new EdwinSolanaWallet(process.env.SOLANA_PRIVATE_KEY);
    const meteoraOptimizer = new MeteoraOptimizer(wallet, process.env.METEORA_POOL_ADDRESS);
    const changedPosition = await meteoraOptimizer.loadInitialState();
    console.log('Initial position loaded:', changedPosition ? 'Created new position' : 'Using existing position');

    async function runOptimizationLoop() {
        try {
            const changedPosition = await meteoraOptimizer.optimize();
            if (changedPosition) {
                console.log('Position was rebalanced');
            }
        } catch (error) {
            // Only handle expected errors here, let unexpected errors bubble up
            if (error instanceof Error && error.message.includes('Bad request')) {
                console.error('Expected error running optimizeMeteora:', error);
            } else {
                throw error;
            }
        }

        await delay(10 * 1000);
        await runOptimizationLoop();
    }

    // Start the optimization loop 10 seconds after startup
    setTimeout(runOptimizationLoop, 10 * 1000);
}

main().catch(async (error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('Insufficient native token balance for transaction and position creation fees')) {
        console.error(
            'Not enough native token balance for transaction and position creation fees. Please fund the wallet with more native token and try again.'
        );
        await cleanupAndExit(1);
        return;
    }

    console.error('Unexpected error:', error);
    await cleanupAndExit(1);
});
