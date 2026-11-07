import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { type ViewerData, ViewerReadError } from "./viewer-data.js";

const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/model.js", ["model.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

export function createViewerServer(data: ViewerData) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader("Referrer-Policy", "no-referrer");
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new ViewerReadError("not_listening", "Viewer is not listening.", 503);
      const host = `127.0.0.1:${address.port}`;
      if (
        request.headers.host !== host ||
        (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) ||
        (request.headers["sec-fetch-site"] !== undefined &&
          !["same-origin", "none"].includes(String(request.headers["sec-fetch-site"])))
      )
        throw new ViewerReadError(
          "origin_denied",
          "Only same-origin loopback inspection is allowed.",
          403,
        );
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        throw new ViewerReadError(
          "method_denied",
          "This viewer accepts read-only GET requests.",
          405,
        );
      }
      if ((request.url?.length ?? 0) > 2048)
        throw new ViewerReadError("request_limit", "Request URL is too long.", 414);
      const url = new URL(request.url ?? "/", `http://${host}`);
      const asset = ASSETS.get(url.pathname);
      if (asset) {
        const [filename, contentType] = asset;
        if (!filename || !contentType) throw new Error("Invalid bundled asset.");
        const bytes = await readFile(
          fileURLToPath(new URL(`../viewer/${filename}`, import.meta.url)),
        );
        response.writeHead(200, { "Content-Type": contentType });
        response.end(bytes);
        return;
      }
      const required = (keys: string[]) => {
        if (
          url.searchParams.size !== keys.length ||
          keys.some(
            (key) => !url.searchParams.get(key) || url.searchParams.getAll(key).length !== 1,
          )
        )
          throw new ViewerReadError(
            "invalid_query",
            "Supply exactly the required query parameters.",
          );
        return keys.map((key) => url.searchParams.get(key) ?? "");
      };
      if (url.pathname === "/api/history") {
        required([]);
        send(200, await data.history());
      } else if (url.pathname === "/api/run") {
        const [id = ""] = required(["run"]);
        send(200, await data.run(id));
      } else if (url.pathname === "/api/artifact") {
        const [id = "", stage = ""] = required(["run", "stage"]);
        send(200, await data.artifact(id, stage));
      } else if (url.pathname === "/api/receipt") {
        const [id = "", receipt = ""] = required(["run", "receipt"]);
        send(200, await data.receipt(id, receipt));
      } else throw new ViewerReadError("not_found", "Unknown viewer route.", 404);
    } catch (error: unknown) {
      // Do not leak local paths, raw records, or SDK cause chains to the browser.
      const known = error instanceof ViewerReadError;
      send(known ? error.status : 409, {
        error: {
          code: known ? error.code : "verification_failed",
          message: known
            ? error.message
            : "Stored data could not be read or verified. Check the retained store; it was not changed.",
        },
      });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  return server;
}
