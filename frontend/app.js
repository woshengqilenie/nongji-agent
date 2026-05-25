const LLM_STORAGE_KEY = "llm_config_v1";
const MAP_STORAGE_KEY = "map_config_v1";
const DEMO_DELAY_MS = {
  short: 5000,
  normal: 5000,
  long: 5000,
};

const state = {
  apiBase: `${window.location.origin}/api`,
  users: [],
  machines: [],
  skus: [],
  orders: [],
  currentOrder: null,
  currentWeather: null,
  lastDispatchProposal: null,
  lastExceptionResult: null,
  lastAgentPayload: null,
  llmConfig: {
    endpoint: "",
    apiKey: "",
    model: "deepseek-chat",
  },
  mapConfig: {
    key: "",
    securityJsCode: "",
  },
  mapStageText: "等待订单",
  mapRuntime: {
    map: null,
    infoWindow: null,
    loadPromise: null,
    overlays: [],
    loadedKey: "",
  },
  demoRunning: false,
};

const dom = {
  apiBaseText: document.getElementById("apiBaseText"),
  llmStatusText: document.getElementById("llmStatusText"),
  mapStatusText: document.getElementById("mapStatusText"),
  llmConfigBtn: document.getElementById("llmConfigBtn"),
  mapConfigBtn: document.getElementById("mapConfigBtn"),
  llmModal: document.getElementById("llmModal"),
  llmEndpointInput: document.getElementById("llmEndpointInput"),
  llmApiKeyInput: document.getElementById("llmApiKeyInput"),
  llmModelInput: document.getElementById("llmModelInput"),
  mapKeyInput: document.getElementById("mapKeyInput"),
  mapSecurityCodeInput: document.getElementById("mapSecurityCodeInput"),
  mapConfigSection: document.getElementById("mapConfigSection"),
  llmSaveBtn: document.getElementById("llmSaveBtn"),
  llmCloseBtn: document.getElementById("llmCloseBtn"),
  llmClearBtn: document.getElementById("llmClearBtn"),
  llmHintText: document.getElementById("llmHintText"),
  mapHintText: document.getElementById("mapHintText"),
  refreshAllBtn: document.getElementById("refreshAllBtn"),
  demoStandardBtn: document.getElementById("demoStandardBtn"),
  demoWeatherBtn: document.getElementById("demoWeatherBtn"),
  demoFaultBtn: document.getElementById("demoFaultBtn"),
  demoClearBtn: document.getElementById("demoClearBtn"),
  demoOutput: document.getElementById("demoOutput"),
  mapCanvas: document.getElementById("mapCanvas"),
  mapPlaceholder: document.getElementById("mapPlaceholder"),
  mapSummaryText: document.getElementById("mapSummaryText"),
  mapOrderText: document.getElementById("mapOrderText"),
  mapStageText: document.getElementById("mapStageText"),
  mapSelectionText: document.getElementById("mapSelectionText"),
  weatherSummaryText: document.getElementById("weatherSummaryText"),
  weatherHandleBtn: document.getElementById("weatherHandleBtn"),
  weatherRecheckBtn: document.getElementById("weatherRecheckBtn"),
  weatherResumeBtn: document.getElementById("weatherResumeBtn"),
  weatherRefundBtn: document.getElementById("weatherRefundBtn"),
  weatherRiskBadges: document.getElementById("weatherRiskBadges"),
  weatherMetricsGrid: document.getElementById("weatherMetricsGrid"),
  weatherHourlyOutput: document.getElementById("weatherHourlyOutput"),
  demandText: document.getElementById("demandText"),
  parseDemandBtn: document.getElementById("parseDemandBtn"),
  demandResult: document.getElementById("demandResult"),
  buyerSelect: document.getElementById("buyerSelect"),
  skuSelect: document.getElementById("skuSelect"),
  areaInput: document.getElementById("areaInput"),
  urgencySelect: document.getElementById("urgencySelect"),
  qualityInput: document.getElementById("qualityInput"),
  lngInput: document.getElementById("lngInput"),
  latInput: document.getElementById("latInput"),
  createOrderBtn: document.getElementById("createOrderBtn"),
  createOrderHint: document.getElementById("createOrderHint"),
  targetOrderIdInput: document.getElementById("targetOrderIdInput"),
  operatorInput: document.getElementById("operatorInput"),
  payBtn: document.getElementById("payBtn"),
  dispatchBtn: document.getElementById("dispatchBtn"),
  confirmDispatchBtn: document.getElementById("confirmDispatchBtn"),
  startBtn: document.getElementById("startBtn"),
  finishBtn: document.getElementById("finishBtn"),
  confirmBtn: document.getElementById("confirmBtn"),
  markAbnormalBtn: document.getElementById("markAbnormalBtn"),
  exceptionType: document.getElementById("exceptionType"),
  exceptionDesc: document.getElementById("exceptionDesc"),
  exceptionBtn: document.getElementById("exceptionBtn"),
  explainBtn: document.getElementById("explainBtn"),
  agentOutput: document.getElementById("agentOutput"),
  metricsGrid: document.getElementById("metricsGrid"),
  statusList: document.getElementById("statusList"),
  orderTbody: document.getElementById("orderTbody"),
  eventsOutput: document.getElementById("eventsOutput"),
};

function setCode(el, obj) {
  el.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

function formatApiError(data) {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return "未知错误";
  if (typeof data.详情 === "string") return data.详情;
  if (typeof data.detail === "string") return data.detail;
  if (data.详情 && typeof data.详情 === "object") {
    if (data.详情.错误) return data.详情.错误;
    return JSON.stringify(data.详情);
  }
  if (data.detail && typeof data.detail === "object") {
    if (data.detail.错误) return data.detail.错误;
    return JSON.stringify(data.detail);
  }
  if (data.错误) return String(data.错误);
  return JSON.stringify(data);
}

function appendDemoLog(step, payload) {
  const stamp = new Date().toLocaleTimeString();
  const line = `[${stamp}] ${step}`;
  if (!dom.demoOutput.textContent) {
    dom.demoOutput.textContent = line;
  } else {
    dom.demoOutput.textContent += `\n${line}`;
  }
  if (payload !== undefined) {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    dom.demoOutput.textContent += `\n${text}\n`;
  } else {
    dom.demoOutput.textContent += "\n";
  }
  dom.demoOutput.scrollTop = dom.demoOutput.scrollHeight;
}

function clearDemoLog() {
  dom.demoOutput.textContent = "";
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setDemoButtonsDisabled(disabled) {
  state.demoRunning = disabled;
  dom.demoStandardBtn.disabled = disabled;
  dom.demoWeatherBtn.disabled = disabled;
  dom.demoFaultBtn.disabled = disabled;
  dom.demoClearBtn.disabled = disabled;
  dom.demoStandardBtn.textContent = disabled ? "演示进行中..." : "标准派单演示";
  dom.demoWeatherBtn.textContent = disabled ? "演示进行中..." : "天气暂停演示";
  dom.demoFaultBtn.textContent = disabled ? "演示进行中..." : "故障改派演示";
}

async function pauseAfterStep(ms = DEMO_DELAY_MS.normal) {
  if (ms > 0) {
    await sleep(ms);
  }
}

async function runDemoStep(label, task, options = {}) {
  const { startText, pauseMs = DEMO_DELAY_MS.normal } = options;
  appendDemoLog(startText || `${label}：处理中`);
  const result = await task();
  appendDemoLog(label, result);
  await pauseAfterStep(pauseMs);
  return result;
}

function loadLLMConfig() {
  try {
    const raw = localStorage.getItem(LLM_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.llmConfig = {
      endpoint: parsed.endpoint || "",
      apiKey: parsed.apiKey || "",
      model: parsed.model || "deepseek-chat",
    };
  } catch {
    // ignore invalid local storage
  }
}

function loadMapConfig() {
  try {
    const raw = localStorage.getItem(MAP_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.mapConfig = {
      key: parsed.key || "",
      securityJsCode: parsed.securityJsCode || "",
    };
  } catch {
    // ignore invalid local storage
  }
}

function saveLLMConfig() {
  localStorage.setItem(LLM_STORAGE_KEY, JSON.stringify(state.llmConfig));
  localStorage.setItem(MAP_STORAGE_KEY, JSON.stringify(state.mapConfig));
}

function clearLLMConfig() {
  state.llmConfig = { endpoint: "", apiKey: "", model: "deepseek-chat" };
  localStorage.removeItem(LLM_STORAGE_KEY);
}

function clearMapConfig() {
  state.mapConfig = { key: "", securityJsCode: "" };
  localStorage.removeItem(MAP_STORAGE_KEY);
}

function updateLLMStatus() {
  const endpointReady = !!state.llmConfig.endpoint;
  const keyReady = !!state.llmConfig.apiKey;
  const model = state.llmConfig.model || "deepseek-chat";
  const statusText = endpointReady
    ? `LLM: 已配置 (${model})`
    : `LLM: 未配置URL（可用后端环境变量）`;
  dom.llmStatusText.textContent = statusText;
  dom.llmHintText.textContent = keyReady
    ? "当前使用手动填写的 API Key。"
    : "API Key 留空时将尝试使用后端环境变量 LLM_API_KEY。";

  const mapReady = !!state.mapConfig.key;
  dom.mapStatusText.textContent = mapReady ? "地图：已配置高德 Key" : "地图：未配置";
  dom.mapHintText.textContent = mapReady
    ? "地图会联动当前订单、候选农机和最终派单结果。"
    : "请填写高德 Key；如控制台启用了安全密钥，也一并填写。";
}

function openLLMModal() {
  dom.llmEndpointInput.value = state.llmConfig.endpoint;
  dom.llmApiKeyInput.value = state.llmConfig.apiKey;
  dom.llmModelInput.value = state.llmConfig.model || "deepseek-chat";
  dom.mapKeyInput.value = state.mapConfig.key || "";
  dom.mapSecurityCodeInput.value = state.mapConfig.securityJsCode || "";
  dom.llmModal.classList.remove("hidden");
}

function openMapModal() {
  openLLMModal();
  window.setTimeout(() => {
    dom.mapConfigSection?.scrollIntoView({ behavior: "smooth", block: "center" });
    dom.mapKeyInput?.focus();
  }, 0);
}

function closeLLMModal() {
  dom.llmModal.classList.add("hidden");
}

function applyLLMFormToState() {
  state.llmConfig.endpoint = dom.llmEndpointInput.value.trim();
  state.llmConfig.apiKey = dom.llmApiKeyInput.value.trim();
  state.llmConfig.model = dom.llmModelInput.value.trim() || "deepseek-chat";
  state.mapConfig.key = dom.mapKeyInput.value.trim();
  state.mapConfig.securityJsCode = dom.mapSecurityCodeInput.value.trim();
}

async function request(path, options = {}) {
  const resp = await fetch(`${state.apiBase}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await resp.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // keep raw text
  }
  if (!resp.ok) {
    throw new Error(formatApiError(data));
  }
  return data;
}

async function clearAllDemoWeatherOverrides() {
  try {
    await request("/weather/demo/overrides", { method: "DELETE" });
  } catch {
    // ignore cleanup failure
  }
}

async function applyDemoWeatherScenario(orderId, payload) {
  return request(`/weather/demo/order/${orderId}/scenario`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function canResumeWeatherOrder(order, weather) {
  if (!order || order.status !== "ABNORMAL_PENDING") return false;
  const suggestedAction = weather?.suggested_action || "continue";
  return suggestedAction !== "pause";
}

function canRefundWeatherOrder(order) {
  return !!order && order.status === "ABNORMAL_PENDING";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeRiskLevel(level) {
  return ["high", "medium", "low"].includes(level) ? level : "low";
}

function riskLevelText(level) {
  if (level === "high") return "高风险";
  if (level === "medium") return "中风险";
  return "低风险";
}

function actionHintText(action) {
  if (action === "pause") return "建议暂停";
  if (action === "reassign") return "建议改派";
  if (action === "watch") return "建议观察";
  return "可继续执行";
}

function setMapPlaceholder(message, hidden = false) {
  if (hidden) {
    dom.mapPlaceholder.classList.add("hidden");
    return;
  }
  dom.mapPlaceholder.textContent = message;
  dom.mapPlaceholder.classList.remove("hidden");
}

function updateMapMeta() {
  const order = state.currentOrder;
  dom.mapOrderText.textContent = order
    ? `当前订单：#${order.id} · ${order.status}`
    : "当前订单：未选择";
  dom.mapStageText.textContent = `当前阶段：${state.mapStageText}`;

  const exceptionPayload =
    state.lastExceptionResult && order && state.lastExceptionResult.order_id === order.id ? state.lastExceptionResult : null;
  const dispatchPayload =
    state.lastDispatchProposal && order && state.lastDispatchProposal.order_id === order.id ? state.lastDispatchProposal : null;

  if (exceptionPayload?.replacement_machine_id) {
    dom.mapSelectionText.textContent = `当前结果：建议改派到 #${exceptionPayload.replacement_machine_id}`;
  } else if (dispatchPayload?.selected_machine_id) {
    dom.mapSelectionText.textContent = `当前结果：推荐 #${dispatchPayload.selected_machine_id}`;
  } else if (order?.machine_id) {
    dom.mapSelectionText.textContent = `当前结果：已指派 #${order.machine_id}`;
  } else {
    dom.mapSelectionText.textContent = "当前结果：暂无";
  }

  dom.mapSummaryText.textContent = order
    ? "当前仅展示该订单的目的地、候选比较和最终派单结果。"
    : "当前未选择订单，仅展示全部农机位置。";
}

function setMapStage(text) {
  state.mapStageText = text || "等待订单";
  updateMapMeta();
}

function renderWeatherPanel() {
  const weather = state.currentWeather;
  if (!weather) {
    dom.weatherSummaryText.textContent = "选择订单后，将显示目的地当前天气与未来 6 小时风险。";
    dom.weatherHandleBtn.disabled = true;
    dom.weatherHandleBtn.textContent = "天气自动处置";
    dom.weatherRecheckBtn.disabled = true;
    dom.weatherResumeBtn.disabled = true;
    dom.weatherRefundBtn.disabled = true;
    dom.weatherRiskBadges.innerHTML = "";
    dom.weatherMetricsGrid.innerHTML = "";
    setCode(dom.weatherHourlyOutput, { 提示: "暂无天气数据" });
    return;
  }

  const risk = weather.risk || {};
  const machineContext = weather.machine_context || null;
  const normalizedRisk = normalizeRiskLevel(risk.risk_level);
  const action = weather.suggested_action || "continue";
  const actionText = actionHintText(action);
  dom.weatherSummaryText.textContent = `${weather.current.weather_text}，${riskLevelText(normalizedRisk)}。${weather.suggested_reason || risk.recommendation || ""}`;
  dom.weatherHandleBtn.disabled = !state.currentOrder || !["pause", "reassign"].includes(action);
  dom.weatherHandleBtn.textContent = ["pause", "reassign"].includes(action)
    ? `天气自动处置：${actionText}`
    : `天气自动处置：${actionText}`;
  dom.weatherRecheckBtn.disabled = !state.currentOrder;
  dom.weatherResumeBtn.disabled = !canResumeWeatherOrder(state.currentOrder, weather);
  dom.weatherRefundBtn.disabled = !canRefundWeatherOrder(state.currentOrder);

  const badges = [
    { label: `风险等级：${riskLevelText(normalizedRisk)}`, cls: normalizedRisk },
    { label: `风险分：${risk.risk_score ?? "-"}`, cls: normalizedRisk },
    { label: `处理建议：${actionText}`, cls: normalizedRisk },
    ...(risk.flags || []).map((flag) => ({ label: flag, cls: normalizedRisk })),
  ];
  if (machineContext?.comparison_text) {
    badges.push({
      label: `机具对比：${machineContext.comparison_text}`,
      cls: normalizedRisk,
    });
  }
  dom.weatherRiskBadges.innerHTML = badges
    .map((item) => `<span class="risk-badge ${item.cls}">${escapeHtml(item.label)}</span>`)
    .join("");

  const metrics = [
    { k: "当前天气", v: weather.current.weather_text },
    { k: "处理建议", v: actionText },
    { k: "当前温度", v: `${weather.current.temperature_2m}°C` },
    { k: "当前风速", v: `${weather.current.wind_speed_10m} km/h` },
    { k: "6小时最大降水概率", v: `${risk.max_precip_probability}%` },
    { k: "6小时最大风速", v: `${risk.max_wind_speed} km/h` },
  ];
  if (machineContext) {
    metrics.push({ k: "当前机具距离", v: `${machineContext.distance_km} km` });
    metrics.push({ k: "机具当地天气", v: machineContext.current.weather_text });
  }
  dom.weatherMetricsGrid.innerHTML = metrics
    .map((m) => `<div class="metric"><div class="k">${m.k}</div><div class="v">${m.v}</div></div>`)
    .join("");

  setCode(dom.weatherHourlyOutput, {
    处理建议: actionText,
    建议原因: weather.suggested_reason || risk.recommendation || "",
    当前机具天气对比: machineContext || "当前订单尚未绑定执行机具",
    未来6小时预报: weather.hourly || [],
  });
}

async function loadOrderWeather(orderId) {
  if (!orderId) {
    state.currentWeather = null;
    renderWeatherPanel();
    return;
  }
  try {
    state.currentWeather = await request(`/weather/order/${orderId}`);
  } catch (err) {
    state.currentWeather = null;
    dom.weatherSummaryText.textContent = err.message || "天气查询失败";
    dom.weatherRiskBadges.innerHTML = "";
    dom.weatherMetricsGrid.innerHTML = "";
    setCode(dom.weatherHourlyOutput, { 错误: err.message || "天气查询失败" });
    return;
  }
  renderWeatherPanel();
}

function resetMapRuntime() {
  if (state.mapRuntime.map) {
    state.mapRuntime.map.destroy();
  }
  const script = document.getElementById("amap-script");
  if (script) script.remove();
  try {
    delete window.AMap;
  } catch {
    window.AMap = undefined;
  }
  state.mapRuntime = {
    map: null,
    infoWindow: null,
    loadPromise: null,
    overlays: [],
    loadedKey: "",
  };
  setMapPlaceholder("请先点击右上角“地图设置”，填写高德 Key 后加载地图。");
}

async function ensureMapInstance() {
  if (!state.mapConfig.key) {
    setMapPlaceholder("请先点击右上角“地图设置”，填写高德 Key 后加载地图。");
    return null;
  }

  if (state.mapRuntime.map) {
    setMapPlaceholder("", true);
    return state.mapRuntime.map;
  }

  if (!state.mapRuntime.loadPromise) {
    state.mapRuntime.loadPromise = new Promise((resolve, reject) => {
      if (window.AMap) {
        state.mapRuntime.loadedKey = state.mapConfig.key;
        resolve(window.AMap);
        return;
      }

      if (state.mapConfig.securityJsCode) {
        window._AMapSecurityConfig = { securityJsCode: state.mapConfig.securityJsCode };
      }

      const script = document.createElement("script");
      script.id = "amap-script";
      script.async = true;
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(state.mapConfig.key)}`;
      script.onload = () => {
        if (!window.AMap) {
          reject(new Error("高德地图脚本已加载，但 AMap 对象不可用"));
          return;
        }
        state.mapRuntime.loadedKey = state.mapConfig.key;
        resolve(window.AMap);
      };
      script.onerror = () => reject(new Error("高德地图脚本加载失败，请检查 Key 或网络"));
      document.head.appendChild(script);
    });
  }

  const AMap = await state.mapRuntime.loadPromise;
  if (!state.mapRuntime.map) {
    state.mapRuntime.map = new AMap.Map(dom.mapCanvas, {
      zoom: 7,
      center: [117.2, 36.6],
      resizeEnable: true,
    });
    state.mapRuntime.infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -26) });
  }
  setMapPlaceholder("", true);
  return state.mapRuntime.map;
}

function clearMapOverlays() {
  if (!state.mapRuntime.map || !state.mapRuntime.overlays.length) return;
  state.mapRuntime.map.remove(state.mapRuntime.overlays);
  state.mapRuntime.overlays = [];
}

function buildMachineMarkerHtml(machine, tone = "normal") {
  const toneClass =
    tone === "selected" ? "selected" : tone === "fault" ? "fault" : String(machine.status).toLowerCase();
  return `<div class="map-pin machine ${toneClass}">
    <span class="dot"></span>
    <span class="label">#${escapeHtml(machine.id)} ${escapeHtml(machine.machine_type)}</span>
  </div>`;
}

function buildTargetMarkerHtml(order, weather = null) {
  const riskLevel = normalizeRiskLevel(weather?.risk?.risk_level);
  const riskTag = weather?.risk ? `<span class="risk-tag ${riskLevel}">${escapeHtml(riskLevelText(riskLevel))}</span>` : "";
  return `<div class="map-pin target">
    <span class="dot"></span>
    <span class="label">目的地 #${escapeHtml(order.id)}</span>
    ${riskTag}
  </div>`;
}

function buildDraftTargetMarkerHtml() {
  return `<div class="map-pin draft">
    <span class="dot"></span>
    <span class="label">表单目的地预览</span>
  </div>`;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const radius = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function midpointPosition(machine, order) {
  return [(machine.lng + order.target_lng) / 2, (machine.lat + order.target_lat) / 2];
}

function bindMarkerInfo(marker, html) {
  marker.on("click", () => {
    if (!state.mapRuntime.map || !state.mapRuntime.infoWindow) return;
    state.mapRuntime.infoWindow.setContent(html);
    state.mapRuntime.infoWindow.open(state.mapRuntime.map, marker.getPosition());
  });
}

function createRouteLabel(AMap, machine, order, text, toneClass = "") {
  const marker = new AMap.Marker({
    position: midpointPosition(machine, order),
    content: `<div class="map-route-label ${toneClass}">${escapeHtml(text)}</div>`,
    offset: new AMap.Pixel(0, 0),
  });
  state.mapRuntime.overlays.push(marker);
  return marker;
}

function buildMachineInfoHtml(machine, order, candidate) {
  const distanceText =
    candidate?.distance_km != null
      ? `${candidate.distance_km} km`
      : order && order.target_lat != null && order.target_lng != null
        ? `${haversineKm(order.target_lat, order.target_lng, machine.lat, machine.lng).toFixed(2)} km`
        : "暂无";
  const weatherHint = candidate?.weather_action_hint ? actionHintText(candidate.weather_action_hint) : "未评估";
  const weatherGap = candidate?.weather_gap_level || "未评估";
  return `
    <div>
      <strong>#${escapeHtml(machine.id)} ${escapeHtml(machine.machine_type)}</strong><br />
      状态：${escapeHtml(machine.status)}<br />
      健康分：${escapeHtml(machine.health_score)}<br />
      作业效率：${escapeHtml(machine.capacity_mu_per_hour)} 亩/小时<br />
      距离目的地：${escapeHtml(distanceText)}<br />
      天气建议：${escapeHtml(weatherHint)}<br />
      天气差异：${escapeHtml(weatherGap)}
    </div>
  `;
}

function buildOrderInfoHtml(order, weather = null) {
  const risk = weather?.risk;
  const machineContext = weather?.machine_context;
  return `
    <div>
      <strong>订单 #${escapeHtml(order.id)}</strong><br />
      状态：${escapeHtml(order.status)}<br />
      面积：${escapeHtml(order.area_mu)} 亩<br />
      紧急级别：${escapeHtml(order.urgency_level)}<br />
      质量约束：${escapeHtml(order.quality_constraints || "无")}<br />
      天气风险：${escapeHtml(risk ? riskLevelText(normalizeRiskLevel(risk.risk_level)) : "暂无")}<br />
      天气建议：${escapeHtml(weather ? actionHintText(weather.suggested_action) : "暂无")}<br />
      处理说明：${escapeHtml(weather?.suggested_reason || "暂无")}<br />
      当前机具对比：${escapeHtml(machineContext?.comparison_text || "暂无")}
    </div>
  `;
}

function buildDraftTargetInfoHtml(draftTarget) {
  return `
    <div>
      <strong>表单目的地预览</strong><br />
      经度：${escapeHtml(draftTarget.lng)}<br />
      纬度：${escapeHtml(draftTarget.lat)}<br />
      说明：这是“创建订单”表单里的实时坐标预览，尚未入库
    </div>
  `;
}

function getCoordinateInputValue(input) {
  const raw = String(input?.value ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function getDraftTarget() {
  const lng = getCoordinateInputValue(dom.lngInput);
  const lat = getCoordinateInputValue(dom.latInput);
  if (lng == null || lat == null) return null;
  return { lng, lat };
}

function isSameTarget(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.lng - b.lng) < 0.000001 && Math.abs(a.lat - b.lat) < 0.000001;
}

async function setCurrentOrder(orderId, options = {}) {
  const { order: providedOrder = null, stageText = "" } = options;
  const normalizedId = Number(orderId);
  if (!normalizedId) {
    state.currentOrder = null;
    state.currentWeather = null;
    if (stageText) setMapStage(stageText);
    updateMapMeta();
    renderWeatherPanel();
    await renderMapScene();
    return null;
  }

  dom.targetOrderIdInput.value = normalizedId;
  state.currentOrder = providedOrder || (await request(`/orders/${normalizedId}`));
  if (stageText) setMapStage(stageText);
  updateMapMeta();
  await loadOrderWeather(normalizedId);
  await renderMapScene();
  return state.currentOrder;
}

async function renderMapScene() {
  updateMapMeta();

  const map = await ensureMapInstance().catch((err) => {
    setMapPlaceholder(err.message || "地图加载失败");
    return null;
  });
  if (!map) return;

  clearMapOverlays();
  const AMap = window.AMap;
  const fitOverlays = [];
  const order = state.currentOrder;
  const dispatchPayload =
    state.lastDispatchProposal && order && state.lastDispatchProposal.order_id === order.id ? state.lastDispatchProposal : null;
  const exceptionPayload =
    state.lastExceptionResult && order && state.lastExceptionResult.order_id === order.id ? state.lastExceptionResult : null;
  const proposalPayload = exceptionPayload?.proposal?.candidates?.length ? exceptionPayload.proposal : dispatchPayload;
  const candidates = (proposalPayload?.candidates || []).slice(0, 3);
  const candidateMap = new Map(candidates.map((item) => [item.machine_id, item]));
  const weather = order && state.currentWeather && state.currentWeather.order_id === order.id ? state.currentWeather : null;
  const targetReady = order && Number.isFinite(order.target_lng) && Number.isFinite(order.target_lat);
  const draftTarget = getDraftTarget();
  const shouldShowDraftTarget = draftTarget && (!targetReady || !isSameTarget(draftTarget, { lng: order.target_lng, lat: order.target_lat }));
  const selectedMachineId =
    exceptionPayload?.replacement_machine_id ??
    exceptionPayload?.proposal?.selected_machine_id ??
    dispatchPayload?.selected_machine_id ??
    order?.machine_id ??
    null;
  const faultMachineId =
    exceptionPayload && ["ABNORMAL_PENDING", "REASSIGN_PROPOSED"].includes(order?.status)
      ? order?.machine_id
      : null;

  for (const machine of state.machines) {
    const tone = machine.id === selectedMachineId ? "selected" : machine.id === faultMachineId ? "fault" : "normal";
    const marker = new AMap.Marker({
      position: [machine.lng, machine.lat],
      content: buildMachineMarkerHtml(machine, tone),
      offset: new AMap.Pixel(0, 0),
    });
    bindMarkerInfo(marker, buildMachineInfoHtml(machine, order, candidateMap.get(machine.id)));
    state.mapRuntime.overlays.push(marker);
    fitOverlays.push(marker);
  }

  if (targetReady) {
    const targetMarker = new AMap.Marker({
      position: [order.target_lng, order.target_lat],
      content: buildTargetMarkerHtml(order, weather),
      offset: new AMap.Pixel(0, 0),
    });
    bindMarkerInfo(targetMarker, buildOrderInfoHtml(order, weather));
    state.mapRuntime.overlays.push(targetMarker);
    fitOverlays.push(targetMarker);
  }

  if (shouldShowDraftTarget) {
    const draftMarker = new AMap.Marker({
      position: [draftTarget.lng, draftTarget.lat],
      content: buildDraftTargetMarkerHtml(),
      offset: new AMap.Pixel(0, 0),
    });
    bindMarkerInfo(draftMarker, buildDraftTargetInfoHtml(draftTarget));
    state.mapRuntime.overlays.push(draftMarker);
    fitOverlays.push(draftMarker);
  }

  if (targetReady) {
    for (const candidate of candidates) {
      const machine = state.machines.find((item) => item.id === candidate.machine_id);
      if (!machine) continue;

      const isSelected = candidate.machine_id === selectedMachineId;
      const polyline = new AMap.Polyline({
        path: [
          [machine.lng, machine.lat],
          [order.target_lng, order.target_lat],
        ],
        strokeColor: isSelected ? "#0f7f68" : "#6b8d72",
        strokeWeight: isSelected ? 6 : 3,
        strokeStyle: isSelected ? "solid" : "dashed",
        strokeOpacity: isSelected ? 0.95 : 0.55,
      });
      state.mapRuntime.overlays.push(polyline);
      fitOverlays.push(polyline);

      const prefix = exceptionPayload ? (isSelected ? "改派推荐" : "候选") : isSelected ? "最终选中" : "候选";
      const hintText = candidate.weather_action_hint ? ` · ${actionHintText(candidate.weather_action_hint)}` : "";
      createRouteLabel(
        AMap,
        machine,
        order,
        `${prefix} #${candidate.machine_id} · ${candidate.score}分 · ${candidate.distance_km}km${hintText}`,
        isSelected ? "selected" : ""
      );
    }

    if (faultMachineId && faultMachineId !== selectedMachineId) {
      const machine = state.machines.find((item) => item.id === faultMachineId);
      if (machine) {
        const faultLine = new AMap.Polyline({
          path: [
            [machine.lng, machine.lat],
            [order.target_lng, order.target_lat],
          ],
          strokeColor: "#cc473d",
          strokeWeight: 4,
          strokeStyle: "dashed",
          strokeOpacity: 0.85,
        });
        state.mapRuntime.overlays.push(faultLine);
        fitOverlays.push(faultLine);
        createRouteLabel(AMap, machine, order, `原机故障 #${machine.id}`, "warning");
      }
    }
  }

  if (state.mapRuntime.overlays.length) {
    map.add(state.mapRuntime.overlays);
  }
  if (fitOverlays.length) {
    map.setFitView(fitOverlays, false, [80, 80, 80, 80]);
  }
}

function parseSSEBlock(block) {
  let event = "message";
  const dataLines = [];
  const lines = block.split("\n");
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  const dataText = dataLines.join("\n");
  let data = { 文本: dataText };
  try {
    data = dataText ? JSON.parse(dataText) : {};
  } catch {
    // keep text payload
  }
  return { event, data };
}

async function streamLLMChat({ messages, stage, onToken, onDone }) {
  const payload = {
    endpoint: state.llmConfig.endpoint || "",
    api_key: state.llmConfig.apiKey || "",
    model: state.llmConfig.model || "deepseek-chat",
    messages,
    stage,
    temperature: 0.2,
  };

  const resp = await fetch(`${state.apiBase}/llm/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // keep raw
    }
    throw new Error(formatApiError(data));
  }

  if (!resp.body) {
    throw new Error("模型流式响应为空");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!block.trim()) continue;

      const { event, data } = parseSSEBlock(block);
      if (event === "token") {
        const token = data.增量 || "";
        if (token) {
          fullText += token;
          if (onToken) onToken(fullText, data);
        }
      } else if (event === "done") {
        fullText = data.全文 || fullText;
        if (onDone) onDone(fullText, data);
        return fullText;
      } else if (event === "error") {
        throw new Error(data.错误 || "模型流式调用失败");
      }
    }
  }

  return fullText;
}

function extractJsonObject(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      const candidate = cleaned.slice(first, last + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function applyParsedDemandToForm(parsed) {
  if (!parsed || typeof parsed !== "object") return;

  if (parsed.area_mu && Number(parsed.area_mu) > 0) {
    dom.areaInput.value = Number(parsed.area_mu);
  }

  if (parsed.urgency_level) {
    const urgency = String(parsed.urgency_level).toLowerCase();
    if (["low", "medium", "high"].includes(urgency)) {
      dom.urgencySelect.value = urgency;
    }
  }

  if (parsed.quality_constraints) {
    dom.qualityInput.value = String(parsed.quality_constraints);
  }

  if (parsed.work_type) {
    const workText = String(parsed.work_type);
    const match = state.skus.find((s) => String(s.work_type).includes(workText));
    if (match) dom.skuSelect.value = String(match.id);
  }
}

function buildDemandMessages(text) {
  return [
    {
      role: "system",
      content:
        "你是农机调度需求解析器。请把用户文本解析为JSON，且仅输出JSON，不要markdown。字段为：work_type(收割/播种/耕地/植保)、area_mu(数字)、budget_range(字符串)、urgency_level(low/medium/high)、quality_constraints(字符串)。",
    },
    { role: "user", content: text },
  ];
}

function buildExplainMessages(payload, audience = "需求方") {
  return [
    {
      role: "system",
      content:
        "你是农机调度系统解释助手。请用中文简洁解释Agent决策原因，不超过3句，避免术语堆砌。",
    },
    {
      role: "user",
      content: `请面向${audience}解释以下决策：${JSON.stringify(payload, null, 2)}`,
    },
  ];
}

function getCurrentOrderId() {
  const id = Number(dom.targetOrderIdInput.value);
  if (!id) {
    throw new Error("请先输入或选择订单ID");
  }
  return id;
}

function getOperatorId() {
  const id = Number(dom.operatorInput.value);
  return id || 21;
}

async function loadCatalog() {
  const [users, skus, machines] = await Promise.all([
    request("/catalog/users"),
    request("/catalog/skus"),
    request("/catalog/machines"),
  ]);
  state.users = users;
  state.skus = skus;
  state.machines = machines;

  const buyers = users.filter((u) => u.role === "buyer");
  dom.buyerSelect.innerHTML = buyers
    .map((u) => `<option value="${u.id}">${u.id} - ${u.name}</option>`)
    .join("");

  dom.skuSelect.innerHTML = skus
    .map((s) => `<option value="${s.id}">${s.id} - ${s.title} ¥${s.unit_price}/${s.unit}</option>`)
    .join("");
}

async function loadOrders() {
  const orders = await request("/orders?limit=20");
  state.orders = orders;
  dom.orderTbody.innerHTML = orders
    .map(
      (o) => `<tr>
      <td>${o.id}</td>
      <td>${o.order_no}</td>
      <td>${o.buyer_id}</td>
      <td>${o.sku_id}</td>
      <td>${o.machine_id ?? "-"}</td>
      <td>${o.area_mu}</td>
      <td>${o.amount}</td>
      <td>${o.status}</td>
      <td><button class="mini-btn" data-oid="${o.id}">选中</button></td>
    </tr>`
    )
    .join("");

  dom.orderTbody.querySelectorAll(".mini-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await setCurrentOrder(Number(btn.dataset.oid), { stageText: "已切换到当前订单" });
    });
  });
}

async function loadMetrics() {
  const metrics = await request("/dashboard/metrics");
  const events = await request("/dashboard/recent-events?limit=20");

  dom.metricsGrid.innerHTML = [
    { k: "总订单", v: metrics.total_orders },
    { k: "完成订单", v: metrics.completed_orders },
    { k: "完成率", v: `${metrics.completion_rate}%` },
    { k: "活动中订单", v: metrics.active_orders },
    { k: "平均订单金额", v: metrics.avg_order_amount },
  ]
    .map((m) => `<div class="metric"><div class="k">${m.k}</div><div class="v">${m.v}</div></div>`)
    .join("");

  dom.statusList.innerHTML = Object.entries(metrics.status_counts || {})
    .map(([status, count]) => `<li><span>${status}</span><strong>${count}</strong></li>`)
    .join("");

  setCode(dom.eventsOutput, events);
}

async function refreshAll() {
  await Promise.all([loadCatalog(), loadOrders(), loadMetrics()]);
  const currentOrderId = Number(dom.targetOrderIdInput.value);
  if (currentOrderId) {
    await setCurrentOrder(currentOrderId);
  } else {
    await renderMapScene();
  }
}

async function parseDemandWithLLM(text, showInPanel = true) {
  if (!text || !text.trim()) throw new Error("请输入需求文本");

  let streamText = "";
  const full = await streamLLMChat({
    stage: "需求解析",
    messages: buildDemandMessages(text),
    onToken: (partial) => {
      streamText = partial;
      if (showInPanel) {
        setCode(dom.demandResult, { 流式输出: partial });
      }
    },
  });

  const parsed = extractJsonObject(full);
  if (!parsed) {
    if (showInPanel) {
      setCode(dom.demandResult, {
        提示: "模型输出不是合法JSON，请重试",
        原始输出: streamText || full,
      });
    }
    throw new Error("需求解析失败：模型输出不是合法JSON");
  }

  applyParsedDemandToForm(parsed);
  if (showInPanel) setCode(dom.demandResult, parsed);
  return parsed;
}

async function parseDemand() {
  const text = dom.demandText.value.trim();
  await parseDemandWithLLM(text, true);
}

async function createOrder() {
  const payload = {
    buyer_id: Number(dom.buyerSelect.value),
    sku_id: Number(dom.skuSelect.value),
    area_mu: Number(dom.areaInput.value),
    urgency_level: dom.urgencySelect.value,
    quality_constraints: dom.qualityInput.value.trim(),
    target_lng: Number(dom.lngInput.value),
    target_lat: Number(dom.latInput.value),
  };
  const res = await request("/orders", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  dom.createOrderHint.textContent = `订单已创建：${res.id} (${res.status})`;
  await Promise.all([loadOrders(), loadMetrics()]);
  await setCurrentOrder(res.id, { order: res, stageText: "订单已创建，等待派单" });
}

function pickDefaultBuyerId() {
  const buyers = state.users.filter((u) => u.role === "buyer");
  return buyers.length ? buyers[0].id : Number(dom.buyerSelect.value);
}

function pickDefaultHarvestSkuId() {
  const byText = state.skus.find((s) => String(s.work_type).includes("收"));
  return byText ? byText.id : Number(dom.skuSelect.value);
}

async function createDemoOrder({ areaMu = 180, urgency = "high", quality = "收割损失率<=2%", lng = 119.12, lat = 36.71 } = {}) {
  const payload = {
    buyer_id: pickDefaultBuyerId(),
    sku_id: pickDefaultHarvestSkuId(),
    area_mu: areaMu,
    urgency_level: urgency,
    quality_constraints: quality,
    target_lng: lng,
    target_lat: lat,
  };
  const order = await request("/orders", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  await setCurrentOrder(order.id, { order, stageText: "演示订单已创建" });
  return order;
}

async function actionPay() {
  const orderId = getCurrentOrderId();
  const opId = getOperatorId();
  const res = await request(`/orders/${orderId}/pay?operator_id=${opId}`, { method: "POST" });
  setCode(dom.agentOutput, res);
  await Promise.all([loadOrders(), loadMetrics()]);
  await setCurrentOrder(orderId, { stageText: "已支付托管，等待 Agent 派单" });
}

async function actionDispatch() {
  const orderId = getCurrentOrderId();
  const res = await request("/agents/dispatch/propose", {
    method: "POST",
    body: JSON.stringify({ order_id: orderId, auto_transition: true }),
  });
  state.lastDispatchProposal = res;
  state.lastExceptionResult = null;
  state.lastAgentPayload = res;
  setCode(dom.agentOutput, res);
  await Promise.all([loadOrders(), loadMetrics()]);
  await setCurrentOrder(orderId, { stageText: "Agent 已生成派单候选" });
}

async function actionConfirmDispatch() {
  const orderId = getCurrentOrderId();
  const opId = getOperatorId();
  if (!state.lastDispatchProposal?.selected_machine_id) {
    throw new Error("请先执行 Agent 派单，获取 selected_machine_id");
  }
  const res = await request(`/orders/${orderId}/transition`, {
    method: "POST",
    body: JSON.stringify({
      to_status: "DISPATCH_CONFIRMED",
      operator_id: opId,
      payload: { machine_id: state.lastDispatchProposal.selected_machine_id },
    }),
  });
  setCode(dom.agentOutput, res);
  await Promise.all([loadOrders(), loadMetrics()]);
  await setCurrentOrder(orderId, { stageText: "人工已确认派单" });
}

async function actionStart() {
  const orderId = getCurrentOrderId();
  const opId = getOperatorId();
  const res = await request(`/orders/${orderId}/start?operator_id=${opId}`, { method: "POST" });
  setCode(dom.agentOutput, res);
  await Promise.all([loadOrders(), loadMetrics()]);
  await setCurrentOrder(orderId, { stageText: "农机已开始作业" });
}

async function actionFinish() {
  const orderId = getCurrentOrderId();
  const opId = getOperatorId();
  const res = await request(`/orders/${orderId}/finish?operator_id=${opId}`, { method: "POST" });
  setCode(dom.agentOutput, res);
  await Promise.all([loadOrders(), loadMetrics()]);
  await setCurrentOrder(orderId, { stageText: "作业已完成，等待验收" });
}

async function actionConfirm() {
  const orderId = getCurrentOrderId();
  const opId = Number(dom.buyerSelect.value) || getOperatorId();
  const res = await request(`/orders/${orderId}/confirm?operator_id=${opId}`, { method: "POST" });
  setCode(dom.agentOutput, res);
  await Promise.all([loadOrders(), loadMetrics()]);
  await setCurrentOrder(orderId, { stageText: "需求方已确认验收" });
}

async function actionException() {
  const orderId = getCurrentOrderId();
  const res = await request("/agents/exception/handle", {
    method: "POST",
    body: JSON.stringify({
      order_id: orderId,
      event_type: dom.exceptionType.value,
      description: dom.exceptionDesc.value.trim(),
      auto_transition: true,
    }),
  });
  state.lastExceptionResult = res;
  state.lastAgentPayload = res;
  setCode(dom.agentOutput, res);
  await Promise.all([loadOrders(), loadMetrics()]);
  await setCurrentOrder(orderId, {
    stageText: res.replacement_machine_id ? "Agent 已给出异常改派方案" : "异常已记录，等待进一步处理",
  });
}

async function actionWeatherHandle() {
  const order = state.currentOrder;
  if (!order) throw new Error("请先选择订单");
  if (!state.currentWeather) throw new Error("请先加载当前订单天气");

  const allowedStatuses = new Set([
    "DISPATCH_CONFIRMED",
    "IN_SERVICE",
    "ABNORMAL_PENDING",
    "REASSIGN_PROPOSED",
    "REASSIGN_CONFIRMED",
  ]);
  if (!allowedStatuses.has(order.status)) {
    throw new Error("天气自动处置仅适用于已确认派单后的订单，请先完成派单确认");
  }

  const action = state.currentWeather.suggested_action || "continue";
  if (!["pause", "reassign"].includes(action)) {
    throw new Error("当前天气只建议观察，不会自动触发暂停或改派");
  }

  const description = state.currentWeather.suggested_reason || "目的地天气异常，需自动处置";
  dom.exceptionType.value = "weather";
  dom.exceptionDesc.value = description;

  const res = await request("/agents/exception/handle", {
    method: "POST",
    body: JSON.stringify({
      order_id: order.id,
      event_type: "weather",
      description,
      auto_transition: true,
    }),
  });
  state.lastExceptionResult = res;
  state.lastAgentPayload = res;
  setCode(dom.agentOutput, res);
  await Promise.all([loadOrders(), loadMetrics()]);
  await setCurrentOrder(order.id, {
    stageText: res.action_type === "reassign" ? "天气异常，Agent 已给出改派方案" : "天气异常，订单已进入暂停待处理",
  });
}

async function actionWeatherRecheck() {
  const order = state.currentOrder;
  if (!order) throw new Error("请先选择订单");
  await setCurrentOrder(order.id, {
    stageText: order.status === "ABNORMAL_PENDING" ? "天气复检完成，等待后续处置" : "天气复检完成",
  });
  setCode(dom.agentOutput, {
    当前天气: state.currentWeather?.current?.weather_text || "未知",
    风险等级: state.currentWeather?.risk?.risk_level || "unknown",
    Agent建议: state.currentWeather?.suggested_action || "continue",
    建议说明: state.currentWeather?.suggested_reason || "",
  });
}

async function actionWeatherResume() {
  const order = state.currentOrder;
  if (!order) throw new Error("请先选择订单");
  if (order.status !== "ABNORMAL_PENDING") throw new Error("只有异常待处理的订单才能恢复原机继续");
  if (!state.currentWeather) throw new Error("请先完成天气复检");
  if (state.currentWeather.suggested_action === "pause") {
    throw new Error("当前天气仍不适合作业，不能恢复原机继续");
  }

  const opId = getOperatorId();
  const res = await request(`/orders/${order.id}/transition`, {
    method: "POST",
    body: JSON.stringify({
      to_status: "IN_SERVICE",
      operator_id: opId,
      note: "天气复检通过，恢复原机继续作业",
    }),
  });
  setCode(dom.agentOutput, {
    恢复结果: res,
    说明: "天气风险已下降，订单恢复到作业中。",
  });
  await Promise.all([loadOrders(), loadMetrics()]);
  await setCurrentOrder(order.id, { stageText: "天气恢复，原机已恢复作业" });
}

async function actionWeatherRefund() {
  const order = state.currentOrder;
  if (!order) throw new Error("请先选择订单");
  if (order.status !== "ABNORMAL_PENDING") throw new Error("只有异常待处理的订单才能取消并退款");

  const opId = getOperatorId();
  const refunding = await request(`/orders/${order.id}/transition`, {
    method: "POST",
    body: JSON.stringify({
      to_status: "REFUNDING",
      operator_id: opId,
      note: "天气持续恶化，取消订单并发起退款",
    }),
  });
  const refunded = await request(`/orders/${order.id}/transition`, {
    method: "POST",
    body: JSON.stringify({
      to_status: "REFUNDED",
      operator_id: opId,
      note: "天气异常退款完成",
    }),
  });
  setCode(dom.agentOutput, {
    退款中: refunding,
    已退款: refunded,
    说明: "订单已终止，托管资金已按演示流程退回。",
  });
  await Promise.all([loadOrders(), loadMetrics()]);
  await setCurrentOrder(order.id, { stageText: "天气异常，订单已取消并退款" });
}

async function actionMarkAbnormal() {
  const orderId = getCurrentOrderId();
  const opId = getOperatorId();
  const note = dom.exceptionDesc.value.trim() || "检测到异常，进入异常处理";
  const res = await request(`/orders/${orderId}/transition`, {
    method: "POST",
    body: JSON.stringify({
      to_status: "ABNORMAL_PENDING",
      operator_id: opId,
      note,
    }),
  });
  setCode(dom.agentOutput, res);
  await Promise.all([loadOrders(), loadMetrics()]);
  await setCurrentOrder(orderId, { stageText: "订单已进入异常待处理" });
}

async function explainWithLLM(payload, audience = "需求方") {
  let streamText = "";
  const full = await streamLLMChat({
    stage: "决策解释",
    messages: buildExplainMessages(payload, audience),
    onToken: (partial) => {
      streamText = partial;
      setCode(dom.agentOutput, { 说明流: partial });
    },
  });
  const text = (full || streamText || "").trim();
  setCode(dom.agentOutput, { 说明: text });
  return text;
}

async function actionExplain() {
  const payload = state.lastAgentPayload || {};
  await explainWithLLM(payload, "需求方");
}

async function demoStandardFlow() {
  await clearAllDemoWeatherOverrides();
  clearDemoLog();
  appendDemoLog("开始：标准派单演示");
  await pauseAfterStep(DEMO_DELAY_MS.short);

  const demandText = "明天上午收割300亩小麦，预算20000，收割损失率<=2%";
  dom.demandText.value = demandText;
  const parsed = await runDemoStep(
    "1) 需求解析完成",
    () => parseDemandWithLLM(demandText, true),
    { startText: "1) 正在调用 LLM 解析需求", pauseMs: DEMO_DELAY_MS.long }
  );

  const order = await runDemoStep(
    "2) 创建订单",
    async () => {
      const created = await createDemoOrder({ areaMu: 160, urgency: "high" });
      return { id: created.id, status: created.status, amount: created.amount };
    },
    { startText: "2) 正在生成演示订单", pauseMs: DEMO_DELAY_MS.normal }
  );

  const opId = getOperatorId();
  await runDemoStep(
    "3) 支付托管",
    () => request(`/orders/${order.id}/pay?operator_id=${opId}`, { method: "POST" }),
    { startText: "3) 正在进入支付托管环节" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：已支付托管，等待 Agent 派单" });

  const dispatchRes = await runDemoStep(
    "4) Agent派单建议",
    () =>
      request("/agents/dispatch/propose", {
        method: "POST",
        body: JSON.stringify({ order_id: order.id, auto_transition: true }),
      }),
    { startText: "4) Agent 正在计算候选机具与派单方案", pauseMs: DEMO_DELAY_MS.long }
  );
  state.lastDispatchProposal = dispatchRes;
  state.lastExceptionResult = null;
  state.lastAgentPayload = dispatchRes;
  await setCurrentOrder(order.id, { stageText: "演示中：Agent 已生成派单候选" });

  const selectedMachine = dispatchRes.selected_machine_id;
  if (!selectedMachine) throw new Error("标准派单演示中未选出可用机具");

  await runDemoStep(
    "5) 人工确认派单",
    () =>
      request(`/orders/${order.id}/transition`, {
        method: "POST",
        body: JSON.stringify({
          to_status: "DISPATCH_CONFIRMED",
          operator_id: opId,
          payload: { machine_id: selectedMachine },
        }),
      }),
    { startText: "5) 等待人工确认派单" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：人工已确认派单" });

  await runDemoStep(
    "6) 开始作业",
    () => request(`/orders/${order.id}/start?operator_id=${opId}`, { method: "POST" }),
    { startText: "6) 机手到场，开始作业" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：农机已开始作业" });
  await runDemoStep(
    "7) 完成作业",
    () => request(`/orders/${order.id}/finish?operator_id=${opId}`, { method: "POST" }),
    { startText: "7) 作业执行中，准备回传完成状态" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：作业已完成，等待验收" });
  await runDemoStep(
    "8) 需求方确认验收",
    () => request(`/orders/${order.id}/confirm?operator_id=${pickDefaultBuyerId()}`, { method: "POST" }),
    { startText: "8) 等待需求方确认验收" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：需求方已确认验收" });

  const explain = await runDemoStep(
    "9) Agent解释输出",
    async () => ({ 说明: await explainWithLLM(dispatchRes, "需求方") }),
    { startText: "9) 正在生成可读解释", pauseMs: DEMO_DELAY_MS.long }
  );

  await Promise.all([loadOrders(), loadMetrics()]);
  void explain;
  appendDemoLog("标准派单演示结束");
}

async function demoWeatherFlow() {
  await clearAllDemoWeatherOverrides();
  clearDemoLog();
  appendDemoLog("开始：天气暂停演示");
  await pauseAfterStep(DEMO_DELAY_MS.short);

  const order = await runDemoStep(
    "1) 创建订单",
    async () => {
      const created = await createDemoOrder({
        areaMu: 210,
        urgency: "high",
        quality: "到场后需连续完成，不接受暴雨或雷暴作业",
        lng: 118.856,
        lat: 36.362,
      });
      return { id: created.id, status: created.status, amount: created.amount };
    },
    { startText: "1) 正在生成天气异常演示订单" }
  );

  const opId = getOperatorId();
  await runDemoStep(
    "2) 支付托管",
    () => request(`/orders/${order.id}/pay?operator_id=${opId}`, { method: "POST" }),
    { startText: "2) 订单进入支付托管" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：已支付托管，等待 Agent 派单" });

  const dispatchRes = await runDemoStep(
    "3) Agent派单建议",
    () =>
      request("/agents/dispatch/propose", {
        method: "POST",
        body: JSON.stringify({ order_id: order.id, auto_transition: true }),
      }),
    { startText: "3) Agent 正在生成初始派单方案", pauseMs: DEMO_DELAY_MS.long }
  );
  state.lastDispatchProposal = dispatchRes;
  state.lastExceptionResult = null;
  state.lastAgentPayload = dispatchRes;
  await setCurrentOrder(order.id, { stageText: "演示中：Agent 已完成初始派单" });

  const selectedMachine = dispatchRes.selected_machine_id;
  if (!selectedMachine) throw new Error("天气演示中未选出可用机具");

  await runDemoStep(
    "4) 人工确认派单",
    () =>
      request(`/orders/${order.id}/transition`, {
        method: "POST",
        body: JSON.stringify({
          to_status: "DISPATCH_CONFIRMED",
          operator_id: opId,
          payload: { machine_id: selectedMachine },
        }),
      }),
    { startText: "4) 调度员确认当前派单结果" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：已确认派单，农机准备进场" });

  await runDemoStep(
    "5) 开始作业",
    () => request(`/orders/${order.id}/start?operator_id=${opId}`, { method: "POST" }),
    { startText: "5) 农机到场，订单进入作业中" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：农机正在作业" });

  const weatherScenario = await runDemoStep(
    "6) 目的地天气突变",
    () =>
      applyDemoWeatherScenario(order.id, {
        target_scene: "severe_storm",
        machine_scene: "clear",
        apply_current_machine: true,
        clear_existing: true,
      }),
    { startText: "6) 模拟目的地突发暴雨/雷暴，农机出发地仍然晴朗", pauseMs: DEMO_DELAY_MS.long }
  );

  const weatherView = await runDemoStep(
    "7) 天气看板刷新",
    async () => {
      await setCurrentOrder(order.id, { stageText: "演示中：目的地天气高风险，等待 Agent 处置" });
      return {
        当前天气: state.currentWeather?.current?.weather_text,
        风险等级: state.currentWeather?.risk?.risk_level,
        风险分: state.currentWeather?.risk?.risk_score,
        Agent建议: state.currentWeather?.suggested_action,
        建议说明: state.currentWeather?.suggested_reason,
        覆写场景: weatherScenario,
      };
    },
    { startText: "7) 地图与天气卡片正在显示高风险天气", pauseMs: DEMO_DELAY_MS.long }
  );
  void weatherView;

  const weatherHandleRes = await runDemoStep(
    "8) Agent天气异常处置",
    async () => {
      await actionWeatherHandle();
      return state.lastExceptionResult;
    },
    { startText: "8) Agent 判断目的地不可作业，自动建议暂停", pauseMs: DEMO_DELAY_MS.long }
  );

  await runDemoStep(
    "9) 查看暂停结果",
    async () => {
      const latestOrder = await request(`/orders/${order.id}`);
      return {
        订单状态: latestOrder.status,
        Agent动作: weatherHandleRes?.action_type,
        Agent说明: weatherHandleRes?.reason,
      };
    },
    { startText: "9) 正在核对订单状态与异常处理结果" }
  );

  await runDemoStep(
    "10) 等待天气窗口恢复",
    () =>
      applyDemoWeatherScenario(order.id, {
        target_scene: "clear",
        machine_scene: "clear",
        apply_current_machine: true,
        clear_existing: true,
      }),
    { startText: "10) 模拟降雨结束，作业窗口重新打开", pauseMs: DEMO_DELAY_MS.long }
  );

  await runDemoStep(
    "11) 调度员发起天气复检",
    async () => {
      await actionWeatherRecheck();
      return {
        当前天气: state.currentWeather?.current?.weather_text,
        风险等级: state.currentWeather?.risk?.risk_level,
        Agent建议: state.currentWeather?.suggested_action,
      };
    },
    { startText: "11) 正在重新检查目的地天气", pauseMs: DEMO_DELAY_MS.long }
  );

  await runDemoStep(
    "12) 恢复原机继续作业",
    async () => {
      await actionWeatherResume();
      return await request(`/orders/${order.id}`);
    },
    { startText: "12) 天气已恢复，订单重新进入作业中", pauseMs: DEMO_DELAY_MS.long }
  );

  await runDemoStep(
    "13) 完成作业",
    () => request(`/orders/${order.id}/finish?operator_id=${opId}`, { method: "POST" }),
    { startText: "13) 恢复后的作业执行中" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：天气恢复后作业已完成" });

  await runDemoStep(
    "14) 需求方确认验收",
    () => request(`/orders/${order.id}/confirm?operator_id=${pickDefaultBuyerId()}`, { method: "POST" }),
    { startText: "14) 等待需求方确认验收" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：天气恢复后需求方已确认验收" });

  const explain = await runDemoStep(
    "15) Agent解释输出",
    async () => ({ 说明: await explainWithLLM(weatherHandleRes, "需求方") }),
    { startText: "15) 正在生成天气暂停与恢复的可读解释", pauseMs: DEMO_DELAY_MS.long }
  );

  await Promise.all([loadOrders(), loadMetrics()]);
  void explain;
  appendDemoLog("天气暂停演示结束");
}

async function demoFaultFlow() {
  await clearAllDemoWeatherOverrides();
  clearDemoLog();
  appendDemoLog("开始：故障改派演示");
  await pauseAfterStep(DEMO_DELAY_MS.short);

  const order = await runDemoStep(
    "1) 创建订单",
    async () => {
      const created = await createDemoOrder({ areaMu: 240, urgency: "high", quality: "到场延迟<=30分钟" });
      return { id: created.id, status: created.status, amount: created.amount };
    },
    { startText: "1) 正在生成异常场景订单" }
  );

  const opId = getOperatorId();
  await runDemoStep(
    "2) 支付托管",
    () => request(`/orders/${order.id}/pay?operator_id=${opId}`, { method: "POST" }),
    { startText: "2) 正在进入支付托管环节" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：已支付托管，等待首次派单" });

  const dispatchRes = await runDemoStep(
    "3) Agent首次派单",
    () =>
      request("/agents/dispatch/propose", {
        method: "POST",
        body: JSON.stringify({ order_id: order.id, auto_transition: true }),
      }),
    { startText: "3) Agent 正在生成首次派单方案", pauseMs: DEMO_DELAY_MS.long }
  );
  state.lastDispatchProposal = dispatchRes;
  state.lastExceptionResult = null;
  await setCurrentOrder(order.id, { stageText: "演示中：Agent 已生成首次派单候选" });
  const selectedMachine = dispatchRes.selected_machine_id;
  if (!selectedMachine) throw new Error("故障演示中首次派单未选出机具");

  await runDemoStep(
    "4) 人工确认首次派单",
    () =>
      request(`/orders/${order.id}/transition`, {
        method: "POST",
        body: JSON.stringify({
          to_status: "DISPATCH_CONFIRMED",
          operator_id: opId,
          payload: { machine_id: selectedMachine },
        }),
      }),
    { startText: "4) 等待人工确认首次派单" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：人工已确认首次派单" });
  await runDemoStep(
    "5) 开始作业",
    () => request(`/orders/${order.id}/start?operator_id=${opId}`, { method: "POST" }),
    { startText: "5) 首次作业开始" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：首次作业进行中" });

  await runDemoStep(
    "6) 标记异常待处理",
    () =>
      request(`/orders/${order.id}/transition`, {
        method: "POST",
        body: JSON.stringify({
          to_status: "ABNORMAL_PENDING",
          operator_id: opId,
          note: "发动机温度异常，进入异常流程",
        }),
      }),
    { startText: "6) 模拟设备故障，订单转入异常处理" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：订单进入异常处理" });

  const exceptionRes = await runDemoStep(
    "7) Agent异常处置建议",
    () =>
      request("/agents/exception/handle", {
        method: "POST",
        body: JSON.stringify({
          order_id: order.id,
          event_type: "fault",
          description: "发动机温度异常，建议改派",
          auto_transition: true,
        }),
      }),
    { startText: "7) Agent 正在评估故障并寻找替补机具", pauseMs: DEMO_DELAY_MS.long }
  );
  state.lastExceptionResult = exceptionRes;
  state.lastAgentPayload = exceptionRes;
  await setCurrentOrder(order.id, { stageText: "演示中：Agent 已给出改派建议" });

  const replacementMachineId = exceptionRes.replacement_machine_id;
  if (!replacementMachineId) throw new Error("故障演示中没有可用替补机具");

  await runDemoStep(
    "8) 人工确认改派",
    () =>
      request(`/orders/${order.id}/transition`, {
        method: "POST",
        body: JSON.stringify({
          to_status: "REASSIGN_CONFIRMED",
          operator_id: opId,
          payload: { machine_id: replacementMachineId },
        }),
      }),
    { startText: "8) 等待人工确认改派" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：人工已确认改派" });

  await runDemoStep(
    "9) 恢复作业",
    () => request(`/orders/${order.id}/start?operator_id=${opId}`, { method: "POST" }),
    { startText: "9) 替补机具接手，恢复作业" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：替补机具已恢复作业" });
  await runDemoStep(
    "10) 完成作业",
    () => request(`/orders/${order.id}/finish?operator_id=${opId}`, { method: "POST" }),
    { startText: "10) 改派后的作业执行中" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：改派后作业已完成" });
  await runDemoStep(
    "11) 确认验收",
    () => request(`/orders/${order.id}/confirm?operator_id=${pickDefaultBuyerId()}`, { method: "POST" }),
    { startText: "11) 等待需求方确认验收" }
  );
  await setCurrentOrder(order.id, { stageText: "演示中：需求方已确认验收" });

  const explain = await runDemoStep(
    "12) Agent解释输出",
    async () => ({ 说明: await explainWithLLM(exceptionRes, "需求方") }),
    { startText: "12) 正在生成故障改派解释", pauseMs: DEMO_DELAY_MS.long }
  );

  await Promise.all([loadOrders(), loadMetrics()]);
  void explain;
  appendDemoLog("故障改派演示结束");
}

function bindEvents() {
  dom.refreshAllBtn.addEventListener("click", () => run(refreshAll));

  dom.llmConfigBtn.addEventListener("click", openLLMModal);
  dom.mapConfigBtn.addEventListener("click", openMapModal);
  dom.llmCloseBtn.addEventListener("click", closeLLMModal);
  dom.llmModal.addEventListener("click", (e) => {
    if (e.target === dom.llmModal) closeLLMModal();
  });
  dom.llmSaveBtn.addEventListener("click", () => {
    const previousMapConfig = JSON.stringify(state.mapConfig);
    applyLLMFormToState();
    if (previousMapConfig !== JSON.stringify(state.mapConfig)) {
      resetMapRuntime();
    }
    saveLLMConfig();
    updateLLMStatus();
    dom.llmHintText.textContent = "已保存外部服务设置。";
    void renderMapScene();
  });
  dom.llmClearBtn.addEventListener("click", () => {
    clearLLMConfig();
    clearMapConfig();
    resetMapRuntime();
    openLLMModal();
    updateLLMStatus();
    dom.llmHintText.textContent = "已清空本地设置。";
    void renderMapScene();
  });

  dom.targetOrderIdInput.addEventListener("change", () => {
    const orderId = Number(dom.targetOrderIdInput.value);
    if (!orderId) {
      state.currentOrder = null;
      setMapStage("等待订单");
      void renderMapScene();
      return;
    }
    void setCurrentOrder(orderId, { stageText: "已切换到当前订单" });
  });

  const rerenderDraftTarget = () => {
    void renderMapScene();
  };
  dom.lngInput.addEventListener("input", rerenderDraftTarget);
  dom.latInput.addEventListener("input", rerenderDraftTarget);

  dom.demoStandardBtn.addEventListener("click", () => runDemo(demoStandardFlow));
  dom.demoWeatherBtn.addEventListener("click", () => runDemo(demoWeatherFlow));
  dom.demoFaultBtn.addEventListener("click", () => runDemo(demoFaultFlow));
  dom.demoClearBtn.addEventListener("click", clearDemoLog);

  dom.parseDemandBtn.addEventListener("click", () => run(parseDemand));
  dom.createOrderBtn.addEventListener("click", () => run(createOrder));
  dom.payBtn.addEventListener("click", () => run(actionPay));
  dom.dispatchBtn.addEventListener("click", () => run(actionDispatch));
  dom.confirmDispatchBtn.addEventListener("click", () => run(actionConfirmDispatch));
  dom.startBtn.addEventListener("click", () => run(actionStart));
  dom.finishBtn.addEventListener("click", () => run(actionFinish));
  dom.confirmBtn.addEventListener("click", () => run(actionConfirm));
  dom.markAbnormalBtn.addEventListener("click", () => run(actionMarkAbnormal));
  dom.exceptionBtn.addEventListener("click", () => run(actionException));
  dom.weatherHandleBtn.addEventListener("click", () => run(actionWeatherHandle));
  dom.weatherRecheckBtn.addEventListener("click", () => run(actionWeatherRecheck));
  dom.weatherResumeBtn.addEventListener("click", () => run(actionWeatherResume));
  dom.weatherRefundBtn.addEventListener("click", () => run(actionWeatherRefund));
  dom.explainBtn.addEventListener("click", () => run(actionExplain));
}

async function run(fn) {
  try {
    await fn();
  } catch (err) {
    setCode(dom.agentOutput, { 错误: err.message || String(err) });
  }
}

async function runDemo(fn) {
  if (state.demoRunning) {
    appendDemoLog("已有演示正在进行，请等待当前流程完成");
    return;
  }
  setDemoButtonsDisabled(true);
  try {
    await fn();
  } catch (err) {
    const msg = err.message || String(err);
    appendDemoLog("演示失败", { 错误: msg });
    setCode(dom.agentOutput, { 错误: msg });
  } finally {
    setDemoButtonsDisabled(false);
  }
}

async function init() {
  loadLLMConfig();
  loadMapConfig();
  updateLLMStatus();
  dom.apiBaseText.textContent = `API: ${state.apiBase}`;
  updateMapMeta();
  bindEvents();
  await refreshAll();
}

init().catch((err) => {
  setCode(dom.agentOutput, { 初始化错误: err.message || String(err) });
});
