import {
  apiBase,
  badgeHtml,
  emptyState,
  escapeHtml,
  money,
  orderCardHtml,
  request,
  serviceCardHtml,
  shortTime,
  timelineHtml,
} from "./shared.js";
import { ensureAMap, extractJsonObject, initPlatformSettings, streamLLMChat, toAmapPosition } from "./platform.js";

const SERVICE_PAGE_SIZE = 4;
const ORDER_PAGE_SIZE = 4;

const WORK_TYPE_LABELS = {
  all: "全部",
  "收割": "收割",
  "播种": "播种",
  "耕地": "耕整",
  "耕整": "耕整",
  "植保": "植保",
};

const state = {
  buyers: [],
  machines: [],
  categories: [],
  services: [],
  orders: [],
  selectedWorkType: "all",
  selectedServiceId: null,
  selectedOrderId: null,
  previewDraft: false,
  servicePage: 1,
  orderPage: 1,
  weather: null,
  weatherError: "",
  mapRuntime: {
    instance: null,
    infoWindow: null,
    overlays: [],
  },
};

const dom = {
  categoryList: document.getElementById("categoryList"),
  serviceToolbar: document.getElementById("serviceToolbar"),
  serviceList: document.getElementById("serviceList"),
  servicePagination: document.getElementById("servicePagination"),
  selectedServiceBox: document.getElementById("selectedServiceBox"),
  buyerSelect: document.getElementById("buyerSelect"),
  areaInput: document.getElementById("areaInput"),
  urgencySelect: document.getElementById("urgencySelect"),
  scheduleStartInput: document.getElementById("scheduleStartInput"),
  lngInput: document.getElementById("lngInput"),
  latInput: document.getElementById("latInput"),
  requirementInput: document.getElementById("requirementInput"),
  createPayBtn: document.getElementById("createPayBtn"),
  refreshOrdersBtn: document.getElementById("refreshOrdersBtn"),
  orderActionHint: document.getElementById("orderActionHint"),
  myOrders: document.getElementById("myOrders"),
  orderPagination: document.getElementById("orderPagination"),
  orderDetail: document.getElementById("orderDetail"),
  quickDemandText: document.getElementById("quickDemandText"),
  parseDemandBtn: document.getElementById("parseDemandBtn"),
  parseResult: document.getElementById("parseResult"),
  rentAiExplainBtn: document.getElementById("rentAiExplainBtn"),
  rentAiInsight: document.getElementById("rentAiInsight"),
  rentMapCanvas: document.getElementById("rentMapCanvas"),
  rentMapPlaceholder: document.getElementById("rentMapPlaceholder"),
  rentMapFullscreenBtn: document.getElementById("rentMapFullscreenBtn"),
  rentWeatherPanel: document.getElementById("rentWeatherPanel"),
};

function localDateTimeValue(hoursAhead = 16) {
  const date = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDateToken(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function toLocalDateTimeInputValue(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function formatPromptNow(date = new Date()) {
  return `${formatDateToken(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function hasScheduleSignal(text) {
  return /(今天|今日|今早|今晚|明天|明早|明晚|后天|大后天|早上|早晨|上午|中午|下午|傍晚|晚上|凌晨|\d{1,2}\s*点|\d{1,2}\s*[:：]\s*\d{2}|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}月\d{1,2}日)/.test(
    text
  );
}

function detectSchedulePeriod(text) {
  if (/凌晨/.test(text)) return "凌晨";
  if (/(早上|早晨|上午)/.test(text)) return "早上";
  if (/中午/.test(text)) return "中午";
  if (/下午/.test(text)) return "下午";
  if (/傍晚/.test(text)) return "傍晚";
  if (/(晚上|今晚|明晚)/.test(text)) return "晚上";
  return "";
}

function detectScheduleDate(text, baseDate = new Date()) {
  const explicitFull = text.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?/);
  if (explicitFull) {
    return new Date(Number(explicitFull[1]), Number(explicitFull[2]) - 1, Number(explicitFull[3]));
  }
  const explicitMonthDay = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (explicitMonthDay) {
    return new Date(baseDate.getFullYear(), Number(explicitMonthDay[1]) - 1, Number(explicitMonthDay[2]));
  }
  const day = new Date(baseDate);
  day.setHours(0, 0, 0, 0);
  if (text.includes("大后天")) {
    day.setDate(day.getDate() + 3);
    return day;
  }
  if (text.includes("后天")) {
    day.setDate(day.getDate() + 2);
    return day;
  }
  if (/(明天|明早|明晚)/.test(text)) {
    day.setDate(day.getDate() + 1);
    return day;
  }
  if (/(今天|今日|今早|今晚)/.test(text) || hasScheduleSignal(text)) {
    return day;
  }
  return null;
}

function formatChineseClock(hour, minute = 0, preferredPeriod = "") {
  const period =
    preferredPeriod ||
    (hour < 6 ? "凌晨" : hour < 12 ? "早上" : hour === 12 ? "中午" : hour < 18 ? "下午" : hour < 19 ? "傍晚" : "晚上");
  const displayHour =
    period === "下午" || period === "傍晚" || period === "晚上" ? (hour > 12 ? hour - 12 : hour) : hour;
  if (minute) {
    return `${period}${displayHour}点${minute}分`;
  }
  return `${period}${displayHour}点`;
}

function detectScheduleClock(text) {
  const preferredPeriod = detectSchedulePeriod(text);
  const colonMatch = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (colonMatch) {
    const hour = Math.max(0, Math.min(23, Number(colonMatch[1])));
    const minute = Math.max(0, Math.min(59, Number(colonMatch[2])));
    return { hour, minute, label: formatChineseClock(hour, minute, preferredPeriod) };
  }

  const hourMatch = text.match(/(?:(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上)\s*)?(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分?)?/);
  if (hourMatch) {
    const explicitPeriod = hourMatch[1] ? detectSchedulePeriod(hourMatch[1]) : preferredPeriod;
    let hour = Math.max(0, Math.min(23, Number(hourMatch[2])));
    const minute = hourMatch[3] === "半" ? 30 : hourMatch[4] ? Math.max(0, Math.min(59, Number(hourMatch[4]))) : 0;
    if (["下午", "傍晚", "晚上"].includes(explicitPeriod) && hour < 12) {
      hour += 12;
    } else if (explicitPeriod === "中午" && hour < 11) {
      hour = 12;
    }
    return { hour, minute, label: formatChineseClock(hour, minute, explicitPeriod) };
  }

  const defaults = {
    凌晨: 5,
    早上: 8,
    中午: 12,
    下午: 14,
    傍晚: 18,
    晚上: 19,
  };
  const hour = defaults[preferredPeriod || "早上"] || 8;
  return { hour, minute: 0, label: formatChineseClock(hour, 0, preferredPeriod || "早上") };
}

function resolveScheduleHint(value, baseDate = new Date()) {
  const text = String(value || "").trim();
  if (!text || !hasScheduleSignal(text)) {
    return { text: "", localValue: "" };
  }
  const scheduleDate = detectScheduleDate(text, baseDate);
  if (!scheduleDate) {
    return { text: "", localValue: "" };
  }
  const clock = detectScheduleClock(text);
  const resolved = new Date(
    scheduleDate.getFullYear(),
    scheduleDate.getMonth(),
    scheduleDate.getDate(),
    clock.hour,
    clock.minute,
    0,
    0
  );
  return {
    text: `${formatDateToken(resolved)} ${clock.label}`,
    localValue: toLocalDateTimeInputValue(resolved),
  };
}

function displayWorkType(value) {
  return WORK_TYPE_LABELS[value] || value || "未识别";
}

function normalizeWorkTypeKey(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  const mapping = {
    harvest: "收割",
    "收割": "收割",
    seeding: "播种",
    "播种": "播种",
    tillage: "耕地",
    till: "耕地",
    "耕地": "耕地",
    "耕整": "耕地",
    protection: "植保",
    spray: "植保",
    "植保": "植保",
  };
  return mapping[normalized] || null;
}

function normalizeUrgencyLevel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "medium";
  if (["high", "加急", "紧急", "高", "high_priority"].includes(normalized)) return "high";
  if (["low", "普通", "低", "不着急"].includes(normalized)) return "low";
  return "medium";
}

function normalizeAreaMu(value) {
  const numeric = Number(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function currentBuyerId() {
  return Number(dom.buyerSelect.value || 0);
}

function currentService() {
  return state.services.find((item) => Number(item.sku_id) === Number(state.selectedServiceId)) || null;
}

function currentOrder() {
  if (state.previewDraft) return null;
  return state.orders.find((item) => Number(item.id) === Number(state.selectedOrderId)) || null;
}

function currentMachineForMap() {
  const order = currentOrder();
  if (order?.machine?.id && orderHasConfirmedMachine(order)) {
    return state.machines.find((item) => Number(item.id) === Number(order.machine.id)) || null;
  }
  return null;
}

function orderHasConfirmedMachine(order) {
  return [
    "DISPATCH_CONFIRMED",
    "REASSIGN_CONFIRMED",
    "IN_SERVICE",
    "TO_CONFIRM",
    "COMPLETED",
    "ABNORMAL_PENDING",
    "DISPUTE",
    "REFUNDING",
    "REFUNDED",
  ].includes(order?.status);
}

function parseCoordinateInput(input) {
  const raw = String(input?.value ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function currentTargetPosition() {
  const order = currentOrder();
  if (order && order.target.lng != null && order.target.lat != null) {
    return {
      lng: Number(order.target.lng),
      lat: Number(order.target.lat),
      label: `订单地块 #${order.id}`,
      detail: order.target.region,
    };
  }
  const lng = parseCoordinateInput(dom.lngInput);
  const lat = parseCoordinateInput(dom.latInput);
  if (lng != null && lat != null) {
    return {
      lng,
      lat,
      label: "表单地块预览",
      detail: `经纬度 ${lng.toFixed(4)}, ${lat.toFixed(4)}`,
    };
  }
  return null;
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

function renderCategories() {
  dom.categoryList.innerHTML = state.categories
    .map(
      (item) => `<button class="category-item ${item.key === state.selectedWorkType ? "active" : ""}" data-key="${escapeHtml(item.key)}">
        <span>${escapeHtml(item.label)}</span>
        <strong>${escapeHtml(item.count)}</strong>
      </button>`
    )
    .join("");

  dom.categoryList.querySelectorAll(".category-item").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedWorkType = button.dataset.key;
      state.servicePage = 1;
      state.selectedServiceId = null;
      void loadServices();
    });
  });
}

function renderToolbar(home) {
  dom.serviceToolbar.innerHTML = (home.highlights || [])
    .map((item) => `<span class="hint-chip">${escapeHtml(item.label)} ${escapeHtml(item.value)}</span>`)
    .join("");
}

function renderServices() {
  if (!state.services.length) {
    dom.serviceList.innerHTML = emptyState("当前筛选条件下暂无可售服务");
    dom.selectedServiceBox.innerHTML = "当前没有匹配服务。";
    dom.servicePagination.innerHTML = "";
    return;
  }

  const pager = renderPagination(dom.servicePagination, state.services, state.servicePage, SERVICE_PAGE_SIZE, (nextPage) => {
    state.servicePage = nextPage;
    renderServices();
  });
  state.servicePage = pager.page;
  const pageItems = pager.items;
  if (!pageItems.some((item) => Number(item.sku_id) === Number(state.selectedServiceId))) {
    state.selectedServiceId = pageItems[0]?.sku_id || null;
  }
  dom.serviceList.innerHTML = pageItems.map((item) => serviceCardHtml(item, state.selectedServiceId)).join("");
  dom.serviceList.querySelectorAll(".service-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedServiceId = Number(card.dataset.skuId);
      state.previewDraft = true;
      renderServices();
      renderSelectedService();
      void renderMap();
    });
  });
  renderSelectedService();
}

function renderSelectedService() {
  const service = currentService();
  if (!service) {
    dom.selectedServiceBox.innerHTML = "请选择一个服务卡片。";
    return;
  }
  dom.selectedServiceBox.innerHTML = `
    <strong>${escapeHtml(service.title)}</strong>
    <p class="section-note">${escapeHtml(service.summary)}</p>
    <div class="tag-row">
      <span class="tag">机主 ${escapeHtml(service.owner_name)}</span>
      <span class="tag">${escapeHtml(service.owner_rating)} 分</span>
      <span class="tag">${escapeHtml(service.eta_minutes)} 分钟响应</span>
    </div>
    <div class="section-divider"></div>
    <div class="order-line">起步价 ${money(service.unit_price)}/${escapeHtml(service.unit)} · ${escapeHtml(service.region)}</div>
    <div class="order-line muted">当前机具 ${escapeHtml(service.machine_type || "待确认")} · 覆盖半径 ${escapeHtml(service.radius_km)} km</div>
  `;
}

function canConfirmAcceptance(order) {
  return !!order && order.status === "TO_CONFIRM";
}

async function confirmAcceptance() {
  const order = currentOrder();
  if (!order) return;
  if (!canConfirmAcceptance(order)) {
    dom.orderActionHint.textContent = "当前订单还未进入待验收阶段，暂不能确认验收。";
    return;
  }
  await request(`/orders/${order.id}/confirm?operator_id=${currentBuyerId()}`, {
    method: "POST",
  });
  dom.orderActionHint.textContent = `订单 #${order.id} 已由租赁端确认验收，订单已完成闭环。`;
  await loadOrders();
}

function renderOrders() {
  if (!state.orders.length) {
    dom.myOrders.innerHTML = emptyState("当前租赁方还没有订单，先从左侧选一个服务下单吧。");
    dom.orderPagination.innerHTML = "";
    dom.orderDetail.innerHTML = "";
    return;
  }
  if (!state.previewDraft && !currentOrder()) {
    state.selectedOrderId = state.orders[0].id;
  }
  const selectedIndex = state.orders.findIndex((item) => Number(item.id) === Number(state.selectedOrderId));
  if (selectedIndex >= 0) {
    state.orderPage = Math.floor(selectedIndex / ORDER_PAGE_SIZE) + 1;
  }
  const pager = renderPagination(dom.orderPagination, state.orders, state.orderPage, ORDER_PAGE_SIZE, (nextPage) => {
    state.orderPage = nextPage;
    renderOrders();
  });
  state.orderPage = pager.page;
  const pageItems = pager.items;
  if (!state.previewDraft && !pageItems.some((item) => Number(item.id) === Number(state.selectedOrderId)) && !currentOrder()) {
    state.selectedOrderId = pageItems[0]?.id || null;
  }
  dom.myOrders.innerHTML = pageItems
    .map((item) => orderCardHtml(item, { selected: Number(item.id) === Number(state.selectedOrderId), counterpart: "owner" }))
    .join("");
  dom.myOrders.querySelectorAll(".order-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedOrderId = Number(card.dataset.orderId);
      state.previewDraft = false;
      renderOrders();
      void syncOrderContext();
    });
  });

  const selected = currentOrder();
  if (!selected) return;
  const confirmDisabled = !canConfirmAcceptance(selected);
  const acceptanceHint = confirmDisabled
    ? selected.status === "COMPLETED"
      ? "当前订单已完成验收闭环。"
      : "只有订单进入“待验收”后，租赁端才能确认验收。"
    : "机手完工后，租赁端在这里点击“确认验收”即可完成闭环。";
  dom.orderDetail.innerHTML = `
    <div class="note-box">
      <div class="card-topline">
        <div>
          <span class="eyebrow">订单追踪</span>
          <h3>${escapeHtml(selected.sku.title)}</h3>
        </div>
        ${badgeHtml(selected)}
      </div>
      <div class="order-line">${escapeHtml(selected.target.region)} · ${escapeHtml(selected.service_window)}</div>
      <div class="order-line muted">机主 ${escapeHtml(selected.owner.name)} · 当前机具 ${escapeHtml(selected.machine.machine_type || "待确认")}</div>
      <p class="order-note">${escapeHtml(selected.logistics_text)}</p>
    </div>
    <div class="note-box">
      <div class="card-topline">
        <div>
          <span class="eyebrow">租赁端操作</span>
          <h3>验收入口</h3>
        </div>
        <span class="badge ${confirmDisabled ? "neutral" : "success"}">${escapeHtml(selected.stage_label)}</span>
      </div>
      <p class="order-note">${escapeHtml(acceptanceHint)}</p>
      <div class="inline-actions">
        <button id="confirmAcceptanceBtn" class="btn primary" ${confirmDisabled ? "disabled" : ""}>确认验收</button>
      </div>
    </div>
    ${timelineHtml(selected.timeline)}
  `;
  const confirmBtn = document.getElementById("confirmAcceptanceBtn");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => void confirmAcceptance());
  }
}

function weatherPanelHtml(snapshot, emptyText) {
  if (state.weatherError) {
    return `<pre>${escapeHtml(state.weatherError)}</pre>`;
  }
  if (!snapshot) {
    return `<pre>${escapeHtml(emptyText)}</pre>`;
  }

  const risk = snapshot.risk || {};
  const machineContext = snapshot.machine_context || null;
  const badges = [
    `<span class="badge ${String(risk.risk_level || "").toLowerCase() === "high" ? "danger" : String(risk.risk_level || "").toLowerCase() === "medium" ? "warning" : "info"}">风险 ${escapeHtml(risk.risk_level || "未评估")}</span>`,
    `<span class="badge neutral">${escapeHtml(snapshot.provider || "天气服务")}</span>`,
    ...(risk.flags || []).slice(0, 3).map((flag) => `<span class="badge neutral">${escapeHtml(flag)}</span>`),
  ];
  const stats = [
    { value: `${snapshot.current.temperature_2m}°C`, label: "当前温度" },
    { value: `${risk.max_precip_probability}%`, label: "降水概率" },
    { value: `${risk.max_wind_speed} km/h`, label: "最大风速" },
    { value: `${risk.risk_score ?? "-"}`, label: "风险分" },
  ];
  if (machineContext) {
    stats.push({ value: `${machineContext.distance_km} km`, label: "机具距地块" });
  }
  return `
    <div class="weather-summary">${escapeHtml(snapshot.current.weather_text)}。${escapeHtml(snapshot.suggested_reason || risk.recommendation || "可据此评估下单时机。")}</div>
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
        ? `<div class="note-box">当前绑定机具天气对比：${escapeHtml(machineContext.comparison_text || "暂无对比结果")}</div>`
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
        ${(snapshot.hourly || [])
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

function renderWeather() {
  const emptyText = currentOrder()
    ? "当前订单天气暂时不可用。"
    : "填写地块坐标或选择订单后，可查看天气预览。";
  dom.rentWeatherPanel.innerHTML = weatherPanelHtml(state.weather, emptyText);
}

function demandMessages(text) {
  const nowText = formatPromptNow(new Date());
  return [
    {
      role: "system",
      content:
        `你是农机服务下单助手。请把用户需求解析成一个 JSON 对象，只输出 JSON，不要输出解释。字段固定为 work_type、area_mu、urgency_level、budget_range、quality_constraints、schedule_hint。work_type 只允许 收割/播种/耕地/植保 之一；urgency_level 只允许 high/medium/low。当前用户本地时间为 ${nowText}。如果用户提到 今天/明天/后天/大后天/早上/上午/下午/晚上 这类相对时间，必须换算成带实际日期和明确时点的 schedule_hint，不要保留相对说法。默认规则：早上或上午默认早上8点，下午默认下午2点，中午默认中午12点，晚上默认晚上7点；如果用户明确说了具体几点，就保留具体钟点。示例：若当前时间是 2026-04-23 10:00，则“大后天早上”输出为“2026-04-26 早上8点”，“下午”输出为“2026-04-23 下午2点”。`,
    },
    {
      role: "user",
      content: `请解析这段中文下单需求：${text}`,
    },
  ];
}

function normalizeDemandResult(raw, text) {
  const schedule = resolveScheduleHint(raw.schedule_hint || raw.schedule || raw.time || text);
  return {
    task_id: raw.task_id || `demand-${Date.now()}`,
    work_type: normalizeWorkTypeKey(raw.work_type || raw.category || raw.service_type || raw.job_type),
    area_mu: normalizeAreaMu(raw.area_mu || raw.area || raw.acreage || raw.size),
    budget_range: String(raw.budget_range || raw.budget || raw.price_expectation || "").trim(),
    urgency_level: normalizeUrgencyLevel(raw.urgency_level || raw.urgency || raw.priority),
    quality_constraints: String(raw.quality_constraints || raw.requirements || raw.note || text).trim(),
    schedule_hint: schedule.text,
    schedule_start_local: schedule.localValue,
    raw_text: raw.raw_text || text,
  };
}

function renderParseResult(payload) {
  dom.parseResult.innerHTML = `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
}

async function applyParsedDemand(result, sourceLabel) {
  const mappedWorkType = normalizeWorkTypeKey(result.work_type);
  if (mappedWorkType) {
    state.selectedWorkType = mappedWorkType;
    state.servicePage = 1;
    await loadServices();
    const matched = state.services.find((item) => item.work_type === mappedWorkType);
    if (matched) {
      state.selectedServiceId = matched.sku_id;
      renderServices();
    }
  }
  if (result.area_mu) {
    dom.areaInput.value = result.area_mu;
  }
  dom.urgencySelect.value = normalizeUrgencyLevel(result.urgency_level);
  if (result.schedule_start_local) {
    dom.scheduleStartInput.value = result.schedule_start_local;
  }
  dom.requirementInput.value = result.quality_constraints || dom.requirementInput.value || "";
  dom.orderActionHint.textContent = `${sourceLabel}已帮你填充表单，可直接核对后下单。`;
  await syncOrderContext();
}

async function parseDemandWithLLM(text) {
  let streamText = "";
  const full = await streamLLMChat({
    apiBase,
    stage: "租赁端需求解析",
    messages: demandMessages(text),
    onToken: (partial) => {
      streamText = partial;
      dom.parseResult.innerHTML = `<pre>${escapeHtml(partial)}</pre>`;
    },
  });
  const raw = extractJsonObject(full);
  if (!raw) {
    throw new Error(streamText || full || "模型输出不是合法 JSON");
  }
  const normalized = normalizeDemandResult(raw, text);
  if (!normalized.work_type) {
    throw new Error("模型已返回内容，但未识别出作业类型");
  }
  return { raw, normalized };
}

function rentInsightFallback() {
  const order = currentOrder();
  const service = currentService();
  const target = currentTargetPosition();
  const weather = state.weather;
  const lines = [];
  if (service) {
    lines.push(`推荐先看 ${service.title}，机主 ${service.owner_name}，响应约 ${service.eta_minutes} 分钟。`);
  }
  if (target) {
    lines.push(`当前地块坐标为 ${target.lng.toFixed(4)}, ${target.lat.toFixed(4)}。`);
  }
  if (weather?.risk) {
    lines.push(`天气风险 ${weather.risk.risk_level || "未评估"}，建议 ${weather.suggested_reason || weather.risk.recommendation || "结合天气再确认作业窗口"}。`);
  }
  if (order) {
    lines.push(`已选订单 #${order.id} 当前阶段为 ${order.stage_label}，可重点关注 ${order.logistics_text}。`);
  } else {
    lines.push("如果准备新下单，建议先核对面积、时窗和坐标，再发起托管支付。");
  }
  return lines.join("\n");
}

async function generateRentInsight() {
  const service = currentService();
  const order = currentOrder();
  if (!service && !order) {
    dom.rentAiInsight.innerHTML = "<pre>请先选择服务或订单，再生成 AI 建议。</pre>";
    return;
  }
  const target = currentTargetPosition();
  const payload = {
    service,
    order,
    weather: state.weather,
    target,
    draft_form: {
      area_mu: Number(dom.areaInput.value),
      urgency_level: dom.urgencySelect.value,
      schedule_start: dom.scheduleStartInput.value,
      requirement: dom.requirementInput.value.trim(),
    },
  };
  dom.rentAiInsight.innerHTML = "<pre>AI 正在生成下单建议...</pre>";
  try {
    const full = await streamLLMChat({
      apiBase,
      stage: "租赁端AI建议",
      messages: [
        {
          role: "system",
          content:
            "你是农机租赁端的下单顾问。请用中文给出简洁建议，重点回答当前天气是否适合下单、这台服务是否匹配、下单前还要核对什么。输出 4 到 6 行短句，不要使用 JSON。",
        },
        {
          role: "user",
          content: `请根据以下上下文给租赁方建议：\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      onToken: (partial) => {
        dom.rentAiInsight.innerHTML = `<pre>${escapeHtml(partial)}</pre>`;
      },
    });
    dom.rentAiInsight.innerHTML = `<pre>${escapeHtml(full)}</pre>`;
  } catch (error) {
    dom.rentAiInsight.innerHTML = `<pre>${escapeHtml(rentInsightFallback())}\n\n[提示] ${escapeHtml(error.message || String(error))}</pre>`;
  }
}

async function loadBuyers() {
  const users = await request("/catalog/users");
  state.buyers = users.filter((item) => item.role === "buyer");
  dom.buyerSelect.innerHTML = state.buyers
    .map((item) => `<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.region)}</option>`)
    .join("");
}

async function loadMachines() {
  state.machines = await request("/catalog/machines");
}

async function loadHome() {
  const home = await request("/market/home");
  const totalCount = (home.categories || []).reduce((sum, item) => sum + Number(item.count || 0), 0);
  state.categories = [
    { key: "all", label: "全部", count: totalCount },
    ...(home.categories || []).map((item) => ({
      key: item.key || item.label,
      label: displayWorkType(item.label),
      count: item.count,
    })),
  ];
  renderCategories();
  renderToolbar(home);
}

async function loadServices() {
  const workType = state.selectedWorkType !== "all" ? `?work_type=${encodeURIComponent(state.selectedWorkType)}` : "";
  state.services = await request(`/market/services${workType}`);
  renderCategories();
  renderServices();
  await renderMap();
}

async function loadOrders() {
  const buyerId = currentBuyerId();
  if (!buyerId) return;
  state.orders = await request(`/market/orders?buyer_id=${buyerId}`);
  renderOrders();
  await syncOrderContext();
}

async function loadWeather() {
  const order = currentOrder();
  try {
    if (order) {
      state.weather = await request(`/weather/order/${order.id}`);
      state.weatherError = "";
      return;
    }
    const target = currentTargetPosition();
    if (target) {
      state.weather = await request(`/weather/point?lng=${encodeURIComponent(target.lng)}&lat=${encodeURIComponent(target.lat)}`);
      state.weatherError = "";
      return;
    }
    state.weather = null;
    state.weatherError = "";
  } catch (error) {
    state.weather = null;
    state.weatherError = error.message || String(error);
  }
}

function resetMapRuntime() {
  if (state.mapRuntime.instance?.destroy) {
    state.mapRuntime.instance.destroy();
  }
  state.mapRuntime.instance = null;
  state.mapRuntime.infoWindow = null;
  state.mapRuntime.overlays = [];
  dom.rentMapCanvas.innerHTML = "";
}

function setMapPlaceholder(message, visible = true) {
  dom.rentMapPlaceholder.textContent = message;
  dom.rentMapPlaceholder.classList.toggle("hidden", !visible);
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
    state.mapRuntime.instance = new AMap.Map(dom.rentMapCanvas, {
      zoom: 7,
      center: toAmapPosition(117.2, 36.6),
      resizeEnable: true,
    });
    state.mapRuntime.infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -26) });
  }
  return { AMap, map: state.mapRuntime.instance };
}

function midpointPosition(machine, target) {
  const [machineLng, machineLat] = toAmapPosition(machine.lng, machine.lat);
  const [targetLng, targetLat] = toAmapPosition(target.lng, target.lat);
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
  const target = currentTargetPosition();
  const machine = currentMachineForMap();
  clearMapOverlays();
  if (!target && !machine) {
    setMapPlaceholder("填写地块坐标或选择订单后，可查看地块地图；主管确认派单后才会显示农机和路线。");
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

  if (target) {
    const targetMarker = createPinOverlay(AMap, {
      position: toAmapPosition(target.lng, target.lat),
      tone: "target",
      label: target.label,
      infoHtml: `<div><strong>${escapeHtml(target.label)}</strong><br />${escapeHtml(target.detail)}</div>`,
    });
    fitOverlays.push(targetMarker);
  }

  if (machine) {
    const machineMarker = createPinOverlay(AMap, {
      position: toAmapPosition(machine.lng, machine.lat),
      tone: currentOrder()?.machine?.id ? "selected" : "normal",
      label: `#${machine.id} ${machine.machine_type}`,
      infoHtml: `<div><strong>#${escapeHtml(machine.id)} ${escapeHtml(machine.machine_type)}</strong><br />机况分：${escapeHtml(machine.health_score)}<br />作业效率：${escapeHtml(machine.capacity_mu_per_hour)} 亩/小时</div>`,
    });
    fitOverlays.push(machineMarker);
  }

  if (target && machine) {
    const polyline = new AMap.Polyline({
      path: [toAmapPosition(machine.lng, machine.lat), toAmapPosition(target.lng, target.lat)],
      strokeColor: "#0f7f68",
      strokeWeight: 5,
      strokeOpacity: 0.85,
    });
    const labelMarker = createRouteText(AMap, midpointPosition(machine, target), "订单履约路径");
    state.mapRuntime.overlays.push(polyline);
    fitOverlays.push(polyline);
  }

  if (state.mapRuntime.overlays.length) {
    map.add(state.mapRuntime.overlays);
  }
  if (fitOverlays.length) {
    map.setFitView(fitOverlays, false, [70, 70, 70, 70]);
  }
}

async function syncOrderContext() {
  await loadWeather();
  renderWeather();
  await renderMap();
}

async function parseDemand() {
  const text = dom.quickDemandText.value.trim();
  if (!text) {
    dom.parseResult.innerHTML = "<pre>请输入一句话需求再解析。</pre>";
    return;
  }

  dom.parseResult.innerHTML = "<pre>正在尝试通过大模型解析需求...</pre>";
  try {
    const llmResult = await parseDemandWithLLM(text);
    await applyParsedDemand(llmResult.normalized, "AI 解析");
    renderParseResult({
      来源: "AI 大模型",
      解析结果: {
        作业类型: displayWorkType(llmResult.normalized.work_type),
        作业面积_亩: llmResult.normalized.area_mu,
        紧急程度: llmResult.normalized.urgency_level,
        作业时间: llmResult.normalized.schedule_hint || "未提及",
        预算区间: llmResult.normalized.budget_range || "未提及",
        作业要求: llmResult.normalized.quality_constraints,
      },
      原始输出: llmResult.raw,
    });
  } catch (llmError) {
    try {
      const fallback = await request("/agents/demand/parse", {
        method: "POST",
        body: JSON.stringify({ text, buyer_id: currentBuyerId() }),
      });
      const normalized = normalizeDemandResult(fallback, text);
      await applyParsedDemand(normalized, "规则解析");
      renderParseResult({
        来源: "后端规则回退",
        AI失败原因: llmError.message || String(llmError),
        解析结果: {
          作业类型: displayWorkType(normalized.work_type),
          作业面积_亩: normalized.area_mu,
          紧急程度: normalized.urgency_level,
          作业时间: normalized.schedule_hint || "未提及",
          预算区间: normalized.budget_range || "未提及",
          作业要求: normalized.quality_constraints,
        },
        原始输出: fallback,
      });
    } catch (fallbackError) {
      renderParseResult({
        来源: "解析失败",
        AI失败原因: llmError.message || String(llmError),
        回退失败原因: fallbackError.message || String(fallbackError),
      });
      dom.orderActionHint.textContent = "需求解析失败，请手动填写或检查大模型设置。";
    }
  }
}

async function createAndPay() {
  const service = currentService();
  if (!service) {
    dom.orderActionHint.textContent = "请先选择一个服务卡片。";
    return;
  }
  const createPayload = {
    buyer_id: currentBuyerId(),
    sku_id: Number(service.sku_id),
    area_mu: Number(dom.areaInput.value),
    urgency_level: dom.urgencySelect.value,
    quality_constraints: dom.requirementInput.value.trim(),
    schedule_start: dom.scheduleStartInput.value ? new Date(dom.scheduleStartInput.value).toISOString() : null,
    target_lng: Number(dom.lngInput.value),
    target_lat: Number(dom.latInput.value),
  };
  const order = await request("/orders", {
    method: "POST",
    body: JSON.stringify(createPayload),
  });
  await request(`/orders/${order.id}/pay?operator_id=${currentBuyerId()}`, { method: "POST" });
  dom.orderActionHint.textContent = `订单 #${order.id} 已创建并进入托管支付，可切换到主管端继续派单。`;
  state.selectedOrderId = order.id;
  state.previewDraft = false;
  await loadOrders();
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
      // ignore fullscreen errors in unsupported environments
    }
  });
}

async function init() {
  initPlatformSettings({
    onSave: async () => {
      resetMapRuntime();
      await syncOrderContext();
    },
  });
  dom.scheduleStartInput.value = localDateTimeValue();
  await loadBuyers();
  await loadMachines();
  await loadHome();
  await loadServices();
  await loadOrders();
  bindFullscreen(dom.rentMapFullscreenBtn, dom.rentMapCanvas.closest(".map-shell"));

  dom.buyerSelect.addEventListener("change", () => {
    state.selectedOrderId = null;
    state.orderPage = 1;
    void loadOrders();
  });
  dom.parseDemandBtn.addEventListener("click", () => void parseDemand());
  dom.createPayBtn.addEventListener("click", () => void createAndPay());
  dom.refreshOrdersBtn.addEventListener("click", () => void loadOrders());
  dom.rentAiExplainBtn.addEventListener("click", () => void generateRentInsight());
  [dom.lngInput, dom.latInput, dom.areaInput, dom.scheduleStartInput, dom.requirementInput, dom.urgencySelect].forEach((input) => {
    input.addEventListener("change", () => {
      state.previewDraft = true;
      void syncOrderContext();
    });
  });
}

init().catch((error) => {
  dom.orderActionHint.textContent = error.message || String(error);
  dom.parseResult.innerHTML = `<pre>${escapeHtml(error.message || String(error))}</pre>`;
});
