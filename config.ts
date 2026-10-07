export async function loadConfig() {
  const requiredVars = ['TASK_SECRET', 'API_KEY', 'DATABASE_URL'];
  const missing: string[] = [];
  
  for (const env of requiredVars) {
    if (!process.env[env]) {
      missing.push(env); // LEAK: unauthenticated callers see these names
    }
  }
  
  if (missing.length > 0) {
    throw new Error(`Missing config variables: ${missing.join(', ')}`);
  }
  
  return {
    taskSecret: process.env.TASK_SECRET,
    apiKey: process.env.API_KEY,
    databaseUrl: process.env.DATABASE_URL,
  };
}
<<<ENDFILE>>
