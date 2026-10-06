/**
 * 外送计量对账工具（纯函数，便于单测与升级迁移复用）
 *
 * 业务规则：
 * - 计量站按交接批次出外送计量单（批次号、体积、密度）；
 * - 排下一批出卤时，调度端按「池号 + 交接批次」与计量站对账，
 *   计量站已收货、密度对得上，出卤单才推进到「已出卤」；
 * - 复测后密度变化，原计量单作废、复测单沿用批次号（次数 +1），两次计量都保留；
 * - v2 旧数据没有交接批次，升级时按池号 + 日期补号，对不上的单列。
 */
import type { MeteringTicket } from '../types/metering';
import type { Schedule } from '../types/schedule';

/** 密度对账容差（g/cm³）：|计量密度 − 出卤单密度| ≤ 0.002 视为对得上 */
export const DENSITY_MATCH_TOLERANCE = 0.002;

/** 体积对账容差比例：|计量体积 − 计划量| ≤ 2% 视为一致（非硬性拦截项） */
export const VOLUME_MATCH_TOLERANCE = 0.02;

/** 批次号日期段 / 补号前缀 */
export const BATCH_PREFIX = 'JL';
export const LEGACY_BATCH_PREFIX = 'B';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function compactDate(date: string): string {
  return date.replace(/-/g, '');
}

/**
 * 生成交接批次号：JL-YYYYMMDD-池号-次数（次数两位）。
 * 复测沿用同批次号：复测次数已经体现在计量单 measureRound 上，批次号保持不变。
 */
export function generateBatchNo(measureDate: string, pondCode: string, round = 1): string {
  return `${BATCH_PREFIX}-${compactDate(measureDate)}-${pondCode}-${pad2(round)}`;
}

/**
 * 旧数据补号：B-YYYYMMDD-池号（B 表示 backfilled 历史补号，区别于计量站正式批次）。
 */
export function backfillBatchNo(measureDate: string, pondCode: string): string {
  return `${LEGACY_BATCH_PREFIX}-${compactDate(measureDate)}-${pondCode}`;
}

/** 是否为升级补号批次（含对不上单列的待核实单） */
export function isLegacyBatchNo(batchNo: string): boolean {
  return batchNo.startsWith(`${LEGACY_BATCH_PREFIX}-`);
}

/** 卤水质量（t）= 体积(m³) × 密度(g/cm³ = t/m³) */
export function brineMassT(densityGcm3: number, volumeM3: number): number {
  if (!Number.isFinite(densityGcm3) || !Number.isFinite(volumeM3)) return 0;
  return Math.round(densityGcm3 * volumeM3 * 10) / 10;
}

/** 两张密度是否对得上（容差 DENSITY_MATCH_TOLERANCE；差值按 4 位小数舍入消除浮点误差） */
export function densityMatches(a: number, b: number, tolerance = DENSITY_MATCH_TOLERANCE): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const delta = Math.round(Math.abs(a - b) * 10000) / 10000;
  return delta <= tolerance;
}

/**
 * 出卤单参与对账的密度基准：
 * 已对账过取对账计量密度；尚未对账（含复测退回待排、按新密度重算后）取目标密度。
 */
export function scheduleDensityBasis(schedule: Pick<Schedule, 'dischargeDensity' | 'targetDensity'>): number {
  return typeof schedule.dischargeDensity === 'number' && schedule.dischargeDensity > 0
    ? schedule.dischargeDensity
    : schedule.targetDensity;
}

/** 池号 + 交接批次对账键（旧数据补号也复用此键） */
export function reconcileKey(pondCode: string, batchNo: string): string {
  return `${pondCode}@@${batchNo}`;
}

export interface ReconcileCheck {
  key: 'received' | 'batch' | 'pond' | 'density' | 'volume';
  label: string;
  /** 硬性项不通过则不能对账出卤；体积为辅助核对项，不拦截 */
  blocking: boolean;
  pass: boolean;
  detail: string;
}

export interface ReconcileResult {
  /** 硬性项（收货 / 批次 / 池号 / 密度）全部通过 */
  ok: boolean
  checks: ReconcileCheck[]
  /** 密度差（g/cm³），用于页面提示 */
  densityDelta: number
  /** 体积差比例（0–1），用于页面提示 */
  volumeDeltaRatio: number
}

/**
 * 按「池号 + 交接批次」对账：
 * 计量站收货、批次号一致、池号一致、密度对得上才允许把出卤单推到已出卤。
 * 出卤单批次号为空（待排新单 / 旧数据）时，将以所选计量单批次号指配，不拦截。
 */
export function evaluateReconcile(
  schedule: Pick<Schedule, 'batchNo' | 'targetDensity' | 'dischargeDensity' | 'volumeM3'>,
  pondCode: string,
  ticket: Pick<MeteringTicket, 'batchNo' | 'pondCode' | 'densityGcm3' | 'volumeM3' | 'received' | 'status'>,
): ReconcileResult {
  const basisDensity = scheduleDensityBasis(schedule);
  const densityDelta = Math.round((ticket.densityGcm3 - basisDensity) * 10000) / 10000;
  const volumeDeltaRatio =
    schedule.volumeM3 > 0 ? Math.abs(ticket.volumeM3 - schedule.volumeM3) / schedule.volumeM3 : 0;

  const batchPass = schedule.batchNo === null || schedule.batchNo === '' || schedule.batchNo === ticket.batchNo;
  const checks: ReconcileCheck[] = [
    {
      key: 'received',
      label: '计量站收货',
      blocking: true,
      pass: ticket.received,
      detail: ticket.received ? '计量站已收货' : '计量站尚未收货，不能对账',
    },
    {
      key: 'batch',
      label: '交接批次',
      blocking: true,
      pass: batchPass,
      detail:
        schedule.batchNo === null || schedule.batchNo === ''
          ? `出卤单未指配批次，将按 ${ticket.batchNo} 指配`
          : batchPass
            ? `批次一致：${ticket.batchNo}`
            : `批次不一致：出卤单 ${schedule.batchNo} / 计量单 ${ticket.batchNo}`,
    },
    {
      key: 'pond',
      label: '池号',
      blocking: true,
      pass: pondCode === ticket.pondCode,
      detail: pondCode === ticket.pondCode ? `池号一致：${pondCode}` : `池号不一致：调度 ${pondCode} / 计量 ${ticket.pondCode}`,
    },
    {
      key: 'density',
      label: '密度',
      blocking: true,
      pass: densityMatches(basisDensity, ticket.densityGcm3),
      detail: `出卤单 ${basisDensity} / 计量 ${ticket.densityGcm3} g/cm³，相差 ${Math.abs(densityDelta)}（容差 ±${DENSITY_MATCH_TOLERANCE}）`,
    },
    {
      key: 'volume',
      label: '体积核对',
      blocking: false,
      pass: volumeDeltaRatio <= VOLUME_MATCH_TOLERANCE,
      detail: `计划 ${schedule.volumeM3} / 计量 ${ticket.volumeM3} m³，偏差 ${(volumeDeltaRatio * 100).toFixed(1)}%`,
    },
  ];

  const ok = checks.every((check) => !check.blocking || check.pass);
  return { ok, checks, densityDelta, volumeDeltaRatio };
}
