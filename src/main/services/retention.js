export function selectExpiredBackups(backups, keep = 10) {
  const limit = Math.max(1, Math.min(500, Number(keep) || 10));
  const sorted = [...(backups || [])].sort((a, b) => {
    const timeA = new Date(a.createdAt || a.timestamp || 0).getTime();
    const timeB = new Date(b.createdAt || b.timestamp || 0).getTime();
    return timeB - timeA;
  });
  return sorted.slice(limit);
}
