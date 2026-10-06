/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：新增外送计量单表 meteringTickets；出水编排（出卤单）新增交接批次号等字段；
 *       旧数据按「池号 + 日期」补交接批次号，对不上的单列待核实。
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import type { MeteringTicket } from '../types/metering';
import { estimateEvapMm } from './brine';
import { DENSITY_MATCH_TOLERANCE, backfillBatchNo, densityMatches, scheduleDensityBasis } from './metering';
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
    this.version(2)
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

    // ---------- v3：外送计量对账 ----------
    // - 出卤单（schedules）新增 batchNo / dischargeDensity / meteringTicketId
    // - 新增 meteringTickets 表，[pondCode+batchNo] 复合索引支撑「池号 + 交接批次」对账
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, batchNo',
        meteringTickets:
          'id, batchNo, pondCode, pondId, measureDate, status, received, legacyFlag, [pondCode+batchNo]',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();

        // 迁移 1：出卤单补齐交接批次相关字段
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (!('batchNo' in row)) row.batchNo = null;
          if (!('dischargeDensity' in row)) row.dischargeDensity = null;
          if (!('meteringTicketId' in row)) row.meteringTicketId = null;
        });

        // 迁移 2：旧数据没登记交接批次 —— 已出卤的历史出卤单按「池号 + 日期」补号，
        // 并补录对应历史计量单；同池同日存在多张无法唯一对应时，计量单标记 unmatched 单列。
        const ponds = (await tx.table('ponds').toArray()) as Pond[];
        const pondById = new Map(ponds.map((pond) => [pond.id, pond]));
        const schedulesV3 = (await tx.table('schedules').toArray()) as Schedule[];
        const observationsV3 = (await tx.table('observations').toArray()) as Observation[];
        const doneList = schedulesV3.filter((row) => row.state === '已出卤');

        const keyCount = new Map<string, number>();
        for (const row of doneList) {
          const pond = pondById.get(row.pondId);
          if (pond === undefined) continue;
          const key = `${pond.code}@@${row.planDate}`;
          keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
        }
        const dupSeen = new Map<string, number>();
        const legacyTickets: MeteringTicket[] = [];

        for (const row of doneList) {
          const pond = pondById.get(row.pondId);
          // 池都对不上的历史单：批次号留空，由界面「待核实旧数据」分区单列
          if (pond === undefined) continue;
          const key = `${pond.code}@@${row.planDate}`;
          const ambiguous = (keyCount.get(key) ?? 0) > 1;
          let batchNo = backfillBatchNo(row.planDate, pond.code);
          if (ambiguous) {
            const seen = (dupSeen.get(key) ?? 0) + 1;
            dupSeen.set(key, seen);
            batchNo = `${batchNo}-DUP${seen}`;
          }
          const pondObs = observationsV3
            .filter((obs) => obs.pondId === row.pondId && obs.date <= row.planDate)
            .sort((a, b) => a.date.localeCompare(b.date));
          const fallbackObs = observationsV3
            .filter((obs) => obs.pondId === row.pondId)
            .sort((a, b) => a.date.localeCompare(b.date));
          const density =
            pondObs.length > 0
              ? pondObs[pondObs.length - 1].densityGcm3
              : fallbackObs.length > 0
                ? fallbackObs[fallbackObs.length - 1].densityGcm3
                : row.targetDensity;

          const ticketId = `ticket-legacy-${row.id}`;
          legacyTickets.push({
            id: ticketId,
            batchNo,
            pondCode: pond.code,
            pondId: pond.id,
            measureDate: row.planDate,
            volumeM3: row.volumeM3,
            densityGcm3: density,
            received: true,
            measureRound: 1,
            status: '有效',
            supersededById: '',
            originId: ticketId,
            matchedScheduleId: ambiguous ? '' : row.id,
            legacyFlag: ambiguous ? 'unmatched' : 'backfilled',
            note: ambiguous
              ? 'v3 升级按池号+日期补号：同池同日存在多张已出卤单，无法唯一对应，待人工核实'
              : 'v3 升级按池号+日期补录的历史计量单',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          });

          await tx.table('schedules').update(row.id, {
            batchNo,
            dischargeDensity: density,
            meteringTicketId: ambiguous ? null : ticketId,
            updatedAt: stamp,
          });
        }

        if (legacyTickets.length > 0) {
          await tx.table('meteringTickets').bulkPut(legacyTickets);
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

/** 删除蒸发池，并级联清理相关闸门、观测、化验与走水计划；计量单保留但标记池对不上 */
export async function removePond(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.meteringTickets],
    async () => {
      const gates = await db.gates.toArray();
      const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
      if (related.length > 0) await db.gates.bulkDelete(related);
      await db.observations.where('pondId').equals(id).delete();
      await db.assays.where('pondId').equals(id).delete();
      await db.schedules.where('pondId').equals(id).delete();
      // 计量凭证不能物理删除：解除与现存池的关联，池号文本保留，进入「对不上」待核实
      await db.meteringTickets.where('pondId').equals(id).modify({ pondId: '', updatedAt: nowIso() });
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

/* ------------------------------ 走水编排 / 出卤单 ------------------------------ */

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
 * 出卤回写（对账通过后在事务内调用）：
 * 把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到计量密度。
 */
async function applyDischargeWriteback(schedule: Schedule, meteredDensity: number): Promise<void> {
  const pond = await db.ponds.get(schedule.pondId);
  if (!pond) return;
  const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
  await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
  const list = await db.observations.where('pondId').equals(pond.id).toArray();
  if (list.length === 0) return;
  const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
  const density = meteredDensity > 0 ? meteredDensity : latest.densityGcm3;
  await db.observations.update(latest.id, {
    densityGcm3: density,
    evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
    updatedAt: nowIso(),
  });
}

/** 推进走水状态；注意：「走水中 → 已出卤」必须走计量对账，不允许直接推进 */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState): Promise<void> {
  if (next === '已出卤') {
    throw new Error('外送出卤必须凭计量站有效计量单在「外送计量对账」页完成对账');
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* ------------------------------ 外送计量单 ------------------------------ */

export async function listMeteringTickets(): Promise<MeteringTicket[]> {
  const rows = await db.meteringTickets.toArray();
  return rows.sort((a, b) => b.measureDate.localeCompare(a.measureDate) || b.measureRound - a.measureRound);
}

export async function putMeteringTicket(row: MeteringTicket): Promise<void> {
  await db.meteringTickets.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/**
 * 删除计量单（仅限误登；复测作废应走「登记复测」以保留记录）。
 * 若已有出卤单引用该单，清空引用指针，避免台账悬挂引用。
 */
export async function removeMeteringTicket(id: string): Promise<void> {
  await db.transaction('rw', db.meteringTickets, db.schedules, async () => {
    const linked = await db.schedules.toArray();
    for (const schedule of linked) {
      if (schedule.meteringTicketId === id) {
        await db.schedules.update(schedule.id, { meteringTicketId: null, updatedAt: nowIso() });
      }
    }
    await db.meteringTickets.delete(id);
  });
}

/** 计量站收货 / 取消收货标记（只有已收货的计量单才能对账出卤） */
export async function markTicketReceived(id: string, received: boolean): Promise<void> {
  await db.meteringTickets.update(id, { received, updatedAt: nowIso() });
}

export type ReconcileOutcome =
  | { ok: true; ticketId: string; batchNo: string; densityGcm3: number }
  | { ok: false; reason: string };

/**
 * 按「池号 + 交接批次」对账并出卤：
 * 计量站已收货、批次一致、池号一致、密度对得上（容差 ±0.002）才把出卤单推到「已出卤」。
 * 同事务内：出卤单回写批次号 / 计量密度、池阶段推进、计量单占用对账出卤单。
 */
export async function reconcileDischarge(scheduleId: string, ticketId: string): Promise<ReconcileOutcome> {
  return db.transaction('rw', db.schedules, db.meteringTickets, db.ponds, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return { ok: false, reason: '出卤单不存在或已被删除' };
    const ticket = await db.meteringTickets.get(ticketId);
    if (!ticket) return { ok: false, reason: '计量单不存在或已被删除' };
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return { ok: false, reason: '蒸发池已不存在，无法对账' };

    if (ticket.status !== '有效') return { ok: false, reason: '该计量单已作废，不能用于对账' };
    if (!ticket.received) return { ok: false, reason: '计量站尚未收货，不能对账出卤' };
    if (ticket.matchedScheduleId !== '' && ticket.matchedScheduleId !== scheduleId) {
      return { ok: false, reason: '该计量单已被另一张出卤单占用' };
    }
    if (schedule.batchNo !== null && schedule.batchNo !== '' && schedule.batchNo !== ticket.batchNo) {
      return { ok: false, reason: `交接批次不一致：出卤单 ${schedule.batchNo} / 计量单 ${ticket.batchNo}` };
    }
    if (pond.code !== ticket.pondCode) {
      return { ok: false, reason: `池号不一致：调度端 ${pond.code} / 计量站 ${ticket.pondCode}` };
    }
    const basis = scheduleDensityBasis(schedule);
    if (!densityMatches(basis, ticket.densityGcm3)) {
      return {
        ok: false,
        reason: `密度对不上：出卤单 ${basis} / 计量 ${ticket.densityGcm3} g/cm³，相差 ${Math.abs(
          Math.round((ticket.densityGcm3 - basis) * 10000) / 10000,
        )}，超过容差 ±${DENSITY_MATCH_TOLERANCE}`,
      };
    }

    const stamp = nowIso();
    await db.schedules.update(scheduleId, {
      state: '已出卤',
      batchNo: ticket.batchNo,
      dischargeDensity: ticket.densityGcm3,
      meteringTicketId: ticket.id,
      updatedAt: stamp,
    });
    await applyDischargeWriteback({ ...schedule, batchNo: ticket.batchNo }, ticket.densityGcm3);
    await db.meteringTickets.update(ticketId, { matchedScheduleId: scheduleId, updatedAt: stamp });

    return { ok: true, ticketId: ticket.id, batchNo: ticket.batchNo, densityGcm3: ticket.densityGcm3 };
  });
}

export interface RemeasureDraft {
  measureDate: string;
  densityGcm3: number;
  volumeM3: number;
  note: string;
}

export interface RemeasureOutcome {
  newTicket: MeteringTicket;
  /** 因计量单作废而退回「待排」的出卤单数量 */
  returnedCount: number;
}

/**
 * 复测登记：复测后密度一变，原计量单作废（不删除、不改原密度），
 * 另开一张复测计量单（交接批次沿用、次数 +1，两次计量都保留）；
 * 用过原计量单、已推到「已出卤」的出卤单退回「待排」，按新密度重算（目标密度改为新密度），
 * 交接批次号保留，待重新对账。
 */
export async function registerRemeasure(originalId: string, draft: RemeasureDraft): Promise<RemeasureOutcome | { error: string }> {
  return db.transaction('rw', db.meteringTickets, db.schedules, async () => {
    const original = await db.meteringTickets.get(originalId);
    if (!original) return { error: '原计量单不存在' };
    if (original.status !== '有效') return { error: '原计量单已作废，不能再次复测，请沿复测链找到最新有效单' };
    if (!Number.isFinite(draft.densityGcm3) || draft.densityGcm3 <= 0) return { error: '复测密度不合法' };

    const stamp = nowIso();
    const newTicket: MeteringTicket = {
      id: uuid('ticket'),
      batchNo: original.batchNo,
      pondCode: original.pondCode,
      pondId: original.pondId,
      measureDate: draft.measureDate,
      volumeM3: draft.volumeM3 > 0 ? draft.volumeM3 : original.volumeM3,
      densityGcm3: draft.densityGcm3,
      received: true,
      measureRound: original.measureRound + 1,
      status: '有效',
      supersededById: '',
      originId: original.originId || original.id,
      matchedScheduleId: '',
      legacyFlag: '',
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.meteringTickets.put(newTicket);
    await db.meteringTickets.update(original.id, { status: '作废', supersededById: newTicket.id, updatedAt: stamp });

    // 用过原计量单的出卤单退回待排、按新密度重算；批次号保留，作废单痕迹保留
    // meteringTicketId 未建索引，全表读出后在事务内过滤
    const all = await db.schedules.toArray();
    const used = all.filter((item) => item.meteringTicketId === original.id);
    let returnedCount = 0;
    for (const schedule of used) {
      if (schedule.state !== '已出卤') continue;
      await db.schedules.update(schedule.id, {
        state: '待排',
        targetDensity: draft.densityGcm3,
        dischargeDensity: null,
        // meteringTicketId 保留为作废单 id，界面可据此提示「复测退回」
        batchNo: schedule.batchNo ?? original.batchNo,
        updatedAt: stamp,
      });
      returnedCount += 1;
    }

    return { newTicket, returnedCount };
  });
}

/**
 * 核实单列的旧数据：人工选定现存蒸发池并确认 / 修正交接批次号后，
 * 计量单脱离待核实分区，按正常计量单参与对账。
 */
export async function resolveLegacyTicket(
  ticketId: string,
  pondId: string,
  batchNo: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const ticket = await db.meteringTickets.get(ticketId);
  if (!ticket) return { ok: false, reason: '计量单不存在' };
  const pond = await db.ponds.get(pondId);
  if (!pond) return { ok: false, reason: '选定的蒸发池不存在' };
  const normalized = batchNo.trim();
  if (normalized === '') return { ok: false, reason: '交接批次号不能为空' };
  const occupied = await db.meteringTickets
    .where('[pondCode+batchNo]')
    .equals([pond.code, normalized])
    .first();
  if (occupied && occupied.id !== ticket.id) {
    return { ok: false, reason: `池号 + 批次号已被计量单 ${occupied.id} 占用` };
  }
  await db.meteringTickets.update(ticketId, {
    pondId: pond.id,
    pondCode: pond.code,
    batchNo: normalized,
    legacyFlag: '',
    updatedAt: nowIso(),
  });
  return { ok: true };
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
  meteringTickets: MeteringTicket[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, meteringTickets] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.meteringTickets.toArray(),
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
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.meteringTickets],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.meteringTickets.clear(),
      ]);
      await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
      // 兼容 v2 存档：补齐交接批次相关字段
      await db.schedules.bulkPut(
        snapshot.schedules.map((row) => ({
          ...row,
          batchNo: row.batchNo ?? null,
          dischargeDensity: row.dischargeDensity ?? null,
          meteringTicketId: row.meteringTicketId ?? null,
          revision: ROW_REVISION,
        })),
      );
      // 兼容缺少计量单数组的旧存档
      const tickets = snapshot.meteringTickets ?? [];
      await db.meteringTickets.bulkPut(tickets.map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.meteringTickets],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.meteringTickets.clear(),
      ]);
    },
  );
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, meteringTickets] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
    db.meteringTickets.count(),
  ]);
  return { ponds, gates, observations, assays, schedules, meteringTickets };
}
