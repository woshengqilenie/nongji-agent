import {
  apiBase,
  emptyState,
  escapeHtml,
  metricCardHtml,
  orderCardHtml,
  request,
  shortTime,
  timelineHtml,
  urgencyText,
} from "./shared.js";
import { ensureAMap, initPlatformSettings, streamLLMChat, toAmapPosition } from "./platform.js";

const state = {
  owners: [],
  machines: [],
  dashboard: null,
  activeGroup: "pending_response",
  selectedOrderId: null,
  weather: null,
  weatherError: "",
  mapRuntime: {
    instance: null,
    infoWindow: null,
    overlays: [],
  },
  gpsRuntime: {
    timer: null,
    overlays: [],
    activeOrderId: null,
    lastSnapshot: null,
  },
};

const dom = {
  ownerSelect: document.getElementById("ownerSelect"),
  machineMetrics: document.getElementById("machineMetrics"),
  groupTabs: document.getElementById("groupTabs"),
  groupOrders: document.getElementById("groupOrders"),
  selectedOrderSummary: document.getElementById("selectedOrderSummary"),
  selectedOrderTimeline: document.getElementById("selectedOrderTimeline"),
  selectedOrderMeta: document.getElementById("selectedOrderMeta"),
  machineMapCanvas: document.getElementById("machineMapCanvas"),
  machineMapPlaceholder: document.getElementById("machineMapPlaceholder"),
  machineMapFullscreenBtn: document.getElementById("machineMapFullscreenBtn"),
  machineWeatherPanel: document.getElementById("machineWeatherPanel"),
  machineAiAdviceBtn: document.getElementById("machineAiAdviceBtn"),
  machineAiInsight: document.getElementById("machineAiInsight"),
  machineNoteInput: document.getElementById("machineNoteInput"),
  proposedWindowInput: document.getElementById("proposedWindowInput"),
  machineActionResult: document.getElementById("machineActionResult"),
  gpsWorkbenchPanel: document.getElementById("gpsWorkbenchPanel"),
  acceptBtn: document.getElementById("acceptBtn"),
  departBtn: document.getElementById("departBtn"),
  startBtn: document.getElementById("startBtn"),
  finishBtn: document.getElementById("finishBtn"),
  rejectBtn: document.getElementById("rejectBtn"),
  rescheduleBtn: document.getElementById("rescheduleBtn"),
  faultBtn: document.getElementById("faultBtn"),
  refreshOwnerBtn: document.getElementById("refreshOwnerBtn"),
};

function currentOwnerId() {
  return Number(dom.ownerSelect.value || 0);
}

function ownerOrdersByGroup(groupKey) {
  return state.dashboard?.groups?.[groupKey] || [];
}

function findSelectedOrder() {
  const groups = state.dashboard?.groups || {};
  return Object.values(groups).flat().find((item) => Number(item.id) === Number(state.selectedOrderId)) || null;
}

function ownerMachines() {
  return state.machines.filter((item) => Number(item.owner_id) === Number(currentOwnerId()));
}

function primaryMachineForOrder(order) {
  if (!order) return ownerMachines()[0] || null;
  if (order.machine?.id) {
    return state.machines.find((item) => Number(item.id) === Number(order.machine.id)) || ownerMachines()[0] || null;
  }
  return ownerMachines()[0] || null;
}

function renderMetrics() {
  if (!state.dashboard) {
    dom.machineMetrics.innerHTML = "";
    return;
  }
  const metrics = state.dashboard.metrics;
  dom.machineMetrics.innerHTML = [
    metricCardHtml("待响应", metrics.pending_response, "主管端已派单，等待你确认"),
    metricCardHtml("已接单", metrics.accepted, "已确认但尚未出发"),
    metricCardHtml("在途 / 作业", `${metrics.en_route + metrics.in_service}`, "正在履约的农机任务"),
    metricCardHtml("异常任务", metrics.abnormal, "故障、改派或天气异常待处理"),
  ].join("");
}

function renderTabs() {
  const labels = {
    pending_response: "待响应",
    accepted: "已接单",
    en_route: "在途",
    in_service: "作业中",
    abnormal: "异常",
    history: "历史",
  };
  dom.groupTabs.innerHTML = Object.entries(labels)
    .map(
      ([key, label]) => `<button class="btn ${state.activeGroup === key ? "primary" : "secondary"}" data-group="${key}">${escapeHtml(label)}</button>`
    )
    .join("");
  dom.groupTabs.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeGroup = button.dataset.group;
      renderTabs();
      renderGroupOrders();
    });
  });
}

function ensureSelectedOrder() {
  const groups = state.dashboard?.groups || {};
  const currentGroupOrders = ownerOrdersByGroup(state.activeGroup);
  if (currentGroupOrders.some((item) => Number(item.id) === Number(state.selectedOrderId))) return;
  const fallback = currentGroupOrders[0] || Object.values(groups).flat()[0] || null;
  state.selectedOrderId = fallback?.id || null;
}

function renderGroupOrders() {
  ensureSelectedOrder();
  const orders = ownerOrdersByGroup(state.activeGroup);
  if (!orders.length) {
    dom.groupOrders.innerHTML = emptyState("当前分组没有任务。");
    renderSelectedOrder();
    return;
  }
  dom.groupOrders.innerHTML = orders
    .map((item) => orderCardHtml(item, { selected: Number(item.id) === Number(state.selectedOrderId), counterpart: "buyer" }))
    .join("");
  dom.groupOrders.querySelectorAll(".order-card").forEach((card) => {
    card.addEventListener("click", () => {
      if (Number(card.dataset.orderId) !== Number(state.selectedOrderId)) stopGpsWorkDemo();
      state.selectedOrderId = Number(card.dataset.orderId);
      renderGroupOrders();
      void syncSelectedOrderContext();
    });
  });
  renderSelectedOrder();
}

function updateActionButtons(order) {
  const canAccept = order && ["DISPATCH_CONFIRMED", "REASSIGN_CONFIRMED"].includes(order.status) && ["waiting_owner", "reassign_waiting_owner"].includes(order.stage_key);
  const canDepart = order && ["DISPATCH_CONFIRMED", "REASSIGN_CONFIRMED"].includes(order.status) && ["accepted", "reassign_accepted", "waiting_owner", "reassign_waiting_owner"].includes(order.stage_key);
  const canStart = order && (order.status === "IN_SERVICE" || ["DISPATCH_CONFIRMED", "REASSIGN_CONFIRMED"].includes(order.status));
  const canFinish = order && order.status === "IN_SERVICE";
  const canReject = order && ["DISPATCH_CONFIRMED", "REASSIGN_CONFIRMED"].includes(order.status);
  const canReschedule = order && ["DISPATCH_CONFIRMED", "REASSIGN_CONFIRMED"].includes(order.status);
  const canFault = order && ["DISPATCH_CONFIRMED", "REASSIGN_CONFIRMED", "IN_SERVICE", "ABNORMAL_PENDING"].includes(order.status);

  dom.acceptBtn.disabled = !canAccept;
  dom.departBtn.disabled = !canDepart;
  dom.startBtn.disabled = !canStart;
  dom.finishBtn.disabled = !canFinish;
  dom.rejectBtn.disabled = !canReject;
  dom.rescheduleBtn.disabled = !canReschedule;
  dom.faultBtn.disabled = !canFault;
}

function renderSelectedOrder() {
  const order = findSelectedOrder();
  updateActionButtons(order);
  if (!order) {
    dom.selectedOrderSummary.textContent = "请选择左侧任务卡片。";
    dom.selectedOrderTimeline.innerHTML = "";
    dom.selectedOrderMeta.textContent = "暂无选中任务。";
    renderGpsWorkbench(null);
    return;
  }
  dom.selectedOrderSummary.innerHTML = `
    <div class="card-topline">
      <div>
        <span class="eyebrow">任务 #${escapeHtml(order.id)}</span>
        <h3>${escapeHtml(order.sku.title)}</h3>
      </div>
      <span class="badge ${order.status === "ABNORMAL_PENDING" ? "danger" : "warning"}">${escapeHtml(order.stage_label)}</span>
    </div>
    <div class="order-line">${escapeHtml(order.target.region)} · ${escapeHtml(order.area_mu)} 亩 · ${escapeHtml(order.service_window)}</div>
    <div class="order-line muted">需求方 ${escapeHtml(order.buyer.name)} · 紧急程度 ${escapeHtml(urgencyText(order.urgency_level))}</div>
    <p class="order-note">${escapeHtml(order.logistics_text)}</p>
  `;
  dom.selectedOrderTimeline.innerHTML = timelineHtml(order.timeline);
  dom.selectedOrderMeta.innerHTML = `
    <strong>作业说明</strong>
    <p class="section-note">${escapeHtml(order.quality_constraints || "暂无额外要求")}</p>
    <div class="section-divider"></div>
    <div class="order-line">当前机具：${escapeHtml(order.machine.machine_type || "待平台确认")} #${escapeHtml(order.machine.id || "-")}</div>
    <div class="order-line">最新动态：${escapeHtml(order.latest_event.summary || "暂无")}</div>
    <div class="order-line muted">更新时间：${escapeHtml(shortTime(order.updated_at))}</div>
  `;
  renderGpsWorkbench(order, state.gpsRuntime.lastSnapshot);
}

function weatherPanelHtml() {
  if (state.weatherError) {
    return `<pre>${escapeHtml(state.weatherError)}</pre>`;
  }
  if (!state.weather) {
    return "<pre>选择任务后可查看目的地天气与当前机具天气对比。</pre>";
  }
  const risk = state.weather.risk || {};
  const machineContext = state.weather.machine_context || null;
  const stats = [
    { value: `${state.weather.current.temperature_2m}°C`, label: "当前温度" },
    { value: `${risk.max_precip_probability}%`, label: "降水概率" },
    { value: `${risk.max_wind_speed} km/h`, label: "最大风速" },
    { value: `${risk.risk_score ?? "-"}`, label: "风险分" },
  ];
  if (machineContext) {
    stats.push({ value: `${machineContext.distance_km} km`, label: "机具距地块" });
    stats.push({ value: machineContext.current.weather_text, label: "机具所在地天气" });
  }
  return `
    <div class="weather-summary">${escapeHtml(state.weather.current.weather_text)}。${escapeHtml(state.weather.suggested_reason || risk.recommendation || "请结合时窗决定是否接单。")}</div>
    <div class="tag-row">
      <span class="badge ${String(risk.risk_level || "").toLowerCase() === "high" ? "danger" : String(risk.risk_level || "").toLowerCase() === "medium" ? "warning" : "info"}">风险 ${escapeHtml(risk.risk_level || "未评估")}</span>
      <span class="badge neutral">${escapeHtml(state.weather.provider || "天气服务")}</span>
      ${(risk.flags || []).slice(0, 3).map((flag) => `<span class="badge neutral">${escapeHtml(flag)}</span>`).join("")}
    </div>
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
        ? `<div class="note-box">机具与地块天气对比：${escapeHtml(machineContext.comparison_text || "暂无")}</div>`
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

function renderWeather() {
  dom.machineWeatherPanel.innerHTML = weatherPanelHtml();
}

async function loadOwners() {
  const users = await request("/catalog/users");
  state.owners = users.filter((item) => item.role === "owner");
  dom.ownerSelect.innerHTML = state.owners
    .map((item) => `<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.region)}</option>`)
    .join("");
}

async function loadMachines() {
  state.machines = await request("/catalog/machines");
}

async function loadDashboard() {
  state.dashboard = await request(`/machine/orders?owner_id=${currentOwnerId()}`);
  renderMetrics();
  renderTabs();
  renderGroupOrders();
  await syncSelectedOrderContext();
}

async function loadWeather() {
  const order = findSelectedOrder();
  if (!order) {
    state.weather = null;
    state.weatherError = "";
    return;
  }
  try {
    state.weather = await request(`/weather/order/${order.id}`);
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
  dom.machineMapCanvas.innerHTML = "";
}

function setMapPlaceholder(message, visible = true) {
  dom.machineMapPlaceholder.textContent = message;
  dom.machineMapPlaceholder.classList.toggle("hidden", !visible);
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
    state.mapRuntime.instance = new AMap.Map(dom.machineMapCanvas, {
      zoom: 7,
      center: toAmapPosition(117.2, 36.6),
      resizeEnable: true,
    });
    state.mapRuntime.infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -26) });
  }
  return { AMap, map: state.mapRuntime.instance };
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

function metersPerLngDegree(lat) {
  return 111320 * Math.max(Math.cos((Number(lat) * Math.PI) / 180), 0.2);
}

function offsetLngLat(origin, eastM, northM) {
  const lng = Number(origin.lng) + eastM / metersPerLngDegree(origin.lat);
  const lat = Number(origin.lat) + northM / 111320;
  return { lng, lat };
}

function lngLatToAmap(point) {
  return toAmapPosition(point.lng, point.lat);
}

function distanceMeters(a, b) {
  const lat = (Number(a.lat) + Number(b.lat)) / 2;
  const dx = (Number(b.lng) - Number(a.lng)) * metersPerLngDegree(lat);
  const dy = (Number(b.lat) - Number(a.lat)) * 111320;
  return Math.sqrt(dx * dx + dy * dy);
}

function interpolatePoint(a, b, ratio) {
  return {
    lng: Number(a.lng) + (Number(b.lng) - Number(a.lng)) * ratio,
    lat: Number(a.lat) + (Number(b.lat) - Number(a.lat)) * ratio,
  };
}

function buildGpsDemoGeometry(order, machine) {
  const areaMu = Math.max(Number(order?.area_mu || 0), 1);
  const areaSqm = areaMu * 666.6667;
  const target = { lng: Number(order.target.lng), lat: Number(order.target.lat) };
  const fieldWidthM = Math.sqrt(areaSqm * 1.35);
  const fieldHeightM = areaSqm / fieldWidthM;
  const swathWidthM = Math.max(8, Math.min(18, fieldHeightM / 7));
  const halfW = fieldWidthM / 2;
  const halfH = fieldHeightM / 2;
  const corners = [
    offsetLngLat(target, -halfW, -halfH),
    offsetLngLat(target, halfW, -halfH),
    offsetLngLat(target, halfW, halfH),
    offsetLngLat(target, -halfW, halfH),
  ];
  const rowCount = Math.max(5, Math.ceil(fieldHeightM / swathWidthM));
  const rowStep = fieldHeightM / Math.max(rowCount - 1, 1);
  const workPath = [];
  for (let idx = 0; idx < rowCount; idx += 1) {
    const y = -halfH + idx * rowStep;
    const west = offsetLngLat(target, -halfW, y);
    const east = offsetLngLat(target, halfW, y);
    if (idx % 2 === 0) {
      workPath.push(west, east);
    } else {
      workPath.push(east, west);
    }
  }
  const startPoint = machine ? { lng: machine.lng, lat: machine.lat } : offsetLngLat(target, -halfW - 160, -halfH - 80);
  const approachPath = [startPoint, offsetLngLat(target, -halfW - 70, -halfH - 35), workPath[0]];
  const fullPath = [...approachPath, ...workPath.slice(1)];
  return {
    areaMu,
    areaSqm,
    target,
    corners,
    fullPath,
    workStartIndex: approachPath.length - 1,
    fieldWidthM,
    fieldHeightM,
    swathWidthM,
  };
}

function snapshotAtPathIndex(geometry, pathIndex) {
  const safeIndex = Math.max(0, Math.min(pathIndex, geometry.fullPath.length - 1));
  const visiblePath = geometry.fullPath.slice(0, safeIndex + 1);
  let workDistanceM = 0;
  for (let idx = Math.max(geometry.workStartIndex, 1); idx <= safeIndex; idx += 1) {
    workDistanceM += distanceMeters(geometry.fullPath[idx - 1], geometry.fullPath[idx]);
  }
  const actualAreaMu = Math.min(geometry.areaMu, (workDistanceM * geometry.swathWidthM) / 666.6667);
  const coverageRatio = geometry.areaMu ? Math.min(actualAreaMu / geometry.areaMu, 1) : 0;
  const halfW = geometry.fieldWidthM / 2;
  const halfH = geometry.fieldHeightM / 2;
  const coveredX = -halfW + geometry.fieldWidthM * coverageRatio;
  const coveredPolygon =
    coverageRatio <= 0
      ? []
      : [
          offsetLngLat(geometry.target, -halfW, -halfH),
          offsetLngLat(geometry.target, coveredX, -halfH),
          offsetLngLat(geometry.target, coveredX, halfH),
          offsetLngLat(geometry.target, -halfW, halfH),
        ];
  return {
    plannedAreaMu: geometry.areaMu,
    actualAreaMu,
    coverageRatio,
    visiblePath,
    coveredPolygon,
    pointCount: visiblePath.length,
  };
}

function renderGpsWorkbench(order, snapshot = null) {
  if (!dom.gpsWorkbenchPanel) return;
  if (!order) {
    dom.gpsWorkbenchPanel.innerHTML = `<div class="gps-status">请选择任务后查看 GPS 作业核算。</div>`;
    return;
  }
  const activeForOrder = Number(state.gpsRuntime.activeOrderId) === Number(order.id);
  const data = activeForOrder && snapshot ? snapshot : null;
  const planned = Number(order.area_mu || 0);
  const actual = data ? data.actualAreaMu : 0;
  const coverage = data ? Math.round(data.coverageRatio * 100) : 0;
  const status = data
    ? `GPS 正在回传：已核算 ${actual.toFixed(1)} 亩`
    : order.status === "IN_SERVICE"
      ? "当前任务作业中，可播放模拟 GPS 轨迹。"
      : "点击“开始作业”后生成模拟 GPS 轨迹。";
  dom.gpsWorkbenchPanel.innerHTML = `
    <div class="gps-status">${escapeHtml(status)}</div>
    <div class="gps-meter-grid">
      <div><span>计划面积</span><strong>${escapeHtml(planned)} 亩</strong></div>
      <div><span>GPS核算</span><strong>${escapeHtml(actual.toFixed(1))} 亩</strong></div>
      <div><span>覆盖率</span><strong>${escapeHtml(coverage)}%</strong></div>
      <div><span>轨迹点</span><strong>${escapeHtml(data?.pointCount || 0)} 个</strong></div>
    </div>
    <div class="gps-progress"><span style="width: ${coverage}%"></span></div>
    <div class="inline-actions">
      <button id="gpsReplayBtn" class="btn secondary" type="button" ${order.status !== "IN_SERVICE" ? "disabled" : ""}>播放 GPS 轨迹</button>
      <button id="gpsStopBtn" class="btn secondary" type="button" ${!activeForOrder ? "disabled" : ""}>停止</button>
    </div>
  `;
  document.getElementById("gpsReplayBtn")?.addEventListener("click", () => void startGpsWorkDemo(order));
  document.getElementById("gpsStopBtn")?.addEventListener("click", stopGpsWorkDemo);
}

function clearGpsOverlays() {
  if (state.gpsRuntime.timer) {
    window.clearInterval(state.gpsRuntime.timer);
    state.gpsRuntime.timer = null;
  }
  if (state.mapRuntime.instance && state.gpsRuntime.overlays.length) {
    state.mapRuntime.instance.remove(state.gpsRuntime.overlays);
  }
  state.gpsRuntime.overlays = [];
}

function stopGpsWorkDemo() {
  clearGpsOverlays();
  state.gpsRuntime.activeOrderId = null;
  renderGpsWorkbench(findSelectedOrder(), state.gpsRuntime.lastSnapshot);
}

async function startGpsWorkDemo(orderArg = null) {
  const order = orderArg || findSelectedOrder();
  const machine = primaryMachineForOrder(order);
  if (!order || order.target.lng == null || order.target.lat == null) {
    renderGpsWorkbench(order);
    return;
  }
  let mapPack;
  try {
    mapPack = await ensureMapInstance();
  } catch (error) {
    state.gpsRuntime.lastSnapshot = {
      plannedAreaMu: Number(order.area_mu || 0),
      actualAreaMu: 0,
      coverageRatio: 0,
      pointCount: 0,
    };
    renderGpsWorkbench(order, state.gpsRuntime.lastSnapshot);
    dom.gpsWorkbenchPanel?.insertAdjacentHTML("beforeend", `<div class="gps-hint">${escapeHtml(error.message || "地图加载失败，无法播放 GPS 轨迹。")}</div>`);
    return;
  }

  clearGpsOverlays();
  clearMapOverlays();
  const { AMap, map } = mapPack;
  const geometry = buildGpsDemoGeometry(order, machine);
  const fieldPolygon = new AMap.Polygon({
    path: geometry.corners.map(lngLatToAmap),
    strokeColor: "#d6961f",
    strokeWeight: 2,
    strokeOpacity: 0.95,
    fillColor: "#f5d58b",
    fillOpacity: 0.18,
  });
  const coveredPolygon = new AMap.Polygon({
    path: [],
    strokeColor: "#1b7f5b",
    strokeWeight: 1,
    strokeOpacity: 0.7,
    fillColor: "#1b7f5b",
    fillOpacity: 0.28,
  });
  const trackLine = new AMap.Polyline({
    path: [],
    strokeColor: "#2d5b7b",
    strokeWeight: 6,
    strokeOpacity: 0.92,
    lineJoin: "round",
    lineCap: "round",
  });
  const machineMarker = new AMap.Marker({
    position: lngLatToAmap(geometry.fullPath[0]),
    anchor: "center",
    content: `<div class="map-pin-dot gps-active"></div>`,
  });
  const label = new AMap.Text({
    position: lngLatToAmap(geometry.target),
    anchor: "top-center",
    offset: new AMap.Pixel(0, 12),
    text: "GPS作业核算",
    style: pinLabelStyle("selected"),
  });
  state.gpsRuntime.overlays = [fieldPolygon, coveredPolygon, trackLine, machineMarker, label];
  map.add(state.gpsRuntime.overlays);
  map.setFitView(state.gpsRuntime.overlays, false, [70, 70, 70, 70]);
  state.gpsRuntime.activeOrderId = order.id;

  let idx = 0;
  const tick = () => {
    const snapshot = snapshotAtPathIndex(geometry, idx);
    state.gpsRuntime.lastSnapshot = snapshot;
    trackLine.setPath(snapshot.visiblePath.map(lngLatToAmap));
    if (snapshot.coveredPolygon.length) {
      coveredPolygon.setPath(snapshot.coveredPolygon.map(lngLatToAmap));
    }
    machineMarker.setPosition(lngLatToAmap(snapshot.visiblePath[snapshot.visiblePath.length - 1]));
    renderGpsWorkbench(order, snapshot);
    idx += 1;
    if (idx >= geometry.fullPath.length) {
      window.clearInterval(state.gpsRuntime.timer);
      state.gpsRuntime.timer = null;
    }
  };
  tick();
  state.gpsRuntime.timer = window.setInterval(tick, 420);
}

async function renderMap() {
  const order = findSelectedOrder();
  const machine = primaryMachineForOrder(order);
  clearMapOverlays();
  if (!order && !machine) {
    setMapPlaceholder("选择任务后可查看机具与地块地图。");
    return;
  }
  if (order && (order.target.lng == null || order.target.lat == null)) {
    setMapPlaceholder("当前任务缺少地块经纬度，暂时无法绘制地图。");
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
  if (order) {
    const targetMarker = createPinOverlay(AMap, {
      position: toAmapPosition(order.target.lng, order.target.lat),
      tone: "target",
      label: `任务地块 #${order.id}`,
      infoHtml: `<div><strong>任务 #${escapeHtml(order.id)}</strong><br />${escapeHtml(order.target.region)}</div>`,
    });
    fitOverlays.push(targetMarker);
  }

  if (machine) {
    const tone = order?.status === "ABNORMAL_PENDING" ? "fault" : "selected";
    const machineMarker = createPinOverlay(AMap, {
      position: toAmapPosition(machine.lng, machine.lat),
      tone,
      label: `#${machine.id} ${machine.machine_type}`,
      infoHtml: `<div><strong>#${escapeHtml(machine.id)} ${escapeHtml(machine.machine_type)}</strong><br />机况分：${escapeHtml(machine.health_score)}<br />作业效率：${escapeHtml(machine.capacity_mu_per_hour)} 亩/小时</div>`,
    });
    fitOverlays.push(machineMarker);
  }

  if (order && machine) {
    const polyline = new AMap.Polyline({
      path: [toAmapPosition(machine.lng, machine.lat), toAmapPosition(order.target.lng, order.target.lat)],
      strokeColor: order.status === "ABNORMAL_PENDING" ? "#cc473d" : "#0f7f68",
      strokeWeight: 5,
      strokeStyle: order.status === "ABNORMAL_PENDING" ? "dashed" : "solid",
      strokeOpacity: 0.85,
    });
    const lineMarker = createRouteText(
      AMap,
      [
        (toAmapPosition(machine.lng, machine.lat)[0] + toAmapPosition(order.target.lng, order.target.lat)[0]) / 2,
        (toAmapPosition(machine.lng, machine.lat)[1] + toAmapPosition(order.target.lng, order.target.lat)[1]) / 2,
      ],
      order.status === "ABNORMAL_PENDING" ? "异常待处理路径" : "当前履约路径",
      order.status === "ABNORMAL_PENDING" ? "fault" : "selected"
    );
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

function machineAdviceFallback(order) {
  const lines = [];
  if (!order) return "请先选择一个任务。";
  lines.push(`当前任务阶段为 ${order.stage_label}，需求方为 ${order.buyer.name}。`);
  if (state.weather?.risk) {
    lines.push(`天气风险 ${state.weather.risk.risk_level || "未评估"}，建议 ${state.weather.suggested_reason || state.weather.risk.recommendation || "结合天气再判断"}。`);
  }
  if (["waiting_owner", "reassign_waiting_owner"].includes(order.stage_key)) {
    lines.push("如果机具状态正常且天气可接受，优先确认接单；若时窗冲突，建议直接申请改约。");
  } else if (order.status === "ABNORMAL_PENDING") {
    lines.push("当前已进入异常池，优先写明故障或天气原因，便于主管端快速改派。");
  } else {
    lines.push("请根据进度补齐出发、开工或完工动作，避免任务停在中间状态。");
  }
  return lines.join("\n");
}

async function generateMachineInsight() {
  const order = findSelectedOrder();
  if (!order) {
    dom.machineAiInsight.innerHTML = "<pre>请先选择一个任务，再生成 AI 建议。</pre>";
    return;
  }
  const payload = {
    order,
    weather: state.weather,
    available_actions: {
      accept: !dom.acceptBtn.disabled,
      depart: !dom.departBtn.disabled,
      start: !dom.startBtn.disabled,
      finish: !dom.finishBtn.disabled,
      reject: !dom.rejectBtn.disabled,
      reschedule: !dom.rescheduleBtn.disabled,
      fault: !dom.faultBtn.disabled,
    },
    owner_machine: primaryMachineForOrder(order),
  };
  dom.machineAiInsight.innerHTML = "<pre>AI 正在生成接单建议...</pre>";
  try {
    const full = await streamLLMChat({
      apiBase,
      stage: "农机端AI建议",
      messages: [
        {
          role: "system",
          content:
            "你是农机端接单助手。请用中文给机主/机手输出 4 到 6 行建议，重点判断当前应接单、改约、出发还是上报异常。不要输出 JSON。",
        },
        {
          role: "user",
          content: `请根据以下上下文给出建议：\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      onToken: (partial) => {
        dom.machineAiInsight.innerHTML = `<pre>${escapeHtml(partial)}</pre>`;
      },
    });
    dom.machineAiInsight.innerHTML = `<pre>${escapeHtml(full)}</pre>`;
  } catch (error) {
    dom.machineAiInsight.innerHTML = `<pre>${escapeHtml(machineAdviceFallback(order))}\n\n[提示] ${escapeHtml(error.message || String(error))}</pre>`;
  }
}

async function syncSelectedOrderContext() {
  renderSelectedOrder();
  await loadWeather();
  renderWeather();
  await renderMap();
}

async function performAction(path, body = {}) {
  const order = findSelectedOrder();
  if (!order) {
    dom.machineActionResult.innerHTML = "<pre>请先选择一个任务。</pre>";
    return;
  }
  const payload = {
    operator_id: currentOwnerId(),
    note: dom.machineNoteInput.value.trim(),
    proposed_window: dom.proposedWindowInput.value.trim(),
    ...body,
  };
  const result = await request(`/machine/orders/${order.id}${path}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  renderActionResult(result);
  await loadDashboard();
  state.selectedOrderId = result.id;
  await syncSelectedOrderContext();
  if (path === "/start") {
    const updatedOrder = findSelectedOrder();
    await startGpsWorkDemo(updatedOrder || result);
  }
}

function renderActionResult(result) {
  const summary = [
    `订单 #${result.id}`,
    result.stage_label || result.status,
    result.logistics_text,
  ]
    .filter(Boolean)
    .join(" · ");
  dom.machineActionResult.innerHTML = `
    <div class="result-feedback">
      <strong>${escapeHtml(summary || "动作已完成")}</strong>
      <button id="toggleMachineActionJson" class="btn secondary" type="button">查看原始 JSON</button>
      <pre id="machineActionJson" class="hidden">${escapeHtml(JSON.stringify(result, null, 2))}</pre>
    </div>
  `;
  document.getElementById("toggleMachineActionJson")?.addEventListener("click", (event) => {
    const jsonBox = document.getElementById("machineActionJson");
    if (!jsonBox) return;
    const nextHidden = !jsonBox.classList.contains("hidden");
    jsonBox.classList.toggle("hidden", nextHidden);
    event.currentTarget.textContent = nextHidden ? "查看原始 JSON" : "收起原始 JSON";
  });
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
  await loadOwners();
  await loadMachines();
  await loadDashboard();
  bindFullscreen(dom.machineMapFullscreenBtn, dom.machineMapCanvas.closest(".map-shell"));

  dom.ownerSelect.addEventListener("change", () => {
    stopGpsWorkDemo();
    state.selectedOrderId = null;
    void loadDashboard();
  });
  dom.refreshOwnerBtn.addEventListener("click", () => {
    stopGpsWorkDemo();
    void loadDashboard();
  });
  dom.machineAiAdviceBtn.addEventListener("click", () => void generateMachineInsight());
  dom.acceptBtn.addEventListener("click", () => void performAction("/accept"));
  dom.departBtn.addEventListener("click", () => void performAction("/depart"));
  dom.startBtn.addEventListener("click", () => void performAction("/start"));
  dom.finishBtn.addEventListener("click", () => void performAction("/finish"));
  dom.rejectBtn.addEventListener("click", () => void performAction("/reject"));
  dom.rescheduleBtn.addEventListener("click", () => void performAction("/reschedule"));
  dom.faultBtn.addEventListener("click", () => void performAction("/fault"));
}

init().catch((error) => {
  dom.machineActionResult.innerHTML = `<pre>${escapeHtml(error.message || String(error))}</pre>`;
});
