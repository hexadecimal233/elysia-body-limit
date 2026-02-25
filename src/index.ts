/** biome-ignore-all lint/complexity/useLiteralKeys: bypass private */
import Elysia, { ElysiaStatus, type PreContext } from "elysia"
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
  maxSize: FileUnit
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
   * Content types to SKIP body check.
   *
   * * Request without Content-Type will be treated as `""`.
   * * Content-Type after `;` will be ignored.
   *
   * @default []
   * @example ["", "application/json", "application/x-www-form-urlencoded"]
   */
  bodyCheckBlacklist?: string[]
  /**
   * Content types to ONLY perform body check.
   *
   * * Request without Content-Type will be treated as `""`.
   * * Content-Type after `;` will be ignored.
   *
   * @default unset (Capture all requests)
   * @example ["application/json", "application/x-www-form-urlencoded"]
   */
  bodyCheckWhitelist?: string[] // TODO: add defaults
  /**
   * The handler when strictContentLength is triggered.
   *
   * * Returns HTTP 411 (Length Required) by default.
   *
   * @example
   * ```ts
   * (ctx) => {
   *    return ctx.status(411)
   * }
   * ```
   * @returns Response, ElysiaCustomStatusResponse
   */
  // biome-ignore lint/suspicious/noExplicitAny: any
  onLengthRequired?: (ctx: PreContext) => any
  /**
   * The handler when Body Limit is triggered.
   *
   * * Returns HTTP 413 (Payload Too Large) by default.
   *
   * @example
   * ```ts
   * (ctx) => {
   *    return ctx.status(413)
   * }
   * ```
   * @returns Response, ElysiaCustomStatusResponse
   */
  // biome-ignore lint/suspicious/noExplicitAny: any
  onLimit?: (ctx: PreContext) => any
}

const BUN_MAX_SIZE = 128 * 1024 * 1024 // 128MB

const defaultOptions = {
  validateBunConfig: true,
  onLimit: (ctx) => {
    return ctx.status(413)
  },
  onLengthRequired: (ctx) => {
    return ctx.status(411)
  },
} as const satisfies Omit<ElysiaBodyLimitOptions, "maxSize">

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

    const blacklist = new Set(options.bodyCheckBlacklist || [])
    const whitelist = new Set(options.bodyCheckWhitelist || [])
    const bodyCheck = !!options.bodyCheck
    const strictContentLength = !!options.strictContentLength
    const maxSize = parseFileUnit(options.maxSize)
    const onLengthRequired = options.onLengthRequired
    const onLimit = options.onLimit

    // Validate Bun settings
    if (options.validateBunConfig) {
      const cfg = getRootAppCfg(app)
      const reqMaxSize = cfg.serve?.maxRequestBodySize ?? BUN_MAX_SIZE
      if (maxSize > reqMaxSize) {
        throw new Error(
          `Your ElysiaBodyLimitOptions.maxSize (${options.maxSize}) is larger than your Bun maxRequestBodySize (${reqMaxSize})!`,
        )
      }
    }

    return (
      app
        .onError(({ error, code }) => {
          // sus, elysia simply throws it?!
          if (
            code === "PARSE" &&
            (error.cause instanceof ElysiaStatus || error.cause instanceof Response)
          )
            return error.cause
        })
        // Elysia does not throw ElysiaCustomStatusResponse inside parse hooks / parser somehow,
        // Only onParse can throw, so macros aren't viable at this point.
        // ~~Elysia pre-parses Content-Type for us and removes stuff after semicolon.~~ this cause heavy performance downgrade
        .onRequest((ctx) => {
          const req = ctx.request
          const headers = req.headers

          // According to Fetch spec, GET/HEAD usually have no body. (But Bun.serve already handles that)
          // Skip Bodyless requests
          if (!req.body) return

          const transferEncoding = headers.get("transfer-encoding")
          const length = headers.get("content-length")
          const type = headers.get("content-type") || ""

          // Normalize content-type without substring/indexOf
          // RFC 7231: type/subtype; parameters are optional
          // We only need the type/subtype part.
          const semicolon = type.indexOf(";")
          const contentType = semicolon === -1 ? type : type.slice(0, semicolon)

          // Non-chunked requests (Content-Length path)
          if (!transferEncoding) {
            // In Bun.serve, body will be dropped (RFC 9112), so !length may never be triggered.
            // check for null/empty length
            if (!length) {
              if (strictContentLength) {
                return onLengthRequired(ctx) // undefined => pass
              }
              // Content beyond length will be dropped by Bun, and return an error
              // But in debug environments we will be able to pass body without Content-Length
              return
            }
            // auto compare and handles NaN, Header check of the Content-Length
            if (+length > maxSize) {
              return onLimit(ctx) // undefined => pass
            } else {
              // Continue (Bun.serve automatically handles Malformed content-length and treat as a new request)
              return
            }
          }

          // Chunked requests (Transfer-Encoding present)
          if (!bodyCheck) return // bodyCheck disabled → skip all checks

          // Blacklist: skip checking
          if (blacklist.has(contentType)) return

          // Whitelist: if whitelist exists and contentType not in it → skip// Whitelist: if whitelist exists and contentType not in it → skip
          if (whitelist.size > 0 && !whitelist.has(contentType)) return

          // Pipe the stream for unknow requests (Slow path)
          let received = 0

          const sizeChecker = new TransformStream(
            {
              transform(chunk, controller) {
                received += chunk.length
                if (received > maxSize) {
                  const e = onLimit(ctx)
                  if (e) {
                    controller.error(e)
                    return
                  }
                }
                controller.enqueue(chunk)
              },
            },
            { highWaterMark: 1024 * 1024 }, // 1MB should be fast enough
          )

          ctx.request = new Request(req, {
            body: req.body.pipeThrough(sizeChecker),
            duplex: "half",
          })
        })
    )
  }
}
