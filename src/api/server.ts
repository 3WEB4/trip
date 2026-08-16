/**
 * HTTP API.
 *
 *   POST /api/hotel-price-comparisons   { tripUrl, markets, targetCurrency }
 *   GET  /api/markets
 *   GET  /health
 *
 * Comparisons run synchronously in this MVP: one browser, one request at a
 * time. The job queue (BullMQ) and result storage from the design belong in
 * front of `runComparison`, not inside it.
 */

import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runComparison } from '../pipeline.js';
import { isKnownMarket, listMarkets, DEFAULT_MARKETS } from '../markets/markets.js';
import { TripUrlParseError } from '../url/parseTripUrl.js';
import { logger } from '../util/logger.js';

const requestSchema = z.object({
  tripUrl: z.string().url(),
  markets: z.array(z.string()).min(1).max(12).optional(),
  targetCurrency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional(),
  samples: z.number().int().min(1).max(5).optional(),
  baselineMarket: z.string().optional(),
  /** Replay saved responses; handy for demos and regression checks. */
  fixturesDir: z.string().optional(),
});

/**
 * Only one browser-driven comparison runs at a time — the attached Chrome is a
 * single shared resource, and parallel tabs on the same IP invite a block.
 */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const lock = new Mutex();

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/api/markets', async () => ({
    markets: listMarkets().map(({ code, origin, locale, region, defaultCurrency }) => ({
      code,
      origin,
      locale,
      region,
      defaultCurrency,
    })),
    defaults: DEFAULT_MARKETS,
  }));

  app.post('/api/hotel-price-comparisons', async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    const body = parsed.data;
    const markets = (body.markets ?? DEFAULT_MARKETS).map((code) => code.toUpperCase());
    const unknown = markets.filter((code) => !isKnownMarket(code));
    if (unknown.length > 0) {
      return reply.status(400).send({ error: 'unknown_market', markets: unknown });
    }

    try {
      const result = await lock.run(() =>
        runComparison(body.tripUrl, {
          markets,
          targetCurrency: body.targetCurrency?.toUpperCase() ?? 'JPY',
          samples: body.samples ?? 1,
          baselineMarket: body.baselineMarket?.toUpperCase() ?? 'JP',
          ...(body.fixturesDir ? { fixturesDir: body.fixturesDir } : {}),
        }),
      );

      // A run where every market was blocked is not a 200.
      if (result.prices.length === 0) {
        return reply.status(502).send({ error: 'no_comparable_offer', result });
      }
      return reply.send(result);
    } catch (error) {
      if (error instanceof TripUrlParseError) {
        return reply.status(400).send({ error: 'invalid_trip_url', message: error.message });
      }
      logger.error('comparison failed', { message: (error as Error).message });
      return reply.status(500).send({ error: 'comparison_failed', message: (error as Error).message });
    }
  });

  return app;
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryPoint === import.meta.url || process.env.START_SERVER === '1') {
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  buildServer()
    .listen({ port, host })
    .then(() => logger.info('api listening', { port, host }))
    .catch((error: Error) => {
      logger.error('failed to start api', { message: error.message });
      process.exitCode = 1;
    });
}
