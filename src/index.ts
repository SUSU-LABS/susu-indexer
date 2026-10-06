import { DB } from './db';

const logger = {
  error: (...args: unknown[]) => console.error(...args),
};

export class Indexer {
  #db: DB;

  constructor(db: DB) {
    this.#db = db;
  }

  async handleRequest() {
    try {
      // ... main indexing logic ...
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    } catch (error) {
      try {
        await this.#db.recordRunFailure('run-id', error);
      } catch (e) {
        logger.error('Failed to record run failure', e);
      }

      return new Response(JSON.stringify({ status: 'failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
