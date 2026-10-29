import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

const DEFAULT_SERVER_CONNECTION_LIMIT = 5;
const DEFAULT_SERVERLESS_CONNECTION_LIMIT = 1;
const DEFAULT_POOL_TIMEOUT_SECONDS = 30;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 20;
const DEFAULT_CONNECT_RETRIES = 5;
const DEFAULT_TRANSACTION_MAX_WAIT_MS = 10_000;
const DEFAULT_TRANSACTION_TIMEOUT_MS = 30_000;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 15_000;
const RETRYABLE_CONNECTION_ERRORS = new Set(['P1001', 'P1002', 'P1017']);

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function appendParameter(url: string, name: string, value: number) {
  if (new RegExp(`[?&]${name}=`).test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${name}=${value}`;
}

function prismaClientOptions(): Prisma.PrismaClientOptions {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return {};

  // Each Vercel instance has its own Prisma pool. A five-connection pool per
  // instance quickly exhausts a small hosted PostgreSQL plan as functions
  // scale out, so serverless instances default to one connection each.
  // Long-running servers retain a small pool, and either default can be
  // overridden explicitly with DATABASE_CONNECTION_LIMIT.
  const defaultConnectionLimit = process.env.VERCEL ? DEFAULT_SERVERLESS_CONNECTION_LIMIT : DEFAULT_SERVER_CONNECTION_LIMIT;
  const connectionLimit = positiveInteger(process.env.DATABASE_CONNECTION_LIMIT, defaultConnectionLimit);
  const poolTimeout = positiveInteger(process.env.DATABASE_POOL_TIMEOUT, DEFAULT_POOL_TIMEOUT_SECONDS);
  // A TLS handshake to the remote host regularly takes 2-4s, which leaves
  // Prisma's 5s default connect_timeout with too little margin.
  const connectTimeout = positiveInteger(process.env.DATABASE_CONNECT_TIMEOUT, DEFAULT_CONNECT_TIMEOUT_SECONDS);

  // Interactive transactions (a goods receipt, a dispatch…) make many sequential round trips to the remote
  // database; Prisma's 5s default timeout and 2s maxWait expire them part-way through as P2028.
  const transactionOptions = {
    maxWait: positiveInteger(process.env.DATABASE_TRANSACTION_MAX_WAIT, DEFAULT_TRANSACTION_MAX_WAIT_MS),
    timeout: positiveInteger(process.env.DATABASE_TRANSACTION_TIMEOUT, DEFAULT_TRANSACTION_TIMEOUT_MS),
  };

  const withConnectionLimit = appendParameter(databaseUrl, 'connection_limit', connectionLimit);
  const withPoolTimeout = appendParameter(withConnectionLimit, 'pool_timeout', poolTimeout);
  return {
    datasourceUrl: appendParameter(withPoolTimeout, 'connect_timeout', connectTimeout),
    transactionOptions,
  };
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super(prismaClientOptions());
  }

  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    // The hosted database can be briefly unreachable while it powers on or
    // restarts for maintenance, so retry transient connection errors. Invalid
    // URLs, credentials and schema configuration cannot recover by waiting.
    const attempts = positiveInteger(process.env.DATABASE_CONNECT_RETRIES, DEFAULT_CONNECT_RETRIES);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.$connect();
        return;
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientInitializationError) ||
          !RETRYABLE_CONNECTION_ERRORS.has(error.errorCode ?? '') ||
          attempt >= attempts
        ) throw error;
        const delayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
        this.logger.warn(
          `Database connection attempt ${attempt}/${attempts} failed (${error.errorCode ?? 'unknown'}); retrying in ${delayMs / 1000}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
