import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { loginSchema, type LoginInput } from "./types";
import { loginUser, logoutUser, getCurrentUser } from "./service";
import { ValidationError } from "../../lib/errors";

export const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * POST /auth/login — Interactive operator login.
   * Rate limited per IP+email with lockout backoff (s-30 policy class
   * `authLogin`: 5 attempts/min; enforced by the bespoke bucket in
   * `loginUser`, which keys on IP+email-hash so one user's lockout never
   * locks out other users behind the same NAT egress — stronger keying
   * than the generic route limiter, hence no route-level `max` here).
   */
  fastify.post<{ Body: LoginInput }>("/login", async (request, reply) => {
    const parseResult = loginSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError("Invalid login payload", parseResult.error.issues);
    }

    const { rawToken, user } = await loginUser({
      db: fastify.db,
      repos: fastify.repos,
      redisClient: fastify.redisClient,
      log: request.log,
      ip: request.ip || "127.0.0.1",
      userAgent: request.headers["user-agent"] ?? null,
      email: parseResult.data.email,
      password: parseResult.data.password,
    });

    const isLocalhost = Boolean(
      request.headers.host?.includes("localhost") ||
      request.headers.origin?.includes("localhost") ||
      request.headers.host?.includes("127.0.0.1") ||
      request.headers.origin?.includes("127.0.0.1")
    );
    const isSecure = !isLocalhost && (process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production");

    // Set httpOnly session cookie
    reply.setCookie("rr_session", rawToken, {
      path: "/",
      httpOnly: true,
      secure: isSecure,
      sameSite: "lax",
      maxAge: 12 * 60 * 60, // 12 hours in seconds
    });

    return reply.status(200).send({ user });
  });

  /**
   * POST /auth/logout — Revoke current session.
   */
  fastify.post(
    "/logout",
    { preHandler: [fastify.requireAuth] },
    async (request, reply) => {
      const sessionToken = request.cookies["rr_session"];

      await logoutUser({
        db: fastify.db,
        repos: fastify.repos,
        redisClient: fastify.redisClient,
        sessionToken,
      });

      const isLocalhost = Boolean(
        request.headers.host?.includes("localhost") ||
        request.headers.origin?.includes("localhost") ||
        request.headers.host?.includes("127.0.0.1") ||
        request.headers.origin?.includes("127.0.0.1")
      );
      const isSecure = !isLocalhost && (process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production");

      reply.clearCookie("rr_session", {
        path: "/",
        httpOnly: true,
        secure: isSecure,
        sameSite: "lax",
      });

      return reply.status(204).send();
    },
  );

  /**
   * GET /auth/me — Principal summary for authenticated session or API key.
   */
  fastify.get(
    "/me",
    { preHandler: [fastify.requireAuth] },
    async (request, reply) => {
      const me = await getCurrentUser({
        db: fastify.db,
        repos: fastify.repos,
        auth: request.auth!,
      });

      return reply.status(200).send(me);
    },
  );
};
