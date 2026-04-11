import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WorkflowStepStatus } from '@shared/services/trace-logger.service';

/**
 * Workflow step information
 */
export class WorkflowStepDto {
  @ApiProperty({
    description: 'Step name',
    example: 'Validate Request',
  })
  name: string;

  @ApiProperty({
    description: 'Step status',
    enum: WorkflowStepStatus,
    example: WorkflowStepStatus.COMPLETED,
  })
  status: WorkflowStepStatus;

  @ApiPropertyOptional({
    description: 'Step start time',
    type: String,
    format: 'date-time',
  })
  startTime?: string;

  @ApiPropertyOptional({
    description: 'Step end time',
    type: String,
    format: 'date-time',
  })
  endTime?: string;

  @ApiPropertyOptional({
    description: 'Step duration in milliseconds',
    type: Number,
  })
  duration?: number;

  @ApiPropertyOptional({
    description: 'Error message if step failed',
    type: String,
  })
  error?: string;

  @ApiPropertyOptional({
    description: 'Additional step metadata',
    type: Object,
  })
  metadata?: Record<string, any>;
}

/**
 * Workflow status response
 */
export class WorkflowStatusResponseDto {
  @ApiProperty({
    description: 'Trace ID for the workflow',
    example: 'trace_1234567890_abc123',
  })
  traceId: string;

  @ApiProperty({
    description: 'Overall workflow status',
    enum: ['pending', 'in_progress', 'completed', 'failed'],
    example: 'in_progress',
  })
  status: 'pending' | 'in_progress' | 'completed' | 'failed';

  @ApiProperty({
    description: 'Current step index (0-based)',
    example: 2,
  })
  currentStep: number;

  @ApiProperty({
    description: 'Total number of steps',
    example: 5,
  })
  totalSteps: number;

  @ApiProperty({
    description: 'Progress percentage (0-100)',
    example: 40,
  })
  progressPercentage: number;

  @ApiProperty({
    description: 'Workflow steps with status',
    type: [WorkflowStepDto],
  })
  steps: WorkflowStepDto[];

  @ApiProperty({
    description: 'Workflow start time',
    type: String,
    format: 'date-time',
  })
  startTime: string;

  @ApiPropertyOptional({
    description: 'Workflow end time',
    type: String,
    format: 'date-time',
  })
  endTime?: string;

  @ApiPropertyOptional({
    description: 'Total workflow duration in milliseconds',
    type: Number,
  })
  duration?: number;

  @ApiPropertyOptional({
    description: 'Additional workflow metadata',
    type: Object,
  })
  metadata?: Record<string, any>;
}

/**
 * Async execution response with trace ID
 */
export class AsyncExecutionResponseDto {
  @ApiProperty({
    description: 'Request accepted for async processing',
    example: true,
  })
  success: boolean;

  @ApiProperty({
    description: 'Trace ID for tracking the request',
    example: 'trace_1234567890_abc123',
  })
  traceId: string;

  @ApiPropertyOptional({
    description: 'Job ID for queue tracking (if queue enabled)',
    example: '1234',
  })
  jobId?: string;

  @ApiProperty({
    description: 'Execution ID for result tracking',
    example: 'exec_1234567890_abc123',
  })
  executionId: string;

  @ApiProperty({
    description: 'Status endpoint URL',
    example: '/universal-swap/trace-status/trace_1234567890_abc123',
  })
  statusUrl: string;

  @ApiProperty({
    description: 'Estimated completion time in seconds',
    example: 60,
  })
  estimatedCompletionSeconds: number;

  @ApiProperty({
    description: 'Message',
    example: 'Request accepted. Processing asynchronously.',
  })
  message: string;

  @ApiProperty({
    description: 'Timestamp',
    type: String,
    format: 'date-time',
  })
  timestamp: string;
}

/**
 * Structured log entry DTO
 */
export class StructuredLogEntryDto {
  @ApiProperty({
    description: 'Unique log ID',
    example: 'log_1234567890_abc123',
  })
  logId: string;

  @ApiProperty({
    description: 'Trace ID',
    example: 'trace_1234567890_abc123',
  })
  traceId: string;

  @ApiPropertyOptional({
    description: 'Parent log ID for hierarchical structure',
    example: 'log_1234567890_xyz789',
  })
  parentLogId?: string;

  @ApiProperty({
    description: 'Log level',
    enum: ['debug', 'info', 'warn', 'error'],
    example: 'info',
  })
  level: string;

  @ApiProperty({
    description: 'Log message',
    example: 'Fetching quote from Symbiosis',
  })
  message: string;

  @ApiProperty({
    description: 'Context/component name',
    example: 'SwapOrchestrationService',
  })
  context: string;

  @ApiProperty({
    description: 'Timestamp',
    type: String,
    format: 'date-time',
  })
  timestamp: string;

  @ApiPropertyOptional({
    description: 'Operation duration in milliseconds',
    type: Number,
  })
  duration?: number;

  @ApiPropertyOptional({
    description: 'Additional metadata',
    type: Object,
  })
  metadata?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Current workflow step info',
    type: Object,
  })
  step?: {
    name: string;
    status: string;
    index: number;
    totalSteps: number;
  };
}

/**
 * Trace status response with logs
 */
export class TraceStatusResponseDto {
  @ApiProperty({
    description: 'Request successful',
    example: true,
  })
  success: boolean;

  @ApiProperty({
    description: 'Trace ID',
    example: 'trace_1234567890_abc123',
  })
  traceId: string;

  @ApiProperty({
    description: 'Workflow status',
    type: WorkflowStatusResponseDto,
  })
  workflow: WorkflowStatusResponseDto;

  @ApiPropertyOptional({
    description: 'Execution result (available when completed)',
    type: Object,
  })
  result?: any;

  @ApiPropertyOptional({
    description: 'Error details (available when failed)',
    type: Object,
  })
  error?: {
    code: string;
    message: string;
    details?: any;
  };

  @ApiProperty({
    description: 'Timestamp',
    type: String,
    format: 'date-time',
  })
  timestamp: string;
}

/**
 * Trace logs response
 */
export class TraceLogsResponseDto {
  @ApiProperty({
    description: 'Request successful',
    example: true,
  })
  success: boolean;

  @ApiProperty({
    description: 'Trace ID',
    example: 'trace_1234567890_abc123',
  })
  traceId: string;

  @ApiProperty({
    description: 'Total number of logs',
    example: 25,
  })
  totalLogs: number;

  @ApiProperty({
    description: 'Structured log entries',
    type: [StructuredLogEntryDto],
  })
  logs: StructuredLogEntryDto[];

  @ApiProperty({
    description: 'Hierarchical log tree (for visualization)',
    type: Array,
  })
  logTree: any[];

  @ApiProperty({
    description: 'Timestamp',
    type: String,
    format: 'date-time',
  })
  timestamp: string;
}
