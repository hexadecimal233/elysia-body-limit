# elysia-body-limit

A lightweight body size limit plugin for Elysia.js applications that helps secure your apps by limiting request body size.

[![NPM Version](https://img.shields.io/npm/v/elysia-body-limit)](https://www.npmjs.com/package/elysia-body-limit)

## Features

- 📏 Configurable maximum body size
- 🔍 Content-Length header validation
- 🔄 Transfer-Encoding stream monitoring
- ⚡ Bun maxRequestBodySize validation
- 🛡️ Strict Content-Length mode
- 🎯 Custom error handlers

## Installation

```bash
bun add elysia-body-limit
```

## Basic Usage

```typescript
import { Elysia } from "elysia";
import { bodyLimit } from "elysia-body-limit";

// Your current Elysia instance is now under protect!
const app = new Elysia()
  .use(bodyLimit({
    maxSize: "10m"
  }))
  .post("/", ({ body }) => "Body received!")
  .listen(3000);
```

> [!NOTE]
> The middleware automatically validates that your `maxSize` is not larger than Bun's `maxRequestBodySize` configuration.

## How It Works

1. **Content-Length Check**: For requests with `Content-Length` header, the middleware validates the size before processing
2. **Transfer-Encoding Support**: When `bodyCheck` is enabled, the middleware monitors streaming requests to enforce size limits
3. **Bun Configuration Validation**: Automatically warns if your limit exceeds Bun's internal `maxRequestBodySize`
