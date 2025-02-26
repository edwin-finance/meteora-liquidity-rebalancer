import { BinLiquidity } from '@meteora-ag/dlmm';
import { BalanceLogger } from './utils/logger';
import { AlertType, sendAlert } from './utils/alerts';
import { EdwinSolanaWallet } from 'edwin-sdk';
import { MeteoraProtocol } from 'edwin-sdk';
import { JupiterService } from 'edwin-sdk';

const METERORA_MAX_BINS_PER_SIDE = 34;
const SOL_FEE_BUFFER = 0.1; // Keep 0.1 SOL for transaction fees

/**
 * MeteoraOptimizer class for managing and optimizing liquidity positions on Meteora.
 * This class handles position creation, rebalancing, and optimization to maximize yield.
 */
export class MeteoraOptimizer {
    private workingPoolAddress: string | undefined;
    private workingPoolBinStep: number | undefined;
    private currLowerBinId: number = 0;
    private currUpperBinId: number = 0;
    private meteora: MeteoraProtocol;
    private jupiter: JupiterService;
    private balanceLogger: BalanceLogger;
    private positionRangePerSide: number;
    private wallet: EdwinSolanaWallet;

    /**
     * Creates a new MeteoraOptimizer instance.
     *
     * @param wallet - An EdwinSolanaWallet instance for interacting with the Solana blockchain
     */
    constructor(wallet: EdwinSolanaWallet) {
        this.meteora = new MeteoraProtocol(wallet);
        this.jupiter = new JupiterService(wallet);
        this.wallet = wallet;
        this.balanceLogger = new BalanceLogger();
        this.positionRangePerSide = Number(process.env.METEORA_POSITION_RANGE_PER_SIDE_RELATIVE);
    }

    /**
     * Gets the current wallet balances with a buffer for SOL to ensure enough for transaction fees.
     *
     * @returns Object containing usable SOL and USDC balances
     */
    private async getUsableBalances(): Promise<{ sol: number; usdc: number }> {
        const solBalance = await this.wallet.getBalance();
        const usdcBalance = await this.wallet.getBalance('usdc');

        // Return balances with a buffer for SOL
        return {
            sol: Math.max(0, solBalance - SOL_FEE_BUFFER),
            usdc: usdcBalance,
        };
    }

    /**
     * Helper function that will retry the given async function a few times.
     * If all attempts fail, the last error is thrown.
     */
    private async retry<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
        let lastError: unknown;
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                console.error(`Attempt ${attempt + 1} failed: ${error}`);
                if (error instanceof Error && error.message.includes('insufficient funds')) {
                    throw new Error('Insufficient funds');
                }
                if (attempt < retries - 1) {
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                }
            }
        }
        throw lastError;
    }

    private async getGoodPool(): Promise<[string | undefined, number | undefined]> {
        try {
            const pools = await this.retry(() =>
                this.meteora.getPools({
                    asset: 'sol',
                    assetB: 'usdc',
                })
            );
            const minBinStep = Math.ceil((this.positionRangePerSide * 10000) / METERORA_MAX_BINS_PER_SIDE);
            const filteredPools = pools.filter((pool) => pool.bin_step >= minBinStep);
            const pool = filteredPools.reduce((maxPool: any, currentPool: any) => {
                if (!maxPool || currentPool.trade_volume_24h > maxPool.trade_volume_24h) {
                    return currentPool;
                }
                return maxPool;
            }, null);

            if (!pool) {
                console.log('No pool found with minimum bin step of', minBinStep);
                return [undefined, undefined];
            }
            return [pool.address, pool.bin_step];
        } catch (error) {
            console.error('Error in getGoodPool:', error);
            await sendAlert(
                AlertType.ERROR,
                `In getGoodPool: ${error instanceof Error ? error.message : String(error)}`
            );
            return [undefined, undefined];
        }
    }

    private async getBinStep(poolAddress: string): Promise<number | undefined> {
        try {
            const response = await fetch(`https://dlmm-api.meteora.ag/pair/${poolAddress}`, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            return data.bin_step;
        } catch (error) {
            console.error('Error in getBinStep:', error);
            await sendAlert(
                AlertType.ERROR,
                `In getBinStep: ${error instanceof Error ? error.message : String(error)}`
            );
            return undefined;
        }
    }

    async loadInitialState(): Promise<boolean> {
        const balances = await this.getUsableBalances();
        console.log('Initial balances from wallet: ', balances.sol, balances.usdc);

        const positions = await this.retry(() => this.meteora.getPositions());

        if (positions.size === 0) {
            console.log('No positions found');
            const [poolAddress, binStep] = await this.getGoodPool();
            if (!poolAddress) {
                console.error('Failed to find a good pool.');
                return false;
            }
            this.workingPoolAddress = poolAddress;
            this.workingPoolBinStep = binStep;
            console.log(
                'Found pool to work with: ',
                this.workingPoolAddress,
                'with bin step: ',
                this.workingPoolBinStep
            );
            await this.rebalancePosition();
            await this.addLiquidity();
            return true;
        } else {
            const position = positions.values().next().value;
            if (!position) {
                throw new Error('No valid position found.');
            }
            this.workingPoolAddress = position.publicKey.toString();
            this.workingPoolBinStep = await this.getBinStep(this.workingPoolAddress);
            if (!this.workingPoolBinStep) {
                throw new Error('Failed to get bin step for pool: ' + this.workingPoolAddress);
            }
            const positionData = position.lbPairPositionsData[0].positionData;
            this.currLowerBinId = positionData.lowerBinId;
            this.currUpperBinId = positionData.upperBinId;
            console.log(
                'Found existing position in pool: ',
                this.workingPoolAddress,
                'with bin step: ',
                this.workingPoolBinStep,
                'and bin range: ',
                this.currLowerBinId,
                'to',
                this.currUpperBinId
            );
            return false;
        }
    }

    private async rebalancePosition() {
        try {
            // Get current balances from wallet
            const { sol: positionSol, usdc: positionUsdc } = await this.getUsableBalances();
            console.log(`Current position balances before rebalance: ${positionSol} SOL, ${positionUsdc} USDC`);

            // Get current price from Meteora pool (with retry)
            if (!this.workingPoolAddress) {
                throw new Error('No working pool address found');
            }
            const activeBin: BinLiquidity = await this.retry(() =>
                this.meteora.getActiveBin({
                    poolAddress: this.workingPoolAddress as string,
                })
            );

            if (!activeBin) {
                throw new Error('Failed to get active bin from Meteora pool');
            }

            const currentPrice = Number(activeBin.pricePerToken);
            console.log('Current price of SOL/USDC: ', currentPrice);

            // Calculate total value in USD
            const totalValueInUsd = positionSol * currentPrice + positionUsdc;
            console.log('Total portfolio value in USD: ', totalValueInUsd);

            // Calculate target balances (50/50)
            const targetValueInUsd = totalValueInUsd / 2;
            const targetSolBalance = targetValueInUsd / currentPrice;
            const targetUsdcBalance = targetValueInUsd;

            console.log(`Target balances: ${targetSolBalance} SOL, ${targetUsdcBalance} USDC`);

            // Calculate how much to swap
            if (positionSol > targetSolBalance) {
                // Need to sell SOL for USDC
                const solToSwap = positionSol - targetSolBalance;
                console.log(`Need to swap ${solToSwap.toFixed(6)} SOL for USDC`);

                if (solToSwap < 0.01) {
                    console.log('Amount too small to swap, skipping');
                    return;
                }

                // Execute the swap
                const outputUsdcAmount = await this.retry(() =>
                    this.jupiter.swap({
                        asset: 'sol',
                        assetB: 'usdc',
                        amount: solToSwap.toString(),
                    })
                );
                this.balanceLogger.logAction(
                    `Swapped ${solToSwap.toFixed(6)} SOL for ${outputUsdcAmount.toFixed(6)} USDC to rebalance`
                );
            } else if (positionUsdc > targetUsdcBalance) {
                // Need to sell USDC for SOL
                const usdcToSwap = positionUsdc - targetUsdcBalance;
                console.log(`Need to swap ${usdcToSwap.toFixed(6)} USDC for SOL`);

                if (usdcToSwap < 0.01) {
                    console.log('Amount too small to swap, skipping');
                    return;
                }

                // Execute the swap
                const outputSolAmount = await this.retry(() =>
                    this.jupiter.swap({
                        asset: 'usdc',
                        assetB: 'sol',
                        amount: usdcToSwap.toString(),
                    })
                );

                this.balanceLogger.logAction(
                    `Swapped ${usdcToSwap.toFixed(6)} USDC for ${outputSolAmount.toFixed(6)} SOL to rebalance`
                );
            }

            this.balanceLogger.logCurrentPrice(Number(activeBin.pricePerToken));
            const balances = await this.getUsableBalances();
            this.balanceLogger.logBalances(balances.sol, balances.usdc, 'Total worth after rebalance');

            // 5 seconds delay for the wallet catch up
            await new Promise((resolve) => setTimeout(resolve, 5000));
        } catch (error) {
            console.error('Error in rebalancePosition:', error);
            throw error;
        }
    }

    private async addLiquidity() {
        const balances = await this.getUsableBalances();
        const meteoraRangeInterval = Math.ceil(
            (this.positionRangePerSide * 10000) / (this.workingPoolBinStep as number)
        );
        console.log('Adding liquidity with range interval: ', meteoraRangeInterval);
        await this.retry(() =>
            this.meteora.addLiquidity({
                poolAddress: this.workingPoolAddress as string,
                amount: balances.sol.toString(),
                amountB: balances.usdc.toString(),
                rangeInterval: Math.min(meteoraRangeInterval, METERORA_MAX_BINS_PER_SIDE),
            })
        );
        this.balanceLogger.logBalances(balances.sol, balances.usdc, 'Liquidity added to pool');

        console.log('Collecting new opened position lower and upper bin ids..');
        let positions = await this.retry(() =>
            this.meteora.getPositionsFromPool({
                poolAddress: this.workingPoolAddress as string,
            })
        );

        // Retry if positions array is empty
        if (positions.length === 0) {
            console.log('No positions found, retrying...');
            positions = await this.retry(() =>
                this.meteora.getPositionsFromPool({
                    poolAddress: this.workingPoolAddress as string,
                })
            );
        }

        const position = positions[0].positionData;
        this.currLowerBinId = position.lowerBinId;
        this.currUpperBinId = position.upperBinId;
        console.log('New position lower and upper bin ids collected: ', this.currLowerBinId, this.currUpperBinId);
    }

    private async removeLiquidity() {
        const { liquidityRemoved, feesClaimed } = await this.retry(() =>
            this.meteora.removeLiquidity({
                shouldClosePosition: true,
                poolAddress: this.workingPoolAddress as string,
            })
        );
        const positionSol = liquidityRemoved[0];
        const positionUsdc = liquidityRemoved[1];
        const rewardsSol = feesClaimed[0];
        const rewardsUsdc = feesClaimed[1];
        this.balanceLogger.logBalances(positionSol, positionUsdc, 'Liquidity removed from pool');
        this.balanceLogger.logBalances(rewardsSol, rewardsUsdc, 'Rewards claimed');

        // Wait for the wallet to update with the new balances
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const newBalances = await this.getUsableBalances();
        this.balanceLogger.logAction(
            `Withdrew liquidity and rewards from pool ${this.workingPoolAddress}: ${
                newBalances.sol
            } SOL, ${newBalances.usdc} USDC`
        );
    }

    public async optimize(): Promise<boolean> {
        try {
            if (!this.workingPoolAddress) {
                throw new Error('No working pool address found');
            }
            const activeBin: BinLiquidity = await this.retry(() =>
                this.meteora.getActiveBin({
                    poolAddress: this.workingPoolAddress as string,
                })
            );
            if (activeBin.binId < this.currLowerBinId || activeBin.binId > this.currUpperBinId) {
                console.log(
                    `Pool active bin ${activeBin.binId} is out of position bin range: ${this.currLowerBinId} to ${this.currUpperBinId}`
                );
                this.balanceLogger.logAction(
                    `Detected that pool active bin ${activeBin.binId} is out of position bin range: ${this.currLowerBinId} to ${this.currUpperBinId}`
                );
                await this.removeLiquidity();
                await this.rebalancePosition();
                await this.addLiquidity();
                return true;
            } else {
                console.log(
                    `Pool active bin ${activeBin.binId} is within position bin range: ${this.currLowerBinId} to ${this.currUpperBinId}`
                );
                return false;
            }
        } catch (error) {
            if (error instanceof Error && error.message.includes('No positions found in this pool')) {
                // Position situation might be stale, initialize the optimizer
                await this.loadInitialState();
            }
            console.error('Error in optimizeMeteora:', error);
            await sendAlert(
                AlertType.ERROR,
                `In optimizeMeteora: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
        }
    }
}
