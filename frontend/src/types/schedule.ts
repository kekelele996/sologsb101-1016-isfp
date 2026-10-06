/**
 * 走水编排（Schedule，兼作调度端「出卤单」）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 *
 * 外送卤水对账规则：
 * - 调度端管蒸发池阶段与出卤单；计量站按交接批次出外送计量单（批次号 / 体积 / 密度）。
 * - 排下一批出卤时两边按「池号 + 交接批次」对账：计量站已收货且密度对得上，
 *   出卤单才允许推进到「已出卤」。
 * - 复测后密度变化、计量单作废时，用过它的出卤单退回「待排」，按新密度重算，
 *   交接批次号保留以便再次对账。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

export interface Schedule {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 计划走水日期 YYYY-MM-DD */
  planDate: string
  /** 目标密度（g/cm³） */
  targetDensity: number
  /** 计划量（m³） */
  volumeM3: number
  /** 调度员 */
  operator: string
  /** 走水状态 */
  state: ScheduleState
  /** 手工拖拽后的排序序号，越小越先走水 */
  orderIndex: number
  /**
   * 交接批次号（与计量站外送计量单对账用）。
   * 排下一批出卤时分配；复测退回待排时保留原批次，以便按新密度再次对账。
   * v2 旧数据在 v3 升级时按池号 + 日期补号，对不上的保持 null 单列。
   */
  batchNo: string | null
  /**
   * 对账通过的计量密度（g/cm³）。出卤单推进到「已出卤」时取自计量单；
   * 复测作废后出卤单退回待排，此字段清空，待按新密度重新对账。
   */
  dischargeDensity: number | null
  /** 当前（或最近一次）对账所用计量单 id；退回待排后保留作废单痕迹，重新对账则覆盖 */
  meteringTicketId: string | null
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿 */
export interface ScheduleDraft {
  pondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
  /** 交接批次号可手工预填，留空则在对账 / 出卤时处理 */
  batchNo: string | null
}
