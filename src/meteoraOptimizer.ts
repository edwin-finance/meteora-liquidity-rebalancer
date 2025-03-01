import { BinLiquidity } from '@meteora-ag/dlmm';
import { BalanceLogger } from './utils/logger';
import { AlertType, sendAlert } from './utils/alerts';
import { EdwinSolanaWallet } from 'edwin-sdk';
import { MeteoraProtocol } from 'edwin-sdk';
import { JupiterService } from 'edwin-sdk';

const METERORA_MAX_BINS_PER_SIDE = 34;
const NATIVE_TOKEN_FEE_BUFFER = Number(process.env.NATIVE_TOKEN_FEE_BUFFER || 0.1); // Keep buffer for transaction and position creation fees

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
    private assetA: string;
    private assetB: string;
    private isAssetANative: boolean;
    private isAssetBNative: boolean;

    /**
     * Creates a new MeteoraOptimizer instance.
     *
     * @param wallet - An EdwinSolanaWallet instance for interacting with the Solana blockchain
     * @param assetA - The first asset in the trading pair (e.g., 'sol')
     * @param assetB - The second asset in the trading pair (e.g., 'usdc')
     */
    constructor(wallet: EdwinSolanaWallet, assetA: string, assetB: string) {
        this.meteora = new MeteoraProtocol(wallet);
        this.jupiter = new JupiterService(wallet);
        this.wallet = wallet;
        this.balanceLogger = new BalanceLogger();
        this.positionRangePerSide = Number(process.env.METEORA_POSITION_RANGE_PER_SIDE_RELATIVE);
        this.assetA = assetA;
        this.assetB = assetB;
        this.isAssetANative = assetA.toLowerCase() === 'sol';
        this.isAssetBNative = assetB.toLowerCase() === 'sol';

        // Ensure both assets are not SOL
        if (this.isAssetANative && this.isAssetBNative) {
            throw new Error('Both assets cannot be SOL');
        }
    }

    /**
     * Gets the current wallet balances with a buffer for native token to ensure enough for transaction fees.
     *
     * @returns Object containing usable assetA and assetB balances
     */
    private async getUsableBalances(): Promise<{ [asset: string]: number }> {
        const assetABalance = await this.wallet.getBalance(this.assetA);
        const assetBBalance = await this.wallet.getBalance(this.assetB);

        // Return balances with a buffer for native token
        const result: { [key: string]: number } = {};

        // Apply buffer to whichever asset is SOL
        result[this.assetA] = this.isAssetANative
            ? Math.max(0, assetABalance - NATIVE_TOKEN_FEE_BUFFER)
            : assetABalance;

        result[this.assetB] = this.isAssetBNative
            ? Math.max(0, assetBBalance - NATIVE_TOKEN_FEE_BUFFER)
            : assetBBalance;

        return result;
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
                    asset: this.assetA,
                    assetB: this.assetB,
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

    private async verifyNativeTokenBuffer() {
        // Get native SOL balance directly (without accounting for the buffer)
        const nativeBalance = await this.wallet.getBalance();
        if (nativeBalance < NATIVE_TOKEN_FEE_BUFFER) {
            console.error(
                `Insufficient native token balance for transaction and position creation fees: ${nativeBalance} SOL. Minimum required: ${NATIVE_TOKEN_FEE_BUFFER} SOL`
            );
            await sendAlert(
                AlertType.ERROR,
                `Insufficient native token balance for transaction and position creation fees: ${nativeBalance} SOL. Minimum required: ${NATIVE_TOKEN_FEE_BUFFER} SOL`
            );
            throw new Error('Insufficient native token balance for transaction and position creation fees');
        }
    }

    async loadInitialState(): Promise<boolean> {
        const balances = await this.getUsableBalances();
        console.log(
            `Initial balances from wallet: ${balances[this.assetA]} ${this.assetA}, ${balances[this.assetB]} ${this.assetB}`
        );

        // Verify we have enough native token for transaction fees
        await this.verifyNativeTokenBuffer();

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
            const balances = await this.getUsableBalances();
            const assetAAmount = balances[this.assetA];
            const assetBAmount = balances[this.assetB];

            console.log(
                `Current position balances before rebalance: ${assetAAmount} ${this.assetA}, ${assetBAmount} ${this.assetB}`
            );

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
            console.log(`Current price of ${this.assetA}/${this.assetB}: ${currentPrice}`);

            // Calculate total value in terms of assetB
            const totalValueInAssetB = assetAAmount * currentPrice + assetBAmount;

            // Calculate target balances (50/50)
            const targetValueInAssetB = totalValueInAssetB / 2;
            const targetAssetABalance = targetValueInAssetB / currentPrice;
            const targetAssetBBalance = targetValueInAssetB;

            console.log(
                `Target balances: ${targetAssetABalance} ${this.assetA}, ${targetAssetBBalance} ${this.assetB}`
            );

            // Calculate how much to swap
            if (assetAAmount > targetAssetABalance) {
                // Need to sell assetA for assetB
                const assetAToSwap = assetAAmount - targetAssetABalance;
                console.log(`Need to swap ${assetAToSwap.toFixed(6)} ${this.assetA} for ${this.assetB}`);

                // Execute the swap
                const outputAssetBAmount = await this.retry(() =>
                    this.jupiter.swap({
                        asset: this.assetA,
                        assetB: this.assetB,
                        amount: assetAToSwap.toString(),
                    })
                );
                this.balanceLogger.logAction(
                    `Swapped ${assetAToSwap.toFixed(6)} ${this.assetA} for ${outputAssetBAmount.toFixed(6)} ${this.assetB} to rebalance`
                );
            } else if (assetBAmount > targetAssetBBalance) {
                // Need to sell assetB for assetA
                const assetBToSwap = assetBAmount - targetAssetBBalance;
                console.log(`Need to swap ${assetBToSwap.toFixed(6)} ${this.assetB} for ${this.assetA}`);

                // Execute the swap
                const outputAssetAAmount = await this.retry(() =>
                    this.jupiter.swap({
                        asset: this.assetB,
                        assetB: this.assetA,
                        amount: assetBToSwap.toString(),
                    })
                );

                this.balanceLogger.logAction(
                    `Swapped ${assetBToSwap.toFixed(6)} ${this.assetB} for ${outputAssetAAmount.toFixed(6)} ${this.assetA} to rebalance`
                );
            }

            this.balanceLogger.logCurrentPrice(Number(activeBin.pricePerToken));
            const newBalances = await this.getUsableBalances();
            this.balanceLogger.logBalances(
                newBalances[this.assetA],
                newBalances[this.assetB],
                'Total worth after rebalance'
            );

            // 5 seconds delay for the wallet catch up
            await new Promise((resolve) => setTimeout(resolve, 5000));
        } catch (error) {
            console.error('Error in rebalancePosition:', error);
            throw error;
        }
    }

    private async addLiquidity() {
        // Verify we have enough native token for transaction fees before adding liquidity
        await this.verifyNativeTokenBuffer();

        const balances = await this.getUsableBalances();
        const meteoraRangeInterval = Math.ceil(
            (this.positionRangePerSide * 10000) / (this.workingPoolBinStep as number)
        );
        console.log('Adding liquidity with range interval: ', meteoraRangeInterval);
        await this.retry(() =>
            this.meteora.addLiquidity({
                poolAddress: this.workingPoolAddress as string,
                amount: balances[this.assetA].toString(),
                amountB: balances[this.assetB].toString(),
                rangeInterval: Math.min(meteoraRangeInterval, METERORA_MAX_BINS_PER_SIDE),
            })
        );
        this.balanceLogger.logBalances(balances[this.assetA], balances[this.assetB], 'Liquidity added to pool');

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
        const positionAssetA = liquidityRemoved[0];
        const positionAssetB = liquidityRemoved[1];
        const rewardsAssetA = feesClaimed[0];
        const rewardsAssetB = feesClaimed[1];
        this.balanceLogger.logBalances(positionAssetA, positionAssetB, 'Liquidity removed from pool');
        this.balanceLogger.logBalances(rewardsAssetA, rewardsAssetB, 'Rewards claimed');

        // Wait for the wallet to update with the new balances
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const newBalances = await this.getUsableBalances();
        this.balanceLogger.logAction(
            `Withdrew liquidity and rewards from pool ${this.workingPoolAddress}: ${
                newBalances[this.assetA]
            } ${this.assetA}, ${newBalances[this.assetB]} ${this.assetB}`
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
                await this.verifyNativeTokenBuffer();
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
