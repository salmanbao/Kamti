import {
  Controller,
  Post,
  Body,
  Headers,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { WinstonLoggerService } from '@shared/services/winston-logger.service';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiHeader,
} from '@nestjs/swagger';
import { WebhookService } from '../services/webhook/webhook.service';
import type { WebhookPayload } from '../services/webhook/webhook.service';

/**
 * Webhook Testing Controller
 *
 * Provides endpoints for testing webhook functionality and signature verification.
 * This controller is primarily for development and testing purposes.
 */
@ApiTags('Webhook Testing')
@Controller('webhooks')
export class WebhookTestController {
  private readonly logger: WinstonLoggerService;

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.logger = winstonLogger;
    this.logger.setContext(WebhookTestController.name);
  }

  /**
   * Test webhook receiver endpoint
   *
   * Receives and validates webhook payloads with signature verification.
   * Used for testing webhook notifications from the swap service.
   *
   * @param body - Webhook payload
   * @param signature - HMAC-SHA256 signature header
   * @returns Validation result
   */
  @Post('test-receiver')
  @ApiOperation({
    summary: 'Test webhook receiver',
    description:
      'Receives and validates webhook notifications. Used for testing webhook integration.',
  })
  @ApiHeader({
    name: 'X-Webhook-Signature',
    description: 'HMAC-SHA256 signature of the payload (optional for testing)',
    required: false,
  })
  @ApiBody({
    description: 'Webhook payload',
    schema: {
      type: 'object',
      properties: {
        event: {
          type: 'string',
          enum: ['swap.completed', 'swap.failed'],
          example: 'swap.completed',
        },
        executionId: { type: 'string', example: 'exec_1234567890' },
        jobId: { type: 'string', example: '1' },
        timestamp: { type: 'number', example: 1732708800000 },
        data: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            transactionHash: { type: 'string', example: '0xabc123...' },
            outputAmount: { type: 'string', example: '1000000000' },
            duration: { type: 'number', example: 30000 },
            error: {
              type: 'object',
              nullable: true,
              properties: {
                message: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Webhook received and validated successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'Webhook received' },
        payload: { type: 'object' },
        signatureValid: { type: 'boolean', nullable: true },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid webhook signature',
  })
  async receiveWebhook(
    @Body() payload: WebhookPayload,
    @Headers('x-webhook-signature') signature?: string,
  ) {
    this.logger.log('📥 Received webhook', {
      event: payload.event,
      executionId: payload.executionId,
      jobId: payload.jobId,
      hasSignature: !!signature,
    });

    // Validate signature if provided
    let signatureValid: boolean | null = null;
    if (signature) {
      // In production, get secret from environment
      const testSecret = process.env.WEBHOOK_SECRET || 'test-secret-key';
      const body = JSON.stringify(payload);

      try {
        signatureValid = WebhookService.verifySignature(
          body,
          signature,
          testSecret,
        );

        if (!signatureValid) {
          this.logger.error('❌ Invalid webhook signature');
          throw new HttpException(
            'Invalid webhook signature',
            HttpStatus.UNAUTHORIZED,
          );
        }

        this.logger.log('✅ Webhook signature verified');
      } catch (error) {
        this.logger.error('❌ Signature verification failed', {
          error: error.message,
        });
        throw new HttpException(
          'Signature verification failed',
          HttpStatus.UNAUTHORIZED,
        );
      }
    }

    // Log payload details
    this.logger.log('Webhook payload details', {
      event: payload.event,
      executionId: payload.executionId,
      success: payload.data.success,
      transactionHash: payload.data.transactionHash,
      outputAmount: payload.data.outputAmount,
      error: payload.data.error,
    });

    return {
      success: true,
      message: 'Webhook received and processed',
      payload,
      signatureValid,
      receivedAt: new Date().toISOString(),
    };
  }

  /**
   * Generate test webhook signature
   *
   * Helper endpoint to generate HMAC signatures for testing.
   *
   * @param body - Request with payload and secret
   * @returns Generated signature
   */
  @Post('generate-signature')
  @ApiOperation({
    summary: 'Generate webhook signature',
    description:
      'Generates HMAC-SHA256 signature for testing webhook payloads.',
  })
  @ApiBody({
    description: 'Payload and secret',
    schema: {
      type: 'object',
      properties: {
        payload: { type: 'object', description: 'Webhook payload to sign' },
        secret: {
          type: 'string',
          example: 'your-secret-key',
          description: 'Secret key for HMAC',
        },
      },
      required: ['payload', 'secret'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Signature generated successfully',
    schema: {
      type: 'object',
      properties: {
        signature: { type: 'string', example: 'abc123...' },
        payload: { type: 'object' },
        payloadString: { type: 'string' },
      },
    },
  })
  generateSignature(@Body() body: { payload: any; secret: string }) {
    const payloadString = JSON.stringify(body.payload);
    const crypto = require('crypto');

    const signature = crypto
      .createHmac('sha256', body.secret)
      .update(payloadString)
      .digest('hex');

    this.logger.log('🔑 Generated webhook signature', {
      payloadLength: payloadString.length,
      signatureLength: signature.length,
    });

    return {
      signature,
      payload: body.payload,
      payloadString,
      instructions: {
        usage:
          'Include this signature in X-Webhook-Signature header when calling webhook endpoints',
        example: `curl -X POST http://localhost:3000/api/webhooks/test-receiver \\
  -H "Content-Type: application/json" \\
  -H "X-Webhook-Signature: ${signature}" \\
  -d '${payloadString}'`,
      },
    };
  }
}
