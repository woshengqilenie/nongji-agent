import {
  apiBase,
  candidateTableHtml,
  emptyState,
  escapeHtml,
  heatRowHtml,
  metricCardHtml,
  orderCardHtml,
  ownerRankHtml,
  request,
  shortTime,
  timelineHtml,
} from "./shared.js";
import { ensureAMap, initPlatformSettings, streamLLMChat, toAmapPosition } from "./platform.js";

const REGION_PAGE_SIZE = 4;
const OWNER_PAGE_SIZE = 4;
const EVENT_PAGE_SIZE = 5;
const PROPOSAL_GENERATE_STATUSES = new Set(["PAID_ESCROW", "DISPATCH_PROPOSED", "ABNORMAL_PENDING", "REASSIGN_PROPOSED"]);
const PROPOSAL_CONFIRM_STATUSES = new Set(["DISPATCH_PROPOSED", "REASSIGN_PROPOSED"]);

const state = {
  dispatchers: [],
  machines: [],
  overview: null,
  activeQueue: "waiting_dispatch",
  selectedOrderId: null,
  selectedOrder: null,
  proposal: null,
  selectedCandidateMachineId: null,
  weather: null,
  weatherError: "",
  pages: {
    regionHeat: 1,
    ownerRank: 1,
    recentEvents: 1,
  },
  mapRuntime: {
    instance: null,
    infoWindow: null,
    overlays: [],
  },
};

const dom = {
  supervisorMetrics: document.getElementById("supervisorMetrics"),
  dispatcherSelect: document.getElementById("dispatcherSelect"),
  refreshOverviewBtn: document.getElementById("refreshOverviewBtn"),
  queueTabs: document.getElementById("queueTabs"),
  queueOrders: document.getElementById("queueOrders"),
  supervisorOrderSummary: document.getElementById("supervisorOrderSummary"),
  dispatchGuide: document.getElementById("dispatchGuide"),
  dispatchResult: document.getElementById("dispatchResult"),
  supervisorAiExplainBtn: document.getElementById("supervisorAiExplainBtn"),
  supervisorAiInsight: document.getElementById("supervisorAiInsight"),
  candidateTable: document.getElementById("candidateTable"),
  dispatchMapCanvas: document.getElementById("dispatchMapCanvas"),
  dispatchMapPlaceholder: document.getElementById("dispatchMapPlaceholder"),
  supervisorMapFullscreenBtn: document.getElementById("supervisorMapFullscreenBtn"),
  weatherPanel: document.getElementById("weatherPanel"),
  supervisorTimeline: document.getElementById("supervisorTimeline"),
  regionHeat: document.getElementById("regionHeat"),
  regionHeatPagination: document.getElementById("regionHeatPagination"),
  ownerRank: document.getElementById("ownerRank"),
  ownerRankPagination: document.getElementById("ownerRankPagination"),
  recentEvents: document.getElementById("recentEvents"),
  recentEventsPagination: document.getElementById("recentEventsPagination"),
  proposeDispatchBtn: document.getElementById("proposeDispatchBtn"),
  confirmDispatchBtn: document.getElementById("confirmDispatchBtn"),
  simulateStormBtn: document.getElementById("simulateStormBtn"),
  clearWeatherBtn: document.getElementById("clearWeatherBtn"),
  weatherHandleBtn: document.getElementById("weatherHandleBtn"),
  faultHandleBtn: document.getElementById("faultHandleBtn"),
  resumeBtn: document.getElementById("resumeBtn"),
  refundBtn: document.getElementById("refundBtn"),
};

function currentDispatcherId() {
  return Number(dom.dispatcherSelect.value || 0);
}

function queueOrders(queueKey) {
  return state.overview?.queues?.[queueKey] || [];
}

function proposalEnvelope() {
  return state.proposal && Number(state.proposal.order_id) === Number(state.selectedOrderId) ? state.proposal : null;
}

function proposalPayload() {
  const envelope = proposalEnvelope();
  if (!envelope) return null;
  return envelope.proposal?.candidates?.length ? envelope.proposal : envelope;
}

function proposalCandidates() {
  return proposalPayload()?.candidates || [];
}

function canGenerateProposal(order) {
  return !!order && PROPOSAL_GENERATE_STATUSES.has(order.status);
}

function canConfirmProposal(order) {
  return !!order && PROPOSAL_CONFIRM_STATUSES.has(order.status);
}

function syncCandidateSelection() {
  const candidates = proposalCandidates();
  if (!candidates.length) {
    state.selectedCandidateMachineId = null;
    return null;
  }
  const candidateIds = new Set(candidates.map((item) => Number(item.machine_id)).filter(Boolean));
  const currentSelected = Number(state.selectedCandidateMachineId || 0);
  if (currentSelected && candidateIds.has(currentSelected)) {
    return currentSelected;
  }
  const envelope = proposalEnvelope();
  const fallbackMachineId =
    envelope?.replacement_machine_id || envelope?.selected_machine_id || envelope?.proposal?.selected_machine_id || candidates[0]?.machine_id || null;
  state.selectedCandidateMachineId = fallbackMachineId ? Number(fallbackMachineId) : null;
  return state.selectedCandidateMachineId;
}

function selectedMachineIdFromProposal() {
  return syncCandidateSelection();
}

function selectedCandidateFromProposal() {
  const selectedMachineId = Number(selectedMachineIdFromProposal() || 0);
  if (!selectedMachineId) return null;
  return proposalCandidates().find((item) => Number(item.machine_id) === selectedMachineId) || null;
}

function machineById(machineId) {
  return state.machines.find((item) => Number(item.id) === Number(machineId)) || null;
}

function riskLevelText(level) {
  const normalized = String(level || "").toLowerCase();
  return {
    low: "低风险",
    medium: "中风险",
    high: "高风险",
    severe: "极高风险",
  }[normalized] || (level || "未评估");
}

function riskBadgeClass(level) {
  const normalized = String(level || "").toLowerCase();
  if (["high", "severe"].includes(normalized)) return "danger";
  if (normalized === "medium") return "warning";
  if (normalized === "low") return "info";
  return "neutral";
}

function actionText(action) {
  const normalized = String(action || "").toLowerCase();
  return {
    continue: "可继续作业",
    monitor: "持续观察",
    pause: "建议暂停",
    reassign: "建议改派",
  }[normalized] || (action || "待判断");
}

function exceptionActionText(action) {
  const normalized = String(action || "").toLowerCase();
  return {
    reassign: "建议改派",
    pause: "建议暂停",
    refund: "建议取消并退款",
    cancel_refund: "建议取消并退款",
    observe: "持续观察",
  }[normalized] || (action || "待处理");
}

function renderDispatchFeedback(title, lines = []) {
  const safeLines = lines.filter(Boolean);
  dom.dispatchResult.innerHTML = `
    <div class="result-feedback">
      <strong>${escapeHtml(title)}</strong>
      ${safeLines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
    </div>
  `;
}

function paginate(items, page, pageSize) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  return {
    page: safePage,
    total,
    totalPages,
    startIndex,
    endIndex: Math.min(startIndex + pageSize, total),
    items: items.slice(startIndex, startIndex + pageSize),
  };
}

function renderPagination(container, items, page, pageSize, onPageChange) {
  const pager = paginate(items, page, pageSize);
  if (!pager.total) {
    container.innerHTML = "";
    return pager;
  }
  const buttons = [];
  for (let nextPage = 1; nextPage <= pager.totalPages; nextPage += 1) {
    buttons.push(
      `<button class="page-chip ${nextPage === pager.page ? "active" : ""}" data-page="${nextPage}" type="button">${nextPage}</button>`
    );
  }
  container.innerHTML = `
    <div class="pagination-meta">共 ${pager.total} 条，当前显示 ${pager.startIndex + 1}-${pager.endIndex} 条，第 ${pager.page}/${pager.totalPages} 页</div>
    <div class="pagination-actions compact">
      <button class="page-chip" type="button" data-page="${pager.page - 1}" ${pager.page <= 1 ? "disabled" : ""}>上一页</button>
      ${buttons.join("")}
      <button class="page-chip" type="button" data-page="${pager.page + 1}" ${pager.page >= pager.totalPages ? "disabled" : ""}>下一页</button>
    </div>
  `;
  container.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextPage = Number(button.dataset.page);
      if (!nextPage || nextPage === pager.page) return;
      onPageChange(nextPage);
    });
  });
  return pager;
}

function resetSelectionContext() {
  state.proposal = null;
  state.selectedOrder = null;
  state.selectedCandidateMachineId = null;
  state.weather = null;
  state.weatherError = "";
}

function ensureSelectedOrder({ keepActiveQueue = false } = {}) {
  const selectedOrderId = Number(state.selectedOrderId || 0);
  const activeOrders = queueOrders(state.activeQueue);

  if (activeOrders.some((item) => Number(item.id) === selectedOrderId)) {
    return;
  }

  if (keepActiveQueue) {
    state.selectedOrderId = activeOrders[0]?.id || null;
    return;
  }

  const queuePreference = [state.activeQueue, "waiting_dispatch", "waiting_machine_response", "abnormal", "active", "history"];
  const uniqueQueues = [...new Set(queuePreference)];
  for (const key of uniqueQueues) {
    const orders = queueOrders(key);
    if (orders.some((item) => Number(item.id) === selectedOrderId)) {
      state.activeQueue = key;
      return;
    }
  }
  for (const key of uniqueQueues) {
    const orders = queueOrders(key);
    if (orders.length) {
      state.activeQueue = key;
      state.selectedOrderId = orders[0].id;
      return;
    }
  }
  state.selectedOrderId = null;
}

function renderMetrics() {
  if (!state.overview) return;
  const metrics = state.overview.metrics;
  dom.supervisorMetrics.innerHTML = [
    metricCardHtml("总订单", metrics.total_orders, "平台当前订单规模"),
    metricCardHtml("待派单", metrics.waiting_dispatch, "支付完成但仍待主管确认派单"),
    metricCardHtml("待机主响应", metrics.waiting_machine_response, "派单已确认，等待机主接单"),
    metricCardHtml("异常订单", metrics.abnormal_orders, "天气、故障、改派相关订单"),
    metricCardHtml("活动订单", metrics.active_orders, "在途、作业中、待验收订单"),
    metricCardHtml("完成率", `${metrics.completion_rate}%`, "完成闭环订单占比"),
  ].join("");
}

function renderQueueTabs() {
  const labels = {
    waiting_dispatch: "待派单",
    waiting_machine_response: "待机主响应",
    abnormal: "异常池",
    active: "履约中",
    history: "历史",
  };
  dom.queueTabs.innerHTML = Object.entries(labels)
    .map(
      ([key, label]) =>
        `<button class="btn ${state.activeQueue === key ? "primary" : "secondary"}" data-queue="${key}">${escapeHtml(label)} (${queueOrders(key).length})</button>`
    )
    .join("");
  dom.queueTabs.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.activeQueue === button.dataset.queue) return;
      state.activeQueue = button.dataset.queue;
      renderQueueTabs();
      renderQueueOrders({ keepActiveQueue: true });
    });
  });
}

function renderQueueOrders(options = {}) {
  const previousOrderId = Number(state.selectedOrderId || 0);
  ensureSelectedOrder(options);
  if (Number(state.selectedOrderId || 0) !== previousOrderId) {
    resetSelectionContext();
  }
  const orders = queueOrders(state.activeQueue);
  renderQueueTabs();
  if (!orders.length) {
    dom.queueOrders.innerHTML = emptyState("当前队列没有订单。");
    resetSelectionContext();
    renderSelectedOrder();
    renderWeather();
    void renderMap();
    return;
  }
  dom.queueOrders.innerHTML = orders
    .map((item) => orderCardHtml(item, { selected: Number(item.id) === Number(state.selectedOrderId), counterpart: "buyer" }))
    .join("");
  dom.queueOrders.querySelectorAll(".order-card").forEach((card) => {
    card.addEventListener("click", () => {
      const nextId = Number(card.dataset.orderId);
      if (nextId !== Number(state.selectedOrderId)) {
        state.proposal = null;
        state.selectedCandidateMachineId = null;
      }
      state.selectedOrderId = nextId;
      renderQueueOrders();
    });
  });
  void loadSelectedOrder();
}

function renderSidePanels() {
  const regionPager = renderPagination(dom.regionHeatPagination, state.overview?.regions || [], state.pages.regionHeat, REGION_PAGE_SIZE, (nextPage) => {
    state.pages.regionHeat = nextPage;
    renderSidePanels();
  });
  state.pages.regionHeat = regionPager.page;
  dom.regionHeat.innerHTML = regionPager.items.map((item) => heatRowHtml(item)).join("") || emptyState("暂无区域数据");

  const ownerPager = renderPagination(dom.ownerRankPagination, state.overview?.owners || [], state.pages.ownerRank, OWNER_PAGE_SIZE, (nextPage) => {
    state.pages.ownerRank = nextPage;
    renderSidePanels();
  });
  state.pages.ownerRank = ownerPager.page;
  dom.ownerRank.innerHTML = ownerPager.items.map((item) => ownerRankHtml(item)).join("") || emptyState("暂无机主评分");

  const eventPager = renderPagination(dom.recentEventsPagination, state.overview?.recent_events || [], state.pages.recentEvents, EVENT_PAGE_SIZE, (nextPage) => {
    state.pages.recentEvents = nextPage;
    renderSidePanels();
  });
  state.pages.recentEvents = eventPager.page;
  dom.recentEvents.innerHTML =
    eventPager.items
      .map(
        (item) => `<div class="event-item">
          <div class="event-item-head">
            <strong>订单 #${escapeHtml(item.order_id)}</strong>
            <span class="muted">${escapeHtml(shortTime(item.created_at))}</span>
          </div>
          <p>${escapeHtml(item.summary)}</p>
        </div>`
      )
      .join("") || emptyState("暂无动态");
}

function updateActionButtons() {
  const order = state.selectedOrder;
  const selectedMachineId = selectedMachineIdFromProposal();
  const selectedCandidate = selectedCandidateFromProposal();
  dom.proposeDispatchBtn.disabled = !canGenerateProposal(order);
  dom.confirmDispatchBtn.disabled = !canConfirmProposal(order) || !selectedMachineId;
  dom.proposeDispatchBtn.textContent =
    !order || ["PAID_ESCROW", "DISPATCH_PROPOSED"].includes(order.status) ? "生成派单建议" : "生成改派建议";
  dom.confirmDispatchBtn.textContent =
    canConfirmProposal(order) && selectedMachineId
      ? `确认派给 #${selectedMachineId}${selectedCandidate?.machine_type ? ` ${selectedCandidate.machine_type}` : ""}`
      : "确认派给所选机具";
  dom.resumeBtn.disabled = !order || order.status !== "ABNORMAL_PENDING";
  dom.refundBtn.disabled = !order || !["ABNORMAL_PENDING", "DISPUTE"].includes(order.status);
  dom.weatherHandleBtn.disabled = !order;
  dom.faultHandleBtn.disabled = !order;
  dom.simulateStormBtn.disabled = !order;
  dom.clearWeatherBtn.disabled = !order;
}

function renderDispatchGuide() {
  const order = state.selectedOrder;
  const selectedMachineId = selectedMachineIdFromProposal();
  const selectedCandidate = selectedCandidateFromProposal();

  if (!order) {
    dom.dispatchGuide.innerHTML = `
      <strong>主管派单说明</strong>
      <p>先在左侧选择订单。待主管派单时，按钮位于中间“订单调度详情”区域顶部，紧挨在订单摘要下方。</p>
    `;
    return;
  }

  if (order.status === "PAID_ESCROW") {
    dom.dispatchGuide.innerHTML = `
      <strong>当前还在平台匹配前置阶段</strong>
      <p>先点击上方第一行左侧的“生成派单建议”。系统会按距离、ETA、天气、机况、报价生成候选，并把订单推进到“待主管派单”。</p>
    `;
    return;
  }

  if (order.status === "DISPATCH_PROPOSED") {
    dom.dispatchGuide.innerHTML = proposalCandidates().length
      ? `
        <strong>当前订单已进入待主管派单</strong>
        <p>按钮就在本卡片顶部两行操作区的第一行。先点下方某张候选机具卡片查看详情，再点击“${escapeHtml(dom.confirmDispatchBtn.textContent)}”完成派单。</p>
      `
      : `
        <strong>当前订单已进入待主管派单</strong>
        <p>这时主管要先点击顶部第一行左侧“生成派单建议”拉取候选列表，再从下方卡片里选择机具并确认派单。</p>
      `;
    return;
  }

  if (order.status === "ABNORMAL_PENDING") {
    dom.dispatchGuide.innerHTML = `
      <strong>当前订单处于异常待处理</strong>
      <p>可先用“天气自动处置”或“故障改派建议”生成建议；如果要直接重算候选，也可以点击顶部第一行左侧“生成改派建议”。</p>
    `;
    return;
  }

  if (order.status === "REASSIGN_PROPOSED") {
    dom.dispatchGuide.innerHTML = proposalCandidates().length
      ? `
        <strong>当前订单已进入待主管改派确认</strong>
        <p>请从候选卡片里选择替补机具，再点击“${escapeHtml(dom.confirmDispatchBtn.textContent)}”。${
          selectedMachineId && selectedCandidate ? `当前选中的是 #${escapeHtml(selectedMachineId)} ${escapeHtml(selectedCandidate.machine_type)}。` : ""
        }</p>
      `
      : `
        <strong>当前订单已进入待主管改派确认</strong>
        <p>请先点击顶部第一行左侧“生成改派建议”刷新候选机具，然后从下方卡片中选中替补机具并确认。</p>
      `;
    return;
  }

  if (["DISPATCH_CONFIRMED", "REASSIGN_CONFIRMED"].includes(order.status)) {
    dom.dispatchGuide.innerHTML = `
      <strong>主管派单已完成</strong>
      <p>当前订单已经派给机主侧等待响应。此时顶部派单按钮会置灰；若后续因拒单、改约或故障回流到待派单/改派处理中，再重新生成候选并确认。</p>
    `;
    return;
  }

  dom.dispatchGuide.innerHTML = `
    <strong>当前状态以履约或收尾动作为主</strong>
    <p>派单按钮仍位于订单摘要下方的第一行操作区；但当前订单状态不是主管确认派单节点，重点应转为异常处置、继续履约或退款闭环。</p>
  `;
}

function bindCandidateCardEvents() {
  dom.candidateTable.querySelectorAll(".candidate-card").forEach((card) => {
    const activate = () => {
      const nextMachineId = Number(card.dataset.machineId);
      if (!nextMachineId) return;
      state.selectedCandidateMachineId = nextMachineId;
      renderSelectedOrder();
      void renderMap();
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate();
    });
  });
}

function renderSelectedOrder() {
  const order = state.selectedOrder;
  updateActionButtons();
  if (!order) {
    dom.supervisorOrderSummary.textContent = "请选择左侧订单。";
    renderDispatchGuide();
    dom.candidateTable.innerHTML = emptyState("还没有候选评分。");
    dom.weatherPanel.innerHTML = "<pre>天气信息将在选择订单后显示。</pre>";
    dom.supervisorTimeline.innerHTML = "";
    return;
  }

  dom.supervisorOrderSummary.innerHTML = `
    <div class="card-topline">
      <div>
        <span class="eyebrow">主管视角订单 #${escapeHtml(order.id)}</span>
        <h3>${escapeHtml(order.sku.title)}</h3>
      </div>
      <span class="badge ${order.status === "ABNORMAL_PENDING" ? "danger" : "warning"}">${escapeHtml(order.stage_label)}</span>
    </div>
    <div class="order-line">${escapeHtml(order.target.region)} · ${escapeHtml(order.area_mu)} 亩 · ${escapeHtml(order.service_window)}</div>
    <div class="order-line muted">需求方 ${escapeHtml(order.buyer.name)} · 机主 ${escapeHtml(order.owner.name)} · 当前机具 ${escapeHtml(order.machine.machine_type || "待确认")}</div>
    <p class="order-note">${escapeHtml(order.logistics_text)}</p>
    <div class="section-divider"></div>
    <div class="order-line">最新动态：${escapeHtml(order.latest_event.summary || "暂无")}</div>
  `;
  dom.supervisorTimeline.innerHTML = timelineHtml(order.timeline);
  renderDispatchGuide();
  dom.candidateTable.innerHTML = candidateTableHtml(proposalCandidates(), selectedMachineIdFromProposal());
  bindCandidateCardEvents();
}

function renderWeather() {
  if (state.weatherError) {
    dom.weatherPanel.innerHTML = `<pre>${escapeHtml(state.weatherError)}</pre>`;
    return;
  }
  if (!state.weather) {
    dom.weatherPanel.innerHTML = "<pre>选择订单后可查看天气 API 返回的实时信息与处置建议。</pre>";
    return;
  }

  const risk = state.weather.risk || {};
  const machineContext = state.weather.machine_context || null;
  const badges = [
    `<span class="badge ${riskBadgeClass(risk.risk_level)}">风险 ${escapeHtml(riskLevelText(risk.risk_level))}</span>`,
    `<span class="badge ${riskBadgeClass(risk.risk_level)}">建议 ${escapeHtml(actionText(state.weather.suggested_action))}</span>`,
    `<span class="badge neutral">${escapeHtml(state.weather.provider || "天气服务")}</span>`,
    ...(risk.flags || []).slice(0, 3).map((flag) => `<span class="badge neutral">${escapeHtml(flag)}</span>`),
  ];
  const stats = [
    { value: `${state.weather.current.temperature_2m}°C`, label: "当前温度" },
    { value: `${risk.max_precip_probability}%`, label: "6小时最大降水概率" },
    { value: `${risk.max_wind_speed} km/h`, label: "6小时最大风速" },
    { value: `${risk.risk_score ?? "-"}`, label: "天气风险分" },
  ];
  if (machineContext) {
    stats.push({ value: `${machineContext.distance_km} km`, label: "当前机具距地块" });
    stats.push({ value: riskLevelText(machineContext.risk?.risk_level), label: "机具所在地天气" });
  }

  dom.weatherPanel.innerHTML = `
    <div class="weather-summary">${escapeHtml(state.weather.current.weather_text)}。${escapeHtml(state.weather.suggested_reason || risk.recommendation || "暂无补充建议。")}</div>
    <div class="tag-row">${badges.join("")}</div>
    <div class="weather-stat-grid">
      ${stats
        .map(
          (item) => `<div class="weather-stat">
            <strong>${escapeHtml(item.value)}</strong>
            <span>${escapeHtml(item.label)}</span>
          </div>`
        )
        .join("")}
    </div>
    ${
      machineContext
        ? `<div class="note-box">当前机具天气对比：${escapeHtml(machineContext.comparison_text || "暂无对比结果")}</div>`
        : ""
    }
    <table class="weather-hourly">
      <thead>
        <tr>
          <th>时间</th>
          <th>天气</th>
          <th>降水概率</th>
          <th>降水量</th>
          <th>风速</th>
        </tr>
      </thead>
      <tbody>
        ${(state.weather.hourly || [])
          .slice(0, 24)
          .map(
            (item) => `<tr>
              <td>${escapeHtml(shortTime(item.time) || item.time)}</td>
              <td>${escapeHtml(item.weather_text)}</td>
              <td>${escapeHtml(item.precipitation_probability)}%</td>
              <td>${escapeHtml(item.precipitation)} mm</td>
              <td>${escapeHtml(item.wind_speed_10m)} km/h</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

async function loadDispatchers() {
  const users = await request("/catalog/users");
  state.dispatchers = users.filter((item) => item.role === "dispatcher" || item.role === "admin");
  dom.dispatcherSelect.innerHTML = state.dispatchers
    .map((item) => `<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.region)}</option>`)
    .join("");
}

async function loadMachines() {
  state.machines = await request("/catalog/machines");
}

async function loadOverview() {
  state.overview = await request("/supervisor/overview");
  renderMetrics();
  renderSidePanels();
  renderQueueOrders();
}

async function loadSelectedOrder() {
  if (!state.selectedOrderId) {
    state.selectedOrder = null;
    state.selectedCandidateMachineId = null;
    state.weather = null;
    state.weatherError = "";
    renderSelectedOrder();
    renderWeather();
    await renderMap();
    return;
  }
  state.selectedOrder = await request(`/supervisor/orders/${state.selectedOrderId}`);
  if (state.proposal && Number(state.proposal.order_id) !== Number(state.selectedOrder.id)) {
    state.proposal = null;
    state.selectedCandidateMachineId = null;
  }
  if (!state.proposal) {
    state.selectedCandidateMachineId = null;
  } else {
    syncCandidateSelection();
  }
  try {
    state.weather = await request(`/weather/order/${state.selectedOrderId}`);
    state.weatherError = "";
  } catch (error) {
    state.weather = null;
    state.weatherError = error.message || String(error);
  }
  renderSelectedOrder();
  renderWeather();
  await renderMap();
}

function resetMapRuntime() {
  if (state.mapRuntime.instance?.destroy) {
    state.mapRuntime.instance.destroy();
  }
  state.mapRuntime.instance = null;
  state.mapRuntime.infoWindow = null;
  state.mapRuntime.overlays = [];
  dom.dispatchMapCanvas.innerHTML = "";
}

function setMapPlaceholder(message, visible = true) {
  dom.dispatchMapPlaceholder.textContent = message;
  dom.dispatchMapPlaceholder.classList.toggle("hidden", !visible);
}

function clearMapOverlays() {
  if (!state.mapRuntime.instance || !state.mapRuntime.overlays.length) return;
  state.mapRuntime.instance.remove(state.mapRuntime.overlays);
  state.mapRuntime.overlays = [];
}

function bindMarkerInfo(marker, html) {
  marker.on("click", () => {
    if (!state.mapRuntime.instance || !state.mapRuntime.infoWindow) return;
    state.mapRuntime.infoWindow.setContent(html);
    state.mapRuntime.infoWindow.open(state.mapRuntime.instance, marker.getPosition());
  });
}

async function ensureMapInstance() {
  const AMap = await ensureAMap();
  if (!state.mapRuntime.instance) {
    state.mapRuntime.instance = new AMap.Map(dom.dispatchMapCanvas, {
      zoom: 7,
      center: toAmapPosition(117.2, 36.6),
      resizeEnable: true,
    });
    state.mapRuntime.infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -26) });
  }
  return { AMap, map: state.mapRuntime.instance };
}

function midpointPosition(machine, order) {
  const [machineLng, machineLat] = toAmapPosition(machine.lng, machine.lat);
  const [targetLng, targetLat] = toAmapPosition(order.target.lng, order.target.lat);
  return [(machineLng + targetLng) / 2, (machineLat + targetLat) / 2];
}

function pinLabelStyle(tone = "normal") {
  const palette =
    tone === "target"
      ? { bg: "rgba(255, 248, 234, 0.96)", border: "rgba(214, 150, 31, 0.35)" }
      : tone === "selected"
        ? { bg: "rgba(242, 251, 246, 0.96)", border: "rgba(27, 127, 91, 0.34)" }
        : tone === "fault"
          ? { bg: "rgba(255, 245, 244, 0.96)", border: "rgba(204, 71, 61, 0.32)" }
          : { bg: "rgba(245, 248, 255, 0.96)", border: "rgba(63, 114, 175, 0.28)" };
  return {
    "background-color": palette.bg,
    border: `1px solid ${palette.border}`,
    "border-radius": "999px",
    color: "#2f2513",
    "font-size": "12px",
    "font-weight": "700",
    "line-height": "1",
    "padding": "8px 12px",
    "white-space": "nowrap",
    "box-shadow": "0 10px 22px rgba(78, 56, 14, 0.16)",
  };
}

function createPinOverlay(AMap, { position, tone = "normal", label, infoHtml }) {
  const marker = new AMap.Marker({
    position,
    anchor: "center",
    offset: new AMap.Pixel(0, 0),
    content: `<div class="map-pin-dot ${escapeHtml(tone)}"></div>`,
  });
  if (infoHtml) bindMarkerInfo(marker, infoHtml);
  const text = new AMap.Text({
    position,
    anchor: "bottom-center",
    offset: new AMap.Pixel(0, -18),
    text: label,
    style: pinLabelStyle(tone),
  });
  if (infoHtml) bindMarkerInfo(text, infoHtml);
  state.mapRuntime.overlays.push(marker, text);
  return marker;
}

function createRouteText(AMap, position, text, tone = "selected") {
  const marker = new AMap.Text({
    position,
    anchor: "center",
    offset: new AMap.Pixel(0, 0),
    text,
    style: pinLabelStyle(tone),
  });
  state.mapRuntime.overlays.push(marker);
  return marker;
}

async function renderMap() {
  const order = state.selectedOrder;
  clearMapOverlays();
  if (!order) {
    setMapPlaceholder("请选择左侧订单后查看调度地图。");
    return;
  }
  if (order.target.lng == null || order.target.lat == null) {
    setMapPlaceholder("当前订单缺少地块经纬度，暂时无法绘制调度地图。");
    return;
  }

  let mapPack;
  try {
    mapPack = await ensureMapInstance();
  } catch (error) {
    setMapPlaceholder(error.message || "地图加载失败");
    return;
  }

  setMapPlaceholder("", false);
  const { AMap, map } = mapPack;
  const fitOverlays = [];
  const candidates = proposalCandidates();
  const candidateMap = new Map(candidates.map((item) => [Number(item.machine_id), item]));
  const selectedMachineId = Number(selectedMachineIdFromProposal() || 0);
  const currentMachineId = Number(order.machine.id || 0);
  const machineIds = [...new Set([currentMachineId, selectedMachineId, ...candidates.map((item) => Number(item.machine_id))].filter(Boolean))];

  const targetMarker = createPinOverlay(AMap, {
    position: toAmapPosition(order.target.lng, order.target.lat),
    tone: "target",
    label: `地块 #${order.id}`,
    infoHtml: `<div><strong>订单 #${escapeHtml(order.id)}</strong><br />${escapeHtml(order.target.region)}<br />天气建议：${escapeHtml(actionText(state.weather?.suggested_action))}</div>`,
  });
  fitOverlays.push(targetMarker);

  for (const machineId of machineIds) {
    const machine = machineById(machineId);
    if (!machine) continue;
    const candidate = candidateMap.get(machineId);
    const tone =
      machineId === selectedMachineId
        ? "selected"
        : currentMachineId && machineId === currentMachineId && selectedMachineId && selectedMachineId !== currentMachineId
          ? "fault"
          : "normal";
    const marker = createPinOverlay(AMap, {
      position: toAmapPosition(machine.lng, machine.lat),
      tone,
      label: `#${machine.id} ${machine.machine_type}`,
      infoHtml: `<div>
        <strong>#${escapeHtml(machine.id)} ${escapeHtml(machine.machine_type)}</strong><br />
        机况分：${escapeHtml(machine.health_score)}<br />
        作业效率：${escapeHtml(machine.capacity_mu_per_hour)} 亩/小时<br />
        ${candidate ? `算法总分：${escapeHtml(candidate.score)}<br />ETA：${escapeHtml(candidate.eta_minutes)} 分钟` : "当前仅展示机具位置"}
      </div>`,
    });
    fitOverlays.push(marker);
  }

  for (const candidate of candidates) {
    const machine = machineById(candidate.machine_id);
    if (!machine) continue;
    const isSelected = Number(candidate.machine_id) === selectedMachineId;
    const polyline = new AMap.Polyline({
      path: [toAmapPosition(machine.lng, machine.lat), toAmapPosition(order.target.lng, order.target.lat)],
      strokeColor: isSelected ? "#0f7f68" : "#6b8d72",
      strokeWeight: isSelected ? 6 : 3,
      strokeStyle: isSelected ? "solid" : "dashed",
      strokeOpacity: isSelected ? 0.95 : 0.55,
    });
    const labelMarker = createRouteText(
      AMap,
      midpointPosition(machine, order),
      `${isSelected ? "推荐" : "候选"} #${candidate.machine_id} · ${candidate.score}分 · ${candidate.distance_km}km`,
      isSelected ? "selected" : "normal"
    );
    state.mapRuntime.overlays.push(polyline);
    fitOverlays.push(polyline);
  }

  if (currentMachineId && selectedMachineId && currentMachineId !== selectedMachineId) {
    const currentMachine = machineById(currentMachineId);
    if (currentMachine) {
      const faultLine = new AMap.Polyline({
        path: [toAmapPosition(currentMachine.lng, currentMachine.lat), toAmapPosition(order.target.lng, order.target.lat)],
        strokeColor: "#cc473d",
        strokeWeight: 4,
        strokeStyle: "dashed",
        strokeOpacity: 0.85,
      });
      state.mapRuntime.overlays.push(faultLine);
      fitOverlays.push(faultLine);
    }
  }

  if (state.mapRuntime.overlays.length) {
    map.add(state.mapRuntime.overlays);
  }
  if (fitOverlays.length) {
    map.setFitView(fitOverlays, false, [70, 70, 70, 70]);
  }
}

async function supervisorInsightFallback() {
  const order = state.selectedOrder;
  if (!order) return "请先选择订单，再生成 AI 解读。";
  try {
    if (proposalPayload()) {
      const explain = await request("/agents/explain", {
        method: "POST",
        body: JSON.stringify({
          decision_type: "dispatch",
          audience: "dispatcher",
          payload: proposalPayload(),
        }),
      });
      return explain.说明 || explain.detail || "已生成派单说明。";
    }
  } catch {
    // ignore
  }
  return `当前订单 #${order.id} 处于 ${order.stage_label}。天气建议为 ${actionText(state.weather?.suggested_action)}，请结合候选评分与异常状态做人工确认。`;
}

async function generateSupervisorInsight() {
  const order = state.selectedOrder;
  if (!order) {
    dom.supervisorAiInsight.innerHTML = "<pre>请先选择订单，再生成 AI 解读。</pre>";
    return;
  }
  const payload = {
    overview_metrics: state.overview?.metrics,
    order,
    proposal: proposalPayload(),
    weather: state.weather,
    current_queue: state.activeQueue,
  };
  dom.supervisorAiInsight.innerHTML = "<pre>AI 正在生成主管解读...</pre>";
  try {
    const full = await streamLLMChat({
      apiBase,
      stage: "主管端AI解读",
      messages: [
        {
          role: "system",
          content:
            "你是平台调度主管助理。请用中文输出 4 到 6 行简洁建议，说明当前订单是否该确认派单、是否需要天气处置、是否要关注运营指标。不要输出 JSON。",
        },
        {
          role: "user",
          content: `请根据以下上下文给出主管端建议：\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      onToken: (partial) => {
        dom.supervisorAiInsight.innerHTML = `<pre>${escapeHtml(partial)}</pre>`;
      },
    });
    dom.supervisorAiInsight.innerHTML = `<pre>${escapeHtml(full)}</pre>`;
  } catch (error) {
    const fallback = await supervisorInsightFallback();
    dom.supervisorAiInsight.innerHTML = `<pre>${escapeHtml(fallback)}\n\n[提示] ${escapeHtml(error.message || String(error))}</pre>`;
  }
}

async function runDispatchProposal() {
  const order = state.selectedOrder;
  if (!state.selectedOrderId || !order) return;
  const autoTransition = ["PAID_ESCROW", "ABNORMAL_PENDING"].includes(order.status);
  state.proposal = await request("/agents/dispatch/propose", {
    method: "POST",
    body: JSON.stringify({ order_id: state.selectedOrderId, auto_transition: autoTransition }),
  });
  syncCandidateSelection();
  const selectedCandidate = selectedCandidateFromProposal();
  renderDispatchFeedback(
    order.status === "ABNORMAL_PENDING" ? "已生成改派候选" : "已生成派单候选",
    [
      `本次共生成 ${proposalCandidates().length} 个候选机具。`,
      selectedCandidate ? `当前默认选中 #${selectedCandidate.machine_id} ${selectedCandidate.machine_type}，可在下方卡片切换。` : "当前暂无可直接确认的候选机具。",
      "原始算法 JSON 已隐藏，主管只需看卡片信息并完成确认。",
    ]
  );
  await loadOverview();
}

async function confirmDispatch() {
  if (!state.selectedOrderId || !proposalEnvelope()) return;
  const machineId = selectedMachineIdFromProposal();
  const candidate = selectedCandidateFromProposal();
  if (!machineId) {
    renderDispatchFeedback("当前没有可确认的候选机具", ["请先生成派单建议，或先在下方候选卡片中选中一台机具。"]);
    return;
  }
  const result = await request(`/supervisor/orders/${state.selectedOrderId}/dispatch/confirm`, {
    method: "POST",
    body: JSON.stringify({
      operator_id: currentDispatcherId(),
      machine_id: machineId,
      note: `主管端确认派给机具 #${machineId}${candidate?.machine_type ? ` ${candidate.machine_type}` : ""}`,
    }),
  });
  renderDispatchFeedback("已确认派单", [
    `订单 #${result.id} 已派给机具 #${machineId}${candidate?.machine_type ? ` ${candidate.machine_type}` : ""}。`,
    "订单已流转到机主待响应队列。",
  ]);
  await loadOverview();
}

async function simulateStorm() {
  if (!state.selectedOrderId) return;
  await request(`/weather/demo/order/${state.selectedOrderId}/scenario`, {
    method: "POST",
    body: JSON.stringify({
      target_scene: "severe_storm",
      machine_scene: "clear",
      apply_current_machine: true,
      clear_existing: true,
    }),
  });
  renderDispatchFeedback("已模拟目的地暴雨", ["请结合下方天气面板、地图和 AI 解读继续判断是否暂停或改派。"]);
  await loadSelectedOrder();
}

async function clearWeather() {
  if (!state.selectedOrderId) return;
  await request(`/weather/demo/order/${state.selectedOrderId}/scenario`, { method: "DELETE" });
  renderDispatchFeedback("已清除天气覆写", ["当前订单已恢复为默认天气数据。"]);
  await loadSelectedOrder();
}

async function handleWeather() {
  if (!state.selectedOrderId) return;
  renderDispatchFeedback("正在评估天气异常", ["系统正在读取目的地天气、比较当前机具位置，并生成暂停或改派建议。"]);
  try {
    state.proposal = await request("/agents/exception/handle", {
      method: "POST",
      body: JSON.stringify({
        order_id: state.selectedOrderId,
        event_type: "weather",
        description: "主管端发起天气异常自动处置",
        auto_transition: true,
      }),
    });
    syncCandidateSelection();
    const replacementId = state.proposal.replacement_machine_id || selectedMachineIdFromProposal();
    renderDispatchFeedback("已生成天气异常处置建议", [
      `系统建议：${exceptionActionText(state.proposal.action_type)}。`,
      state.proposal.reason || "",
      replacementId ? `已同步准备候选机具 #${replacementId}，可在下方卡片查看并确认。` : "当前未给出替补机具，建议先观察天气或暂停作业。",
    ]);
    await loadOverview();
  } catch (error) {
    renderDispatchFeedback("天气异常处置失败", [
      error.message || String(error),
      "通常是当前订单状态不允许进入异常处理，或天气服务暂时不可用。可以先选择履约中/已派单订单，或点击“模拟目的地暴雨”后再试。",
    ]);
  }
}

async function handleFault() {
  if (!state.selectedOrderId) return;
  renderDispatchFeedback("正在评估故障改派", ["系统正在排除当前机具并重新计算替补候选。"]);
  try {
    state.proposal = await request("/agents/exception/handle", {
      method: "POST",
      body: JSON.stringify({
        order_id: state.selectedOrderId,
        event_type: "fault",
        description: "主管端发起故障改派评估",
        auto_transition: true,
      }),
    });
    syncCandidateSelection();
    const replacementId = state.proposal.replacement_machine_id || selectedMachineIdFromProposal();
    renderDispatchFeedback("已生成故障改派建议", [
      `系统建议：${exceptionActionText(state.proposal.action_type)}。`,
      state.proposal.reason || "",
      replacementId ? `已同步准备候选机具 #${replacementId}，可在下方卡片查看并确认。` : "当前没有更优替补机具，建议先暂停并等待。",
    ]);
    await loadOverview();
  } catch (error) {
    renderDispatchFeedback("故障改派评估失败", [
      error.message || String(error),
      "通常是当前订单状态不允许进入异常处理。可以先选择履约中/已派单订单，或从农机端上报故障后再处理。",
    ]);
  }
}

async function resumeService() {
  if (!state.selectedOrderId) return;
  const result = await request(`/supervisor/orders/${state.selectedOrderId}/resume`, {
    method: "POST",
    body: JSON.stringify({ operator_id: currentDispatcherId(), note: "天气恢复，主管确认继续作业" }),
  });
  renderDispatchFeedback("已恢复继续作业", [`订单 #${result.id} 已恢复到履约流程。`]);
  await loadOverview();
}

async function refundOrder() {
  if (!state.selectedOrderId) return;
  const result = await request(`/supervisor/orders/${state.selectedOrderId}/refund`, {
    method: "POST",
    body: JSON.stringify({ operator_id: currentDispatcherId(), note: "无法继续履约，主管端取消并退款" }),
  });
  renderDispatchFeedback("已取消并退款", [`订单 #${result.id} 已完成退款闭环。`]);
  await loadOverview();
}

function bindFullscreen(button, target) {
  button.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement === target) {
        await document.exitFullscreen();
      } else {
        await target.requestFullscreen();
      }
    } catch {
      // ignore
    }
  });
}

async function init() {
  initPlatformSettings({
    onSave: async () => {
      resetMapRuntime();
      await renderMap();
    },
  });
  await loadDispatchers();
  await loadMachines();
  await loadOverview();
  bindFullscreen(dom.supervisorMapFullscreenBtn, dom.dispatchMapCanvas.closest(".map-shell"));

  dom.refreshOverviewBtn.addEventListener("click", () => void loadOverview());
  dom.dispatcherSelect.addEventListener("change", () => {
    state.selectedOrderId = null;
    state.proposal = null;
    state.selectedCandidateMachineId = null;
    void loadOverview();
  });
  dom.supervisorAiExplainBtn.addEventListener("click", () => void generateSupervisorInsight());
  dom.proposeDispatchBtn.addEventListener("click", () => void runDispatchProposal());
  dom.confirmDispatchBtn.addEventListener("click", () => void confirmDispatch());
  dom.simulateStormBtn.addEventListener("click", () => void simulateStorm());
  dom.clearWeatherBtn.addEventListener("click", () => void clearWeather());
  dom.weatherHandleBtn.addEventListener("click", () => void handleWeather());
  dom.faultHandleBtn.addEventListener("click", () => void handleFault());
  dom.resumeBtn.addEventListener("click", () => void resumeService());
  dom.refundBtn.addEventListener("click", () => void refundOrder());
}

init().catch((error) => {
  renderDispatchFeedback("主管端加载失败", [error.message || String(error)]);
  setMapPlaceholder(error.message || String(error));
});
