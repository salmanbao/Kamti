import {
  Controller,
  Get,
  Post,
  Param,
  HttpException,
  HttpStatus,
  Inject,
  Optional,
} from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import type { IQueueService } from '../services/queue/queue.interface';

/**
 * Job Status Controller
 *
 * Provides REST endpoints for tracking async swap jobs:
 * - GET /jobs/:jobId - Get job status and progress
 * - GET /jobs/:jobId/result - Get completed job results
 * - POST /jobs/:jobId/cancel - Cancel a queued/running job
 * - POST /jobs/:jobId/retry - Retry a failed job
 * - GET /queue/stats - Get queue statistics
 *
 * Used for monitoring jobs submitted via async=true in swap requests.
 */
@ApiTags('Job Status')
@Controller('jobs')
export class JobStatusController {
  private readonly logger: WinstonLoggerService;

  constructor(
    private readonly winstonLogger: WinstonLoggerService,
    @Optional()
    @Inject('IQueueService')
    private readonly queueService?: IQueueService,
  ) {
    this.logger = winstonLogger;
    this.logger.setContext(JobStatusController.name);
  }

  /**
   * Get job progress and current status
   *
   * @param jobId - Job ID returned from async swap execution
   * @returns Real-time job status with progress percentage
   */
  @Get(':jobId')
  @ApiOperation({
    summary: 'Get job status and progress',
    description:
      'Returns real-time status of an async swap job including progress percentage, current state, and execution details.',
  })
  @ApiParam({
    name: 'jobId',
    description: 'Job ID returned from async swap request',
    example: '1234',
  })
  @ApiResponse({
    status: 200,
    description: 'Job progress retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', example: '1234' },
        status: {
          type: 'string',
          enum: [
            'WAITING',
            'ACTIVE',
            'COMPLETED',
            'FAILED',
            'DELAYED',
            'PAUSED',
          ],
          example: 'ACTIVE',
        },
        progress: {
          type: 'number',
          example: 65,
          description: 'Progress percentage (0-100)',
        },
        data: {
          type: 'object',
          description: 'Swap job data',
          properties: {
            executionId: { type: 'string' },
            userWallet: { type: 'string' },
            timestamp: { type: 'number' },
          },
        },
        result: {
          type: 'object',
          nullable: true,
          description: 'Execution result (only present if completed)',
        },
        error: {
          type: 'object',
          nullable: true,
          description: 'Error details (only present if failed)',
          properties: {
            message: { type: 'string' },
            code: { type: 'string' },
            stack: { type: 'string' },
          },
        },
        timestamps: {
          type: 'object',
          properties: {
            created: { type: 'number' },
            started: { type: 'number', nullable: true },
            completed: { type: 'number', nullable: true },
          },
        },
        attempts: { type: 'number', example: 1 },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Job not found',
  })
  @ApiResponse({
    status: 503,
    description: 'Queue service not available',
  })
  async getJobStatus(@Param('jobId') jobId: string) {
    if (!this.queueService) {
      throw new HttpException(
        'Queue service not available. Set REDIS_URL to enable async execution.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    this.logger.log(`📊 Fetching job status: ${jobId}`);

    try {
      const progress = await this.queueService.getJobProgress(jobId);

      if (!progress) {
        throw new HttpException(`Job ${jobId} not found`, HttpStatus.NOT_FOUND);
      }

      this.logger.log(`✅ Job status retrieved: ${jobId} - ${progress.status}`);

      return {
        success: true,
        data: progress,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(`❌ Failed to fetch job status: ${jobId}`, {
        error: error.message,
        stack: error.stack,
      });

      throw new HttpException(
        `Failed to fetch job status: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get completed job results
   *
   * @param jobId - Job ID
   * @returns Swap execution results with transaction details
   */
  @Get(':jobId/result')
  @ApiOperation({
    summary: 'Get completed job results',
    description:
      'Returns execution results for completed jobs including transaction hashes, amounts, and timing details.',
  })
  @ApiParam({
    name: 'jobId',
    description: 'Job ID',
    example: '1234',
  })
  @ApiResponse({
    status: 200,
    description: 'Job results retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        executionId: { type: 'string' },
        transactionHash: { type: 'string', nullable: true },
        outputAmount: { type: 'string', nullable: true },
        error: {
          type: 'object',
          nullable: true,
          properties: {
            message: { type: 'string' },
            code: { type: 'string' },
          },
        },
        timestamp: { type: 'number' },
        duration: {
          type: 'number',
          description: 'Execution duration in milliseconds',
        },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Job not found or not completed',
  })
  @ApiResponse({
    status: 503,
    description: 'Queue service not available',
  })
  async getJobResult(@Param('jobId') jobId: string) {
    if (!this.queueService) {
      throw new HttpException(
        'Queue service not available',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    this.logger.log(`📋 Fetching job result: ${jobId}`);

    try {
      const result = await this.queueService.getJobResult(jobId);

      if (!result) {
        throw new HttpException(
          `Job ${jobId} not found or not completed yet`,
          HttpStatus.NOT_FOUND,
        );
      }

      this.logger.log(`✅ Job result retrieved: ${jobId}`);

      return {
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(`❌ Failed to fetch job result: ${jobId}`, {
        error: error.message,
      });

      throw new HttpException(
        `Failed to fetch job result: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Cancel a job
   *
   * @param jobId - Job ID to cancel
   * @returns Cancellation confirmation
   */
  @Post(':jobId/cancel')
  @ApiOperation({
    summary: 'Cancel a queued or running job',
    description:
      'Attempts to cancel a job. Only works for jobs that are waiting or delayed. Jobs already in progress cannot be cancelled.',
  })
  @ApiParam({
    name: 'jobId',
    description: 'Job ID to cancel',
    example: '1234',
  })
  @ApiResponse({
    status: 200,
    description: 'Job cancelled successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'Job cancelled successfully' },
        jobId: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Job not found',
  })
  @ApiResponse({
    status: 400,
    description: 'Job cannot be cancelled (already completed or in progress)',
  })
  @ApiResponse({
    status: 503,
    description: 'Queue service not available',
  })
  async cancelJob(@Param('jobId') jobId: string) {
    if (!this.queueService) {
      throw new HttpException(
        'Queue service not available',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    this.logger.log(`🚫 Cancelling job: ${jobId}`);

    try {
      const cancelled = await this.queueService.cancelJob(jobId);

      if (!cancelled) {
        throw new HttpException(
          `Job ${jobId} not found or cannot be cancelled`,
          HttpStatus.BAD_REQUEST,
        );
      }

      this.logger.log(`✅ Job cancelled: ${jobId}`);

      return {
        success: true,
        message: 'Job cancelled successfully',
        jobId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(`❌ Failed to cancel job: ${jobId}`, {
        error: error.message,
      });

      throw new HttpException(
        `Failed to cancel job: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Retry a failed job
   *
   * @param jobId - Job ID to retry
   * @returns Retry confirmation
   */
  @Post(':jobId/retry')
  @ApiOperation({
    summary: 'Retry a failed job',
    description:
      'Re-queues a failed job for execution. Only works for jobs in FAILED state.',
  })
  @ApiParam({
    name: 'jobId',
    description: 'Job ID to retry',
    example: '1234',
  })
  @ApiResponse({
    status: 200,
    description: 'Job retried successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'Job retried successfully' },
        jobId: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Job not found',
  })
  @ApiResponse({
    status: 400,
    description: 'Job cannot be retried (not in FAILED state)',
  })
  @ApiResponse({
    status: 503,
    description: 'Queue service not available',
  })
  async retryJob(@Param('jobId') jobId: string) {
    if (!this.queueService) {
      throw new HttpException(
        'Queue service not available',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    this.logger.log(`🔄 Retrying job: ${jobId}`);

    try {
      const retried = await this.queueService.retryJob(jobId);

      if (!retried) {
        throw new HttpException(
          `Job ${jobId} not found or cannot be retried`,
          HttpStatus.BAD_REQUEST,
        );
      }

      this.logger.log(`✅ Job retried: ${jobId}`);

      return {
        success: true,
        message: 'Job retried successfully',
        jobId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(`❌ Failed to retry job: ${jobId}`, {
        error: error.message,
      });

      throw new HttpException(
        `Failed to retry job: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get queue statistics
   *
   * @returns Queue metrics (waiting, active, completed, failed counts)
   */
  @Get('queue/stats')
  @ApiOperation({
    summary: 'Get queue statistics',
    description:
      'Returns queue metrics including counts of jobs in different states (waiting, active, completed, failed, delayed, paused).',
  })
  @ApiResponse({
    status: 200,
    description: 'Queue statistics retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        waiting: {
          type: 'number',
          example: 5,
          description: 'Jobs waiting to be processed',
        },
        active: {
          type: 'number',
          example: 2,
          description: 'Jobs currently being processed',
        },
        completed: {
          type: 'number',
          example: 150,
          description: 'Successfully completed jobs',
        },
        failed: { type: 'number', example: 3, description: 'Failed jobs' },
        delayed: {
          type: 'number',
          example: 0,
          description: 'Jobs scheduled for future execution',
        },
        paused: {
          type: 'number',
          example: 0,
          description: 'Jobs in paused queue',
        },
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'Queue service not available',
  })
  async getQueueStats() {
    if (!this.queueService) {
      throw new HttpException(
        'Queue service not available',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    this.logger.log('📊 Fetching queue statistics');

    try {
      const stats = await this.queueService.getQueueStats();

      this.logger.log('✅ Queue statistics retrieved', stats);

      return {
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('❌ Failed to fetch queue statistics', {
        error: error.message,
      });

      throw new HttpException(
        `Failed to fetch queue statistics: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
