import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from './winston-logger.service';

/**
 * Log level for structured logging
 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

/**
 * Workflow step status
 */
export enum WorkflowStepStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

/**
 * Structured log entry with hierarchical parent-child relationship
 */
export interface StructuredLogEntry {
  logId: string; // Unique log ID
  traceId: string; // Root trace ID for the entire request
  parentLogId?: string; // Parent log ID for hierarchical structure
  level: LogLevel;
  message: string;
  context: string;
  timestamp: string;
  duration?: number; // Duration in milliseconds
  metadata?: Record<string, any>;
  step?: {
    name: string;
    status: WorkflowStepStatus;
    index: number;
    totalSteps: number;
  };
}

/**
 * Workflow step definition
 */
export interface WorkflowStep {
  name: string;
  status: WorkflowStepStatus;
  startTime?: Date;
  endTime?: Date;
  duration?: number;
  error?: string;
  metadata?: Record<string, any>;
}

/**
 * Workflow status for a trace
 */
export interface WorkflowStatus {
  traceId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  currentStep: number;
  totalSteps: number;
  steps: WorkflowStep[];
  startTime: Date;
  endTime?: Date;
  duration?: number;
  metadata?: Record<string, any>;
}

/**
 * Trace Logger Service
 * 
 * Provides structured hierarchical logging with parent-child relationships
 * for complete request tracing. Integrates with analytical tools like Loki,
 * Elasticsearch, and other log aggregators.
 * 
 * Features:
 * - Hierarchical parent-child log structure
 * - Unique trace ID for entire request lifecycle
 * - Workflow step tracking with status updates
 * - Integration with Winston for file-based logging
 * - Metadata enrichment for analytical querying
 * - Duration tracking for performance analysis
 */
@Injectable()
export class TraceLoggerService {
  private readonly logs: Map<string, StructuredLogEntry[]> = new Map();
  private readonly workflows: Map<string, WorkflowStatus> = new Map();
  private readonly context: string = 'TraceLogger';

  constructor(private readonly winstonLogger: WinstonLoggerService) {
    this.winstonLogger.setContext(TraceLoggerService.name);
  }

  /**
   * Generate a unique trace ID
   */
  generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate a unique log ID
   */
  private generateLogId(): string {
    return `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Initialize a workflow with steps
   */
  initializeWorkflow(
    traceId: string,
    steps: string[],
    metadata?: Record<string, any>,
  ): void {
    const workflowSteps: WorkflowStep[] = steps.map((stepName) => ({
      name: stepName,
      status: WorkflowStepStatus.PENDING,
    }));

    const workflow: WorkflowStatus = {
      traceId,
      status: 'pending',
      currentStep: 0,
      totalSteps: steps.length,
      steps: workflowSteps,
      startTime: new Date(),
      metadata,
    };

    this.workflows.set(traceId, workflow);
    this.logs.set(traceId, []);

    // Log workflow initialization
    this.log(
      traceId,
      undefined,
      LogLevel.INFO,
      'TraceLogger',
      `Workflow initialized with ${steps.length} steps`,
      {
        steps: steps.map((name, index) => ({ index, name })),
        ...metadata,
      },
    );

    this.winstonLogger.audit('WORKFLOW_INITIALIZED', {
      traceId,
      totalSteps: steps.length,
      steps: steps.map((name, index) => ({ index, name })),
      ...metadata,
    });
  }

  /**
   * Update workflow step status
   */
  updateStepStatus(
    traceId: string,
    stepIndex: number,
    status: WorkflowStepStatus,
    metadata?: Record<string, any>,
  ): void {
    const workflow = this.workflows.get(traceId);
    if (!workflow) {
      this.winstonLogger.warn(
        `Workflow not found for traceId: ${traceId}`,
        this.context,
      );
      return;
    }

    const step = workflow.steps[stepIndex];
    if (!step) {
      this.winstonLogger.warn(
        `Step ${stepIndex} not found in workflow ${traceId}`,
        this.context,
      );
      return;
    }

    const now = new Date();

    // Update step status
    step.status = status;
    if (status === WorkflowStepStatus.IN_PROGRESS) {
      step.startTime = now;
      workflow.currentStep = stepIndex;
      workflow.status = 'in_progress';
    } else if (
      status === WorkflowStepStatus.COMPLETED ||
      status === WorkflowStepStatus.FAILED ||
      status === WorkflowStepStatus.SKIPPED
    ) {
      step.endTime = now;
      if (step.startTime) {
        step.duration = now.getTime() - step.startTime.getTime();
      }
    }

    if (metadata) {
      step.metadata = { ...step.metadata, ...metadata };
    }

    // Update overall workflow status
    if (status === WorkflowStepStatus.FAILED) {
      workflow.status = 'failed';
      workflow.endTime = now;
      workflow.duration = now.getTime() - workflow.startTime.getTime();
    } else if (stepIndex === workflow.totalSteps - 1 && status === WorkflowStepStatus.COMPLETED) {
      workflow.status = 'completed';
      workflow.endTime = now;
      workflow.duration = now.getTime() - workflow.startTime.getTime();
    }

    this.workflows.set(traceId, workflow);

    // Log step status update
    this.log(
      traceId,
      undefined,
      status === WorkflowStepStatus.FAILED ? LogLevel.ERROR : LogLevel.INFO,
      'TraceLogger',
      `Step ${stepIndex + 1}/${workflow.totalSteps}: ${step.name} - ${status}`,
      {
        step: {
          name: step.name,
          status,
          index: stepIndex,
          totalSteps: workflow.totalSteps,
          duration: step.duration,
        },
        ...metadata,
      },
    );

    this.winstonLogger.audit('WORKFLOW_STEP_UPDATE', {
      traceId,
      stepIndex,
      stepName: step.name,
      status,
      duration: step.duration,
      currentStep: workflow.currentStep,
      workflowStatus: workflow.status,
      ...metadata,
    });
  }

  /**
   * Log a structured entry with hierarchical parent-child relationship
   */
  log(
    traceId: string,
    parentLogId: string | undefined,
    level: LogLevel,
    context: string,
    message: string,
    metadata?: Record<string, any>,
  ): string {
    const logId = this.generateLogId();
    const workflow = this.workflows.get(traceId);

    const entry: StructuredLogEntry = {
      logId,
      traceId,
      parentLogId,
      level,
      message,
      context,
      timestamp: new Date().toISOString(),
      metadata,
    };

    // Add current workflow step info if available
    if (workflow) {
      const currentStep = workflow.steps[workflow.currentStep];
      if (currentStep) {
        entry.step = {
          name: currentStep.name,
          status: currentStep.status,
          index: workflow.currentStep,
          totalSteps: workflow.totalSteps,
        };
      }
    }

    // Store log entry
    const traceLogs = this.logs.get(traceId) || [];
    traceLogs.push(entry);
    this.logs.set(traceId, traceLogs);

    // Write to Winston logger with structured data
    const winstonMetadata = {
      logId,
      traceId,
      parentLogId,
      context,
      hierarchical: true, // Flag for log aggregators
      ...entry.step ? { step: entry.step } : {},
      ...metadata,
    };

    switch (level) {
      case LogLevel.DEBUG:
        this.winstonLogger.debug(message, winstonMetadata);
        break;
      case LogLevel.INFO:
        this.winstonLogger.log(message, winstonMetadata);
        break;
      case LogLevel.WARN:
        this.winstonLogger.warn(message, winstonMetadata);
        break;
      case LogLevel.ERROR:
        this.winstonLogger.error(message, winstonMetadata);
        break;
    }

    return logId;
  }

  /**
   * Convenience method to log child entry
   */
  logChild(
    traceId: string,
    parentLogId: string,
    level: LogLevel,
    context: string,
    message: string,
    metadata?: Record<string, any>,
  ): string {
    return this.log(traceId, parentLogId, level, context, message, metadata);
  }

  /**
   * Log timed operation with automatic duration calculation
   */
  async logTimed<T>(
    traceId: string,
    parentLogId: string | undefined,
    context: string,
    operationName: string,
    operation: () => Promise<T>,
    metadata?: Record<string, any>,
  ): Promise<{ result: T; logId: string; duration: number }> {
    const startTime = Date.now();
    const startLogId = this.log(
      traceId,
      parentLogId,
      LogLevel.INFO,
      context,
      `Starting: ${operationName}`,
      metadata,
    );

    try {
      const result = await operation();
      const duration = Date.now() - startTime;

      this.log(
        traceId,
        startLogId,
        LogLevel.INFO,
        context,
        `Completed: ${operationName} (${duration}ms)`,
        { duration, success: true, ...metadata },
      );

      return { result, logId: startLogId, duration };
    } catch (error) {
      const duration = Date.now() - startTime;

      this.log(
        traceId,
        startLogId,
        LogLevel.ERROR,
        context,
        `Failed: ${operationName} (${duration}ms) - ${error.message}`,
        {
          duration,
          success: false,
          error: error.message,
          stack: error.stack,
          ...metadata,
        },
      );

      throw error;
    }
  }

  /**
   * Get all logs for a trace
   */
  getTraceLogs(traceId: string): StructuredLogEntry[] {
    return this.logs.get(traceId) || [];
  }

  /**
   * Get workflow status
   */
  getWorkflowStatus(traceId: string): WorkflowStatus | undefined {
    return this.workflows.get(traceId);
  }

  /**
   * Build hierarchical log tree for visualization
   */
  buildLogTree(traceId: string): any[] {
    const logs = this.getTraceLogs(traceId);
    const rootLogs = logs.filter((log) => !log.parentLogId);

    const buildChildren = (parentLogId: string): any[] => {
      return logs
        .filter((log) => log.parentLogId === parentLogId)
        .map((log) => ({
          ...log,
          children: buildChildren(log.logId),
        }));
    };

    return rootLogs.map((log) => ({
      ...log,
      children: buildChildren(log.logId),
    }));
  }

  /**
   * Clear logs for a trace (for memory management)
   */
  clearTrace(traceId: string): void {
    this.logs.delete(traceId);
    this.workflows.delete(traceId);
    this.winstonLogger.debug(`Cleared trace data for: ${traceId}`);
  }

  /**
   * Clean up old traces (older than specified age)
   */
  cleanupOldTraces(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    const tracesToDelete: string[] = [];

    this.workflows.forEach((workflow, traceId) => {
      const age = now - workflow.startTime.getTime();
      if (age > maxAgeMs) {
        tracesToDelete.push(traceId);
      }
    });

    tracesToDelete.forEach((traceId) => {
      this.clearTrace(traceId);
    });

    if (tracesToDelete.length > 0) {
      this.winstonLogger.log(
        `Cleaned up ${tracesToDelete.length} old traces`,
        this.context,
      );
    }
  }

  /**
   * Get summary statistics
   */
  getStats(): {
    totalTraces: number;
    activeTraces: number;
    completedTraces: number;
    failedTraces: number;
    totalLogs: number;
  } {
    const workflows = Array.from(this.workflows.values());
    const totalLogs = Array.from(this.logs.values()).reduce(
      (sum, logs) => sum + logs.length,
      0,
    );

    return {
      totalTraces: workflows.length,
      activeTraces: workflows.filter((w) => w.status === 'in_progress').length,
      completedTraces: workflows.filter((w) => w.status === 'completed').length,
      failedTraces: workflows.filter((w) => w.status === 'failed').length,
      totalLogs,
    };
  }
}
