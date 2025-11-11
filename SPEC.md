# Turso World: Design Specification for Cloudflare Workers

## Executive Summary

Turso World is a workflow orchestration system designed specifically for edge computing environments, leveraging Cloudflare Workers and Turso (distributed SQLite) as the primary data store. Unlike Postgres World's long-running process model, this architecture embraces the serverless paradigm while maintaining robust workflow execution capabilities.

## Architecture Overview

### Core Components

```
┌─────────────────────────────────────────────────────────┐
│                   Cloudflare Workers                     │
├─────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   Trigger    │  │   Executor   │  │   Monitor    │  │
│  │   Worker     │  │   Worker     │  │   Worker     │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                  │                  │          │
├─────────┴──────────────────┴──────────────────┴─────────┤
│                    Cloudflare Queues                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Job Queue   │  │ Event Queue  │  │  DLQ         │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
├───────────────────────────────────────────────────────────┤
│                    Turso Database                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │  workflows | steps | events | state | history   │   │
│  └──────────────────────────────────────────────────┘   │
├───────────────────────────────────────────────────────────┤
│              Cloudflare Durable Objects                  │
│  ┌──────────────┐  ┌──────────────┐                     │
│  │ Workflow DO  │  │ Lock Manager │                     │
│  └──────────────┘  └──────────────┘                     │
└───────────────────────────────────────────────────────────┘
```

## Database Schema

### Core Tables

```sql
-- Workflows table
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  input_data TEXT, -- JSON
  output_data TEXT, -- JSON
  error TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  started_at INTEGER,
  completed_at INTEGER,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  timeout_seconds INTEGER,
  parent_workflow_id TEXT,
  metadata TEXT -- JSON
);

-- Steps table
CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  input_data TEXT, -- JSON
  output_data TEXT, -- JSON
  error TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  started_at INTEGER,
  completed_at INTEGER,
  retry_count INTEGER DEFAULT 0,
  depends_on TEXT, -- JSON array of step IDs
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);

-- Events table (replacing NOTIFY/LISTEN)
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  workflow_id TEXT,
  step_id TEXT,
  payload TEXT, -- JSON
  created_at INTEGER DEFAULT (unixepoch()),
  processed_at INTEGER,
  processor_id TEXT,
  status TEXT CHECK(status IN ('pending', 'processing', 'processed', 'failed'))
);

-- Jobs table (replacing pg-boss)
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT, -- JSON
  priority INTEGER DEFAULT 0,
  retry_limit INTEGER DEFAULT 3,
  retry_count INTEGER DEFAULT 0,
  retry_delay INTEGER DEFAULT 0,
  scheduled_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  failed_at INTEGER,
  status TEXT CHECK(status IN ('created', 'scheduled', 'active', 'completed', 'failed', 'cancelled')),
  output TEXT, -- JSON
  error TEXT,
  worker_id TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

-- State checkpoints for recovery
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  step_id TEXT,
  state_data TEXT, -- JSON
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);

-- Create indexes for performance
CREATE INDEX idx_workflows_status ON workflows(status, created_at);
CREATE INDEX idx_steps_workflow ON steps(workflow_id, status);
CREATE INDEX idx_events_pending ON events(status, created_at) WHERE status = 'pending';
CREATE INDEX idx_jobs_queue_status ON jobs(queue, status, priority DESC, scheduled_at);
CREATE INDEX idx_checkpoints_workflow ON checkpoints(workflow_id, created_at DESC);
```

## Implementation Modules

### 1. Package Structure

```typescript
// @workflow/world-turso/index.ts
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
```

### 2. Core Interfaces

```typescript
// types.ts
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
```

### 3. Worker Implementation

```typescript
// workers/trigger.ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const turso = createClient({
      url: env.TURSO_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    });
    
    // Handle workflow triggers via HTTP
    if (request.method === 'POST' && new URL(request.url).pathname === '/trigger') {
      const { workflowName, input } = await request.json();
      
      // Create workflow instance
      const workflowId = generateId();
      await turso.execute({
        sql: `INSERT INTO workflows (id, name, status, input_data) 
              VALUES (?, ?, 'pending', ?)`,
        args: [workflowId, workflowName, JSON.stringify(input)]
      });
      
      // Queue initial job
      await env.JOB_QUEUE.send({
        type: 'WORKFLOW_START',
        workflowId,
        timestamp: Date.now()
      });
      
      return new Response(JSON.stringify({ workflowId }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
  
  async queue(batch: MessageBatch<Job>, env: Env) {
    // Process job queue messages
    const turso = createClient({
      url: env.TURSO_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    });
    
    for (const message of batch.messages) {
      try {
        await processJob(message.body, turso, env);
        message.ack();
      } catch (error) {
        message.retry();
      }
    }
  }
};
```

### 4. Durable Objects for Coordination

```typescript
// durable-objects/workflow-coordinator.ts
export class WorkflowCoordinator implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }
  
  async fetch(request: Request) {
    const { method, workflowId, operation } = await request.json();
    
    switch (operation) {
      case 'acquireLock':
        return this.acquireLock(workflowId);
      case 'releaseLock':
        return this.releaseLock(workflowId);
      case 'getState':
        return this.getWorkflowState(workflowId);
      case 'updateState':
        return this.updateWorkflowState(workflowId, await request.json());
    }
  }
  
  private async acquireLock(workflowId: string): Promise<Response> {
    const locks = await this.state.storage.get<Set<string>>('locks') || new Set();
    
    if (locks.has(workflowId)) {
      return new Response(JSON.stringify({ locked: false }), { status: 409 });
    }
    
    locks.add(workflowId);
    await this.state.storage.put('locks', locks);
    
    // Set auto-release after timeout
    this.state.waitUntil(
      this.state.storage.setAlarm(Date.now() + 30000, workflowId)
    );
    
    return new Response(JSON.stringify({ locked: true }));
  }
}
```

### 5. Event Streaming Replacement

Since Turso/SQLite doesn't have NOTIFY/LISTEN, we implement polling-based event streaming:

```typescript
// streaming/event-poller.ts
export class EventPoller {
  private turso: Client;
  private interval: number;
  private batchSize: number;
  
  async start(handler: EventHandler) {
    // Use Cloudflare Cron Triggers for regular polling
    // Or use Durable Objects with alarms for more precise timing
    
    const processEvents = async () => {
      const events = await this.turso.execute({
        sql: `SELECT * FROM events 
              WHERE status = 'pending' 
              ORDER BY created_at 
              LIMIT ?`,
        args: [this.batchSize]
      });
      
      for (const event of events.rows) {
        try {
          await handler(event);
          await this.markProcessed(event.id);
        } catch (error) {
          await this.markFailed(event.id, error);
        }
      }
    };
    
    // For Workers, use scheduled handler instead of setInterval
    return processEvents;
  }
}
```

### 6. Job Processing System

```typescript
// jobs/processor.ts
export class JobProcessor {
  private turso: Client;
  private queues: Map<string, Queue>;
  
  async processQueue(queueName: string): Promise<void> {
    // Claim jobs atomically
    const jobs = await this.turso.batch([
      {
        sql: `UPDATE jobs 
              SET status = 'active', 
                  worker_id = ?, 
                  started_at = unixepoch()
              WHERE queue = ? 
                AND status IN ('created', 'scheduled')
                AND (scheduled_at IS NULL OR scheduled_at <= unixepoch())
              ORDER BY priority DESC, created_at
              LIMIT ?
              RETURNING *`,
        args: [this.workerId, queueName, this.batchSize]
      }
    ]);
    
    // Process claimed jobs
    for (const job of jobs[0].rows) {
      await this.executeJob(job);
    }
  }
  
  private async executeJob(job: Job): Promise<void> {
    try {
      const result = await this.handlers.get(job.name)?.(job.data);
      
      await this.turso.execute({
        sql: `UPDATE jobs 
              SET status = 'completed', 
                  completed_at = unixepoch(), 
                  output = ?
              WHERE id = ?`,
        args: [JSON.stringify(result), job.id]
      });
    } catch (error) {
      await this.handleJobFailure(job, error);
    }
  }
}
```

## Configuration

### Environment Variables

```bash
# Turso Configuration
WORKFLOW_TURSO_URL="libsql://your-database.turso.io"
WORKFLOW_TURSO_AUTH_TOKEN="your-auth-token"

# Queue Configuration
WORKFLOW_QUEUE_JOB="workflow-jobs"
WORKFLOW_QUEUE_EVENT="workflow-events"
WORKFLOW_QUEUE_DLQ="workflow-dlq"

# Worker Configuration
WORKFLOW_WORKER_CONCURRENCY="5"
WORKFLOW_EXECUTION_TIMEOUT="25000"  # 25 seconds (Workers limit: 30s)

# Polling Configuration
WORKFLOW_POLL_INTERVAL="1000"  # 1 second
WORKFLOW_POLL_BATCH_SIZE="10"

# Durable Objects
WORKFLOW_DO_NAMESPACE="WORKFLOW_COORDINATOR"
```

### Wrangler Configuration

```toml
name = "turso-world"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[queues.producers]]
queue = "workflow-jobs"
binding = "JOB_QUEUE"

[[queues.consumers]]
queue = "workflow-jobs"
max_batch_size = 10
max_retries = 3

[[durable_objects.bindings]]
name = "WORKFLOW_COORDINATOR"
class_name = "WorkflowCoordinator"

[[migrations]]
tag = "v1"
new_classes = ["WorkflowCoordinator"]

[env.production.vars]
TURSO_URL = "libsql://your-database.turso.io"

[[env.production.queues.producers]]
queue = "workflow-jobs-prod"
binding = "JOB_QUEUE"
```

## Key Differences from Postgres World

### 1. Serverless Adaptation
- **Short-lived executions**: Workers have 30-second CPU limits, so workflows are broken into smaller chunks
- **Stateless design**: Each invocation is independent, with state persisted to Turso
- **Event-driven**: Uses Cloudflare Queues instead of long-polling

### 2. Database Differences
- **No NOTIFY/LISTEN**: Replaced with polling or queue-based events
- **SQLite limitations**: No native job queue, implemented in application layer
- **Distributed consistency**: Uses Durable Objects for distributed locks

### 3. Scalability Model
- **Edge deployment**: Runs close to users globally
- **Automatic scaling**: Workers scale automatically with load
- **Cost efficiency**: Pay-per-request model vs. always-on processes

### 4. Recovery Mechanisms
- **Checkpoint-based**: Regular state checkpoints for recovery
- **Queue retry**: Built-in retry mechanisms in Cloudflare Queues
- **Idempotent operations**: All operations designed to be safely retryable

## Usage Example

```typescript
// Initialize Turso World
import { TursoWorld } from '@workflow/world-turso';

export default {
  async fetch(request: Request, env: Env) {
    const world = new TursoWorld({
      tursoUrl: env.TURSO_URL,
      tursoAuthToken: env.TURSO_AUTH_TOKEN,
      queues: {
        jobQueue: env.JOB_QUEUE,
        eventQueue: env.EVENT_QUEUE,
        dlqQueue: env.DLQ_QUEUE
      }
    });
    
    // Create and start a workflow
    const workflowId = await world.createWorkflow({
      name: 'data-processing',
      steps: [
        { name: 'fetch-data', type: 'http' },
        { name: 'transform', type: 'compute' },
        { name: 'store', type: 'database' }
      ]
    });
    
    await world.startWorkflow(workflowId, {
      source: 'api',
      dataset: 'analytics'
    });
    
    return new Response(JSON.stringify({ workflowId }));
  }
};
```

## Performance Considerations

### 1. Query Optimization
- Use prepared statements for repeated queries
- Implement connection pooling with Turso's embedded replicas
- Batch operations when possible

### 2. Caching Strategy
- Cache workflow definitions in Workers KV
- Use Turso's embedded replicas for read-heavy workloads
- Implement result caching for idempotent operations

### 3. Monitoring & Observability
- Integrate with Cloudflare Analytics
- Custom metrics via Workers Analytics Engine
- Structured logging with correlation IDs

## Security Considerations

### 1. Authentication
- Row-level security via Turso auth tokens
- API key validation at Worker level
- JWT tokens for user authentication

### 2. Data Encryption
- Encrypt sensitive data before storing
- Use Cloudflare's encryption at rest
- Implement field-level encryption for PII

### 3. Access Control
- Implement RBAC at application level
- Audit logging for all operations
- Rate limiting via Cloudflare's rate limiting rules

## Migration Path

### From Postgres World
1. Export workflow definitions and convert schema
2. Migrate job queue to Cloudflare Queues format
3. Replace NOTIFY/LISTEN with event polling
4. Update connection strings and authentication

### Deployment Steps
1. Create Turso database and run schema migrations
2. Deploy Workers with wrangler
3. Configure Queues and Durable Objects
4. Set environment variables
5. Run integration tests
6. Enable production traffic

## Future Enhancements

### Phase 1 (Q1 2025)
- WebSocket support for real-time updates
- Workflow visualization dashboard
- Advanced retry strategies

### Phase 2 (Q2 2025)
- Multi-region replication
- Workflow versioning and blue-green deployments
- Cost optimization analyzer

### Phase 3 (Q3 2025)
- AI-powered workflow optimization
- Predictive scaling
- Advanced debugging tools

## Conclusion

Turso World provides a robust, scalable, and cost-effective workflow orchestration system designed specifically for the edge. By leveraging Cloudflare Workers and Turso, it offers global distribution, automatic scaling, and excellent performance while maintaining the flexibility and reliability needed for production workloads.
