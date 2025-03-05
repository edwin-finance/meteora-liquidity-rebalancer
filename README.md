# Edwin Meteora Rebalancer

A professional-grade liquidity positioning and rebalancing agent for Meteora DeFi on Solana, built with Edwin.

## Features

- Automated liquidity provision on Meteora pools
- Smart rebalancing of positions based on market conditions
- Optimal bin range selection for liquidity efficiency
- Fee harvesting and position management
- Detailed logging and reporting
- Support for local and CloudWatch logging
- Alert system integration for critical events

## Prerequisites

- Node.js 18+
- pnpm
- Docker and docker-compose
- Solana wallet with SOL and tokens for the pairs you want to provide liquidity for

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/edwin-meteora-rebalancer.git
   cd edwin-meteora-rebalancer
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

## Configuration

Create a `.env` file based on the `.env.example`:

### Required environment variables:

- `SOLANA_PRIVATE_KEY`: Your Solana wallet private key
- `SOLANA_RPC_URL`: RPC URL for Solana
- `METEORA_POOL_ADDRESS`: Address of the Meteora pool to provide liquidity to
- `METEORA_POSITION_RANGE_PER_SIDE_RELATIVE`: Relative position range per side (e.g., 0.05 for ±5%)
- `NATIVE_TOKEN_FEE_BUFFER`: Amount of SOL to reserve for transaction fees (default: 0.1)

### Optional environment variables:

#### Telegram alerts
- `TELEGRAM_BOT_TOKEN`: Telegram bot token for alerts
- `TELEGRAM_CHAT_ID`: Telegram chat ID for receiving alerts

#### CloudWatch logging
- `USE_CLOUD_WATCH_STORAGE`: Enable CloudWatch logging (true/false)
- `AWS_REGION`: AWS region for CloudWatch
- `LOG_GROUP_NAME`: CloudWatch log group name
- `BALANCE_LOG_STREAM_NAME`: CloudWatch log stream for balance tracking

## Usage

### Running the agent locally

```bash
# Build the application
pnpm build

# Run the agent
pnpm start
```

### Running with Docker

```bash
# Build the Docker image
docker build -t edwin-meteora-rebalancer .

# Run the container
docker run --env-file .env edwin-meteora-rebalancer
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

## Architecture

The agent operates on the following principles:

1. **Position Creation**: Creates a liquidity position on Meteora with optimal bin range
2. **Monitoring**: Continuously monitors the position relative to the current market price
3. **Rebalancing**: When the price moves outside the position's range, it rebalances by:
   - Removing liquidity from the current position
   - Rebalancing assets to 50/50 ratio if needed
   - Creating a new position centered around the current price

## Contributing

Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to contribute to this project.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a history of changes to this project.

## License

GPL-3.0