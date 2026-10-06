import { createClient, SupabaseClient } from '@supabase/supabase-js';

export class DB {
  #client: SupabaseClient;

  constructor(url: string, key: string) {
    this.#client = createClient(url, key);
  }

  // ... other DB methods ...

  /**
   * Never throws
   */
  async recordRunFailure(runId: string, error: unknown): Promise<void> {
    try {
      await this.#client
        .from('run_failures')
        .insert({
          run_id: runId,
          error_message: typeof error === 'string' ? error : String(error),
          created_at: new Date().toISOString(),
        });
    } catch {
      // Guarantee never throws - transport/network errors are swallowed
      // Intentionally silent to preserve the outer 500 response contract
    }
  }
}
