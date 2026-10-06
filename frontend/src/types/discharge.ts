/**
 * 出卤单（DischargeOrder）—— 调度端
 * 盐田外送卤水的交接凭证：调度端登记池号、计划外送日期、交接批次与计划体积，
 * 排下一批出卤时与计量站的外送计量单按「池号 + 交接批次」对账；
 * 计量站确认收货且密度对得上，出卤单才允许推进到「已出卤」。
 */

/** 出卤单状态：待排（排产中）/ 已出卤（对账通过、已交接） */
export type DischargeState = '待排' | '已出卤';

export const DISCHARGE_STATE_OPTIONS: DischargeState[] = ['待排', '已出卤'];

/**
 * 对账结论：
 * - none     尚未对账
 * - matched  计量站收货且密度对得上，可推送「已出卤」
 * - noTicket 找不到同池号、同交接批次的有效计量单
 * - density  计量单有效，但计量密度与出卤单登记密度对不上
 */
export type ReconcileVerdict = 'none' | 'matched' | 'noTicket' | 'density';

export const RECONCILE_BLOCK_REASON: Record<Exclude<ReconcileVerdict, 'none' | 'matched'>, string> = {
  noTicket: '计量站未登记同池号、同交接批次的有效计量单',
  density: '计量密度与出卤单密度对不上（超过交接容差）',
};

export interface DischargeOrder {
  id: string
  /** 外送来源蒸发池 */
  pondId: string
  /** 计划外送日期 YYYY-MM-DD（与计量日期对账的日期口径） */
  planDate: string
  /** 交接批次号（与计量站共同的对账主键之一） */
  handoverBatch: string
  /** 外送体积（m³，调度端计划量） */
  volumeM3: number
  /** 外送密度（g/cm³，调度端登记；对账时与计量密度比较） */
  densityGcm3: number
  /** 结算质量（t）= 体积 × 密度；复测作废后按新密度重算 */
  massTonnes: number
  /** 调度员 */
  operator: string
  /** 出卤单状态 */
  state: DischargeState
  /** 最近一次对账结论 */
  reconcileVerdict: ReconcileVerdict
  /** 已对账计量单 id（复测作废后清空，重新等待对账） */
  meteringTicketId: string | null
  /** 复测作废后按新密度重算的标记（重新对账通过后清除） */
  revisedAfterVoid: boolean
  /** 升级补号来源：v3 迁移时由旧的「已出卤」走水计划补号生成 */
  migratedFromSchedule: boolean
  /** 升级时对不上、需人工单列核对（如池号已不存在） */
  migrationIssue: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑出卤单的表单草稿 */
export interface DischargeDraft {
  pondId: string
  planDate: string
  handoverBatch: string
  volumeM3: number
  densityGcm3: number
  operator: string
  state: DischargeState
}
