/**
 * Thin re-export and server launcher for backward compatibility with bun --watch.
 */
export * from "./app";
export * from "./server";
export * from "./lib/errors";
export * from "./lib/routes";

import { startServer } from "./server";

if (import.meta.main) {
  startServer();
}
