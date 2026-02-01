export function grossFromNet(net: number): number {
  if (!Number.isFinite(net) || net <= 0) return 0;
  return Math.ceil(net / 0.7);
}

export const grossFromNetRobux = grossFromNet;

export function parseNetRobuxFromLotTitle(title: string): number | null {
  const m = title.replace(/\s+/g, " ").match(/(\d+)\s*(r\$|robux|робукс)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
