import type { SupabaseClient } from '@supabase/supabase-js';

export async function batchUpsert<T>(
  supabase: SupabaseClient,
  table: string,
  rows: T[],
  batchSize: number
): Promise<void> {
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).upsert(chunk);
    if (error) {
      throw new Error(`Batch upsert failed on table ${table}: ${error.message}`);
    }
  }
}

export { batchUpsert };
