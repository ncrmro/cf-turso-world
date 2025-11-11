# @workflow/world-turso

Workflow orchestration system for Cloudflare Workers and Turso.

## Overview

Turso World is a workflow orchestration system designed specifically for edge computing environments, leveraging Cloudflare Workers and Turso (distributed SQLite) as the primary data store.

## Installation

```bash
npm install @workflow/world-turso
```

## Usage

```typescript
import { TursoWorld } from '@workflow/world-turso';

const world = new TursoWorld({
  tursoUrl: process.env.TURSO_URL,
  tursoAuthToken: process.env.TURSO_AUTH_TOKEN,
  queues: {
    jobQueue: 'workflow-jobs',
    eventQueue: 'workflow-events',
    dlqQueue: 'workflow-dlq'
  },
  workers: {
    maxConcurrency: 5,
    executionTimeout: 25000
  },
  polling: {
    interval: 1000,
    batchSize: 10
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
```

## Features

- **Serverless-First**: Designed for Cloudflare Workers with 30-second execution limits
- **Edge Computing**: Runs close to users globally
- **Distributed State**: Uses Turso for distributed SQLite storage
- **Event-Driven**: Queue-based event processing
- **Fault Tolerant**: Built-in retry mechanisms and checkpointing

## Development

```bash
# Build the package
npm run build

# Watch mode
npm run dev
```

## License

MIT
