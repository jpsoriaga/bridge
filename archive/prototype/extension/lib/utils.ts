export function truncatePath(path: string, maxLength = 35): string {
  if (path.length <= maxLength) return path;
  const parts = path.split('/');
  if (parts.length > 2) {
    return `${parts[0]}/.../${parts[parts.length - 1]}`;
  }
  return `...${path.slice(-maxLength + 3)}`;
}
