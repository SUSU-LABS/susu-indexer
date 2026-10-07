export async function authorizeInvocation(config: any) {
  // Auth depends on config.taskSecret
  if (config.taskSecret !== process.env.TASK_SECRET) {
    throw new Error('Unauthorized');
  }
}
