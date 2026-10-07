import { authorizeInvocation } from './auth';
import { loadConfig } from './config';

async function main() {
  // FIX: Check auth BEFORE returning config diagnostics
  
  // Step 1: Try to load config silently (no error details in response)
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    // Log the actual error server-side only
    console.error('[CONFIG ERROR]', err instanceof Error ? err.message : String(err));
    
    // Return generic error to unauthenticated callers
    throw new Error('Configuration error');
  }
  
  // Step 2: Authorize BEFORE returning any diagnostic info
  await authorizeInvocation(config);
  
  // Step 3: Now return config errors if any (only to authenticated users)
  try {
    config = await loadConfig();
  } catch (err) {
    throw err; // Authenticated users get actionable errors
  }
  
  // ... rest of handler
}
