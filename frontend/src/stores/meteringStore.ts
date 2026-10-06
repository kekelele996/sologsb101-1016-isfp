/**
 * 外送计量单状态管理（计量站端，Solid 原生能力）
 * 用 createStore 维护计量单列表；支持初测登记、复测作废联动、删除。
 * 复测后密度一变：原计量单作废（行保留），用过它的出卤单在 db 事务里退回重算。
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { MeteringDraft, MeteringTicket } from '../types/metering';
import {
  createMeteringTicket,
  db,
  initDatabase,
  listMeteringTickets,
  refreshDischargeVerdicts,
  registerRemeasurement,
  removeMeteringTicket,
  type RemeasureResult,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';

export interface MeteringFilters {
  keyword: string;
  status: MeteringTicket['status'] | 'all';
  round: MeteringTicket['round'] | 'all';
}

const EMPTY_FILTERS: MeteringFilters = { keyword: '', status: 'all', round: 'all' };

interface MeteringState_ {
  rows: MeteringTicket[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createMeteringStore() {
  const [state, setState] = createStore<MeteringState_>({ rows: [], loading: true, error: '', lastMessage: '' });
  const [filters, setFilters] = createSignal<MeteringFilters>({ ...EMPTY_FILTERS });

  // 同 scheduleStore：建库必须放在 liveQuery querier 外，否则数据库变更后不会重查。
  void initDatabase();

  liveQuery(async () => db.meteringTickets.toArray()).subscribe({
    next: (list) => {
      setState('rows', [...list].sort((a, b) => b.measureDate.localeCompare(a.measureDate) || a.handoverBatch.localeCompare(b.handoverBatch)));
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

  /** 计量站按交接批次登记初测计量单（同池同批次重复登记会被 db 层拒绝） */
  async function registerInitial(draft: MeteringDraft): Promise<boolean> {
    const result = await createMeteringTicket(draft);
    setState('lastMessage', result.message);
    return result.ok;
  }

  /**
   * 录入复测：密度一变，原单作废、复测单生效、关联出卤单退回重算；
   * 作废/重算完成后顺带刷新一遍出卤单对账结论。
   */
  async function remeasure(originalId: string, draft: MeteringDraft): Promise<RemeasureResult> {
    const result = await registerRemeasurement(originalId, draft);
    setState('lastMessage', result.message);
    if (result.ok && result.changed) await refreshDischargeVerdicts();
    return result;
  }

  async function deleteTicket(id: string): Promise<void> {
    await removeMeteringTicket(id);
    setState('lastMessage', '计量单已删除');
  }

  /** 批量预检后给页面用的同步入口（一般由计量站操作触发） */
  async function prefetch(): Promise<MeteringTicket[]> {
    return listMeteringTickets();
  }

  return {
    state,
    filters,
    patchFilters,
    resetFilters,
    setMessage,
    registerInitial,
    remeasure,
    deleteTicket,
    prefetch,
    // 供极少数需要手工构造行的场景（当前仅预留，与其它 store 保持同一套 id/时间戳口径）
    buildId: (): string => uuid('ticket'),
    now: nowIso,
  };
}

const store = createRoot(createMeteringStore);

export function useMeteringStore() {
  return store;
}
