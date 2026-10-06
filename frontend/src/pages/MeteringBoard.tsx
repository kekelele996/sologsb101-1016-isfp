/**
 * /metering 外送计量对账台
 * - 计量站按交接批次出外送计量单（批次号 / 体积 / 密度）；
 * - 排下一批出卤时按「池号 + 交接批次」对账：已收货、密度对得上，出卤单才推到「已出卤」；
 * - 复测密度一变：原计量单作废、复测单沿用批次（次数 +1），两次计量都保留，
 *   用过它的出卤单退回「待排」按新密度重算；
 * - 旧数据没登记交接批次，升级时按池号 + 日期补号，对不上的单列待核实。
 *
 * 消费模型：MeteringTicket、Schedule、Pond；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>
 */
import { A, useSearchParams } from '@solidjs/router';
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { useMeteringStore, isTicketCandidate, ticketChain } from '../stores/meteringStore';
import { usePondStore } from '../stores/pondStore';
import { useScheduleStore } from '../stores/scheduleStore';
import type { MeteringDraft, MeteringTicket } from '../types/metering';
import type { Schedule } from '../types/schedule';
import {
  brineMassT,
  evaluateReconcile,
  generateBatchNo,
  scheduleDensityBasis,
} from '../utils/metering';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

function emptyTicketDraft(pondId: string): MeteringDraft {
  const pond = usePondStore().state.ponds.find((item) => item.id === pondId);
  const measureDate = today();
  return {
    batchNo: '',
    pondCode: pond?.code ?? '',
    pondId,
    measureDate,
    volumeM3: 800,
    densityGcm3: 1.15,
    received: true,
    measureRound: 1,
    status: '有效',
    note: '',
  };
}

export default function MeteringBoard() {
  const pondStore = usePondStore();
  const scheduleStore = useScheduleStore();
  const meteringStore = useMeteringStore();

  const [ticketDialog, setTicketDialog] = createSignal(false);
  const [editingTicketId, setEditingTicketId] = createSignal<string | null>(null);
  const [deletingTicket, setDeletingTicket] = createSignal<MeteringTicket | null>(null);
  const [remeasuring, setRemeasuring] = createSignal<MeteringTicket | null>(null);
  const [resolving, setResolving] = createSignal<MeteringTicket | null>(null);
  const [activeScheduleId, setActiveScheduleId] = createSignal<string | null>(null);
  const [selectedTicketId, setSelectedTicketId] = createSignal<string | null>(null);
  const [draft, setDraft] = createStore<MeteringDraft>(emptyTicketDraft(''));

  // 复测表单
  const [remeasureForm, setRemeasureForm] = createStore({ measureDate: today(), densityGcm3: 0, volumeM3: 0, note: '' });
  // 旧数据核实表单
  const [resolvePondId, setResolvePondId] = createSignal('');
  const [resolveBatchNo, setResolveBatchNo] = createSignal('');

  onMount(() => {
    void pondStore.loadAll();
  });

  // 支持从走水编排页带 schedule 参数跳转后直接定位出卤单（深链刷新也保留）
  const [searchParams] = useSearchParams();
  const preselectedId = (): string | null =>
    typeof searchParams.schedule === 'string' && searchParams.schedule !== '' ? searchParams.schedule : null;

  const pondById = (id: string) => pondStore.state.ponds.find((pond) => pond.id === id) ?? null;
  const pondCodeOf = (schedule: Schedule): string => pondById(schedule.pondId)?.code ?? '（池已删除）';

  /* ------------------------------ 出卤对账队列 ------------------------------ */

  /** 等待对账的出卤单：走水中；以及复测退回待排、批次号已有/已被作废单占用的单 */
  const pendingSchedules = createMemo<Schedule[]>(() =>
    scheduleStore.state.rows
      .filter((row) => {
        if (row.state === '走水中') return true;
        if (row.state === '待排' && row.batchNo !== null && row.batchNo !== '') return true;
        return false;
      })
      .sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)),
  );

  const activeSchedule = (): Schedule | null => {
    const list = pendingSchedules();
    const fromQuery = preselectedId();
    if (fromQuery !== null) {
      const hit = list.find((row) => row.id === fromQuery);
      if (hit) return hit;
    }
    return list.find((row) => row.id === activeScheduleId()) ?? list[0] ?? null;
  };

  /** 当前出卤单的对账候选计量单：同池、有效、已收货、未被别的单占用 */
  const candidateTickets = createMemo<MeteringTicket[]>(() => {
    const schedule = activeSchedule();
    if (schedule === null) return [];
    const code = pondCodeOf(schedule);
    return meteringStore.state.rows
      .filter((ticket) => isTicketCandidate(ticket, code, schedule.id))
      .sort((a, b) => b.measureDate.localeCompare(a.measureDate) || b.measureRound - a.measureRound);
  });

  const selectedTicket = (): MeteringTicket | null => {
    const list = candidateTickets();
    const id = selectedTicketId();
    return list.find((ticket) => ticket.id === id) ?? list[0] ?? null;
  };

  const reconcileView = createMemo(() => {
    const schedule = activeSchedule();
    const ticket = selectedTicket();
    if (schedule === null || ticket === null) return null;
    return evaluateReconcile(schedule, pondCodeOf(schedule), ticket);
  });

  const returnReason = (schedule: Schedule): string => {
    if (schedule.state !== '待排') return '';
    const used =
      schedule.meteringTicketId !== null
        ? meteringStore.state.rows.find((ticket) => ticket.id === schedule.meteringTicketId)
        : undefined;
    if (used?.status === '作废') {
      const chain = ticketChain(meteringStore.state.rows, used);
      const latest = chain[chain.length - 1];
      return `复测退回：原计量密度 ${used.densityGcm3} → 复测 ${latest?.densityGcm3 ?? '—'} g/cm³，已按新密度重算`;
    }
    return '待排批次单';
  };

  /* -------------------------------- 统计 -------------------------------- */

  const stats = createMemo(() => {
    const rows = meteringStore.state.rows;
    return {
      total: rows.length,
      valid: rows.filter((row) => row.status === '有效').length,
      voided: rows.filter((row) => row.status === '作废').length,
      unReceived: rows.filter((row) => row.status === '有效' && !row.received).length,
      legacy: rows.filter((row) => row.legacyFlag === 'unmatched').length,
      pending: pendingSchedules().length,
    };
  });

  /* ------------------------------ 计量单台账筛选 ------------------------------ */

  const filteredTickets = createMemo<MeteringTicket[]>(() => {
    const f = meteringStore.filters();
    const keyword = f.keyword.trim().toLowerCase();
    return meteringStore.state.rows.filter((ticket) => {
      if (f.legacyOnly && ticket.legacyFlag === '') return false;
      if (f.receipt === '有效' && ticket.status !== '有效') return false;
      if (f.receipt === '作废' && ticket.status !== '作废') return false;
      if (f.receipt === '未收货' && !(ticket.status === '有效' && !ticket.received)) return false;
      if (keyword === '') return true;
      return (
        ticket.batchNo.toLowerCase().includes(keyword) ||
        ticket.pondCode.toLowerCase().includes(keyword) ||
        ticket.note.toLowerCase().includes(keyword)
      );
    });
  });

  /* -------------------------------- 动作 -------------------------------- */

  const openCreate = (): void => {
    const pondId = pondStore.state.ponds[0]?.id ?? '';
    setEditingTicketId(null);
    setDraft(emptyTicketDraft(pondId));
    setTicketDialog(true);
  };

  const openEdit = (ticket: MeteringTicket): void => {
    setEditingTicketId(ticket.id);
    setDraft({
      batchNo: ticket.batchNo,
      pondCode: ticket.pondCode,
      pondId: ticket.pondId,
      measureDate: ticket.measureDate,
      volumeM3: ticket.volumeM3,
      densityGcm3: ticket.densityGcm3,
      received: ticket.received,
      measureRound: ticket.measureRound,
      status: ticket.status,
      note: ticket.note,
    });
    setTicketDialog(true);
  };

  const submitTicket = async (): Promise<void> => {
    if (draft.pondCode.trim() === '') {
      meteringStore.setMessage('请填写计量收货池号');
      return;
    }
    if (editingTicketId() === null) {
      await meteringStore.createTicket({ ...draft });
    } else {
      await meteringStore.updateTicket(editingTicketId() as string, { ...draft });
    }
    setTicketDialog(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deletingTicket();
    if (row === null) return;
    await meteringStore.deleteTicket(row.id);
    setDeletingTicket(null);
  };

  const openRemeasure = (ticket: MeteringTicket): void => {
    setRemeasuring(ticket);
    setRemeasureForm({
      measureDate: today(),
      densityGcm3: ticket.densityGcm3,
      volumeM3: ticket.volumeM3,
      note: '',
    });
  };

  const submitRemeasure = async (): Promise<void> => {
    const original = remeasuring();
    if (original === null) return;
    const result = await meteringStore.remeasure(original.id, { ...remeasureForm });
    if ('error' in result) return;
    setRemeasuring(null);
    setSelectedTicketId(result.newTicket.id);
  };

  const openResolve = (ticket: MeteringTicket): void => {
    setResolving(ticket);
    const matchedPond = pondStore.state.ponds.find((pond) => pond.code === ticket.pondCode);
    setResolvePondId(matchedPond?.id ?? pondStore.state.ponds[0]?.id ?? '');
    setResolveBatchNo(ticket.batchNo);
  };

  const submitResolve = async (): Promise<void> => {
    const ticket = resolving();
    if (ticket === null) return;
    const ok = await meteringStore.resolveLegacy(ticket.id, resolvePondId(), resolveBatchNo());
    if (ok) setResolving(null);
  };

  const confirmReconcile = async (): Promise<void> => {
    const schedule = activeSchedule();
    const ticket = selectedTicket();
    if (schedule === null || ticket === null) return;
    const result = await meteringStore.reconcile(schedule.id, ticket.id);
    if (result.ok) {
      setActiveScheduleId(null);
      setSelectedTicketId(null);
      void pondStore.refreshCounts();
    }
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="计量单" value={stats().total} suffix="张" tone="primary" />
        <StatBadge label="有效" value={stats().valid} suffix="张" tone="success" />
        <StatBadge label="待收货" value={stats().unReceived} suffix="张" tone="warning" />
        <StatBadge label="已作废" value={stats().voided} suffix="张" tone="default" />
        <StatBadge label="待对账出卤单" value={stats().pending} suffix="张" tone="info" />
        <StatBadge label="待核实旧数据" value={stats().legacy} suffix="张" tone="danger" />
      </div>

      <Show when={meteringStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {meteringStore.state.lastMessage}
        </div>
      </Show>

      {/* ---------------------------- 对账工作区 ---------------------------- */}
      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-[15px] font-semibold text-slate-800">排下一批出卤 · 池号 + 交接批次对账</h2>
            <p class="mt-0.5 text-xs text-slate-500">
              计量站已收货、批次一致、密度对得上（±0.002 g/cm³），出卤单才推到「已出卤」并回写池阶段
            </p>
          </div>
          <A
            href="/schedules"
            class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:bg-slate-100"
          >
            前往走水编排 ↩
          </A>
        </header>

        <Show
          when={pendingSchedules().length > 0}
          fallback={
            <EmptyPanel
              title="没有等待对账的出卤单"
              description="在「走水编排」把出卤单推进到「走水中」后回到这里，选同池的有效计量单完成交接批次对账；复测退回待排的出卤单也会出现在这里。"
            />
          }
        >
          <div class="grid gap-3.5 lg:grid-cols-[minmax(260px,320px)_1fr]">
            {/* 待对账出卤单 */}
            <ul class="space-y-2">
              <For each={pendingSchedules()}>
                {(schedule) => {
                  const isActive = () => activeSchedule()?.id === schedule.id;
                  const reason = () => returnReason(schedule);
                  return (
                    <li>
                      <button
                        type="button"
                        class={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                          isActive() ? 'border-brine-500 bg-brine-50 ring-1 ring-brine-400' : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                        onClick={() => {
                          setActiveScheduleId(schedule.id);
                          setSelectedTicketId(null);
                        }}
                      >
                        <div class="flex items-center justify-between gap-2">
                          <span class="text-sm font-medium text-slate-800">{pondCodeOf(schedule)}</span>
                          <span
                            class={`rounded border px-1.5 py-0.5 text-[10px] ${
                              schedule.state === '走水中'
                                ? 'border-amber-300 bg-amber-50 text-amber-700'
                                : 'border-slate-300 bg-slate-100 text-slate-600'
                            }`}
                          >
                            {schedule.state}
                          </span>
                        </div>
                        <p class="mt-0.5 text-xs text-slate-500">
                          {schedule.planDate} · {schedule.volumeM3} m³
                        </p>
                        <p class="mt-0.5 text-xs tabular-nums text-brine-700">
                          对账密度基准 {scheduleDensityBasis(schedule)} g/cm³
                        </p>
                        <p class="mt-0.5 text-[11px] text-slate-400">
                          批次：{schedule.batchNo ?? <span class="text-slate-400">未指配（对账时按计量单指配）</span>}
                        </p>
                        <Show when={reason() !== ''}>
                          <p class="mt-1 rounded bg-rose-50 px-1.5 py-1 text-[11px] leading-relaxed text-rose-700">{reason()}</p>
                        </Show>
                      </button>
                    </li>
                  );
                }}
              </For>
            </ul>

            {/* 对账明细 */}
            <Show when={activeSchedule() !== null}>
              <div class="rounded-lg border border-slate-200 bg-slate-50/60 p-3.5">
                <Show
                  when={candidateTickets().length > 0}
                  fallback={
                    <EmptyPanel
                      title="同池没有可用于对账的计量单"
                      description="计量单须满足：状态有效、计量站已收货、池号与出卤单一致、未被别的出卤单占用。可在下方台账登记新计量单。"
                      actionText="登记计量单"
                      onAction={openCreate}
                    />
                  }
                >
                  <div class="mb-3 flex flex-wrap items-center gap-2">
                    <span class="text-xs text-slate-500">选择本池计量批次：</span>
                    <select
                      class="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brine-500"
                      value={selectedTicket()?.id ?? ''}
                      onChange={(event) => setSelectedTicketId(event.currentTarget.value)}
                    >
                      <For each={candidateTickets()}>
                        {(ticket) => (
                          <option value={ticket.id}>
                            {ticket.batchNo} · 第{ticket.measureRound}次 · {ticket.densityGcm3} · {ticket.measureDate}
                          </option>
                        )}
                      </For>
                    </select>
                  </div>

                  <Show when={selectedTicket() !== null && reconcileView() !== null}>
                    {(() => {
                      const ticket = selectedTicket() as MeteringTicket;
                      const view = reconcileView()!;
                      const schedule = activeSchedule()!;
                      return (
                        <div class="space-y-3">
                          <div class="grid gap-2 sm:grid-cols-2">
                            <div class="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs">
                              <p class="font-semibold text-slate-700">出卤单（调度端）</p>
                              <p class="mt-1 text-slate-600">
                                池号 {pondCodeOf(schedule)} · 日期 {schedule.planDate}
                              </p>
                              <p class="text-slate-600">体积 {schedule.volumeM3} m³</p>
                              <p class="text-slate-600">密度基准 {scheduleDensityBasis(schedule)} g/cm³</p>
                            </div>
                            <div class="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs">
                              <p class="font-semibold text-slate-700">计量单（计量站）</p>
                              <p class="mt-1 text-slate-600">
                                池号 {ticket.pondCode} · 日期 {ticket.measureDate}
                              </p>
                              <p class="text-slate-600">
                                体积 {ticket.volumeM3} m³ · 质量 {brineMassT(ticket.densityGcm3, ticket.volumeM3)} t
                              </p>
                              <p class="text-slate-600">
                                计量密度 {ticket.densityGcm3} g/cm³ · 第 {ticket.measureRound} 次
                              </p>
                            </div>
                          </div>

                          <ul class="space-y-1.5">
                            <For each={view.checks}>
                              {(check) => (
                                <li class="flex items-start gap-2 text-xs">
                                  <span
                                    class={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] text-white ${
                                      check.pass ? 'bg-emerald-500' : check.blocking ? 'bg-rose-500' : 'bg-amber-400'
                                    }`}
                                  >
                                    {check.pass ? '✓' : '!'}
                                  </span>
                                  <span class={`${check.pass ? 'text-slate-600' : check.blocking ? 'text-rose-700' : 'text-amber-700'}`}>
                                    <span class="font-medium">{check.label}</span> · {check.detail}
                                  </span>
                                </li>
                              )}
                            </For>
                          </ul>

                          <div class="flex flex-wrap items-center justify-between gap-2">
                            <p class={`text-xs font-medium ${view.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
                              {view.ok ? '对账通过，可以出卤并回写池阶段' : '硬性核对项未全部通过，暂不能出卤'}
                            </p>
                            <button
                              type="button"
                              class={BTN_PRIMARY}
                              disabled={!view.ok}
                              onClick={() => void confirmReconcile()}
                            >
                              对账通过 · 推到已出卤
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </Show>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </section>

      {/* ---------------------------- 待核实旧数据 ---------------------------- */}
      <Show when={meteringStore.state.rows.some((ticket) => ticket.legacyFlag === 'unmatched')}>
        <section class="rounded-xl border border-rose-200 bg-rose-50/40 p-4">
          <header class="mb-3">
            <h2 class="text-[15px] font-semibold text-rose-800">待核实旧数据（升级时按池号 + 日期对不上）</h2>
            <p class="mt-0.5 text-xs text-rose-600">
              旧计量数据没有交接批次，升级已按池号 + 日期补号；以下单据对不上现存台账，请人工选定蒸发池并确认批次号。
            </p>
          </header>
          <ul class="space-y-2">
            <For each={meteringStore.state.rows.filter((ticket) => ticket.legacyFlag === 'unmatched')}>
              {(ticket) => (
                <li class="flex flex-wrap items-center gap-3 rounded-lg border border-rose-200 bg-white px-3.5 py-3">
                  <div class="min-w-[180px] flex-1">
                    <p class="text-sm font-medium text-slate-800">{ticket.batchNo}</p>
                    <p class="text-xs text-slate-500">
                      池号 {ticket.pondCode} · {ticket.measureDate} · {ticket.volumeM3} m³ · {ticket.densityGcm3} g/cm³
                    </p>
                    <p class="mt-0.5 text-xs text-rose-600">{ticket.note}</p>
                  </div>
                  <button class="rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs text-rose-700 transition hover:bg-rose-100" onClick={() => openResolve(ticket)}>
                    核实并指配
                  </button>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      {/* ---------------------------- 计量单台账 ---------------------------- */}
      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">计量站外送计量单台账</h2>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
            + 登记计量单
          </button>
        </header>

        <FilterBar
          keyword={meteringStore.filters().keyword}
          onKeyword={(value) => meteringStore.patchFilters({ keyword: value })}
          fields={[
            { key: 'receipt', label: '状态', options: ['有效', '未收货', '作废'] },
          ]}
          values={{ receipt: meteringStore.filters().receipt }}
          onChange={(key, value) => {
            if (key === 'receipt') meteringStore.patchFilters({ receipt: value as MeteringDraft['status'] | 'all' | '未收货' });
          }}
          onReset={() => meteringStore.resetFilters()}
          resultText={`命中 ${filteredTickets().length} / ${meteringStore.state.rows.length} 张`}
        >
          <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
            <input
              type="checkbox"
              checked={meteringStore.filters().legacyOnly}
              onChange={(event) => meteringStore.patchFilters({ legacyOnly: event.currentTarget.checked })}
            />
            只看补号旧数据
          </label>
        </FilterBar>

        <Show when={meteringStore.state.rows.length === 0}>
          <EmptyPanel
            title="还没有外送计量单"
            description="计量站按交接批次出具计量单，写清批次号、体积与密度。登记后在上方对账区按池号 + 批次与出卤单核对。"
            actionText="登记第一张计量单"
            onAction={openCreate}
          />
        </Show>

        <Show when={meteringStore.state.rows.length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[1080px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">交接批次</th>
                  <th class="px-3 py-2">池号</th>
                  <th class="px-3 py-2">计量日期</th>
                  <th class="px-3 py-2 text-right">次数</th>
                  <th class="px-3 py-2 text-right">体积 m³</th>
                  <th class="px-3 py-2 text-right">密度 g/cm³</th>
                  <th class="px-3 py-2 text-right">质量 t</th>
                  <th class="px-3 py-2">收货 / 状态</th>
                  <th class="px-3 py-2">复测链</th>
                  <th class="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={filteredTickets()}>
                  {(ticket) => {
                    const chain = () => ticketChain(meteringStore.state.rows, ticket);
                    const linked = () =>
                      ticket.matchedScheduleId !== ''
                        ? scheduleStore.state.rows.find((row) => row.id === ticket.matchedScheduleId)
                        : undefined;
                    return (
                      <tr
                        class={`border-b border-slate-100 align-top hover:bg-slate-50/60 ${
                          ticket.status === '作废' ? 'text-slate-400 line-through decoration-rose-300/70' : ''
                        } ${ticket.legacyFlag === 'unmatched' ? 'bg-rose-50/50' : ''}`}
                      >
                        <td class="px-3 py-2.5">
                          <span class="font-medium text-slate-800">{ticket.batchNo}</span>
                          <Show when={ticket.legacyFlag !== ''}>
                            <span class="ml-1 rounded border border-amber-300 bg-amber-50 px-1 py-0.5 text-[10px] text-amber-700">
                              {ticket.legacyFlag === 'unmatched' ? '待核实' : '补号'}
                            </span>
                          </Show>
                          <Show when={ticket.note !== ''}>
                            <p class="mt-0.5 text-[11px] font-normal normal-case text-slate-400">{ticket.note}</p>
                          </Show>
                        </td>
                        <td class="px-3 py-2.5">
                          {ticket.pondCode}
                          <Show when={ticket.pondId === ''}>
                            <span class="ml-1 text-[10px] text-rose-500">（无现存池）</span>
                          </Show>
                        </td>
                        <td class="px-3 py-2.5 tabular-nums">{ticket.measureDate}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">
                          第 {ticket.measureRound} 次
                        </td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{ticket.volumeM3}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">
                          {ticket.densityGcm3}
                        </td>
                        <td class="px-3 py-2.5 text-right tabular-nums">
                          {brineMassT(ticket.densityGcm3, ticket.volumeM3)}
                        </td>
                        <td class="px-3 py-2.5">
                          <div class="flex flex-col gap-1">
                            <span class={ticket.received ? 'text-emerald-700' : 'text-amber-700'}>
                              {ticket.received ? '已收货' : '未收货'}
                            </span>
                            <span class={ticket.status === '作废' ? 'text-rose-600' : 'text-slate-500'}>{ticket.status}</span>
                            <Show when={linked() !== undefined}>
                              <span class="text-[11px] text-slate-400">
                                对出卤单 {linked()!.planDate}
                              </span>
                            </Show>
                          </div>
                        </td>
                        <td class="px-3 py-2.5">
                          <Show
                            when={chain().length > 1}
                            fallback={<span class="text-xs text-slate-400">仅本次</span>}
                          >
                            <div class="flex flex-wrap gap-1">
                              <For each={chain()}>
                                {(item) => (
                                  <span
                                    title={`${item.measureDate} · ${item.densityGcm3} g/cm³`}
                                    class={`rounded px-1.5 py-0.5 text-[10px] ${
                                      item.status === '作废'
                                        ? 'bg-rose-100 text-rose-700 line-through'
                                        : 'bg-emerald-100 text-emerald-700'
                                    }`}
                                  >
                                    {item.measureRound}次 {item.densityGcm3}
                                  </span>
                                )}
                              </For>
                            </div>
                          </Show>
                        </td>
                        <td class="px-3 py-2.5">
                          <div class="flex flex-wrap gap-x-2.5 gap-y-1">
                            <Show when={ticket.status === '有效'}>
                              <Show when={!ticket.received}>
                                <button class="text-xs text-emerald-700 hover:underline" onClick={() => void meteringStore.setReceived(ticket.id, true)}>
                                  标记收货
                                </button>
                              </Show>
                              <Show when={ticket.received}>
                                <button class="text-xs text-amber-700 hover:underline" onClick={() => void meteringStore.setReceived(ticket.id, false)}>
                                  取消收货
                                </button>
                              </Show>
                              <button
                                class="text-xs text-brine-700 hover:underline"
                                onClick={() => openRemeasure(ticket)}
                              >
                                登记复测
                              </button>
                            </Show>
                            <Show when={ticket.legacyFlag === 'unmatched'}>
                              <button class="text-xs text-rose-700 hover:underline" onClick={() => openResolve(ticket)}>
                                核实指配
                              </button>
                            </Show>
                            <button class="text-xs text-slate-600 hover:underline" onClick={() => openEdit(ticket)}>
                              编辑
                            </button>
                            <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeletingTicket(ticket)}>
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>

      {/* ---------------------------- 登记 / 编辑计量单 ---------------------------- */}
      <AppDialog
        open={ticketDialog()}
        title={editingTicketId() === null ? '登记外送计量单' : '编辑计量单'}
        onClose={() => setTicketDialog(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setTicketDialog(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitTicket()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>收货蒸发池（按现存池回填池号）</span>
            <select
              class={INPUT}
              value={draft.pondId}
              onChange={(event) => {
                const pond = pondStore.state.ponds.find((item) => item.id === event.currentTarget.value);
                setDraft('pondId', event.currentTarget.value);
                if (pond) setDraft('pondCode', pond.code);
              }}
            >
              <option value="">外部 / 历史单据（手填池号）</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计量收货池号（对账键）</span>
            <input class={INPUT} value={draft.pondCode} onInput={(event) => setDraft('pondCode', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>交接批次号（留空自动生成）</span>
            <input
              class={INPUT}
              value={draft.batchNo}
              placeholder={draft.measureDate && draft.pondCode ? generateBatchNo(draft.measureDate, draft.pondCode, draft.measureRound) : 'JL-日期-池号-01'}
              onInput={(event) => setDraft('batchNo', event.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计量日期</span>
            <input type="date" class={INPUT} value={draft.measureDate} onInput={(event) => setDraft('measureDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计量体积（m³）</span>
            <input type="number" step="10" class={INPUT} value={draft.volumeM3} onInput={(event) => setDraft('volumeM3', Number(event.currentTarget.value))} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计量密度（g/cm³）</span>
            <input type="number" step="0.001" class={INPUT} value={draft.densityGcm3} onInput={(event) => setDraft('densityGcm3', Number(event.currentTarget.value))} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计量次数</span>
            <input type="number" min="1" step="1" class={INPUT} value={draft.measureRound} onInput={(event) => setDraft('measureRound', Math.max(1, Number(event.currentTarget.value)))} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>收货与状态</span>
            <div class="flex items-center gap-3 py-1.5">
              <label class="flex items-center gap-1.5 text-sm text-slate-700">
                <input type="checkbox" checked={draft.received} onChange={(event) => setDraft('received', event.currentTarget.checked)} />
                计量站已收货
              </label>
              <select class={`${INPUT} w-auto`} value={draft.status} onChange={(event) => setDraft('status', event.currentTarget.value as MeteringDraft['status'])}>
                <option value="有效">有效</option>
                <option value="作废">作废</option>
              </select>
            </div>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>备注</span>
            <input class={INPUT} value={draft.note} onInput={(event) => setDraft('note', event.currentTarget.value)} />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          复测导致密度变化时不要直接改原单：请在台账对原单点「登记复测」，原单自动作废并保留，复测单沿用批次号、次数 +1，已出卤单退回待排按新密度重算。
        </p>
      </AppDialog>

      {/* ---------------------------- 删除确认 ---------------------------- */}
      <AppDialog
        open={deletingTicket() !== null}
        title="确认删除计量单？"
        width="max-w-lg"
        onClose={() => setDeletingTicket(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeletingTicket(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除批次「{deletingTicket()?.batchNo}」的计量单。复测作废场景建议改用「登记复测」，以保留两次计量记录。
        </p>
      </AppDialog>

      {/* ---------------------------- 复测登记 ---------------------------- */}
      <AppDialog
        open={remeasuring() !== null}
        title={`登记复测 · ${remeasuring()?.batchNo ?? ''}`}
        width="max-w-lg"
        onClose={() => setRemeasuring(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setRemeasuring(null)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitRemeasure()}>
              确认复测并作废旧单
            </button>
          </>
        }
      >
        <Show when={remeasuring() !== null}>
          <div class="space-y-3">
            <div class="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
              首次/上次计量：{remeasuring()?.measureDate} · {remeasuring()?.densityGcm3} g/cm³ · {remeasuring()?.volumeM3} m³。
              复测单沿用批次号，计量次数为第 {(remeasuring()?.measureRound ?? 1) + 1} 次。
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="flex flex-col gap-1 text-[13px] text-slate-600">
                <span>复测日期</span>
                <input type="date" class={INPUT} value={remeasureForm.measureDate} onInput={(event) => setRemeasureForm('measureDate', event.currentTarget.value)} />
              </label>
              <label class="flex flex-col gap-1 text-[13px] text-slate-600">
                <span>复测密度（g/cm³）</span>
                <input type="number" step="0.001" class={INPUT} value={remeasureForm.densityGcm3} onInput={(event) => setRemeasureForm('densityGcm3', Number(event.currentTarget.value))} />
              </label>
              <label class="flex flex-col gap-1 text-[13px] text-slate-600">
                <span>复测体积（m³）</span>
                <input type="number" step="10" class={INPUT} value={remeasureForm.volumeM3} onInput={(event) => setRemeasureForm('volumeM3', Number(event.currentTarget.value))} />
              </label>
              <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
                <span>复测说明</span>
                <input class={INPUT} value={remeasureForm.note} onInput={(event) => setRemeasureForm('note', event.currentTarget.value)} placeholder="如：取样复测，密度较首测偏高" />
              </label>
            </div>
            <p class="rounded-md bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-700">
              原计量单将标记作废（不删除、不改原密度）；用过它且已「已出卤」的出卤单退回「待排」，目标密度按复测值重算，交接批次保留，需重新对账。
            </p>
          </div>
        </Show>
      </AppDialog>

      {/* ---------------------------- 旧数据核实 ---------------------------- */}
      <AppDialog
        open={resolving() !== null}
        title="核实待确认旧数据"
        width="max-w-lg"
        onClose={() => setResolving(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setResolving(null)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitResolve()}>
              确认核实
            </button>
          </>
        }
      >
        <Show when={resolving() !== null}>
          <div class="space-y-3">
            <p class="text-sm text-slate-600">
              升级时按池号 + 日期补号为 <span class="font-medium">{resolving()?.batchNo}</span>，但池号「
              {resolving()?.pondCode}」对不上现存台账。请选定正确的蒸发池并确认 / 修正交接批次号。
            </p>
            <label class="flex flex-col gap-1 text-[13px] text-slate-600">
              <span>对应蒸发池</span>
              <select class={INPUT} value={resolvePondId()} onChange={(event) => setResolvePondId(event.currentTarget.value)}>
                <For each={pondStore.state.ponds}>
                  {(pond) => (
                    <option value={pond.id}>
                      {pond.code} · {pond.seriesName} · {pond.stage}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-[13px] text-slate-600">
              <span>交接批次号</span>
              <input class={INPUT} value={resolveBatchNo()} onInput={(event) => setResolveBatchNo(event.currentTarget.value)} />
            </label>
          </div>
        </Show>
      </AppDialog>
    </div>
  );
}
