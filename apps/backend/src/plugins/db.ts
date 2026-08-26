import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import {
  db,
  withTransaction,
  healthCheck,
  end,
  type Database,
  type Tx,
  type RepoContext,
} from "@repo/db";
import * as repos from "@repo/db";

export type Repositories = typeof repos;

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    repos: Repositories;
    withTransaction: typeof withTransaction;
    dbHealthCheck: typeof healthCheck;
    closeDb: typeof end;
  }
}

export interface DbPluginOptions {
  customDb?: Database;
  customRepos?: Repositories;
  customHealthCheck?: () => Promise<boolean>;
}

const dbPluginCallback: FastifyPluginAsync<DbPluginOptions> = async (
  fastify,
  opts,
) => {
  const activeDb = opts.customDb ?? db;
  const activeRepos = opts.customRepos ?? repos;
  const activeHealthCheck = opts.customHealthCheck ?? healthCheck;

  fastify.decorate("db", activeDb);
  fastify.decorate("repos", activeRepos);
  fastify.decorate("withTransaction", withTransaction);
  fastify.decorate("dbHealthCheck", activeHealthCheck);
  fastify.decorate("closeDb", end);
};

export const dbPlugin = fp(dbPluginCallback, {
  name: "app-db",
  fastify: "5.x",
});
