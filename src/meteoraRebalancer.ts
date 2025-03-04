import { BinLiquidity } from '@meteora-ag/dlmm';
import { BalanceLogger } from './utils/logger';
import { AlertType, sendAlert } from './utils/alerts';
import { EdwinSolanaWallet, JupiterService, MeteoraProtocol } from 'edwin-sdk';

const METERORA_MAX_BINS_PER_SIDE = 34;
const NATIVE_TOKEN_FEE_BUFFER = Number(process.env.NATIVE_TOKEN_FEE_BUFFER || 0.1); // Keep buffer for position creation fees
const NATIVE_TOKEN_MIN_BALANCE = Number(process.env.NATIVE_TOKEN_MIN_BALANCE || 0.01); // Minimum balance to operate for covering transaction fees

type PoolDetails = {
    binStep: number;
    assetAMintAddress: string;
    assetBMintAddress: string;
    assetASymbol: string;
    assetBSymbol: string;
};

/**
 * MeteoraRebalancer class for managing and rebalancing liquidity positions on Meteora.
 * This class handles position rebalancing to maintain a 50/50 balance between the two assets.
 */
export class MeteoraRebalancer {
    private poolAddress: string;
    private _poolDetails: PoolDetails | undefined;
    private currLowerBinId: number = 0;
    private currUpperBinId: number = 0;
    private meteora: MeteoraProtocol;
    private jupiter: JupiterService;
    private balanceLogger: BalanceLogger;
    private positionRangePerSide: number;
    private wallet: EdwinSolanaWallet;

    /**
     * Creates a new MeteoraRebalancer instance.
     */
    public constructor(wallet: EdwinSolanaWallet, poolAddress: string) {
        this.meteora = new MeteoraProtocol(wallet);
        this.jupiter = new JupiterService(wallet);
        this.wallet = wallet;
        this.balanceLogger = new BalanceLogger();
        if (
            !process.env.METEORA_POSITION_RANGE_PER_SIDE_RELATIVE ||
            isNaN(Number(process.env.METEORA_POSITION_RANGE_PER_SIDE_RELATIVE))
        ) {
            throw new Error('METEORA_POSITION_RANGE_PER_SIDE_RELATIVE must be set and be a valid number');
        }
        this.positionRangePerSide = Number(process.env.METEORA_POSITION_RANGE_PER_SIDE_RELATIVE);
        this.poolAddress = poolAddress;
    }

    /**
     * Gets the current wallet balances with a buffer for native token to ensure enough for transaction fees.
     *
     * @returns Object containing usable assetA and assetB balances
     */
    private async getUsableBalances(): Promise<{ [asset: string]: number }> {
        const assetABalance = await this.wallet.getBalance(this.poolDetails.assetAMintAddress);
        const assetBBalance = await this.wallet.getBalance(this.poolDetails.assetBMintAddress);
        // Return balances with a buffer for native token
        const result: { [key: string]: number } = {};
        const isAssetANative = this.poolDetails.assetASymbol.toLowerCase() === 'sol';
        const isAssetBNative = this.poolDetails.assetBSymbol.toLowerCase() === 'sol';

        // Apply buffer to whichever asset is SOL
        result[this.poolDetails.assetASymbol] = isAssetANative
            ? Math.max(0, assetABalance - NATIVE_TOKEN_FEE_BUFFER)
            : assetABalance;

        result[this.poolDetails.assetBSymbol] = isAssetBNative
            ? Math.max(0, assetBBalance - NATIVE_TOKEN_FEE_BUFFER)
            : assetBBalance;

        return result;
    }

    /**
     * Helper function that will retry the given async function a few times.
     * If all attempts fail, the last error is thrown.
     */
    private async retry<T>(fn: () => Promise<T>, retries = 5, delayMs = 5000): Promise<T> {
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

    /**
     * Helper function that will retry getting positions until a non-empty array is returned
     * or until max retries is reached.
     */
    private async retryGetPositions(retries = 5, delayMs = 5000): Promise<any[]> {
        let lastResult: any[] = [];
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const positions = await this.meteora.getPositionsFromPool({ poolAddress: this.poolAddress });
                if (positions.length > 0) {
                    return positions;
                }
                console.log(`Attempt ${attempt + 1}: No positions found yet, retrying in ${delayMs/1000}s...`);
                lastResult = positions;
            } catch (error) {
                console.error(`Attempt ${attempt + 1} failed: ${error}`);
                if (error instanceof Error && error.message.includes('insufficient funds')) {
                    throw new Error('Insufficient funds');
                }
            }
            
            if (attempt < retries - 1) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
        return lastResult; // Return the last result even if empty
    }

    private get poolDetails(): PoolDetails {
        if (!this._poolDetails) {
            throw new Error('Pool details not initialized. Make sure to call MeteoraRebalancer.loadInitialState()');
        }
        return this._poolDetails;
    }

    private async getPoolDetails(poolAddress: string): Promise<PoolDetails | undefined> {
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
            // Parse pool name (e.g. "SOL-USDC") into asset names
            const [assetASymbol, assetBSymbol] = data.name.split('-');
            if (!assetASymbol || !assetBSymbol) {
                throw new Error(`Invalid pool name format: ${data.name}`);
            }
            return {
                binStep: data.bin_step,
                assetAMintAddress: data.mint_x,
                assetBMintAddress: data.mint_y,
                assetASymbol: assetASymbol,
                assetBSymbol: assetBSymbol,
            };
        } catch (error) {
            console.error('Error in getPoolDetails:', error);
            await sendAlert(
                AlertType.ERROR,
                `In getPoolDetails: ${error instanceof Error ? error.message : String(error)}`
            );
            return undefined;
        }
    }

    private async verifyNativeTokenBalanceForFees() {
        const nativeBalance = await this.wallet.getBalance();
        if (nativeBalance < NATIVE_TOKEN_MIN_BALANCE) {
            await sendAlert(AlertType.WARNING, 'Low native token balance detected');
        }
    }

    async loadInitialState(): Promise<boolean> {
        this._poolDetails = await this.getPoolDetails(this.poolAddress);
        if (!this._poolDetails) {
            throw new Error('Failed to get pool details for pool: ' + this.poolAddress);
        }
        const balances = await this.getUsableBalances();
        console.log(
            `Initial usable balances: ${balances[this.poolDetails.assetASymbol]} ${this.poolDetails.assetASymbol}, ${balances[this.poolDetails.assetBSymbol]} ${this.poolDetails.assetBSymbol}`
        );

        console.log('Using specified pool: ', this.poolAddress, 'with bin step: ', this.poolDetails.binStep);

        const positions = await this.retryGetPositions();

        if (positions.length === 0) {
            console.log('No open positions found for pool: ', this.poolAddress);
            await this.verifyNativeTokenBalanceForFees();
            await this.rebalancePosition();
            await this.addLiquidity();
            return true;
        } else {
            const position = positions[0];
            const positionData = position.positionData;
            this.currLowerBinId = positionData.lowerBinId;
            this.currUpperBinId = positionData.upperBinId;
            console.log(
                'Found existing position in pool: ',
                this.poolAddress,
                'with bin step: ',
                this.poolDetails.binStep,
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
            const assetAAmount = balances[this.poolDetails.assetASymbol];
            const assetBAmount = balances[this.poolDetails.assetBSymbol];

            console.log(
                `Current position balances before rebalance: ${assetAAmount} ${this.poolDetails.assetASymbol}, ${assetBAmount} ${this.poolDetails.assetBSymbol}`
            );

            // Get current price from Meteora pool (with retry)
            if (!this.poolAddress) {
                throw new Error('No working pool address found');
            }
            const activeBin: BinLiquidity = await this.retry(() =>
                this.meteora.getActiveBin({
                    poolAddress: this.poolAddress as string,
                })
            );

            if (!activeBin) {
                throw new Error('Failed to get active bin from Meteora pool');
            }

            const currentPrice = Number(activeBin.pricePerToken);
            console.log(
                `Current price of ${this.poolDetails.assetASymbol}/${this.poolDetails.assetBSymbol}: ${currentPrice}`
            );

            // Calculate total value in terms of assetB
            const totalValueInAssetB = assetAAmount * currentPrice + assetBAmount;

            // Calculate target balances (50/50)
            const targetValueInAssetB = totalValueInAssetB / 2;
            const targetAssetABalance = targetValueInAssetB / currentPrice;
            const targetAssetBBalance = targetValueInAssetB;

            console.log(
                `Target usable balances: ${targetAssetABalance} ${this.poolDetails.assetASymbol}, ${targetAssetBBalance} ${this.poolDetails.assetBSymbol}`
            );

            // Calculate how much to swap
            if (assetAAmount > targetAssetABalance) {
                // Need to sell assetA for assetB
                const assetAToSwap = assetAAmount - targetAssetABalance;
                console.log(
                    `Need to swap ${assetAToSwap.toFixed(6)} ${this.poolDetails.assetASymbol} for ${this.poolDetails.assetBSymbol}`
                );

                // Execute the swap
                const outputAssetBAmount = await this.retry(() =>
                    this.jupiter.swap({
                        inputMint: this.poolDetails.assetAMintAddress,
                        outputMint: this.poolDetails.assetBMintAddress,
                        amount: assetAToSwap.toString(),
                    })
                );
                this.balanceLogger.logAction(
                    `Swapped ${assetAToSwap.toFixed(6)} ${this.poolDetails.assetASymbol} for ${outputAssetBAmount.toFixed(6)} ${this.poolDetails.assetBSymbol} to rebalance`
                );
            } else if (assetBAmount > targetAssetBBalance) {
                // Need to sell assetB for assetA
                const assetBToSwap = assetBAmount - targetAssetBBalance;
                console.log(
                    `Need to swap ${assetBToSwap.toFixed(6)} ${this.poolDetails.assetBSymbol} for ${this.poolDetails.assetASymbol}`
                );

                // Execute the swap
                const outputAssetAAmount = await this.retry(() =>
                    this.jupiter.swap({
                        inputMint: this.poolDetails.assetBMintAddress,
                        outputMint: this.poolDetails.assetAMintAddress,
                        amount: assetBToSwap.toString(),
                    })
                );

                this.balanceLogger.logAction(
                    `Swapped ${assetBToSwap.toFixed(6)} ${this.poolDetails.assetBSymbol} for ${outputAssetAAmount.toFixed(6)} ${this.poolDetails.assetASymbol} to rebalance`
                );
            }

            this.balanceLogger.logCurrentPrice(
                Number(activeBin.pricePerToken),
                this.poolDetails.assetASymbol,
                this.poolDetails.assetBSymbol
            );
            const newBalances = await this.getUsableBalances();
            this.balanceLogger.logBalances(
                newBalances[this.poolDetails.assetASymbol],
                newBalances[this.poolDetails.assetBSymbol],
                BalanceLogger.TOTAL_BALANCE_PREFIX,
                this.poolDetails.assetASymbol,
                this.poolDetails.assetBSymbol
            );

            // 5 seconds delay for the wallet catch up
            await new Promise((resolve) => setTimeout(resolve, 5000));
        } catch (error) {
            console.error('Error in rebalancePosition:', error);
            throw error;
        }
    }

    private async verifyNativeTokenBufferForPositions() {
        // Get native SOL balance directly (without accounting for the buffer)
        const nativeBalance = await this.wallet.getBalance();
        if (nativeBalance < NATIVE_TOKEN_FEE_BUFFER) {
            console.error(
                `Insufficient native token balance for position creation fees: ${nativeBalance} SOL. Minimum required: ${NATIVE_TOKEN_FEE_BUFFER} SOL`
            );
            await sendAlert(
                AlertType.ERROR,
                `Insufficient native token balance for position creation fees: ${nativeBalance} SOL. Minimum required: ${NATIVE_TOKEN_FEE_BUFFER} SOL`
            );
            throw new Error('Insufficient native token balance for position creation fees');
        }
    }

    private async addLiquidity() {
        await this.verifyNativeTokenBufferForPositions();
        const balances = await this.getUsableBalances();
        const meteoraRangeInterval = Math.ceil((this.positionRangePerSide * 10000) / this.poolDetails.binStep);
        console.log('Adding liquidity with range interval: ', meteoraRangeInterval);
        await this.retry(() =>
            this.meteora.addLiquidity({
                poolAddress: this.poolAddress,
                amount: balances[this.poolDetails.assetASymbol].toString(),
                amountB: balances[this.poolDetails.assetBSymbol].toString(),
                rangeInterval: Math.min(meteoraRangeInterval, METERORA_MAX_BINS_PER_SIDE),
            })
        );
        this.balanceLogger.logBalances(
            balances[this.poolDetails.assetASymbol],
            balances[this.poolDetails.assetBSymbol],
            'Liquidity added to pool',
            this.poolDetails.assetASymbol,
            this.poolDetails.assetBSymbol
        );

        console.log('Collecting new opened position lower and upper bin ids..');
        const positions = await this.retryGetPositions(10, 10000);

        if (positions.length === 0) {
            console.warn('Could not find positions after adding liquidity. Will attempt to continue without bin IDs.');
            return;
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
                poolAddress: this.poolAddress,
            })
        );
        const positionAssetA = liquidityRemoved[0];
        const positionAssetB = liquidityRemoved[1];
        const rewardsAssetA = feesClaimed[0];
        const rewardsAssetB = feesClaimed[1];
        this.balanceLogger.logBalances(
            positionAssetA,
            positionAssetB,
            'Liquidity removed from pool',
            this.poolDetails.assetASymbol,
            this.poolDetails.assetBSymbol
        );
        this.balanceLogger.logBalances(
            rewardsAssetA,
            rewardsAssetB,
            'Rewards claimed',
            this.poolDetails.assetASymbol,
            this.poolDetails.assetBSymbol
        );

        // Wait for the wallet to update with the new balances
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const newBalances = await this.getUsableBalances();
        this.balanceLogger.logAction(
            `Withdrew liquidity and rewards from pool ${this.poolAddress}: ${
                newBalances[this.poolDetails.assetASymbol]
            } ${this.poolDetails.assetASymbol}, ${newBalances[this.poolDetails.assetBSymbol]} ${this.poolDetails.assetBSymbol}`
        );
    }

    public async rebalance(): Promise<boolean> {
        try {
            if (!this.poolAddress) {
                throw new Error('No working pool address found');
            }
            const activeBin: BinLiquidity = await this.retry(() =>
                this.meteora.getActiveBin({
                    poolAddress: this.poolAddress,
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
                await this.verifyNativeTokenBufferForPositions();
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
                // Position situation might be stale, initialize the rebalancer
                await this.loadInitialState();
            }
            console.error('Error in rebalanceMeteora:', error);
            await sendAlert(
                AlertType.ERROR,
                `In rebalanceMeteora: ${error instanceof Error ? error.message : String(error)}`
            );
            return false;
        }
    }
}
