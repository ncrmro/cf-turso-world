/**
 * Configuration interface for Turso World
 */
export interface TursoWorldConfig {
  tursoUrl: string;
  tursoAuthToken: string;
  queues: {
    jobQueue: string;
    eventQueue: string;
    dlqQueue: string;
  };
  workers: {
    maxConcurrency: number;
    executionTimeout: number;
  };
  polling: {
    interval: number; // milliseconds
    batchSize: number;
  };
}

/**
 * Workflow definition interface
 */
export interface WorkflowDefinition {
  name: string;
  version?: number;
  steps: StepDefinition[];
  timeout?: number;
  maxRetries?: number;
}

/**
 * Step definition interface
 */
export interface StepDefinition {
  name: string;
  type: string;
  dependsOn?: string[];
  config?: Record<string, any>;
}

/**
 * Workflow status interface
 */
export interface WorkflowStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

/**
 * Step result interface
 */
export interface StepResult {
  stepId: string;
  status: 'completed' | 'failed';
  output?: any;
  error?: string;
}

/**
 * Workflow event interface
 */
export interface WorkflowEvent {
  type: string;
  workflowId?: string;
  stepId?: string;
  payload?: any;
}

/**
 * Job interface
 */
export interface Job {
  id?: string;
  queue: string;
  name: string;
  data?: any;
  priority?: number;
  scheduledAt?: number;
}

/**
 * Event handler type
 */
export type EventHandler = (event: WorkflowEvent) => Promise<void>;

/**
 * Job handler type
 */
export type JobHandler = (job: Job) => Promise<any>;

/**
 * Main TursoWorld interface
 */
export interface TursoWorld {
  // Workflow management
  createWorkflow(definition: WorkflowDefinition): Promise<string>;
  startWorkflow(workflowId: string, input: any): Promise<void>;
  getWorkflowStatus(workflowId: string): Promise<WorkflowStatus>;
  cancelWorkflow(workflowId: string): Promise<void>;
  
  // Step execution
  executeStep(stepId: string): Promise<StepResult>;
  retryStep(stepId: string): Promise<void>;
  
  // Event handling
  publishEvent(event: WorkflowEvent): Promise<void>;
  subscribeToEvents(handler: EventHandler): Promise<void>;
  
  // Job processing
  enqueueJob(job: Job): Promise<string>;
  processJobs(queue: string, handler: JobHandler): Promise<void>;
}
