/** biome-ignore-all lint/complexity/useLiteralKeys: bypass private */
import Elysia, { type ElysiaCustomStatusResponse, ElysiaStatus, type PreContext } from "elysia"
import type { FileUnit } from "elysia/type-system/types"
import { parseFileUnit } from "elysia/type-system/utils"

/**
 * Options for configuring body size limits in Elysia
 */
export interface ElysiaBodyLimitOptions {
  /**
   * Maximum size for the content body in bytes.
   *
   * * Supports Elysia file unit.
   * @example 2 * 1024 (2MB), "10m" (10MB)
   */
  maxSize?: FileUnit
  /**
   * Whether to validate against Bun's maxRequestBodySize (Default 128MB)
   * @default true
   */
  validateBunConfig?: boolean
  /**
   * Whether to reject requests when no Content-Length is provided for methods like GET, HEAD, DELETE and OPTIONS.
   *
   * Bun.serve seems to automatically drop the body (RFC 9112) when Transfer-Encoding fails and Content-Length is empty.
   * @default false
   */
  strictContentLength?: boolean
  /**
   * Whether to detect body data (works with `Transfer-Encoding`, failed matches as well)
   * @default false
   */
  bodyCheck?: boolean // This may cause slight performance impacts.
  /**
   * Content types to skip body check.
   *
   * * Request without Content-Type will be treated as `""`.
   *
   * @default []
   * @example ["", "application/json", "application/x-www-form-urlencoded"]
   */
  bodyCheckBlacklist?: string[]
  /**
   * The error handler when strictContentLength is triggered.
   *
   * * Returns HTTP 411 (Length Required) by default.
   *
   * @example
   * ```ts
   * (ctx) => {
   *    return ctx.status(411)
   * }
   * ```
   */
  // biome-ignore lint/suspicious/noExplicitAny: any
  onLengthRequired?: (ctx: PreContext) => ElysiaCustomStatusResponse<any, any, any>
  /**
   * The error handler when Body Limit is triggered.
   *
   * * Returns HTTP 413 (Payload Too Large) by default.
   *
   * @example
   * ```ts
   * (ctx) => {
   *    return ctx.status(413)
   * }
   * ```
   */
  // biome-ignore lint/suspicious/noExplicitAny: any
  onError?: (ctx: PreContext) => ElysiaCustomStatusResponse<any, any, any>
}

const defaultBlacklist = ["", "application/json", "application/x-www-form-urlencoded"]

const defaultOptions = {
  validateBunConfig: true,
  bodyCheckBlacklist: defaultBlacklist,
  onError: (ctx) => {
    return ctx.status(413)
  },
  onLengthRequired: (ctx) => {
    return ctx.status(411)
  },
} as const satisfies ElysiaBodyLimitOptions

/**
 * Body Limit Plugin for Elysia.
 *
 * @example
 * ```ts
 * import { Elysia } from 'elysia';
 * import { bodyLimit } from 'elysia-body-limit';
 *
 * const app = new Elysia()
 *   .use(bodyLimit({
 *     maxSize: "10m"
 *   }))
 *   .listen(3000);
 * ```
 * @param userOptions
 * @returns plugin
 */
export function bodyLimit(userOptions: ElysiaBodyLimitOptions) {
  return (app: Elysia) => {
    const options = {
      ...defaultOptions,
      ...userOptions,
    }

    const maxSize = options.maxSize ? parseFileUnit(options.maxSize) : undefined

    // Get Root elysia config
    const getRootAppCfg = (app: Elysia) => {
      let current = app
      while (current["getParent"]) {
        const parent = current["getParent"]()
        if (!parent) break
        current = parent
      }
      return current.config
    }

    // Precompile size checker
    const createShouldFailure = () => {
      const hasMax = typeof maxSize === "number"

      return (size: number) => {
        if (hasMax && size > maxSize) return true
        return false
      }
    }

    const shouldFailure = createShouldFailure()

    // Pipe the stream for unknow requests
    const transformBody = (ctx: PreContext) => {
      if (!ctx.request.body) return

      const contentType = ctx.request.headers.get("content-type")

      if (options.bodyCheck) {
        if (options.bodyCheckBlacklist.includes(contentType ?? "")) {
          /* skip check */
        } else {
          let received = 0

          const transformStream = new TransformStream({
            transform(chunk, controller) {
              received += chunk.length
              if (shouldFailure(received)) {
                const e = options.onError(ctx) // User handles, error throws in PARSE stage.
                controller.error(e)
                return
              }
              controller.enqueue(chunk)
            },
          })

          ctx.request = new Request(ctx.request, {
            body: ctx.request.body.pipeThrough(transformStream),
            duplex: "half",
          })
        }
      }
    }

    // Validate Bun settings
    if (options.validateBunConfig) {
      const cfg = getRootAppCfg(app)
      const reqMaxSize = cfg.serve?.maxRequestBodySize ?? 128 * 1024 * 1024 // 128MB default
      if (maxSize && maxSize >= reqMaxSize) {
        throw new Error(
          `Your ElysiaBodyLimitOptions.maxSize (${options.maxSize}) is larger than your Bun maxRequestBodySize (${reqMaxSize})!`,
        )
      }
    }

    return (
      app
        .onError(({ error, code }) => {
          if (code === "PARSE" && error.cause instanceof ElysiaStatus) return error.cause // sus, elysia simply throws it?!
        })
        // Elysia does not throw ElysiaCustomStatusResponse inside parse hooks somehow, so macros aren't viable at this point.
        .onRequest(async (ctx) => {
          const { request } = ctx

          if (!request.body) return // Skip Bodyless requests

          const hasTransferEncoding = request.headers.has("transfer-encoding")

          // Check Transfer Encoding first
          if (!hasTransferEncoding) {
            // In Bun.serve, body will be dropped (RFC 9112), so !length may never be triggered.
            const length = request.headers.get("content-length") // RFC 9110 -- Skip
            if (!length) {
              if (options.strictContentLength) {
                return options.onLengthRequired(ctx)
              }
              // Header check of the Content-Length
            } else if (shouldFailure(+length)) {
              return options.onError(ctx)
            }
            // Content beyond length will be dropped by Bun, and return a 404
          }

          transformBody(ctx)
        })
    )
  }
}
