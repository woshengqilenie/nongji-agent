import { supervisorApi } from "./api.js";
import {
  badgeClass,
  emptyState,
  errorState,
  escapeHtml,
  metricCardHtml,
  money,
  orderCardHtml,
  shortTime,
  statusTone,
  timelineHtml,
} from "./shared.js";

const QUEUE_LABELS = {
  waiting_dispatch: "待派单",
  waiting_machine_response: "待响应",
  abnormal: "异常池",
  active: "履约中",
  history: "历史",
};

const state = {
  dispatchers: [],
  machines: [],
  overview: null,
  selectedOrderId: null,
  selectedOrder: null,
  activeQueue: "waiting_dispatch",
  proposal: null,
  selectedCandidateMachineId: null,
  weather: null,
};

const dom = {
  dispatcherName: document.getElementById("dispatcherName"),
  queueCount: document.getElementById("queueCount"),
  queueTabs: document.getElementById("queueTabs"),
  queueOrders: document.getElementById("queueOrders"),
  metricsGrid: document.getElementById("metricsGrid"),
  orderStatus: document.getElementById("orderStatus"),
  orderDetail: document.getElementById("orderDetail"),
  controlState: document.getElementById("controlState"),
  mapSearch: document.getElementById("mapSearch"),
  mapSummary: document.getElementById("mapSummary"),
  plotLayer: document.getElementById("plotLayer"),
  markerLayer: document.getElementById("markerLayer"),
  routeLayer: document.getElementById("routeLayer"),
  matchScore: document.getElementById("matchScore"),
  matchDevice: document.getElementById("matchDevice"),
  matchDriver: document.getElementById("matchDriver"),
  matchReasons: document.getElementById("matchReasons"),
  proposeBtn: document.getElementById("proposeBtn"),
  confirmBtn: document.getElementById("confirmBtn"),
  riskChip: document.getElementById("riskChip"),
  weatherCopy: document.getElementById("weatherCopy"),
  weatherGrid: document.getElementById("weatherGrid"),
  weatherHandleBtn: document.getElementById("weatherHandleBtn"),
  faultHandleBtn: document.getElementById("faultHandleBtn"),
  resumeBtn: document.getElementById("resumeBtn"),
  refundBtn: document.getElementById("refundBtn"),
  actionResult: document.getElementById("actionResult"),
  timeline: document.getElementById("timeline"),
};

function currentDispatcherId() {
  return Number(state.dispatchers[0]?.id || 1);
}

function queues() {
  return state.overview?.queues || {};
}

function queueOrders(queueKey = state.activeQueue) {
  return queues()[queueKey] || [];
}

function allOrders() {
  return Object.values(queues()).flat();
}

function selectedMachine() {
  const machineId = Number(state.selectedCandidateMachineId || state.selectedOrder?.machine?.id || 0);
  return state.machines.find((item) => Number(item.id) === machineId) || null;
}

function proposalPayload() {
  if (!state.proposal) return null;
  return state.proposal.proposal?.candidates ? state.proposal.proposal : state.proposal;
}

function proposalCandidates() {
  return proposalPayload()?.candidates || [];
}

function selectedCandidate() {
  const machineId = Number(state.selectedCandidateMachineId || 0);
  return proposalCandidates().find((item) => Number(item.machine_id) === machineId) || null;
}

function setStatusChip(el, text, tone) {
  el.textContent = text;
  el.className = `status-chip ${badgeClass(tone)}`;
}

function setActionResult(text, type = "empty") {
  dom.actionResult.innerHTML = type === "error" ? errorState(text) : emptyState(text);
}

function renderMetrics() {
  const metrics = state.overview?.metrics || {};
  dom.metricsGrid.innerHTML = [
    metricCardHtml("总订单", metrics.total_orders ?? "-", "primary"),
    metricCardHtml("待派单", metrics.waiting_dispatch ?? "-", "primary"),
    metricCardHtml("待响应", metrics.waiting_machine_response ?? "-", "blue"),
    metricCardHtml("异常订单", metrics.abnormal_orders ?? "-", "red"),
    metricCardHtml("活动订单", metrics.active_orders ?? "-", "green"),
    metricCardHtml("完成率", `${metrics.completion_rate ?? "-"}%`, "green"),
  ].join("");
}

function renderQueueTabs() {
  dom.queueTabs.innerHTML = Object.entries(QUEUE_LABELS)
    .map(([key, label]) => {
      const active = key === state.activeQueue ? "btn-primary" : "btn-secondary";
      return `<button class="${active}" data-queue="${escapeHtml(key)}" type="button">${escapeHtml(label)} ${queueOrders(key).length}</button>`;
    })
    .join("");
  dom.queueTabs.querySelectorAll("[data-queue]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeQueue = button.dataset.queue;
      state.selectedOrderId = queueOrders()[0]?.id || null;
      state.proposal = null;
      state.selectedCandidateMachineId = null;
      renderQueues();
      void loadSelectedOrder();
    });
  });
}

function ensureSelectedOrder() {
  if (state.selectedOrderId && allOrders().some((item) => Number(item.id) === Number(state.selectedOrderId))) return;
  state.selectedOrderId = queueOrders()[0]?.id || allOrders()[0]?.id || null;
  if (!queueOrders().some((item) => Number(item.id) === Number(state.selectedOrderId))) {
    const foundQueue = Object.keys(QUEUE_LABELS).find((key) => queueOrders(key).some((item) => Number(item.id) === Number(state.selectedOrderId)));
    if (foundQueue) state.activeQueue = foundQueue;
  }
}

function renderQueues() {
  ensureSelectedOrder();
  renderQueueTabs();
  const orders = queueOrders();
  dom.queueCount.textContent = String(orders.length);
  if (!orders.length) {
    dom.queueOrders.innerHTML = emptyState("当前队列没有订单。");
    return;
  }
  dom.queueOrders.innerHTML = orders.map((order) => orderCardHtml(order, state.selectedOrderId)).join("");
  dom.queueOrders.querySelectorAll("[data-order-id]").forEach((card) => {
    card.addEventListener("click", () => {
      const nextId = Number(card.dataset.orderId);
      if (nextId === Number(state.selectedOrderId)) return;
      state.selectedOrderId = nextId;
      state.proposal = null;
      state.selectedCandidateMachineId = null;
      renderQueues();
      void loadSelectedOrder();
    });
  });
}

function renderOrderDetail() {
  const order = state.selectedOrder;
  if (!order) {
    setStatusChip(dom.orderStatus, "未选择", "neutral");
    dom.orderDetail.innerHTML = emptyState("请先选择左侧订单。");
    dom.timeline.innerHTML = "";
    dom.controlState.textContent = "待选择";
    return;
  }
  const tone = statusTone(order);
  setStatusChip(dom.orderStatus, order.stage_label || order.status, tone);
  dom.controlState.textContent = order.status || "处理中";
  dom.orderDetail.innerHTML = `
    <div class="field-row"><span>订单</span><strong>#${escapeHtml(order.id)} ${escapeHtml(order.sku?.title || "农机服务")}</strong></div>
    <div class="field-row"><span>地块</span><strong>${escapeHtml(order.target?.region || "未知区域")}</strong></div>
    <div class="field-row"><span>面积</span><strong>${escapeHtml(order.area_mu || "-")} 亩</strong></div>
    <div class="field-row"><span>金额</span><strong>${money(order.amount)}</strong></div>
    <div class="field-row"><span>租赁方</span><strong>${escapeHtml(order.buyer?.name || "-")}</strong></div>
    <div class="field-row"><span>机主</span><strong>${escapeHtml(order.owner?.name || "待派单")}</strong></div>
  `;
  dom.timeline.innerHTML = timelineHtml(order.timeline || []);
}

function chooseDefaultCandidate() {
  const candidates = proposalCandidates();
  if (!candidates.length) {
    state.selectedCandidateMachineId = null;
    return;
  }
  const current = Number(state.selectedCandidateMachineId || 0);
  if (candidates.some((item) => Number(item.machine_id) === current)) return;
  state.selectedCandidateMachineId =
    state.proposal?.replacement_machine_id ||
    state.proposal?.selected_machine_id ||
    proposalPayload()?.selected_machine_id ||
    candidates[0].machine_id;
}

function renderCandidate() {
  chooseDefaultCandidate();
  const candidate = selectedCandidate();
  const order = state.selectedOrder;
  const canPropose = !!order && ["PAID_ESCROW", "DISPATCH_PROPOSED", "ABNORMAL_PENDING", "REASSIGN_PROPOSED"].includes(order.status);
  const canConfirm = !!order && !!candidate && ["DISPATCH_PROPOSED", "REASSIGN_PROPOSED"].includes(order.status);
  dom.proposeBtn.disabled = !canPropose;
  dom.confirmBtn.disabled = !canConfirm;
  dom.proposeBtn.textContent = order?.status === "ABNORMAL_PENDING" ? "生成改派建议" : "生成派单建议";
  dom.confirmBtn.textContent = candidate ? `确认派给 #${candidate.machine_id}` : "确认派单";

  if (!candidate) {
    dom.matchScore.textContent = "--";
    dom.matchScore.style.color = "var(--ag-text-secondary)";
    dom.matchScore.style.backgroundColor = "var(--ag-bg-base)";
    dom.matchDevice.textContent = order ? "暂无候选机具" : "暂无候选";
    dom.matchDriver.textContent = order ? "点击生成派单建议后显示候选评分。" : "先选择订单。";
    dom.matchReasons.innerHTML = "";
    return;
  }

  dom.matchScore.textContent = `${candidate.score} 分`;
  dom.matchScore.style.color = "var(--ag-crop-green)";
  dom.matchScore.style.backgroundColor = "var(--ag-crop-green-light)";
  dom.matchDevice.textContent = `#${candidate.machine_id} ${candidate.machine_type}`;
  dom.matchDriver.textContent = `${candidate.owner_name} · 距地块 ${candidate.distance_km} km · ETA ${candidate.eta_minutes} 分钟`;
  const tags = candidate.reason_tags?.length ? candidate.reason_tags : ["综合评分最高", "距离与机况匹配", "可作为当前推荐候选"];
  dom.matchReasons.innerHTML = tags.map((item) => `<span>${escapeHtml(item)}</span>`).join("");
}

function weatherTone(level) {
  const normalized = String(level || "").toLowerCase();
  if (["high", "severe"].includes(normalized)) return "risk";
  if (normalized === "medium") return "pending";
  if (normalized === "low") return "active";
  return "neutral";
}

function renderWeather() {
  if (!state.weather) {
    setStatusChip(dom.riskChip, "未评估", "neutral");
    dom.weatherCopy.textContent = "选择订单后自动读取天气上下文。";
    dom.weatherGrid.innerHTML = "";
    return;
  }
  const risk = state.weather.risk || {};
  const tone = weatherTone(risk.risk_level);
  setStatusChip(dom.riskChip, `风险 ${risk.risk_level || "未知"}`, tone);
  dom.weatherCopy.textContent = `${state.weather.current?.weather_text || "天气数据已读取"}。${state.weather.suggested_reason || risk.recommendation || "请结合时窗判断。"} `;
  dom.weatherGrid.innerHTML = [
    ["温度", `${state.weather.current?.temperature_2m ?? "-"}°C`],
    ["降水", `${risk.max_precip_probability ?? "-"}%`],
    ["风速", `${risk.max_wind_speed ?? "-"}km/h`],
  ]
    .map(([label, value]) => `<div class="weather-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`)
    .join("");
}

function normalizePosition(lng, lat) {
  const lngValue = Number(lng);
  const latValue = Number(lat);
  if (!Number.isFinite(lngValue) || !Number.isFinite(latValue)) return null;
  const left = 12 + (((lngValue * 31) % 72) + 72) % 72;
  const top = 20 + (((latValue * 37) % 56) + 56) % 56;
  return { left, top };
}

function machineById(machineId) {
  return state.machines.find((item) => Number(item.id) === Number(machineId)) || null;
}

function renderMap() {
  const order = state.selectedOrder;
  dom.plotLayer.innerHTML = "";
  dom.markerLayer.innerHTML = "";
  dom.routeLayer.innerHTML = "";
  if (!order) {
    dom.mapSearch.textContent = "请选择订单查看调度态势";
    dom.mapSummary.textContent = "选择左侧订单后，这里会展示地块、当前机具和候选机具关系。";
    return;
  }
  const target = normalizePosition(order.target?.lng, order.target?.lat) || { left: 42, top: 42 };
  const tone = statusTone(order);
  const plotClass = tone === "risk" ? "active" : "active";
  dom.plotLayer.innerHTML = `<div class="map-plot ${plotClass}" style="width: 148px; height: 104px; left: ${target.left}%; top: ${target.top}%">
    ${escapeHtml(order.target?.region || "订单地块")}<br />${escapeHtml(order.area_mu || "-")}亩
  </div>`;

  const ids = new Set([
    Number(order.machine?.id || 0),
    Number(state.selectedCandidateMachineId || 0),
    ...proposalCandidates().slice(0, 3).map((item) => Number(item.machine_id || 0)),
  ]);
  const markers = [...ids].filter(Boolean).map((id, index) => {
    const machine = machineById(id);
    const pos = normalizePosition(machine?.lng, machine?.lat) || { left: target.left + 10 + index * 8, top: target.top + 8 + index * 6 };
    const klass = id === Number(state.selectedCandidateMachineId) ? "working" : tone === "risk" && id === Number(order.machine?.id) ? "risk" : "";
    return { id, machine, pos, klass };
  });
  dom.markerLayer.innerHTML = markers
    .map((item) => `<div class="map-marker ${item.klass}" style="left:${item.pos.left}%; top:${item.pos.top}%" title="#${item.id} ${escapeHtml(item.machine?.machine_type || "农机")}"></div>`)
    .join("");
  dom.routeLayer.innerHTML = markers
    .map((item) => {
      const width = Math.max(90, Math.hypot(item.pos.left - target.left, item.pos.top - target.top) * 7);
      const angle = Math.atan2(target.top - item.pos.top, target.left - item.pos.left) * (180 / Math.PI);
      const color = item.klass === "risk" ? "var(--ag-risk-red)" : item.klass === "working" ? "var(--ag-primary)" : "var(--ag-machine-blue)";
      return `<div class="route-line" style="left:${item.pos.left}%; top:${item.pos.top}%; width:${width}px; transform: rotate(${angle}deg); background: linear-gradient(90deg, rgba(255,255,255,0.2), ${color})"></div>`;
    })
    .join("");
  dom.mapSearch.textContent = `订单 #${order.id} · ${order.target?.region || "未知地块"} · ${order.stage_label || order.status}`;
  dom.mapSummary.textContent = `当前地块面积 ${order.area_mu || "-"} 亩，已展示 ${markers.length} 台相关农机。${selectedCandidate() ? "高亮点为当前推荐候选。" : "生成派单建议后会高亮候选路线。"}`;
}

function renderAll() {
  renderMetrics();
  renderQueues();
  renderOrderDetail();
  renderCandidate();
  renderWeather();
  renderMap();
}

async function loadOverview() {
  state.overview = await supervisorApi.overview();
  renderMetrics();
  renderQueues();
}

async function loadSelectedOrder() {
  if (!state.selectedOrderId) {
    state.selectedOrder = null;
    state.weather = null;
    renderAll();
    return;
  }
  state.selectedOrder = await supervisorApi.order(state.selectedOrderId);
  try {
    state.weather = await supervisorApi.weather(state.selectedOrderId);
  } catch {
    state.weather = null;
  }
  renderOrderDetail();
  renderCandidate();
  renderWeather();
  renderMap();
}

async function refreshAfterAction(message) {
  setActionResult(message);
  await loadOverview();
  await loadSelectedOrder();
}

async function runProposal() {
  if (!state.selectedOrder) return;
  try {
    const autoTransition = ["PAID_ESCROW", "ABNORMAL_PENDING"].includes(state.selectedOrder.status);
    state.proposal = await supervisorApi.proposeDispatch(state.selectedOrder.id, autoTransition);
    chooseDefaultCandidate();
    await refreshAfterAction(`已生成 ${proposalCandidates().length} 个候选机具。`);
  } catch (error) {
    setActionResult(error.message || String(error), "error");
  }
}

async function confirmDispatch() {
  const candidate = selectedCandidate();
  if (!state.selectedOrder || !candidate) return;
  try {
    await supervisorApi.confirmDispatch(state.selectedOrder.id, {
      operator_id: currentDispatcherId(),
      machine_id: candidate.machine_id,
      note: `v2 主管端确认派给机具 #${candidate.machine_id}`,
    });
    state.proposal = null;
    state.selectedCandidateMachineId = null;
    await refreshAfterAction(`已确认派给机具 #${candidate.machine_id}。`);
  } catch (error) {
    setActionResult(error.message || String(error), "error");
  }
}

async function handleException(eventType) {
  if (!state.selectedOrder) return;
  try {
    state.proposal = await supervisorApi.handleException({
      order_id: state.selectedOrder.id,
      event_type: eventType,
      description: `v2 主管端发起${eventType === "weather" ? "天气" : "故障"}异常处置`,
      auto_transition: true,
    });
    chooseDefaultCandidate();
    await refreshAfterAction(`已生成${eventType === "weather" ? "天气" : "故障"}处置建议。`);
  } catch (error) {
    setActionResult(error.message || String(error), "error");
  }
}

async function simpleOrderAction(kind) {
  if (!state.selectedOrder) return;
  try {
    if (kind === "resume") {
      await supervisorApi.resume(state.selectedOrder.id, { operator_id: currentDispatcherId(), note: "v2 主管端恢复继续作业" });
      await refreshAfterAction("已恢复继续作业。");
    } else {
      await supervisorApi.refund(state.selectedOrder.id, { operator_id: currentDispatcherId(), note: "v2 主管端取消并退款" });
      await refreshAfterAction("已取消并退款。");
    }
  } catch (error) {
    setActionResult(error.message || String(error), "error");
  }
}

function bindEvents() {
  dom.proposeBtn.addEventListener("click", () => void runProposal());
  dom.confirmBtn.addEventListener("click", () => void confirmDispatch());
  dom.weatherHandleBtn.addEventListener("click", () => void handleException("weather"));
  dom.faultHandleBtn.addEventListener("click", () => void handleException("fault"));
  dom.resumeBtn.addEventListener("click", () => void simpleOrderAction("resume"));
  dom.refundBtn.addEventListener("click", () => void simpleOrderAction("refund"));
}

async function init() {
  bindEvents();
  setActionResult("选择订单后可以生成派单建议或处理异常。");
  state.dispatchers = await supervisorApi.dispatchers();
  state.machines = await supervisorApi.machines();
  dom.dispatcherName.textContent = state.dispatchers[0] ? `主管：${state.dispatchers[0].name}` : "主管身份未配置";
  await loadOverview();
  await loadSelectedOrder();
}

init().catch((error) => {
  dom.queueOrders.innerHTML = errorState(error.message || String(error));
  dom.orderDetail.innerHTML = errorState(error.message || String(error));
});
