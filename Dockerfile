# Use Node 18 with Debian (Prisma compatible)
FROM node:18-slim

# Install OpenSSL (required for Prisma)
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3001

# Start command - push schema and start server
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/index.js"]
