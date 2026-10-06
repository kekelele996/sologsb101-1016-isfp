/**
 * 外送计量单状态管理（Solid 原生能力）
 * 用 createStore 维护计量站计量单；封装「按池号 + 交接批次对账出卤」与
 * 「复测登记（原单作废 / 出卤单退回待排按新密度重算）」两条核心事务。
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { MeteringDraft, MeteringTicket } from '../types/metering';
import {
  db,
  initDatabase,
  ROW_REVISION,
  markTicketReceived,
  putMeteringTicket,
  reconcileDischarge,
  registerRemeasure,
  removeMeteringTicket,
  resolveLegacyTicket,
  type RemeasureDraft,
  type RemeasureOutcome,
  type ReconcileOutcome,
} from '../utils/db';
import { generateBatchNo } from '../utils/metering';
import { nowIso, uuid } from '../utils/id';

/** 计量单台账筛选条件 */
export interface MeteringFilters {
  keyword: string;
  /** 有效 / 作废 / 未收货（未收货指有效但计量站尚未收货） */
  receipt: 'all' | '有效' | '作废' | '未收货';
  /** 只看待核实旧数据（legacyFlag !== ''） */
  legacyOnly: boolean;
}

const EMPTY_FILTERS: MeteringFilters = { keyword: '', receipt: 'all', legacyOnly: false };

interface MeteringState {
  rows: MeteringTicket[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

/** 一张计量单能否作为某出卤单的对账候选：有效、已收货、同池号、未被别的出卤单占用 */
export function isTicketCandidate(ticket: MeteringTicket, pondCode: string, scheduleId: string): boolean {
  return (
    ticket.status === '有效' &&
    ticket.received &&
    ticket.pondCode === pondCode &&
    (ticket.matchedScheduleId === '' || ticket.matchedScheduleId === scheduleId)
  );
}

/** 同一条复测链：originId 相同（首次单 originId 等于自身 id），按次数升序 */
export function ticketChain(rows: MeteringTicket[], ticket: MeteringTicket): MeteringTicket[] {
  const originId = ticket.originId || ticket.id;
  return rows
    .filter((row) => (row.originId || row.id) === originId)
    .sort((a, b) => a.measureRound - b.measureRound || a.measureDate.localeCompare(b.measureDate));
}

function createMeteringStore() {
  const [state, setState] = createStore<MeteringState>({
    rows: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [filters, setFilters] = createSignal<MeteringFilters>({ ...EMPTY_FILTERS });

  // 同 scheduleStore：建库必须放在 querier 外，否则 liveQuery 采集不到可观测性集合。
  void initDatabase();

  liveQuery(async () => db.meteringTickets.toArray()).subscribe({
    next: (list) => {
      const sorted = [...list].sort(
        (a, b) =>
          b.measureDate.localeCompare(a.measureDate) ||
          b.measureRound - a.measureRound ||
          a.batchNo.localeCompare(b.batchNo),
      );
      setState('rows', sorted);
      setState('loading', false);
      setState('error', '');
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取外送计量单失败' });
    },
  });

  function patchFilters(patch: Partial<MeteringFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  /** 登记计量站外送计量单；批次号留空时按 池号 + 计量日期 + 首次 自动生成 */
  async function createTicket(draft: MeteringDraft): Promise<MeteringTicket> {
    const stamp = nowIso();
    const pondCode = draft.pondCode.trim() || '未知池';
    const row: MeteringTicket = {
      id: uuid('ticket'),
      batchNo: draft.batchNo.trim() || generateBatchNo(draft.measureDate, pondCode, draft.measureRound || 1),
      pondCode,
      pondId: draft.pondId,
      measureDate: draft.measureDate,
      volumeM3: draft.volumeM3,
      densityGcm3: draft.densityGcm3,
      received: draft.received,
      measureRound: draft.measureRound || 1,
      status: draft.status,
      supersededById: '',
      originId: '',
      matchedScheduleId: '',
      legacyFlag: '',
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    row.originId = row.id;
    await putMeteringTicket(row);
    setState('lastMessage', `已登记计量单：${row.batchNo}（${row.densityGcm3} g/cm³）`);
    return row;
  }

  async function updateTicket(ticketId: string, draft: MeteringDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === ticketId);
    if (existing === undefined) return;
    await putMeteringTicket({
      ...existing,
      batchNo: draft.batchNo.trim() || existing.batchNo,
      pondCode: draft.pondCode.trim() || existing.pondCode,
      pondId: draft.pondId,
      measureDate: draft.measureDate,
      volumeM3: draft.volumeM3,
      densityGcm3: draft.densityGcm3,
      received: draft.received,
      measureRound: draft.measureRound,
      status: draft.status,
      note: draft.note.trim(),
    });
    setState('lastMessage', '计量单已更新');
  }

  async function deleteTicket(ticketId: string): Promise<void> {
    await removeMeteringTicket(ticketId);
    setState('lastMessage', '计量单已删除（作废场景建议改用「登记复测」，原单会保留）');
  }

  async function setReceived(ticketId: string, received: boolean): Promise<void> {
    await markTicketReceived(ticketId, received);
    setState('lastMessage', received ? '已标记计量站收货，可以参与对账' : '已取消收货标记');
  }

  async function reconcile(scheduleId: string, ticketId: string): Promise<ReconcileOutcome> {
    const result = await reconcileDischarge(scheduleId, ticketId);
    setState(
      'lastMessage',
      result.ok
        ? `对账通过：批次 ${result.batchNo}，密度 ${result.densityGcm3} g/cm³，出卤单已推到「已出卤」`
        : `对账未通过：${result.reason}`,
    );
    return result;
  }

  async function remeasure(originalId: string, draft: RemeasureDraft): Promise<RemeasureOutcome | { error: string }> {
    const result = await registerRemeasure(originalId, draft);
    if ('error' in result) {
      setState('lastMessage', `复测登记失败：${result.error}`);
      return result;
    }
    setState(
      'lastMessage',
      `复测单已登记（第 ${result.newTicket.measureRound} 次计量，批次沿用 ${result.newTicket.batchNo}），原单作废` +
        (result.returnedCount > 0 ? `；${result.returnedCount} 张出卤单退回「待排」并按新密度重算` : ''),
    );
    return result;
  }

  async function resolveLegacy(ticketId: string, pondId: string, batchNo: string): Promise<boolean> {
    const result = await resolveLegacyTicket(ticketId, pondId, batchNo);
    if (result.ok) {
      setState('lastMessage', '旧数据已核实，批次号补齐，计量单转入正常台账');
    } else {
      setState('lastMessage', `核实失败：${result.reason}`);
    }
    return result.ok;
  }

  return {
    state,
    filters,
    patchFilters,
    resetFilters,
    setMessage,
    createTicket,
    updateTicket,
    deleteTicket,
    setReceived,
    reconcile,
    remeasure,
    resolveLegacy,
  };
}

const store = createRoot(createMeteringStore);

export function useMeteringStore() {
  return store;
}
