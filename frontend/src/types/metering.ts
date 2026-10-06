/**
 * 外送计量单（MeteringTicket）
 * 盐田外送卤水须经过计量站：计量站按「交接批次」出外送计量单，
 * 写清批次号、体积与密度；调度端凭池号 + 交接批次与出卤单对账。
 *
 * 复测导致密度变化时，原计量单只作废弃（status = '作废'），
 * 不删除、不改原密度；另开一张复测计量单（复测次数 +1，批次号沿用原批次），
 * 两次计量全部保留。
 */

/** 计量单状态：有效（可用于对账）/ 作废（复测后被新单替代） */
export type MeteringStatus = '有效' | '作废';

export const METERING_STATUS_OPTIONS: MeteringStatus[] = ['有效', '作废'];

export interface MeteringTicket {
  id: string
  /** 交接批次号，如 JL-20261006-北-03-01；旧数据补号以 B 打头 */
  batchNo: string
  /** 计量收货池号（调度端按池号对账；历史旧数据可能对不上现存池） */
  pondCode: string
  /** 若能与现存蒸发池对应则记录其 id，供同池过滤；对不上时为空串 */
  pondId: string
  /** 计量日期 YYYY-MM-DD（旧数据补号即按此日期补批次） */
  measureDate: string
  /** 计量体积（m³） */
  volumeM3: number
  /** 计量密度（g/cm³） */
  densityGcm3: number
  /** 计量站是否已收货：只有收了货的计量单才能参与对账出卤 */
  received: boolean
  /** 第几次计量：首次为 1，复测为 2、3…… */
  measureRound: number
  /** 单据状态：有效 / 作废 */
  status: MeteringStatus
  /** 被哪张复测单替代（仅作废单有值） */
  supersededById: string
  /** 首次计量单 id（复测链同源；首次单等于自身 id） */
  originId: string
  /** 已对账的出卤单 id（一张计量单最多对一张出卤单） */
  matchedScheduleId: string
  /**
   * 旧数据补号标记：
   * 空串 = 升级后登记的新计量单；
   * 'backfilled' = v3 升级按池号 + 日期自动补上交接批次；
   * 'unmatched' = 旧数据对不上现存出卤单，单列待核实。
   */
  legacyFlag: '' | 'backfilled' | 'unmatched'
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑计量单的表单草稿 */
export interface MeteringDraft {
  batchNo: string
  pondCode: string
  pondId: string
  measureDate: string
  volumeM3: number
  densityGcm3: number
  received: boolean
  measureRound: number
  status: MeteringStatus
  note: string
}
