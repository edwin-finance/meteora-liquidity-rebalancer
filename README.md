# Edwin Meteora Rebalancer

A professional-grade liquidity positioning and rebalancing bot for Meteora DeFi on Solana, built with Edwin.

## Features

- Automated liquidity provision on Meteora pools
- Smart rebalancing of positions based on market conditions
- Optimal bin range selection for liquidity efficiency
- Fee harvesting and position management
- Detailed logging and reporting

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/edwin-meteora-rebalancer.git
   cd edwin-meteora-rebalancer
   ```

## Configuration

Create a `.env` file based on the `.env.example`:

```bash
cp .env.example .env
```

Required environment variables:

- `SOLANA_PRIVATE_KEY`: Your Solana wallet private key
- `SOLANA_RPC_URL`: RPC URL for Solana
- `METEORA_POSITION_RANGE_PER_SIDE_RELATIVE`: Relative position range per side (e.g. 0.1 for ±10%)

## Usage

### As a standalone application

```bash
# Build the application
pnpm build

# Run the example
pnpm example
```

### As a library in another project

```typescript
import { MeteoraOptimizer } from 'edwin-meteora-rebalancer';
import { EdwinSolanaWallet } from 'edwin-sdk';

const wallet = new EdwinSolanaWallet(process.env.SOLANA_PRIVATE_KEY);
const optimizer = new MeteoraOptimizer(wallet);

// Initialize the optimizer
await optimizer.loadInitialState();

// Run optimization cycle
const positionChanged = await optimizer.optimize();
```

## Development

```bash
# Start development with hot reloading
pnpm dev:watch

# Run linting
pnpm lint

# Format code
pnpm format

# Run tests
pnpm test
```

## License

MIT
