export function formatDuration(fromIso: string, to: Date = new Date()): string {
  const start = new Date(fromIso).getTime();
  if (Number.isNaN(start)) return "—";

  const diffMs = Math.max(0, to.getTime() - start);
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remH = hours % 24;
    return remH > 0 ? `${days}天${remH}小时` : `${days}天`;
  }
  if (hours > 0) {
    const remM = minutes % 60;
    return remM > 0 ? `${hours}小时${remM}分` : `${hours}小时`;
  }
  if (minutes > 0) return `${minutes}分钟`;
  return "刚刚";
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";

  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
