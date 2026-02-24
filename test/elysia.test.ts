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

  it("should reject false content-length header with bodyCheck enabled", async () => {
    const app = new Elysia()
      .use(bodyLimit({ maxSize: 5, bodyCheck: true })) // 5 bytes limit
      .post("/", ({ body }) => body)

    const response = await app.handle(
      new Request("http://localhost/", {
        method: "POST",
        body: "This is too long",
        headers: { "content-type": "text/plain", "content-length": "1" },
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
    const app = new Elysia().use(bodyLimit({ strictContentLength: true })).post("/", () => "ok")

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
})
