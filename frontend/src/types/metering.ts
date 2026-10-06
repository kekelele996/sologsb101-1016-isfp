/**
 * 外送计量单（MeteringTicket）—— 计量站端
 * 盐田外送卤水经过计量站时，按交接批次出具的计量凭证，
 * 写清交接批次号、体积与密度。首次计量与复测各出具一张：
 * 复测后密度一变，原计量单作废（行保留，两次计量都留痕），出卤单退回重算。
 */

/** 计量单状态：有效 / 已作废（复测密度变化后作废，行不删除） */
export type MeteringStatus = '有效' | '已作废';

export const METERING_STATUS_OPTIONS: MeteringStatus[] = ['有效', '已作废'];

/** 计量轮次：初测 / 复测 */
export type MeteringRound = '初测' | '复测';

export const METERING_ROUND_OPTIONS: MeteringRound[] = ['初测', '复测'];

export interface MeteringTicket {
  id: string
  /** 交接批次号（与调度端出卤单共同的对账主键） */
  handoverBatch: string
  /** 外送来源蒸发池（对账主键之二：池号） */
  pondId: string
  /** 计量日期 YYYY-MM-DD */
  measureDate: string
  /** 计量体积（m³，计量站实收） */
  volumeM3: number
  /** 计量密度（g/cm³，25 ℃ 折算口径） */
  densityGcm3: number
  /** 计量轮次：初测 / 复测 */
  round: MeteringRound
  /** 有效 / 已作废 */
  status: MeteringStatus
  /** 作废原因（复测密度变化时记录） */
  voidReason: string
  /** 复测取代的原计量单 id（仅复测单有值） */
  supersedesTicketId: string | null
  /** 升级补号：v3 迁移时按池号与日期补登记的交接批次号 */
  backfilledBatch: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建计量单 / 录入复测的表单草稿 */
export interface MeteringDraft {
  handoverBatch: string
  pondId: string
  measureDate: string
  volumeM3: number
  densityGcm3: number
}
