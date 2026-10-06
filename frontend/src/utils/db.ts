/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：新增外送计量单 / 出卤单（计量站交接域），旧出卤数据按池号+日期补交接批次号，对不上的单列
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import type { DischargeOrder, ReconcileVerdict } from '../types/discharge';
import type { MeteringTicket, MeteringDraft } from '../types/metering';
import { estimateEvapMm } from './brine';
import { backfillBatchNo, densityMatches, handoverMassTonnes, reconcileOrder } from './metering';
import { nowIso, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;
  meteringTickets!: Table<MeteringTicket, string>;
  dischargeOrders!: Table<DischargeOrder, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：计量站交接域（外送计量单 + 出卤单），旧出卤数据补交接批次号 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
        meteringTickets: 'id, handoverBatch, pondId, measureDate, status, round, [pondId+handoverBatch]',
        dischargeOrders: 'id, pondId, planDate, handoverBatch, state, [pondId+handoverBatch]',
      })
      .upgrade(async (tx) => {
        // 迁移 5：旧数据没登记交接批次号，升级时按池号和日期为历史「已出卤」计划补号，
        // 并同步补出一张「有效」初测计量单（旧数据视同计量站已收货、密度对得上）；
        // 池号对不上（池已删除）的记录不造计量单、退回「待排」并 migrationIssue 单列。
        const ponds = await tx.table<Pond, string>('ponds').toArray();
        const pondMap = new Map(ponds.map((pond) => [pond.id, pond]));
        const stamp = nowIso();
        const legacySchedules = await tx.table<Schedule, string>('schedules').toArray();
        for (const schedule of legacySchedules) {
          if (schedule.state !== '已出卤') continue;
          const pond = pondMap.get(schedule.pondId);
          const batch = backfillBatchNo(pond?.code ?? '', schedule.planDate);
          const issue = pond === undefined ? '升级补号失败：该走水计划的池号已不存在，需人工核对' : '';
          const density = schedule.targetDensity;
          const orderId = `discharge-legacy-${schedule.id}`;
          const order: DischargeOrder = {
            id: orderId,
            pondId: schedule.pondId,
            planDate: schedule.planDate,
            handoverBatch: batch,
            volumeM3: schedule.volumeM3,
            densityGcm3: density,
            massTonnes: handoverMassTonnes(schedule.volumeM3, density),
            operator: schedule.operator,
            state: pond === undefined ? '待排' : '已出卤',
            reconcileVerdict: pond === undefined ? 'noTicket' : 'matched',
            meteringTicketId: pond === undefined ? null : `ticket-legacy-${schedule.id}`,
            revisedAfterVoid: false,
            migratedFromSchedule: true,
            migrationIssue: issue,
            createdAt: schedule.createdAt ?? stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          };
          await tx.table('dischargeOrders').put(order);
          if (pond !== undefined) {
            const ticket: MeteringTicket = {
              id: `ticket-legacy-${schedule.id}`,
              handoverBatch: batch,
              pondId: schedule.pondId,
              measureDate: schedule.planDate,
              volumeM3: schedule.volumeM3,
              densityGcm3: density,
              round: '初测',
              status: '有效',
              voidReason: '',
              supersedesTicketId: null,
              backfilledBatch: true,
              createdAt: schedule.createdAt ?? stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            };
            await tx.table('meteringTickets').put(ticket);
          }
        }
      });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验、走水计划与计量交接凭证 */
export async function removePond(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.meteringTickets, db.dischargeOrders],
    async () => {
      const gates = await db.gates.toArray();
      const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
      if (related.length > 0) await db.gates.bulkDelete(related);
      await db.observations.where('pondId').equals(id).delete();
      await db.assays.where('pondId').equals(id).delete();
      await db.schedules.where('pondId').equals(id).delete();
      await db.meteringTickets.where('pondId').equals(id).delete();
      await db.dischargeOrders.where('pondId').equals(id).delete();
      await db.ponds.delete(id);
    },
  );
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

export async function putGate(row: Gate): Promise<void> {
  await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 就地调整开度：同步推导闸门状态 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await db.gates.update(id, { openingPct, state, updatedAt: nowIso() });
}

export async function removeGate(id: string): Promise<void> {
  await db.gates.delete(id);
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
  const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const next: Observation = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    evapMm,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.observations.put(next);
  return next;
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeAssay(id: string): Promise<void> {
  await db.assays.delete(id);
}

/* ------------------------------ 走水编排 ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return;
    const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
    await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
    const list = await db.observations.where('pondId').equals(pond.id).toArray();
    if (list.length === 0) return;
    const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
    const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
    await db.observations.update(latest.id, {
      densityGcm3: density,
      evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
      updatedAt: nowIso(),
    });
  });
}

/** 推进走水状态 */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* ------------------------------ 外送计量单（计量站） ------------------------------ */

export async function listMeteringTickets(): Promise<MeteringTicket[]> {
  const rows = await db.meteringTickets.toArray();
  return rows.sort((a, b) => b.measureDate.localeCompare(a.measureDate) || a.handoverBatch.localeCompare(b.handoverBatch));
}

export async function putMeteringTicket(row: MeteringTicket): Promise<void> {
  await db.meteringTickets.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeMeteringTicket(id: string): Promise<void> {
  await db.meteringTickets.delete(id);
}

/**
 * 计量站登记初测计量单（按交接批次）。
 * 同池号 + 同交接批次只允许一张有效计量单：已存在有效单时拒绝，避免重复收货。
 */
export async function createMeteringTicket(draft: MeteringDraft): Promise<{ ok: boolean; message: string; ticket: MeteringTicket | null }> {
  const batch = draft.handoverBatch.trim();
  if (batch === '') return { ok: false, message: '交接批次号不能为空', ticket: null };
  return db.transaction('rw', db.meteringTickets, async () => {
    const duplicate = await db.meteringTickets
      .where('[pondId+handoverBatch]')
      .equals([draft.pondId, batch])
      .filter((row) => row.status === '有效')
      .first();
    if (duplicate !== undefined) {
      return { ok: false, message: `批次 ${batch} 已有有效计量单（${duplicate.round}，密度 ${duplicate.densityGcm3}）`, ticket: null };
    }
    const stamp = nowIso();
    const ticket: MeteringTicket = {
      id: uuid('ticket'),
      handoverBatch: batch,
      pondId: draft.pondId,
      measureDate: draft.measureDate,
      volumeM3: draft.volumeM3,
      densityGcm3: draft.densityGcm3,
      round: '初测',
      status: '有效',
      voidReason: '',
      supersedesTicketId: null,
      backfilledBatch: false,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.meteringTickets.put(ticket);
    return { ok: true, message: `已登记批次 ${batch} 初测计量单`, ticket };
  });
}

export interface RemeasureResult {
  ok: boolean
  message: string
  /** 复测后密度是否发生变化（变化才作废原单） */
  changed: boolean
  newTicket: MeteringTicket | null
  /** 因作废而退回「待排」重算的出卤单数量 */
  rolledBack: number
}

/**
 * 复测登记：复测后密度一变，原计量单作废，出具复测新单（两次计量都留着）；
 * 用过原计量单的出卤单退回「待排」、清空对账结果并按新密度重算结算质量。
 * 复测密度与原单在容差内视为未变化：不作废、不出新单。
 */
export async function registerRemeasurement(originalId: string, draft: MeteringDraft): Promise<RemeasureResult> {
  return db.transaction('rw', db.meteringTickets, db.dischargeOrders, db.ponds, db.observations, async () => {
    const original = await db.meteringTickets.get(originalId);
    if (original === undefined) return { ok: false, message: '原计量单不存在', changed: false, newTicket: null, rolledBack: 0 };
    if (original.status !== '有效') return { ok: false, message: '原计量单已作废，不能再复测', changed: false, newTicket: null, rolledBack: 0 };
    if (!densityMatches(original.densityGcm3, draft.densityGcm3)) {
      // 密度一变：原单作废（保留行），出具复测新单
      const stamp = nowIso();
      await db.meteringTickets.update(original.id, {
        status: '已作废',
        voidReason: `复测密度变化：${original.densityGcm3} → ${draft.densityGcm3}（${draft.measureDate}）`,
        updatedAt: stamp,
      });
      const nextTicket: MeteringTicket = {
        id: uuid('ticket'),
        handoverBatch: original.handoverBatch,
        pondId: original.pondId,
        measureDate: draft.measureDate,
        volumeM3: draft.volumeM3,
        densityGcm3: draft.densityGcm3,
        round: '复测',
        status: '有效',
        voidReason: '',
        supersedesTicketId: original.id,
        backfilledBatch: false,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      await db.meteringTickets.put(nextTicket);

      // 用过它的出卤单：退回「待排」、按新密度重算，留痕 revisedAfterVoid
      const linked = await db.dischargeOrders
        .where('[pondId+handoverBatch]')
        .equals([original.pondId, original.handoverBatch])
        .toArray();
      let rolledBack = 0;
      for (const order of linked) {
        if (order.meteringTicketId !== original.id) continue;
        rolledBack += 1;
        await db.dischargeOrders.update(order.id, {
          state: '待排',
          reconcileVerdict: 'none',
          meteringTicketId: null,
          densityGcm3: draft.densityGcm3,
          massTonnes: handoverMassTonnes(order.volumeM3, draft.densityGcm3),
          revisedAfterVoid: true,
          updatedAt: stamp,
        });
      }
      return {
        ok: true,
        changed: true,
        newTicket: nextTicket,
        rolledBack,
        message:
          rolledBack > 0
            ? `复测密度变化，原计量单已作废；${rolledBack} 张出卤单退回「待排」并按新密度 ${draft.densityGcm3} 重算`
            : `复测密度变化，原计量单已作废，复测单已出具（暂无关联出卤单受影响）`,
      };
    }
    return {
      ok: true,
      changed: false,
      newTicket: null,
      rolledBack: 0,
      message: `复测密度 ${draft.densityGcm3} 与初测 ${original.densityGcm3} 在容差内，原计量单继续有效`,
    };
  });
}

/* ------------------------------ 出卤单（调度端） ------------------------------ */

export async function listDischargeOrders(): Promise<DischargeOrder[]> {
  const rows = await db.dischargeOrders.toArray();
  return rows.sort((a, b) => b.planDate.localeCompare(a.planDate) || a.handoverBatch.localeCompare(b.handoverBatch));
}

export async function putDischargeOrder(row: DischargeOrder): Promise<void> {
  await db.dischargeOrders.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeDischargeOrder(id: string): Promise<void> {
  await db.dischargeOrders.delete(id);
}

/** 推进出卤时回写池阶段与最新观测密度（与走水出卤回写同一套口径） */
async function writeBackPondStage(pondId: string, actualDensity: number, stamp: string): Promise<void> {
  const pond = await db.ponds.get(pondId);
  if (pond === undefined) return;
  const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
  await db.ponds.update(pond.id, { stage: nextStage, updatedAt: stamp });
  const list = await db.observations.where('pondId').equals(pond.id).toArray();
  if (list.length === 0) return;
  const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
  const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
  await db.observations.update(latest.id, {
    densityGcm3: density,
    evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
    updatedAt: stamp,
  });
}

export interface ReconcileResult {
  ok: boolean
  message: string
  verdict: ReconcileVerdict
  ticketId: string | null
}

/**
 * 排下一批出卤时的对账动作：按池号和交接批次核对。
 * 计量站收了货（存在有效计量单）、密度对得上，出卤单才推到「已出卤」；
 * 否则不推进，并把拦截原因留在单上（缺计量单 / 密度不符）。
 */
export async function reconcileDischargeOrder(orderId: string): Promise<ReconcileResult> {
  return db.transaction('rw', db.dischargeOrders, db.meteringTickets, db.ponds, db.observations, async () => {
    const order = await db.dischargeOrders.get(orderId);
    if (order === undefined) return { ok: false, message: '出卤单不存在', verdict: 'none', ticketId: null };
    const tickets = await db.meteringTickets.toArray();
    const { verdict, ticket } = reconcileOrder(order, tickets);
    const stamp = nowIso();
    if (verdict !== 'matched' || ticket === null) {
      const reason = verdict === 'density'
        ? `密度对不上：出卤单 ${order.densityGcm3} vs 计量单 ${ticket?.densityGcm3 ?? '—'} g/cm³`
        : '计量站还没有同池号、同交接批次的有效计量单';
      await db.dischargeOrders.update(orderId, {
        reconcileVerdict: verdict,
        meteringTicketId: null,
        state: '待排',
        updatedAt: stamp,
      });
      return { ok: false, message: `对账未通过：${reason}，出卤单保持「待排」`, verdict, ticketId: null };
    }
    // 对得上：按计量密度结算并推送「已出卤」，回写池阶段
    const density = ticket.densityGcm3;
    await db.dischargeOrders.update(orderId, {
      state: '已出卤',
      reconcileVerdict: 'matched',
      meteringTicketId: ticket.id,
      densityGcm3: density,
      massTonnes: handoverMassTonnes(ticket.volumeM3, density),
      revisedAfterVoid: false,
      migrationIssue: '',
      updatedAt: stamp,
    });
    await writeBackPondStage(order.pondId, density, stamp);
    return {
      ok: true,
      message: `对账通过（批次 ${order.handoverBatch}，密度 ${density} g/cm³），出卤单已推到「已出卤」`,
      verdict: 'matched',
      ticketId: ticket.id,
    };
  });
}

/** 不推进状态，仅刷新对账结论（排下一批前的批量预检） */
export async function refreshDischargeVerdicts(): Promise<{ matched: number; blocked: number }> {
  return db.transaction('rw', db.dischargeOrders, db.meteringTickets, async () => {
    const [orders, tickets] = await Promise.all([db.dischargeOrders.toArray(), db.meteringTickets.toArray()]);
    const stamp = nowIso();
    let matched = 0;
    let blocked = 0;
    for (const order of orders) {
      if (order.state === '已出卤') continue;
      const { verdict } = reconcileOrder(order, tickets);
      if (verdict === order.reconcileVerdict) continue;
      await db.dischargeOrders.update(order.id, { reconcileVerdict: verdict, updatedAt: stamp });
      if (verdict === 'matched') matched += 1;
      else blocked += 1;
    }
    return { matched, blocked };
  });
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: Schedule[];
  /** v3 起：计量站外送计量单（旧存档缺省时视为空数组） */
  meteringTickets?: MeteringTicket[];
  /** v3 起：调度端出卤单（旧存档缺省时视为空数组） */
  dischargeOrders?: DischargeOrder[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, meteringTickets, dischargeOrders] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.meteringTickets.toArray(),
    db.dischargeOrders.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    ponds,
    gates,
    observations,
    assays,
    schedules,
    meteringTickets,
    dischargeOrders,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.meteringTickets, db.dischargeOrders],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.meteringTickets.clear(),
        db.dischargeOrders.clear(),
      ]);
      await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.schedules.bulkPut(snapshot.schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.meteringTickets.bulkPut((snapshot.meteringTickets ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.dischargeOrders.bulkPut((snapshot.dischargeOrders ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.meteringTickets, db.dischargeOrders],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.meteringTickets.clear(),
        db.dischargeOrders.clear(),
      ]);
    },
  );
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, meteringTickets, dischargeOrders] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
    db.meteringTickets.count(),
    db.dischargeOrders.count(),
  ]);
  return { ponds, gates, observations, assays, schedules, meteringTickets, dischargeOrders };
}
