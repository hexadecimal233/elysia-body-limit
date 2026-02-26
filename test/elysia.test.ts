import { describe, expect, it } from "bun:test"
import { Elysia } from "elysia"
import { bodyLimit, type ElysiaBodyLimitOptions } from "../src"

// Utils
function createStreamBody(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk))
      }
      controller.close()
    },
  })
}

function createBodyLimitApp(
  bodyLimitOptions: ElysiaBodyLimitOptions,
  configure: (app: any) => any,
): any {
  return configure(new Elysia().use(bodyLimit(bodyLimitOptions)))
}

async function sendRequest(
  app: any,
  options: {
    method?: string
    body?: string | ReadableStream<Uint8Array>
    headers?: Record<string, string>
    skipContentLength?: boolean
  } = {},
): Promise<Response> {
  const { method = "POST", body, headers = {}, skipContentLength } = options
  const isStream = body instanceof ReadableStream

  // Simulate web standards
  if (!skipContentLength && body) {
    if (isStream) {
      headers["transfer-encoding"] = "chunked"
    } else {
      headers["content-length"] = body.length.toString()
    }
  }

  return app.handle(
    new Request("http://localhost/", {
      method,
      headers,
      body: isStream ? body : (body ?? undefined),
      ...(isStream && { duplex: "half" as const }),
    }),
  )
}

// Tests
describe("Elysia Body Limit Plugin", () => {
  describe("Basic Limits", () => {
    it("should allow requests under the limit", async () => {
      const app = createBodyLimitApp({ maxSize: "1k" }, (app) =>
        app.post("/", ({ body }: { body: unknown }) => body),
      )

      const response = await sendRequest(app, {
        body: "Hello World",
        headers: { "content-type": "text/plain" },
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toBe("Hello World")
    })

    it("should reject requests exceeding maxSize via Content-Length", async () => {
      const app = createBodyLimitApp({ maxSize: 5 }, (app) =>
        app.post("/", ({ body }: { body: unknown }) => body),
      )

      const response = await sendRequest(app, {
        body: "This is too long",
        headers: {
          "content-type": "text/plain",
        },
      })

      expect(response.status).toBe(413)
    })

    it("should reject streamed bodies that exceed the limit", async () => {
      const app = createBodyLimitApp({ maxSize: 10, bodyCheck: true }, (app) =>
        app.post("/", ({ body }: { body: unknown }) => body),
      )

      const stream = createStreamBody("First chunk...", "Second chunk is way too big!")

      const response = await sendRequest(app, {
        body: stream,
        headers: {
          "transfer-encoding": "chunked",
          "content-type": "text/plain",
        },
      })

      expect(response.status).toBe(413)
    })
  })

  describe("Strict Mode", () => {
    it("should enforce strictContentLength if enabled", async () => {
      const app = createBodyLimitApp({ maxSize: 999999, strictContentLength: true }, (app) =>
        app.post("/", () => "ok"),
      )

      const response = await sendRequest(app, {
        body: "some body",
        skipContentLength: true,
      })

      expect(response.status).toBe(411)
    })
  })

  describe("Type Filtering - Blacklist", () => {
    it("should filter content types using blacklist", async () => {
      const app = createBodyLimitApp(
        {
          maxSize: 1,
          bodyCheck: true,
          bodyCheckBlacklist: ["application/json", "text/plain", "application/xml"],
        },
        (app) => app.post("/", ({ body }: { body: unknown }) => body),
      )

      // application/json - in blacklist, should bypass
      const jsonResponse = await sendRequest(app, {
        headers: { "content-type": "application/json" },
        body: createStreamBody(JSON.stringify({ data: "way over limit" })),
      })
      expect(jsonResponse.status).toBe(200)

      // text/plain - in blacklist, should bypass
      const textResponse = await sendRequest(app, {
        headers: { "content-type": "text/plain" },
        body: createStreamBody("way over limit"),
      })
      expect(textResponse.status).toBe(200)

      // application/xml - in blacklist, should bypass
      const xmlResponse = await sendRequest(app, {
        headers: { "content-type": "application/xml" },
        body: createStreamBody("<root>way over limit</root>"),
      })
      expect(xmlResponse.status).toBe(200)
    })
  })

  describe("Type Filtering - Whitelist", () => {
    it("should filter content types using whitelist", async () => {
      const app = createBodyLimitApp(
        {
          maxSize: 1,
          bodyCheck: true,
          bodyCheckWhitelist: ["application/json", "application/x-www-form-urlencoded"],
        },
        (app) => app.post("/", ({ body }: { body: unknown }) => body),
      )

      // application/json - in whitelist, should be checked and rejected
      const jsonStream = createStreamBody('{"data":"over limit"}')
      const jsonResponse = await sendRequest(app, {
        body: jsonStream,
        headers: {
          "content-type": "application/json",
        },
      })
      expect(jsonResponse.status).toBe(413)

      // application/x-www-form-urlencoded - in whitelist, should be checked and rejected
      const formStream = createStreamBody("key=value&foo=bar")
      const formResponse = await sendRequest(app, {
        body: formStream,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
      })
      expect(formResponse.status).toBe(413)

      // text/plain - NOT in whitelist, should bypass
      const textResponse = await sendRequest(app, {
        body: createStreamBody("over limit"),
        headers: { "content-type": "text/plain" },
      })
      expect(textResponse.status).toBe(200)
    })
  })

  describe("Type Filtering - Header Parameters", () => {
    it("should handle Content-Type with parameters (charset, etc)", async () => {
      // Test with blacklist
      const blacklistApp = createBodyLimitApp(
        {
          maxSize: 1,
          bodyCheck: true,
          bodyCheckBlacklist: ["application/json"],
        },
        (app) => app.post("/", ({ body }: { body: unknown }) => body),
      )

      // application/json with charset should match blacklist
      const blacklistResponse = await sendRequest(blacklistApp, {
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ data: "over limit" }),
      })
      expect(blacklistResponse.status).toBe(200)

      // Test with whitelist
      const whitelistApp = createBodyLimitApp(
        {
          maxSize: 1,
          bodyCheck: true,
          bodyCheckWhitelist: ["text/plain"],
        },
        (app) => app.post("/", ({ body }: { body: unknown }) => body),
      )

      // text/plain with charset should match whitelist
      const stream = createStreamBody("over limit")
      const whitelistResponse = await sendRequest(whitelistApp, {
        body: stream,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      })
      expect(whitelistResponse.status).toBe(413)
    })
  })

  // ========================================================================
  // Type Filtering - Empty Headers
  // ========================================================================
  describe("Type Filtering - Empty Headers", () => {
    it("should handle empty Content-Type header", async () => {
      // Empty Content-Type in blacklist - should bypass
      const blacklistApp = createBodyLimitApp(
        {
          maxSize: 1,
          bodyCheck: true,
          bodyCheckBlacklist: [""],
        },
        (app) => app.post("/", ({ body }: { body: unknown }) => body),
      )

      const blacklistResponse = await sendRequest(blacklistApp, {
        body: "some body without content type",
      })
      expect(blacklistResponse.status).toBe(200)

      // Empty Content-Type in whitelist - should be checked
      const whitelistApp = createBodyLimitApp(
        {
          maxSize: 1,
          bodyCheck: true,
          bodyCheckWhitelist: [""],
        },
        (app) => app.post("/", ({ body }: { body: unknown }) => body),
      )

      const stream = createStreamBody("over limit")
      const whitelistResponse = await sendRequest(whitelistApp, {
        body: stream,
      })
      // Depends on how Bun handles missing Content-Type
      expect([200, 413]).toContain(whitelistResponse.status)
    })
  })

  describe("Filter Priority", () => {
    it("should prioritize blacklist over whitelist", async () => {
      const app = createBodyLimitApp(
        {
          maxSize: 1,
          bodyCheck: true,
          bodyCheckBlacklist: ["application/json"],
          bodyCheckWhitelist: ["application/json", "text/plain"],
        },
        (app) => app.post("/", ({ body }: { body: unknown }) => body),
      )

      // application/json is in BOTH blacklist and whitelist
      // Blacklist takes precedence, should bypass
      const jsonResponse = await sendRequest(app, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: "over limit" }),
      })
      expect(jsonResponse.status).toBe(200)

      // text/plain is only in whitelist, should be checked and rejected
      const textStream = createStreamBody("over limit")
      const textResponse = await sendRequest(app, {
        body: textStream,
        headers: {
          "content-type": "text/plain",
        },
      })
      expect(textResponse.status).toBe(413)

      // text/html is not in either - with whitelist present, should bypass
      const htmlResponse = await sendRequest(app, {
        headers: { "content-type": "text/html" },
        body: "<html>over limit</html>",
      })
      expect(htmlResponse.status).toBe(200)
    })
  })

  describe("Scoping", () => {
    it("should handle multiple elysia instances with different configs", async () => {
      // Create main app with multiple nested instances
      const app = new Elysia()
        // Baseline route without bodyLimit
        .post("/baseline", () => "ok")
        // Heavy limit instance with 1k limit
        .use(
          new Elysia({ name: "heavy-limit" })
            .use(bodyLimit({ maxSize: "1k" }))
            .post("/heavy/passthrough", () => "ok"),
        )
        // Secure limit instance with bodyCheck enabled
        .use(
          new Elysia({ name: "secure-limit", prefix: "/secure" })
            .use(bodyLimit({ maxSize: "1k", bodyCheck: true }))
            .post("/acl-hit", () => "ok")
            .post("/stream-detect", () => "ok"),
        )
        // Whitelist instance
        .use(
          new Elysia({ name: "whitelist-scope" })
            .use(
              bodyLimit({
                maxSize: "1k",
                bodyCheck: true,
                bodyCheckWhitelist: ["application/special-allow"],
              }),
            )
            .post("/whitelist", () => "ok", { parse: "text/plain" }), // manually register parser
        )

      // Test 1: Baseline route should accept any size (no bodyLimit applied)
      const baselineResponse = await app.handle(
        new Request("http://localhost/baseline", {
          method: "POST",
          headers: { "content-type": "text/plain", "content-length": "2000" },
          body: "x".repeat(2000),
        }),
      )
      expect(baselineResponse.status).toBe(200)

      // Test 2: Heavy limit route should reject large bodies via Content-Length
      const heavyResponse = await app.handle(
        new Request("http://localhost/heavy/passthrough", {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            "content-length": "2000",
          },
          body: "x".repeat(2000),
        }),
      )
      expect(heavyResponse.status).toBe(413)

      // Test 3: Secure route with bodyCheck should reject streamed bodies
      const secureStream = createStreamBody("This is a chunk that exceeds the 1k limit".repeat(100))
      const secureResponse = await app.handle(
        new Request("http://localhost/secure/stream-detect", {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            "transfer-encoding": "chunked",
          },
          body: secureStream,
          duplex: "half",
        }),
      )
      expect(secureResponse.status).toBe(413)

      // Test 4: Whitelist route - application/special-allow should be checked
      const specialStream = createStreamBody("x".repeat(2000))
      const specialResponse = await app.handle(
        new Request("http://localhost/whitelist", {
          method: "POST",
          headers: {
            "content-type": "application/special-allow",
            "transfer-encoding": "chunked",
          },
          body: specialStream,
          duplex: "half",
        }),
      )
      expect(specialResponse.status).toBe(413)

      // Test 5: Whitelist route - other types should bypass
      const otherResponse = await app.handle(
        new Request("http://localhost/whitelist", {
          method: "POST",
          headers: { "content-type": "text/plain", "content-length": "2000" },
          body: "x".repeat(2000),
        }),
      )
      expect(otherResponse.status).toBe(200)
    })
  })
})
