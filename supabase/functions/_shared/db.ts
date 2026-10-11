import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient, Database } from '@supabase/supabase-js';

// ... imports existentes ...

export class DatabaseService {
  private supabase: SupabaseClient<Database>;

  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }

  /**
   * Fetches records in pages with deterministic ordering to prevent data loss/duplication.
   * @param table The table name
   * @param columns Columns to select
   * @param from Start index for pagination
   * @param to End index for pagination
   * @param orderBy Optional specific order column. Defaults to 'id' if available, otherwise contract_id or similar.
   */
  async selectInPaged<T extends keyof Database['public']['Tables']>(
    table: T,
    columns: string[],
    from: number,
    to: number,
    orderBy?: keyof Database['public']['Tables'][T]['Row']
  ): Promise<{ data: Database['public']['Tables'][T]['Row'][] | null; error: Error | null }> {
    
    let query = this.supabase.from(table).select(columns.join(','));

    // Deterministic ordering is crucial for stable pagination under concurrent writes
    // If no specific order is provided, default to 'id' which is usually unique and indexed
    const orderColumn = orderBy || 'id';
    
    // Ensure we are ordering by a primary key or unique identifier to guarantee stability
    // For tables without 'id', fallback logic might be needed, but 'id' is standard in Supabase
    query = query.order(orderColumn as string, { ascending: true });

    const { data, error } = await query.range(from, to);

    if (error) {
      console.error(`Error fetching ${table} from ${from} to ${to}:`, error);
    }

    return { data, error };
  }

  /**
   * Reads group facts with paged support.
   */
  async readGroupFacts(groupId: string, pageSize: number = 1000): Promise<any[]> {
    let allFacts = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await this.selectInPaged(
        'facts',
        ['*'],
        offset,
        offset + pageSize - 1,
        'event_identity' // Use event_identity as tiebreaker if id is not sufficient or for specific business logic
      );

      if (error) throw error;
      
      if (!data || data.length === 0) {
        hasMore = false;
      } else {
        allFacts.push(...data);
        if (data.length < pageSize) {
          hasMore = false;
        } else {
          offset += pageSize;
        }
      }
    }

    return allFacts;
  }

  /**
   * Reads group state with paged support.
   */
  async readGroupState(groupId: string, pageSize: number = 1000): Promise<any[]> {
    let allStates = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await this.selectInPaged(
        'states',
        ['*'],
        offset,
        offset + pageSize - 1,
        'position' // Use position as tiebreaker
      );

      if (error) throw error;

      if (!data || data.length === 0) {
        hasMore = false;
      } else {
        allStates.push(...data);
        if (data.length < pageSize) {
          hasMore = false;
        } else {
          offset += pageSize;
        }
      }
    }

    return allStates;
  }
  
  // ... other existing methods ...
}
