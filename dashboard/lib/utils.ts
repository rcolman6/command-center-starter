export function generateId(): string {
  return 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}
