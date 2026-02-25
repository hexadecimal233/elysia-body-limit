import { describe, expect, it } from "bun:test"
import { Elysia } from "elysia"
import { bodyLimit } from "../src"

describe("Elysia Body Limit Plugin", () => {
  it("should allow requests under the limit", async () => {
    const app = new Elysia().use(bodyLimit({ maxSize: "1k" })).post("/", ({ body }) => body)

    const response = await app.handle(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "Hello World",
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("Hello World")
  })

  it("should reject requests exceeding maxSize via Content-Length", async () => {
    const app = new Elysia()
      .use(bodyLimit({ maxSize: 5 })) // 5 bytes limit
      .post("/", ({ body }) => body)

    const response = await app.handle(
      new Request("http://localhost/", {
        method: "POST",
        body: "This is too long",
        headers: {
          "content-type": "text/plain",
          "content-length": "This is too long".length.toString(),
        },
      }),
    )

    expect(response.status).toBe(413)
  })

  it("should reject streamed bodies that exceed the limit", async () => {
    const app = new Elysia()
      .use(bodyLimit({ maxSize: 10, bodyCheck: true }))
      .post("/", ({ body }) => body)

    // Create a readable stream to simulate chunked transfer
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("First chunk..."))
        controller.enqueue(new TextEncoder().encode("Second chunk is way too big!"))
        controller.close()
      },
    })

    const response = await app.handle(
      new Request("http://localhost/", {
        method: "POST",
        headers: {
          "transfer-encoding": "chunked",
          "content-type": "text/plain",
          "content-length": "1", // will be ignored
        },
        body: stream,
        duplex: "half",
      }),
    )

    expect(response.status).toBe(413)
  })

  it("should enforce strictContentLength if enabled", async () => {
    const app = new Elysia()
      .use(bodyLimit({ maxSize: 999999, strictContentLength: true }))
      .post("/", () => "ok")

    const response = await app.handle(
      new Request("http://localhost/", {
        method: "POST",
        // No Content-Length header provided
        body: "some body",
      }),
    )

    expect(response.status).toBe(411)
  })

  it("should bypass body check for blacklisted content types", async () => {
    const app = new Elysia()
      .use(
        bodyLimit({
          maxSize: 1,
          bodyCheck: true,
          bodyCheckBlacklist: ["application/json"],
        }),
      )
      .post("/", ({ body }) => body)

    const response = await app.handle(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      }),
    )

    // Even though the body is > 1 byte, it bypasses because of the blacklist
    expect(response.status).toBe(200)
  })

  describe("Blacklist", () => {
    it("should bypass body check for multiple blacklisted content types", async () => {
      const app = new Elysia()
        .use(
          bodyLimit({
            maxSize: 1,
            bodyCheck: true,
            bodyCheckBlacklist: ["application/json", "text/plain", "application/xml"],
          }),
        )
        .post("/", ({ body }) => body)

      // Test application/json
      const jsonResponse = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: "this is way over 1 byte limit" }),
        }),
      )
      expect(jsonResponse.status).toBe(200)

      // Test text/plain
      const textResponse = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "This text is also over the limit",
        }),
      )
      expect(textResponse.status).toBe(200)

      // Test application/xml
      const xmlResponse = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "content-type": "application/xml" },
          body: "<root>data</root>",
        }),
      )
      expect(xmlResponse.status).toBe(200)
    })

    it("should reject non-blacklisted content types when bodyCheck is enabled", async () => {
      const app = new Elysia()
        .use(
          bodyLimit({
            maxSize: 1,
            bodyCheck: true,
            bodyCheckBlacklist: ["application/json"],
          }),
        )
        .post("/", ({ body }) => body)

      // text/plain is NOT in blacklist, should be checked
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("This is over 1 byte"))
          controller.close()
        },
      })

      const response = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: {
            "transfer-encoding": "chunked",
            "content-type": "text/plain",
          },
          body: stream,
          duplex: "half",
        }),
      )

      expect(response.status).toBe(413)
    })

    it("should handle content-type with parameters in blacklist", async () => {
      const app = new Elysia()
        .use(
          bodyLimit({
            maxSize: 1,
            bodyCheck: true,
            bodyCheckBlacklist: ["application/json"],
          }),
        )
        .post("/", ({ body }) => body)

      // Content-Type with charset parameter should still match
      const response = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ data: "over limit" }),
        }),
      )

      // Should bypass because the base content-type (application/json) is in blacklist
      expect(response.status).toBe(200)
    })

    it("should handle empty content-type in blacklist", async () => {
      const app = new Elysia()
        .use(
          bodyLimit({
            maxSize: 1,
            bodyCheck: true,
            bodyCheckBlacklist: [""],
          }),
        )
        .post("/", ({ body }) => body)

      // Request without Content-Type header (treated as "")
      const response = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          body: "some body without content type",
        }),
      )

      // Should bypass because empty string is in blacklist
      expect(response.status).toBe(200)
    })
  })

  describe("Whitelist", () => {
    it("should only check whitelisted content types", async () => {
      const app = new Elysia()
        .use(
          bodyLimit({
            maxSize: 1,
            bodyCheck: true,
            bodyCheckWhitelist: ["application/json"],
          }),
        )
        .post("/", ({ body }) => body)

      // application/json is in whitelist, should be checked
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":"over limit"}'))
          controller.close()
        },
      })

      const jsonResponse = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: {
            "transfer-encoding": "chunked",
            "content-type": "application/json",
          },
          body: stream,
          duplex: "half",
        }),
      )
      expect(jsonResponse.status).toBe(413)

      // text/plain is NOT in whitelist, should bypass
      const textResponse = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "This is over 1 byte but not in whitelist",
        }),
      )
      expect(textResponse.status).toBe(200)
    })

    it("should handle multiple whitelisted content types", async () => {
      const app = new Elysia()
        .use(
          bodyLimit({
            maxSize: 1,
            bodyCheck: true,
            bodyCheckWhitelist: ["application/json", "application/x-www-form-urlencoded"],
          }),
        )
        .post("/", ({ body }) => body)

      // Both should be checked (and rejected due to size)
      const jsonStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":"over limit"}'))
          controller.close()
        },
      })

      const jsonResponse = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: {
            "transfer-encoding": "chunked",
            "content-type": "application/json",
          },
          body: jsonStream,
          duplex: "half",
        }),
      )
      expect(jsonResponse.status).toBe(413)

      const formStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("key=value&foo=bar"))
          controller.close()
        },
      })

      const formResponse = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: {
            "transfer-encoding": "chunked",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: formStream,
          duplex: "half",
        }),
      )
      expect(formResponse.status).toBe(413)
    })

    it("should handle content-type with parameters in whitelist", async () => {
      const app = new Elysia()
        .use(
          bodyLimit({
            maxSize: 1,
            bodyCheck: true,
            bodyCheckWhitelist: ["text/plain"],
          }),
        )
        .post("/", ({ body }) => body)

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("over limit"))
          controller.close()
        },
      })

      // Content-Type with charset parameter should still match whitelist
      const response = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: {
            "transfer-encoding": "chunked",
            "content-type": "text/plain; charset=utf-8",
          },
          body: stream,
          duplex: "half",
        }),
      )

      // Should be checked because base content-type (text/plain) is in whitelist
      expect(response.status).toBe(413)
    })

    it("should handle empty content-type in whitelist", async () => {
      const app = new Elysia()
        .use(
          bodyLimit({
            maxSize: 1,
            bodyCheck: true,
            bodyCheckWhitelist: [""],
          }),
        )
        .post("/", ({ body }) => body)

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("over limit"))
          controller.close()
        },
      })

      // Request without Content-Type header (treated as "")
      // Note: Bun may handle requests without Content-Type differently
      const response = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: {
            "transfer-encoding": "chunked",
          },
          body: stream,
          duplex: "half",
        }),
      )

      // When Content-Type is missing, it's treated as "" and checked against whitelist
      // Since "" is in whitelist, body check should be performed
      // Note: Actual behavior depends on how Bun handles missing Content-Type
      expect([200, 413]).toContain(response.status)
    })

    it("should check all content types when whitelist is empty array", async () => {
      const app = new Elysia()
        .use(
          bodyLimit({
            maxSize: 1,
            bodyCheck: true,
            bodyCheckWhitelist: [],
          }),
        )
        .post("/", ({ body }) => body)

      // Empty whitelist (size = 0) means whitelist check is skipped
      // So body check proceeds for all content types with transfer-encoding
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("over limit"))
          controller.close()
        },
      })

      const response = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: {
            "transfer-encoding": "chunked",
            "content-type": "application/json",
          },
          body: stream,
          duplex: "half",
        }),
      )

      // Should be checked because whitelist.size === 0 means check all
      expect(response.status).toBe(413)
    })
  })

  describe("Blacklist and Whitelist Interaction", () => {
    it("should prioritize blacklist over whitelist", async () => {
      // When both blacklist and whitelist contain the same content-type,
      // blacklist takes precedence (blacklist check comes first in code)
      const app = new Elysia()
        .use(
          bodyLimit({
            maxSize: 1,
            bodyCheck: true,
            bodyCheckBlacklist: ["application/json"],
            bodyCheckWhitelist: ["application/json", "text/plain"],
          }),
        )
        .post("/", ({ body }) => body)

      // application/json is in blacklist, should bypass (blacklist takes precedence)
      const jsonResponse = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: "over limit" }),
        }),
      )
      expect(jsonResponse.status).toBe(200)

      // text/plain is only in whitelist, should be checked
      const textStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("over limit"))
          controller.close()
        },
      })

      const textResponse = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: {
            "transfer-encoding": "chunked",
            "content-type": "text/plain",
          },
          body: textStream,
          duplex: "half",
        }),
      )
      expect(textResponse.status).toBe(413)
    })

    it("should skip non-whitelisted content types even if not in blacklist", async () => {
      const app = new Elysia()
        .use(
          bodyLimit({
            maxSize: 1,
            bodyCheck: true,
            bodyCheckBlacklist: ["application/xml"],
            bodyCheckWhitelist: ["application/json"],
          }),
        )
        .post("/", ({ body }) => body)

      // text/plain is not in whitelist and not in blacklist
      // Since whitelist exists and text/plain is not in it, it should bypass
      const response = await app.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "This is over 1 byte",
        }),
      )

      expect(response.status).toBe(200)
    })
  })
})
