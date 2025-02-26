# Build stage
FROM node:20-slim AS builder

# Set working directory
WORKDIR /app

# Set PNPM environment variables
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Set CI env variable to disable interactive prompts
ENV CI=true

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install pnpm and configure it
RUN npm install -g pnpm
RUN pnpm config set auto-install-peers true
RUN pnpm config set strict-peer-dependencies false

# Install dependencies
RUN pnpm install --no-frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript code
RUN pnpm run build

# Production stage
FROM node:20-slim

# Set working directory
WORKDIR /app

# Set PNPM environment variables and disable interactivity
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true

# Install pnpm and configure it
RUN npm install -g pnpm
RUN pnpm config set auto-install-peers true
RUN pnpm config set strict-peer-dependencies false

# Copy package files and built code
COPY --from=builder /app/package.json /app/pnpm-lock.yaml* ./
COPY --from=builder /app/dist ./dist

# Install production dependencies only
RUN pnpm install --prod --no-frozen-lockfile

# Create logs directory
RUN mkdir -p logs

# Set environment variables
ENV NODE_ENV=production

# Run the example application
CMD ["node", "dist/examples/example.js"]