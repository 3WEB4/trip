/**
 * HTTP API and web UI.
 *
 *   GET  /                              comparison screen
 *   POST /api/hotel-price-comparisons   run synchronously (scripts, curl)
 *   POST /api/jobs                      queue a comparison, returns a job id
 *   GET  /api/jobs/:id                  job state, progress and result
 *   GET  /api/jobs                      recent jobs
 *   GET  /api/markets
 *   GET  /health
 *
 * Comparisons are executed one at a time: the attached Chrome is a single
 * shared resource and parallel market pages from one IP invite a block.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JobStore, QueueFullError, type Job } from '../jobs/jobStore.js';
import { runComparison } from '../pipeline.js';
import { isKnownMarket, listMarkets, DEFAULT_MARKETS } from '../markets/markets.js';
import { TripUrlParseError } from '../url/parseTripUrl.js';
import { logger } from '../util/logger.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

const requestSchema = z.object({
  tripUrl: z.string().url(),
  markets: z.array(z.string()).min(1).max(12).optional(),
  targetCurrency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional(),
  samples: z.number().int().min(1).max(5).optional(),
  baselineMarket: z.string().optional(),
  /** Replay saved responses; used by the demo mode and by regression checks. */
  fixturesDir: z.string().optional(),
});

type ComparisonRequest = z.infer<typeof requestSchema>;

export interface ServerOptions {
  /**
   * When set, every /api route requires `Authorization: Bearer <token>`.
   * The screen and /health stay open so the page can still be loaded.
   */
  apiToken?: string;
  /**
   * Forces every comparison to replay this fixture directory. Set
   * `DEMO_FIXTURES=<dir>` to run the UI without a browser.
   */
  fixturesDir?: string;
  /** Allow callers to choose their own fixture directory. Off by default. */
  allowClientFixtures?: boolean;
}

/** Normalizes a validated body into the arguments the pipeline takes. */
function toRunOptions(body: ComparisonRequest, options: ServerOptions): Parameters<typeof runComparison>[1] {
  const fixturesDir = options.fixturesDir ?? (options.allowClientFixtures ? body.fixturesDir : undefined);
  return {
    markets: (body.markets ?? DEFAULT_MARKETS).map((code) => code.toUpperCase()),
    targetCurrency: body.targetCurrency?.toUpperCase() ?? 'JPY',
    samples: body.samples ?? 1,
    baselineMarket: body.baselineMarket?.toUpperCase() ?? 'JP',
    ...(fixturesDir ? { fixturesDir } : {}),
  };
}

function unknownMarkets(markets: string[] | undefined): string[] {
  return (markets ?? []).map((code) => code.toUpperCase()).filter((code) => !isKnownMarket(code));
}

/** Jobs are returned as-is; the request holds nothing sensitive. */
function jobView(job: Job): Job {
  return job;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  const jobs = new JobStore(async (job, onProgress) =>
    runComparison(job.request.tripUrl, {
      ...toRunOptions(
        {
          tripUrl: job.request.tripUrl,
          markets: job.request.markets,
          targetCurrency: job.request.targetCurrency,
          samples: job.request.samples,
        },
        options,
      ),
      onProgress,
    }),
  );

  app.register(fastifyStatic, { root: PUBLIC_DIR, index: 'index.html' });

  // A comparison spends a real browser and a real IP, so a public deployment
  // should not let anonymous callers queue work.
  if (options.apiToken) {
    const expected = `Bearer ${options.apiToken}`;
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api/')) return;
      if (request.headers.authorization !== expected) {
        return reply.status(401).send({ error: 'unauthorized' });
      }
    });
  }

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
    /** Lets the UI say "demo data" instead of pretending the prices are live. */
    demoMode: Boolean(options.fixturesDir),
  }));

  /** Queued run. The UI uses this so the browser is never left hanging. */
  app.post('/api/jobs', async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    const unknown = unknownMarkets(parsed.data.markets);
    if (unknown.length > 0) return reply.status(400).send({ error: 'unknown_market', markets: unknown });

    // Fail fast on a bad URL rather than queueing work that cannot succeed.
    try {
      const { parseTripUrl } = await import('../url/parseTripUrl.js');
      parseTripUrl(parsed.data.tripUrl, { targetCurrency: parsed.data.targetCurrency ?? 'JPY' });
    } catch (error) {
      if (error instanceof TripUrlParseError) {
        return reply.status(400).send({ error: 'invalid_trip_url', message: error.message });
      }
      throw error;
    }

    try {
      const job = jobs.create({
        tripUrl: parsed.data.tripUrl,
        markets: (parsed.data.markets ?? DEFAULT_MARKETS).map((code) => code.toUpperCase()),
        targetCurrency: parsed.data.targetCurrency?.toUpperCase() ?? 'JPY',
        samples: parsed.data.samples ?? 1,
      });
      return reply.status(202).send(jobView(job));
    } catch (error) {
      if (error instanceof QueueFullError) {
        return reply.status(429).send({ error: 'queue_full', message: error.message });
      }
      throw error;
    }
  });

  app.get('/api/jobs', async () => ({ jobs: jobs.list().map(jobView) }));

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.status(404).send({ error: 'job_not_found' });
    return reply.send(jobView(job));
  });

  /** Synchronous run, kept for scripts and curl. */
  app.post('/api/hotel-price-comparisons', async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    const unknown = unknownMarkets(parsed.data.markets);
    if (unknown.length > 0) return reply.status(400).send({ error: 'unknown_market', markets: unknown });

    try {
      const result = await runComparison(parsed.data.tripUrl, toRunOptions(parsed.data, options));
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
  const serverOptions: ServerOptions = {
    ...(process.env.DEMO_FIXTURES ? { fixturesDir: process.env.DEMO_FIXTURES } : {}),
    ...(process.env.API_TOKEN ? { apiToken: process.env.API_TOKEN } : {}),
    allowClientFixtures: process.env.ALLOW_CLIENT_FIXTURES === '1',
  };

  if (!serverOptions.apiToken && host === '0.0.0.0') {
    logger.warn('API_TOKEN is not set — anyone who can reach this port can queue comparisons');
  }

  buildServer(serverOptions)
    .listen({ port, host })
    .then(() =>
      logger.info('api listening', {
        port,
        host,
        demoMode: Boolean(serverOptions.fixturesDir),
        authRequired: Boolean(serverOptions.apiToken),
      }),
    )
    .catch((error: Error) => {
      logger.error('failed to start api', { message: error.message });
      process.exitCode = 1;
    });
}
