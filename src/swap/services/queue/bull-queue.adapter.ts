import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
  Inject,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import {
  IQueueService,
  SwapJobData,
  JobStatus,
  JobResult,
  JobProgress,
  QueueOptions,
} from './queue.interface';
import { WebhookService } from '../webhook/webhook.service';
import type { SwapOrchestrationService } from '../core/orchestration/swap-orchestration.service';

/**
 * Bull Queue Adapter
 *
 * Redis-based message queue implementation using BullMQ.
 * Provides reliable job processing with retry logic and persistence.
 *
 * Features:
 * - Redis persistence for job durability
 * - Automatic retry with exponential backoff
 * - Job prioritization
 * - Progress tracking
 * - Event-driven status updates
 *
 * Requirements:
 * - Redis server running
 * - REDIS_URL or REDIS_HOST/PORT configured
 */
@Injectable()
export class BullQueueAdapter
  implements IQueueService, OnModuleInit, OnModuleDestroy
{
  private readonly logger: WinstonLoggerService;
  private swapQueue: Queue;
  private worker: Worker;
  private queueEvents: QueueEvents;
  private redisConnection: Redis;
  private enabled: boolean;
  private orchestrationService: SwapOrchestrationService;

  constructor(
    private readonly winstonLogger: WinstonLoggerService,
    private readonly configService: ConfigService,
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly webhookService?: WebhookService,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(BullQueueAdapter.name);

    // Handle both boolean and string values for QUEUE_ENABLED
    const queueEnabledValue = this.configService.get('QUEUE_ENABLED', false);
    this.enabled = queueEnabledValue === true || queueEnabledValue === 'true';
  }

  async onModuleInit() {
    // Resolve SwapOrchestrationService dynamically to avoid circular dependency
    try {
      this.orchestrationService = this.moduleRef.get(
        'SwapOrchestrationService',
        { strict: false },
      );
      this.logger.log('✅ SwapOrchestrationService resolved successfully');
    } catch (error) {
      this.logger.error(
        `❌ Failed to resolve SwapOrchestrationService: ${error.message}`,
      );
    }

    if (!this.enabled) {
      this.logger.log(
        '⚠️ Message queue is DISABLED. Skipping Redis initialization.',
      );
      return;
    }

    try {
      // Setup Redis connection
      this.redisConnection = this.createRedisConnection();

      // Create BullMQ queue
      this.swapQueue = new Queue('swap-execution', {
        connection: this.redisConnection,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000, // 2s, 4s, 8s
          },
          removeOnComplete: {
            count: 100, // Keep last 100 completed jobs
            age: 24 * 3600, // 24 hours
          },
          removeOnFail: {
            count: 500, // Keep last 500 failed jobs for debugging
          },
        },
      });

      // Create worker to process jobs
      this.worker = new Worker(
        'swap-execution',
        async (job: Job<SwapJobData>) => {
          return await this.processSwapJob(job);
        },
        {
          connection: this.createRedisConnection(),
          concurrency: 5, // Process 5 jobs concurrently
        },
      );

      // Setup event listeners
      this.setupEventListeners();

      // Create queue events for monitoring
      this.queueEvents = new QueueEvents('swap-execution', {
        connection: this.createRedisConnection(),
      });

      this.logger.log('✅ Bull queue initialized successfully');
      this.logger.log(`Queue: swap-execution, Concurrency: 5`);
    } catch (error) {
      this.logger.error('❌ Failed to initialize Bull queue', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    if (!this.enabled) return;

    try {
      await this.worker?.close();
      await this.swapQueue?.close();
      await this.queueEvents?.close();
      await this.redisConnection?.quit();
      this.logger.log('✅ Bull queue closed successfully');
    } catch (error) {
      this.logger.error('❌ Error closing Bull queue', error);
    }
  }

  /**
   * Create Redis connection from environment variables
   */
  private createRedisConnection(): Redis {
    const redisUrl = this.configService.get<string>('REDIS_URL');

    let redis: Redis;

    if (redisUrl) {
      redis = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
      });
    } else {
      const host = this.configService.get<string>('REDIS_HOST', 'localhost');
      const port = this.configService.get<number>('REDIS_PORT', 6379);
      const password = this.configService.get<string>('REDIS_PASSWORD');

      redis = new Redis({
        host,
        port,
        password,
        maxRetriesPerRequest: null,
      });
    }

    // Setup Redis event listeners
    redis.on('connect', () => {
      this.logger.log('✅ Redis connected successfully', {
        host: redis.options.host,
        port: redis.options.port,
        status: redis.status,
      });
    });

    redis.on('ready', () => {
      this.logger.log('✅ Redis ready to accept commands', {
        host: redis.options.host,
        port: redis.options.port,
      });
    });

    redis.on('error', (error) => {
      this.logger.error('❌ Redis connection error', {
        error: error.message,
        host: redis.options.host,
        port: redis.options.port,
      });
    });

    redis.on('close', () => {
      this.logger.warn('⚠️ Redis connection closed', {
        host: redis.options.host,
        port: redis.options.port,
      });
    });

    redis.on('reconnecting', (time) => {
      this.logger.log(`🔄 Redis reconnecting in ${time}ms`, {
        host: redis.options.host,
        port: redis.options.port,
      });
    });

    redis.on('end', () => {
      this.logger.warn('🔒 Redis connection ended', {
        host: redis.options.host,
        port: redis.options.port,
      });
    });

    return redis;
  }

  /**
   * Setup event listeners for job lifecycle
   */
  private setupEventListeners() {
    this.worker.on('completed', async (job: Job, returnvalue: JobResult) => {
      this.logger.log(`✅ Job ${job.id} completed`, {
        executionId: job.data.executionId,
        duration: Date.now() - job.timestamp,
      });

      // Send webhook notification if webhookUrl is provided
      if (job.data.webhookUrl && this.webhookService) {
        const webhookSecret = this.configService.get<string>('WEBHOOK_SECRET');
        const payload = WebhookService.buildCompletedPayload(
          job.data.executionId,
          job.id as string,
          {
            success: returnvalue.success,
            transactionHash: returnvalue.data?.transactionHash,
            outputAmount: returnvalue.data?.outputAmount,
            swapType: returnvalue.data?.swapType,
            provider: returnvalue.data?.provider,
            fullResult: returnvalue.data?.fullResult, // Include complete ExecutionData
            duration: returnvalue.completedAt
              ? new Date(returnvalue.completedAt).getTime() -
                new Date(returnvalue.startedAt).getTime()
              : undefined,
          },
        );

        // Send webhook asynchronously (don't block)
        this.webhookService
          .notify(job.data.webhookUrl, payload, webhookSecret)
          .catch((error) => {
            this.logger.error(`Failed to send webhook for job ${job.id}`, {
              error: error.message,
              webhookUrl: job.data.webhookUrl,
            });
          });
      }
    });

    this.worker.on('failed', async (job: Job | undefined, error: Error) => {
      if (job) {
        this.logger.error(`❌ Job ${job.id} failed`, {
          executionId: job.data?.executionId,
          error: error.message,
          attempts: job.attemptsMade,
        });

        // Send webhook notification if webhookUrl is provided
        if (job.data.webhookUrl && this.webhookService) {
          const webhookSecret =
            this.configService.get<string>('WEBHOOK_SECRET');
          const payload = WebhookService.buildFailedPayload(
            job.data.executionId,
            job.id as string,
            {
              message: error.message,
              code: (error as any).code,
            },
          );

          // Send webhook asynchronously (don't block)
          this.webhookService
            .notify(job.data.webhookUrl, payload, webhookSecret)
            .catch((webhookError) => {
              this.logger.error(
                `Failed to send webhook for failed job ${job.id}`,
                {
                  error: webhookError.message,
                  webhookUrl: job.data.webhookUrl,
                },
              );
            });
        }
      }
    });

    this.worker.on('active', (job: Job) => {
      this.logger.log(`🔄 Job ${job.id} started processing`, {
        executionId: job.data.executionId,
      });
    });

    this.worker.on('progress', (job: Job, progress: number | object) => {
      this.logger.debug(
        `📊 Job ${job.id} progress: ${JSON.stringify(progress)}`,
      );
    });
  }

  /**
   * Process a swap job
   *
   * This method is called by the worker for each job.
   * It executes the swap using the orchestration service.
   */
  private async processSwapJob(job: Job<SwapJobData>): Promise<JobResult> {
    const startTime = Date.now();

    try {
      this.logger.log(`🚀 Processing swap job ${job.id}`, {
        executionId: job.data.executionId,
        userWallet: job.data.userWallet,
      });

      // Update progress: 10%
      await job.updateProgress(10);

      // Check if orchestration service is available
      if (!this.orchestrationService) {
        throw new Error(
          'SwapOrchestrationService not available. Queue worker cannot execute swaps.',
        );
      }

      // Update progress: 20%
      await job.updateProgress(20);

      this.logger.log(`📊 Executing swap for job ${job.id}`, {
        executionId: job.data.executionId,
        sellToken: job.data.request.sellToken?.symbol,
        buyToken: job.data.request.buyToken?.symbol,
      });

      // Execute actual swap through orchestration service
      // Note: We pass request.async = undefined to prevent re-queuing
      const swapRequest = { ...job.data.request, async: undefined };
      const result = await this.orchestrationService.executeSwap(
        swapRequest,
        job.data.executionId,
        startTime,
      );

      // Update progress: 90%
      await job.updateProgress(90);

      this.logger.log(`✅ Swap executed successfully for job ${job.id}`, {
        executionId: job.data.executionId,
        success: result.success,
      });

      // Extract transaction details from result (handle union type)
      const transactionHash =
        (result.data as any)?.transaction?.transactionHash ||
        (result.data as any)?.transactionHashes?.[0] ||
        null;

      const outputAmount =
        (result.data as any)?.currencies?.buy?.estimatedAmount?.raw ||
        (result.data as any)?.route?.estimatedOutputAmount?.raw ||
        null;

      // Update progress: 100%
      await job.updateProgress(100);

      const jobResult: JobResult = {
        executionId: job.data.executionId,
        success: result.success,
        data: {
          transactionHash,
          outputAmount,
          swapType: result.metadata?.swapType,
          provider: result.metadata?.providerCategory,
          fullResult: result.data, // Include full result for reference
        },
        startedAt: new Date(startTime),
        completedAt: new Date(),
        duration: Date.now() - startTime,
      };

      return jobResult;
    } catch (error) {
      this.logger.error(`❌ Error processing job ${job.id}`, {
        executionId: job.data.executionId,
        error: error.message,
        stack: error.stack,
      });

      const jobResult: JobResult = {
        executionId: job.data.executionId,
        success: false,
        error: {
          code: error.code || 'JOB_EXECUTION_FAILED',
          message: error.message,
          details: error.stack,
        },
        startedAt: new Date(startTime),
        completedAt: new Date(),
        duration: Date.now() - startTime,
      };

      throw error; // Re-throw to trigger retry mechanism
    }
  }

  /**
   * Add a swap execution job to the queue
   */
  async addSwapJob(
    jobData: SwapJobData,
    options?: QueueOptions,
  ): Promise<string> {
    if (!this.enabled) {
      throw new Error(
        'Message queue is disabled. Set QUEUE_ENABLED=true to enable.',
      );
    }

    try {
      const job = await this.swapQueue.add('execute-swap', jobData, {
        priority: options?.priority || 5,
        attempts: options?.maxRetries || 3,
        backoff: {
          type: 'exponential',
          delay: options?.retryDelay || 2000,
        },
        removeOnComplete: options?.removeOnComplete !== false,
        removeOnFail: options?.removeOnFail !== false,
      });

      this.logger.log(`📥 Added swap job ${job.id} to queue`, {
        executionId: jobData.executionId,
        priority: options?.priority || 5,
      });

      return job.id as string;
    } catch (error) {
      this.logger.error('❌ Failed to add job to queue', error);
      throw error;
    }
  }

  /**
   * Get job status and progress
   */
  async getJobProgress(jobId: string): Promise<JobProgress | null> {
    if (!this.enabled) return null;

    try {
      const job = await this.swapQueue.getJob(jobId);

      if (!job) {
        return null;
      }

      const state = await job.getState();
      const progress = (job.progress as number) || 0;

      return {
        jobId: job.id as string,
        executionId: job.data.executionId,
        status: this.mapJobState(state),
        progress,
        currentStep: job.name,
        data: job.data,
        createdAt: new Date(job.timestamp),
        processedAt: job.processedOn ? new Date(job.processedOn) : undefined,
        finishedAt: job.finishedOn ? new Date(job.finishedOn) : undefined,
        failedReason: job.failedReason,
        attempts: job.attemptsMade,
        maxAttempts: job.opts.attempts || 3,
      };
    } catch (error) {
      this.logger.error(`❌ Failed to get job progress for ${jobId}`, error);
      return null;
    }
  }

  /**
   * Get job result (for completed/failed jobs)
   */
  async getJobResult(jobId: string): Promise<JobResult | null> {
    if (!this.enabled) return null;

    try {
      const job = await this.swapQueue.getJob(jobId);

      if (!job) {
        return null;
      }

      const state = await job.getState();

      if (state !== 'completed' && state !== 'failed') {
        return null; // Job not finished yet
      }

      return job.returnvalue as JobResult;
    } catch (error) {
      this.logger.error(`❌ Failed to get job result for ${jobId}`, error);
      return null;
    }
  }

  /**
   * Cancel a pending or active job
   */
  async cancelJob(jobId: string): Promise<boolean> {
    if (!this.enabled) return false;

    try {
      const job = await this.swapQueue.getJob(jobId);

      if (!job) {
        return false;
      }

      await job.remove();
      this.logger.log(`🗑️ Cancelled job ${jobId}`);
      return true;
    } catch (error) {
      this.logger.error(`❌ Failed to cancel job ${jobId}`, error);
      return false;
    }
  }

  /**
   * Retry a failed job
   */
  async retryJob(jobId: string): Promise<boolean> {
    if (!this.enabled) return false;

    try {
      const job = await this.swapQueue.getJob(jobId);

      if (!job) {
        return false;
      }

      await job.retry();
      this.logger.log(`🔄 Retrying job ${jobId}`);
      return true;
    } catch (error) {
      this.logger.error(`❌ Failed to retry job ${jobId}`, error);
      return false;
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
  }> {
    if (!this.enabled) {
      return {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      };
    }

    try {
      const counts = await this.swapQueue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
        'paused',
      );

      return {
        waiting: counts.waiting || 0,
        active: counts.active || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
        delayed: counts.delayed || 0,
        paused: counts.paused || 0,
      };
    } catch (error) {
      this.logger.error('❌ Failed to get queue stats', error);
      return {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      };
    }
  }

  /**
   * Pause the queue (stop processing new jobs)
   */
  async pauseQueue(): Promise<void> {
    if (!this.enabled) return;

    try {
      await this.swapQueue.pause();
      this.logger.log('⏸️ Queue paused');
    } catch (error) {
      this.logger.error('❌ Failed to pause queue', error);
      throw error;
    }
  }

  /**
   * Resume the queue
   */
  async resumeQueue(): Promise<void> {
    if (!this.enabled) return;

    try {
      await this.swapQueue.resume();
      this.logger.log('▶️ Queue resumed');
    } catch (error) {
      this.logger.error('❌ Failed to resume queue', error);
      throw error;
    }
  }

  /**
   * Clean completed/failed jobs
   */
  async cleanQueue(
    status: 'completed' | 'failed',
    olderThan: number,
  ): Promise<number> {
    if (!this.enabled) return 0;

    try {
      const jobs = await this.swapQueue.clean(olderThan, 100, status);
      this.logger.log(
        `🧹 Cleaned ${jobs.length} ${status} jobs older than ${olderThan}ms`,
      );
      return jobs.length;
    } catch (error) {
      this.logger.error(`❌ Failed to clean ${status} jobs`, error);
      return 0;
    }
  }

  /**
   * Map Bull job state to our JobStatus enum
   */
  private mapJobState(state: string): JobStatus {
    switch (state) {
      case 'waiting':
        return JobStatus.WAITING;
      case 'active':
        return JobStatus.ACTIVE;
      case 'completed':
        return JobStatus.COMPLETED;
      case 'failed':
        return JobStatus.FAILED;
      case 'delayed':
        return JobStatus.DELAYED;
      case 'paused':
        return JobStatus.PAUSED;
      default:
        return JobStatus.WAITING;
    }
  }

  /**
   * Check if queue is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}
