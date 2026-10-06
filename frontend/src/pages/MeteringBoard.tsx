/**
 * /metering 计量站交接对账台
 * - 计量站端：按交接批次出外送计量单（批次号、体积、密度），支持复测作废留痕
 * - 调度端：管出卤单；排下一批出卤时按池号 + 交接批次对账，
 *   计量站收货且密度对得上才把出卤单推到「已出卤」；复测作废后退回「待排」重算
 * 消费模型：DischargeOrder、MeteringTicket、Pond；复用组件：<StatBadge>、<EmptyPanel>、<AppDialog>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import DischargeList from '../components/metering/DischargeList';
import TicketList from '../components/metering/TicketList';
import { usePondStore } from '../stores/pondStore';
import { useDischargeStore } from '../stores/dischargeStore';
import { useMeteringStore } from '../stores/meteringStore';
import type { DischargeDraft, DischargeOrder, DischargeState } from '../types/discharge';
import type { MeteringDraft, MeteringTicket } from '../types/metering';
import { DENSITY_HANDOVER_TOLERANCE } from '../utils/metering';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

type Tab = 'discharge' | 'metering';

function emptyDischargeDraft(pondId: string): DischargeDraft {
  return { pondId, planDate: today(), handoverBatch: '', volumeM3: 800, densityGcm3: 1.15, operator: '', state: '待排' };
}

function emptyTicketDraft(pondId: string, batch: string, date: string, volume: number, density: number): MeteringDraft {
  return { pondId, measureDate: date, handoverBatch: batch, volumeM3: volume, densityGcm3: density };
}

export default function MeteringBoard() {
  const pondStore = usePondStore();
  const dischargeStore = useDischargeStore();
  const meteringStore = useMeteringStore();

  const [tab, setTab] = createSignal<Tab>('discharge');
  const [issueOnly, setIssueOnly] = createSignal(false);

  const [orderDialog, setOrderDialog] = createSignal(false);
  const [editingOrderId, setEditingOrderId] = createSignal<string | null>(null);
  const [deletingOrder, setDeletingOrder] = createSignal<DischargeOrder | null>(null);
  const [orderDraft, setOrderDraft] = createStore<DischargeDraft>(emptyDischargeDraft(''));

  const [ticketDialog, setTicketDialog] = createSignal(false);
  const [ticketDraft, setTicketDraft] = createStore<MeteringDraft>(emptyTicketDraft('', '', today(), 800, 1.15));

  const [remeasureTarget, setRemeasureTarget] = createSignal<MeteringTicket | null>(null);
  const [remeasureDraft, setRemeasureDraft] = createStore<MeteringDraft>(emptyTicketDraft('', '', today(), 800, 1.15));
  const [deletingTicket, setDeletingTicket] = createSignal<MeteringTicket | null>(null);

  onMount(() => {
    void pondStore.loadAll();
  });

  const ponds = createMemo(() => pondStore.state.ponds);
  const orders = createMemo(() => dischargeStore.state.rows);
  const tickets = createMemo(() => meteringStore.state.rows);

  const stats = createMemo(() => {
    const list = orders();
    const blocked = list.filter((row) => row.state === '待排' && (row.reconcileVerdict === 'noTicket' || row.reconcileVerdict === 'density'));
    const revised = list.filter((row) => row.revisedAfterVoid);
    const issues = list.filter((row) => row.migrationIssue !== '');
    return {
      orders: list.length,
      pending: list.filter((row) => row.state === '待排').length,
      done: list.filter((row) => row.state === '已出卤').length,
      blocked: blocked.length,
      revised: revised.length,
      migrationIssues: issues.length,
      tickets: tickets().length,
      voidTickets: tickets().filter((row) => row.status === '已作废').length,
      mass: Math.round(list.filter((row) => row.state === '已出卤').reduce((acc, row) => acc + row.massTonnes, 0) * 10) / 10,
    };
  });

  const visibleOrders = createMemo<DischargeOrder[]>(() => {
    const current = dischargeStore.filters();
    const series = pondStore.state.currentSeries;
    const keyword = current.keyword.trim().toLowerCase();
    return orders().filter((row) => {
      const pond = ponds().find((item) => item.id === row.pondId);
      if (series !== null && pond?.seriesName !== series) return false;
      if (current.state !== 'all' && row.state !== current.state) return false;
      if (issueOnly() && !(row.reconcileVerdict === 'noTicket' || row.reconcileVerdict === 'density' || row.revisedAfterVoid || row.migrationIssue !== '')) {
        return false;
      }
      if (keyword === '') return true;
      const pondCode = pond === undefined ? '' : `${pond.code} ${pond.seriesName}`;
      return (
        pondCode.toLowerCase().includes(keyword) ||
        row.handoverBatch.toLowerCase().includes(keyword) ||
        row.operator.toLowerCase().includes(keyword) ||
        row.planDate.includes(keyword)
      );
    });
  });

  const visibleTickets = createMemo<MeteringTicket[]>(() => {
    const current = meteringStore.filters();
    const keyword = current.keyword.trim().toLowerCase();
    return tickets().filter((row) => {
      if (current.status !== 'all' && row.status !== current.status) return false;
      if (current.round !== 'all' && row.round !== current.round) return false;
      if (keyword === '') return true;
      const pond = ponds().find((item) => item.id === row.pondId);
      const pondCode = pond === undefined ? '' : `${pond.code} ${pond.seriesName}`;
      return pondCode.toLowerCase().includes(keyword) || row.handoverBatch.toLowerCase().includes(keyword) || row.measureDate.includes(keyword);
    });
  });

  /* ------------------------------ 出卤单表单 ------------------------------ */

  const openCreateOrder = (): void => {
    const first = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? ponds()[0]?.id ?? '';
    setEditingOrderId(null);
    setOrderDraft(emptyDischargeDraft(first));
    setOrderDialog(true);
  };

  const openEditOrder = (order: DischargeOrder): void => {
    setEditingOrderId(order.id);
    setOrderDraft({
      pondId: order.pondId,
      planDate: order.planDate,
      handoverBatch: order.handoverBatch,
      volumeM3: order.volumeM3,
      densityGcm3: order.densityGcm3,
      operator: order.operator,
      state: order.state,
    });
    setOrderDialog(true);
  };

  const submitOrder = async (): Promise<void> => {
    if (orderDraft.pondId === '') {
      dischargeStore.setMessage('请选择蒸发池');
      return;
    }
    if (orderDraft.handoverBatch.trim() === '') {
      dischargeStore.setMessage('请填写交接批次号');
      return;
    }
    if (editingOrderId() === null) {
      await dischargeStore.createOrder({ ...orderDraft });
    } else {
      await dischargeStore.updateOrder(editingOrderId() as string, { ...orderDraft });
    }
    setOrderDialog(false);
  };

  /* ------------------------------ 计量单表单 ------------------------------ */

  const openCreateTicket = (): void => {
    const first = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? ponds()[0]?.id ?? '';
    setTicketDraft(emptyTicketDraft(first, '', today(), 800, 1.15));
    setTicketDialog(true);
  };

  const submitTicket = async (): Promise<void> => {
    if (ticketDraft.pondId === '') {
      meteringStore.setMessage('请选择蒸发池');
      return;
    }
    if (ticketDraft.handoverBatch.trim() === '') {
      meteringStore.setMessage('请填写交接批次号');
      return;
    }
    const ok = await meteringStore.registerInitial({ ...ticketDraft });
    if (ok) setTicketDialog(false);
  };

  const openRemeasure = (ticket: MeteringTicket): void => {
    setRemeasureTarget(ticket);
    setRemeasureDraft(emptyTicketDraft(ticket.pondId, ticket.handoverBatch, today(), ticket.volumeM3, ticket.densityGcm3));
  };

  const submitRemeasure = async (): Promise<void> => {
    const target = remeasureTarget();
    if (target === null) return;
    const result = await meteringStore.remeasure(target.id, { ...remeasureDraft });
    if (result.ok && result.changed) {
      await pondStore.refreshCounts();
      setRemeasureTarget(null);
    } else if (result.ok && !result.changed) {
      setRemeasureTarget(null);
    }
  };

  const message = (): string =>
    tab() === 'discharge' ? dischargeStore.state.lastMessage : meteringStore.state.lastMessage;

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="出卤单" value={stats().orders} suffix="张" tone="primary" />
        <StatBadge label="待排" value={stats().pending} suffix="张" tone="default" />
        <StatBadge label="已出卤" value={stats().done} suffix="张" tone="success" />
        <StatBadge label="对账拦截" value={stats().blocked} suffix="张" tone="danger" hint="缺计量单或密度不符，出卤单保持待排" />
        <StatBadge label="复测退回" value={stats().revised} suffix="张" tone="warning" hint="计量单复测作废后退回待排、按新密度重算" />
        <StatBadge label="升级单列" value={stats().migrationIssues} suffix="张" tone="warning" hint="旧数据按池号+日期补号时对不上、需人工核对" />
        <StatBadge label="计量单" value={stats().tickets} suffix="张" tone="info" hint={`其中作废留痕 ${stats().voidTickets} 张（两次计量都保留）`} />
        <StatBadge label="已交接质量" value={stats().mass} suffix="t" tone="success" />
      </div>

      <Show when={message() !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">{message()}</div>
      </Show>

      <div class="flex flex-wrap items-center gap-2">
        <div class="inline-flex rounded-lg border border-slate-200 bg-white p-1">
          <button
            type="button"
            class={`rounded-md px-3.5 py-1.5 text-sm transition ${tab() === 'discharge' ? 'bg-brine-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            onClick={() => setTab('discharge')}
          >
            调度端 · 出卤对账
          </button>
          <button
            type="button"
            class={`rounded-md px-3.5 py-1.5 text-sm transition ${tab() === 'metering' ? 'bg-brine-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            onClick={() => setTab('metering')}
          >
            计量站 · 外送计量单
          </button>
        </div>
        <span class="text-xs text-slate-400">对账口径：同池号 + 同交接批次，密度差 ≤ {DENSITY_HANDOVER_TOLERANCE} g/cm³ 视为对得上</span>
      </div>

      {/* ---------------- 调度端：出卤单 ---------------- */}
      <Show when={tab() === 'discharge'}>
        <section class="rounded-xl border border-slate-200 bg-white p-4">
          <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-[15px] font-semibold text-slate-800">出卤单与对账（调度端管蒸发池阶段与出卤单）</h2>
            <div class="flex flex-wrap gap-2">
              <button type="button" class={BTN_GHOST} onClick={() => void dischargeStore.precheck()}>
                排下一批前批量预检
              </button>
              <button type="button" class={BTN_PRIMARY} onClick={openCreateOrder} disabled={ponds().length === 0}>
                + 新建出卤单
              </button>
            </div>
          </header>

          <div class="mb-3.5 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/70 px-3.5 py-3">
            <input
              type="text"
              value={dischargeStore.filters().keyword}
              placeholder="搜池号 / 批次号 / 调度员 / 日期"
              class="w-64 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brine-500"
              onInput={(event) => dischargeStore.patchFilters({ keyword: event.currentTarget.value })}
            />
            <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
              池系
              <select
                class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
                value={pondStore.state.currentSeries ?? 'all'}
                onChange={(event) => pondStore.setCurrentSeries(event.currentTarget.value === 'all' ? null : event.currentTarget.value)}
              >
                <For each={pondStore.seriesOptions()}>{(name) => <option value={name}>{name}</option>}</For>
              </select>
            </label>
            <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
              状态
              <select
                class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
                value={dischargeStore.filters().state}
                onChange={(event) => dischargeStore.patchFilters({ state: event.currentTarget.value as DischargeState | 'all' })}
              >
                <option value="all">全部状态</option>
                <option value="待排">待排</option>
                <option value="已出卤">已出卤</option>
              </select>
            </label>
            <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
              <input type="checkbox" checked={issueOnly()} onChange={(event) => setIssueOnly(event.currentTarget.checked)} />
              只看异常（拦截 / 复测退回 / 升级单列）
            </label>
            <span class="rounded-full bg-brine-50 px-2.5 py-0.5 text-xs text-brine-700">
              命中 {visibleOrders().length} / {orders().length} 张
            </span>
          </div>

          <Show when={orders().length === 0}>
            <EmptyPanel
              title="还没有出卤单"
              description="调度端按蒸发池与交接批次登记出卤单；排下一批出卤时与计量站按池号和交接批次对账，计量站收了货、密度对得上，出卤单才推到「已出卤」。"
              actionText="新建第一张出卤单"
              onAction={openCreateOrder}
            />
          </Show>
          <Show when={orders().length > 0}>
            <DischargeList
              orders={visibleOrders()}
              ponds={ponds()}
              tickets={tickets()}
              onReconcile={(id) => void dischargeStore.reconcile(id)}
              onEdit={openEditOrder}
              onDelete={(order) => setDeletingOrder(order)}
            />
          </Show>
          <Show when={orders().length > 0 && visibleOrders().length === 0}>
            <EmptyPanel title="没有符合筛选条件的出卤单" description="可以清空关键字或取消「只看异常」。" />
          </Show>
        </section>
      </Show>

      {/* ---------------- 计量站：外送计量单 ---------------- */}
      <Show when={tab() === 'metering'}>
        <section class="rounded-xl border border-slate-200 bg-white p-4">
          <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-[15px] font-semibold text-slate-800">外送计量单（计量站按交接批次出具）</h2>
            <button type="button" class={BTN_PRIMARY} onClick={openCreateTicket} disabled={ponds().length === 0}>
              + 登记初测计量单
            </button>
          </header>

          <div class="mb-3.5 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/70 px-3.5 py-3">
            <input
              type="text"
              value={meteringStore.filters().keyword}
              placeholder="搜池号 / 批次号 / 日期"
              class="w-64 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brine-500"
              onInput={(event) => meteringStore.patchFilters({ keyword: event.currentTarget.value })}
            />
            <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
              状态
              <select
                class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
                value={meteringStore.filters().status}
                onChange={(event) => meteringStore.patchFilters({ status: event.currentTarget.value as MeteringTicket['status'] | 'all' })}
              >
                <option value="all">全部状态</option>
                <option value="有效">有效</option>
                <option value="已作废">已作废</option>
              </select>
            </label>
            <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
              轮次
              <select
                class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
                value={meteringStore.filters().round}
                onChange={(event) => meteringStore.patchFilters({ round: event.currentTarget.value as MeteringTicket['round'] | 'all' })}
              >
                <option value="all">全部轮次</option>
                <option value="初测">初测</option>
                <option value="复测">复测</option>
              </select>
            </label>
            <span class="rounded-full bg-brine-50 px-2.5 py-0.5 text-xs text-brine-700">
              命中 {visibleTickets().length} / {tickets().length} 张
            </span>
          </div>

          <Show when={tickets().length === 0}>
            <EmptyPanel
              title="还没有外送计量单"
              description="盐田外送卤水经过计量站，按交接批次出具计量单，写清批次号、体积和密度。复测后密度一变，原计量单作废（两次计量都留着），调度端用过它的出卤单退回待排重算。"
              actionText="登记第一张计量单"
              onAction={openCreateTicket}
            />
          </Show>
          <Show when={tickets().length > 0}>
            <TicketList
              tickets={visibleTickets()}
              ponds={ponds()}
              onRemeasure={openRemeasure}
              onDelete={(ticket) => setDeletingTicket(ticket)}
            />
          </Show>
          <Show when={tickets().length > 0 && visibleTickets().length === 0}>
            <EmptyPanel title="没有符合筛选条件的计量单" description="可以清空关键字或放宽状态 / 轮次筛选。" />
          </Show>
        </section>
      </Show>

      {/* ---------------- 出卤单新建/编辑弹层 ---------------- */}
      <AppDialog
        open={orderDialog()}
        title={editingOrderId() === null ? '新建出卤单' : '编辑出卤单'}
        onClose={() => setOrderDialog(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setOrderDialog(false)}>取消</button>
            <button class={BTN_PRIMARY} onClick={() => void submitOrder()}>保存</button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池（池号）</span>
            <select class={INPUT} value={orderDraft.pondId} onChange={(event) => setOrderDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={ponds()}>
                {(pond) => (
                  <option value={pond.id}>{pond.code} · {pond.seriesName} · {pond.stage}</option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>交接批次号</span>
            <input class={INPUT} value={orderDraft.handoverBatch} placeholder="如 JJ-20261012-C3" onInput={(event) => setOrderDraft('handoverBatch', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划外送日期</span>
            <input type="date" class={INPUT} value={orderDraft.planDate} onInput={(event) => setOrderDraft('planDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>调度员</span>
            <input class={INPUT} value={orderDraft.operator} onInput={(event) => setOrderDraft('operator', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>外送体积（m³）</span>
            <input type="number" step="10" class={INPUT} value={orderDraft.volumeM3} onInput={(event) => setOrderDraft('volumeM3', Number(event.currentTarget.value))} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>外送密度（g/cm³）</span>
            <input type="number" step="0.001" class={INPUT} value={orderDraft.densityGcm3} onInput={(event) => setOrderDraft('densityGcm3', Number(event.currentTarget.value))} />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          结算质量 = 体积 × 密度。出卤单保存后保持「待排」，对账通过（计量站收货、密度差 ≤ {DENSITY_HANDOVER_TOLERANCE} g/cm³）才推到「已出卤」并推进蒸发池阶段。
        </p>
      </AppDialog>

      {/* ---------------- 初测计量单弹层 ---------------- */}
      <AppDialog
        open={ticketDialog()}
        title="登记初测外送计量单"
        onClose={() => setTicketDialog(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setTicketDialog(false)}>取消</button>
            <button class={BTN_PRIMARY} onClick={() => void submitTicket()}>保存计量单</button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池（池号）</span>
            <select class={INPUT} value={ticketDraft.pondId} onChange={(event) => setTicketDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={ponds()}>
                {(pond) => (
                  <option value={pond.id}>{pond.code} · {pond.seriesName} · {pond.stage}</option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>交接批次号</span>
            <input class={INPUT} value={ticketDraft.handoverBatch} placeholder="与调度端出卤单一致" onInput={(event) => setTicketDraft('handoverBatch', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计量日期</span>
            <input type="date" class={INPUT} value={ticketDraft.measureDate} onInput={(event) => setTicketDraft('measureDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>实收体积（m³）</span>
            <input type="number" step="10" class={INPUT} value={ticketDraft.volumeM3} onInput={(event) => setTicketDraft('volumeM3', Number(event.currentTarget.value))} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计量密度（g/cm³，25 ℃ 折算）</span>
            <input type="number" step="0.001" class={INPUT} value={ticketDraft.densityGcm3} onInput={(event) => setTicketDraft('densityGcm3', Number(event.currentTarget.value))} />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          同池号 + 同交接批次只允许一张有效计量单。密度若后续复测发生变化，请在列表上对该单「录入复测」，原单会作废留痕。
        </p>
      </AppDialog>

      {/* ---------------- 复测弹层 ---------------- */}
      <AppDialog
        open={remeasureTarget() !== null}
        title={`录入复测（批次 ${remeasureTarget()?.handoverBatch ?? ''}）`}
        width="max-w-lg"
        onClose={() => setRemeasureTarget(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setRemeasureTarget(null)}>取消</button>
            <button class={BTN_PRIMARY} onClick={() => void submitRemeasure()}>提交复测</button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>复测日期</span>
            <input type="date" class={INPUT} value={remeasureDraft.measureDate} onInput={(event) => setRemeasureDraft('measureDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>复测体积（m³）</span>
            <input type="number" step="10" class={INPUT} value={remeasureDraft.volumeM3} onInput={(event) => setRemeasureDraft('volumeM3', Number(event.currentTarget.value))} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>复测密度（g/cm³）· 初测 {remeasureTarget()?.densityGcm3 ?? '—'}</span>
            <input type="number" step="0.001" class={INPUT} value={remeasureDraft.densityGcm3} onInput={(event) => setRemeasureDraft('densityGcm3', Number(event.currentTarget.value))} />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
          复测密度与初测差超过 {DENSITY_HANDOVER_TOLERANCE} g/cm³ 时：原计量单作废（行保留，两次计量都留着），
          出具复测新单；用过原单的出卤单退回「待排」、按新密度重算结算质量。密度在容差内则原单继续有效。
        </p>
      </AppDialog>

      {/* ---------------- 删除确认 ---------------- */}
      <AppDialog
        open={deletingOrder() !== null}
        title="确认删除出卤单？"
        width="max-w-lg"
        onClose={() => setDeletingOrder(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeletingOrder(null)}>取消</button>
            <button class={BTN_DANGER} onClick={() => { void dischargeStore.deleteOrder((deletingOrder() as DischargeOrder).id); setDeletingOrder(null); }}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除批次 {deletingOrder()?.handoverBatch}（计划 {deletingOrder()?.planDate}）的出卤单。计量站的计量单不会被删除。
        </p>
      </AppDialog>

      <AppDialog
        open={deletingTicket() !== null}
        title="确认删除计量单？"
        width="max-w-lg"
        onClose={() => setDeletingTicket(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeletingTicket(null)}>取消</button>
            <button class={BTN_DANGER} onClick={() => { void meteringStore.deleteTicket((deletingTicket() as MeteringTicket).id); setDeletingTicket(null); }}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除批次 {deletingTicket()?.handoverBatch} 的{deletingTicket()?.round}计量单。建议复测作废时优先使用「录入复测」而不是直接删除，以保留两次计量留痕。
        </p>
      </AppDialog>
    </div>
  );
}
