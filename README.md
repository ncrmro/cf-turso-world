# Turso World

A workflow orchestration system designed specifically for edge computing environments, leveraging Cloudflare Workers and Turso (distributed SQLite).

## Project Structure

This is a monorepo using npm workspaces:

```
cf-turso-world/
├── packages/
│   └── world-turso/         # Core workflow orchestration package
└── apps/
    └── dashboard/           # Next.js dashboard for workflow visualization
```

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0

### Installation

```bash
# Install all dependencies
npm install

# Build all packages
npm run build
```

### Development

```bash
# Run all projects in dev mode
npm run dev

# Run specific workspace
npm run dev --workspace=@workflow/dashboard
npm run dev --workspace=@workflow/world-turso
```

### Building

```bash
# Build all workspaces
npm run build

# Build specific workspace
npm run build --workspace=@workflow/world-turso
npm run build --workspace=@workflow/dashboard
```

### Testing

```bash
# Test all workspaces
npm run test
```

## Packages

### @workflow/world-turso

Core workflow orchestration package for Cloudflare Workers and Turso.

[Read more →](./packages/world-turso/README.md)

### @workflow/dashboard

Next.js dashboard application for visualizing and managing workflows.

## Architecture

See [SPEC.md](./SPEC.md) for detailed design specifications and architecture overview.

## Key Features

- **Serverless-First**: Designed for Cloudflare Workers with 30-second execution limits
- **Edge Computing**: Runs close to users globally
- **Distributed State**: Uses Turso for distributed SQLite storage
- **Event-Driven**: Queue-based event processing
- **Fault Tolerant**: Built-in retry mechanisms and checkpointing

## License

MIT
