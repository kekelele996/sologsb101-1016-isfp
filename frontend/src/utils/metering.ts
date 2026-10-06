/**
 * 计量站交接规则工具
 * - 交接密度容差比对
 * - 结算质量（t）= 体积(m³) × 密度(g/cm³)
 * - 旧数据按池号 + 日期补交接批次号
 * - 出卤单 ↔ 外送计量单对账判定（按池号 + 交接批次）
 */
import type { DischargeOrder, ReconcileVerdict } from '../types/discharge';
import type { MeteringTicket } from '../types/metering';

/** 交接密度容差（g/cm³）：|计量密度 − 出卤密度| ≤ 容差视为「对得上」 */
export const DENSITY_HANDOVER_TOLERANCE = 0.005;

/** 质量保留 1 位小数（t） */
export function roundMassTonnes(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 结算质量（t）：1 m³ × 1 g/cm³ = 1 t */
export function handoverMassTonnes(volumeM3: number, densityGcm3: number): number {
  if (!Number.isFinite(volumeM3) || !Number.isFinite(densityGcm3)) return 0;
  return roundMassTonnes(volumeM3 * densityGcm3);
}

/** 两个密度是否在交接容差内对得上 */
export function densityMatches(a: number, b: number, tolerance: number = DENSITY_HANDOVER_TOLERANCE): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tolerance;
}

/**
 * 旧数据补交接批次号：按池号与日期补号。
 * 形如 BN-南-05-20260928（池号中的非字母数字汉字字符统一折成短横线）。
 */
export function backfillBatchNo(pondCode: string, date: string): string {
  const code = pondCode.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'UNKNOWN';
  const day = date.replace(/[^0-9]/g, '').slice(0, 8) || '00000000';
  return `BN-${code}-${day}`;
}

/** 找出与出卤单同池号、同交接批次的有效计量单（初测优先取最近一次） */
export function findActiveTicket(
  order: Pick<DischargeOrder, 'pondId' | 'handoverBatch'>,
  tickets: MeteringTicket[],
): MeteringTicket | null {
  const hits = tickets
    .filter(
      (ticket) =>
        ticket.status === '有效' &&
        ticket.pondId === order.pondId &&
        ticket.handoverBatch.trim() === order.handoverBatch.trim(),
    )
    .sort((a, b) => b.measureDate.localeCompare(a.measureDate) || b.updatedAt.localeCompare(a.updatedAt));
  return hits[0] ?? null;
}

/**
 * 对账判定：排下一批出卤时按池号和交接批次核对。
 * 计量站收了货（存在有效计量单）、密度对得上才 matched。
 */
export function reconcileOrder(
  order: Pick<DischargeOrder, 'pondId' | 'handoverBatch' | 'densityGcm3'>,
  tickets: MeteringTicket[],
): { verdict: ReconcileVerdict; ticket: MeteringTicket | null } {
  const ticket = findActiveTicket(order, tickets);
  if (ticket === null) return { verdict: 'noTicket', ticket: null };
  if (!densityMatches(order.densityGcm3, ticket.densityGcm3)) return { verdict: 'density', ticket };
  return { verdict: 'matched', ticket };
}

/** 对账结论的中文文案 */
export function verdictLabel(verdict: ReconcileVerdict): string {
  switch (verdict) {
    case 'matched':
      return '对账通过';
    case 'noTicket':
      return '缺计量单';
    case 'density':
      return '密度不符';
    default:
      return '未对账';
  }
}
