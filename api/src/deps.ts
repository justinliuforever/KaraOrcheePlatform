import type { RequestHandler } from "express";
import type { Db } from "./db/client";
import type { CatalogStore } from "./storage";
import type { AuthVerifier } from "./auth";

export interface Deps {
  db?: Db;
  catalog?: CatalogStore;
  auth?: AuthVerifier;
}

type AsyncHandler = (
  ...args: Parameters<RequestHandler>
) => Promise<unknown> | unknown;

// Forwards async rejections to the error handler on both Express 4 and 5.
export function wrap(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
