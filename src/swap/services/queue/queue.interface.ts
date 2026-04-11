/**
 * Queue Service Interface
 *
 * Vendor-agnostic interface for message queue operations.
 * Enables swapping queue implementations (Bull, Kafka, RabbitMQ) without code changes.
 *
 * Design Pattern: Strategy Pattern for queue backend selection
 */

/**
 * Job data structure for swap execution
 */
export interface SwapJobData {
  executionId: string;
  request: any; // UniversalSwapRequestDto
  userWallet: string;
  timestamp: number;
  priority?: number;
  webhookUrl?: string;
}

/**
 * Job status
 */
export enum JobStatus {
  WAITING = 'waiting',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed',
  DELAYED = 'delayed',
  PAUSED = 'paused',
}

/**
 * Job result after completion
 */
export interface JobResult {
  executionId: string;
  success: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  startedAt: Date;
  completedAt: Date;
  duration: number; // milliseconds
}

/**
 * Job progress information
 */
export interface JobProgress {
  jobId: string;
  executionId: string;
  status: JobStatus;
  progress: number; // 0-100
  currentStep?: string;
  data?: any;
  createdAt: Date;
  processedAt?: Date;
  finishedAt?: Date;
  failedReason?: string;
  attempts: number;
  maxAttempts: number;
}

/**
 * Queue configuration options
 */
export interface QueueOptions {
  maxRetries?: number;
  retryDelay?: number; // milliseconds
  timeout?: number; // milliseconds
  priority?: number; // 1-10 (higher = more priority)
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
}

/**
 * Queue Service Interface
 *
 * Abstract interface for message queue operations.
 * Implementations: Bull (Redis), Kafka, RabbitMQ
 */
export interface IQueueService {
  /**
   * Add a swap execution job to the queue
   */
  addSwapJob(jobData: SwapJobData, options?: QueueOptions): Promise<string>; // Returns job ID

  /**
   * Get job status and progress
   */
  getJobProgress(jobId: string): Promise<JobProgress | null>;

  /**
   * Get job result (for completed/failed jobs)
   */
  getJobResult(jobId: string): Promise<JobResult | null>;

  /**
   * Cancel a pending or active job
   */
  cancelJob(jobId: string): Promise<boolean>;

  /**
   * Retry a failed job
   */
  retryJob(jobId: string): Promise<boolean>;

  /**
   * Get queue statistics
   */
  getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
  }>;

  /**
   * Pause the queue (stop processing new jobs)
   */
  pauseQueue(): Promise<void>;

  /**
   * Resume the queue
   */
  resumeQueue(): Promise<void>;

  /**
   * Clean completed/failed jobs
   */
  cleanQueue(
    status: 'completed' | 'failed',
    olderThan: number, // milliseconds
  ): Promise<number>; // Returns number of jobs removed
}
