import { emptyState, escapeHtml, metricCardHtml, request, shortTime } from "./shared.js";
import { ensureAMap, initPlatformSettings, toAmapPosition } from "./platform.js";

const state = {
  overview: null,
  selectedFeature: null,
  filters: {
    region: "all",
    workType: "all",
    status: "all",
    keyword: "",
  },
  layers: {
    machines: true,
    fields: true,
    coverage: true,
    routes: true,
    alerts: true,
  },
  mapRuntime: {
    instance: null,
    infoWindow: null,
    overlays: [],
    fitTargets: [],
  },
};

const dom = {
  atlasMetrics: document.getElementById("atlasMetrics"),
  atlasRegionFilter: document.getElementById("atlasRegionFilter"),
  atlasWorkTypeFilter: document.getElementById("atlasWorkTypeFilter"),
  atlasStatusFilter: document.getElementById("atlasStatusFilter"),
  atlasKeywordInput: document.getElementById("atlasKeywordInput"),
  atlasRefreshBtn: document.getElementById("atlasRefreshBtn"),
  atlasResetBtn: document.getElementById("atlasResetBtn"),
  atlasSelectionBox: document.getElementById("atlasSelectionBox"),
  atlasVisibleSummary: document.getElementById("atlasVisibleSummary"),
  atlasLayerMachines: document.getElementById("atlasLayerMachines"),
  atlasLayerFields: document.getElementById("atlasLayerFields"),
  atlasLayerCoverage: document.getElementById("atlasLayerCoverage"),
  atlasLayerRoutes: document.getElementById("atlasLayerRoutes"),
  atlasLayerAlerts: document.getElementById("atlasLayerAlerts"),
  atlasMapCanvas: document.getElementById("atlasMapCanvas"),
  atlasMapPlaceholder: document.getElementById("atlasMapPlaceholder"),
  atlasMapFullscreenBtn: document.getElementById("atlasMapFullscreenBtn"),
  atlasMapFitBtn: document.getElementById("atlasMapFitBtn"),
};

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

function workTypeColor(workType) {
  return {
    收割: "#cf7b17",
    播种: "#2f855a",
    耕地: "#8b5e34",
    耕整: "#8b5e34",
    植保: "#2b6cb0",
  }[workType] || "#6b7280";
}

function routeColor(status) {
  if (["ABNORMAL_PENDING", "REASSIGN_PROPOSED", "DISPUTE", "REFUNDING"].includes(status)) return "#c05621";
  if (["DISPATCH_PROPOSED", "PAID_ESCROW", "DISPATCH_CONFIRMED", "REASSIGN_CONFIRMED", "TO_CONFIRM"].includes(status)) return "#b7791f";
  if (["COMPLETED"].includes(status)) return "#2f855a";
  return "#2b6cb0";
}

function alertColor(level) {
  return {
    red: "#c53030",
    orange: "#dd6b20",
    yellow: "#d69e2e",
    blue: "#3182ce",
  }[String(level || "").toLowerCase()] || "#718096";
}

function normalizeStrings(values) {
  return values.filter(Boolean).map((item) => String(item).trim()).filter(Boolean);
}

function matchesKeyword(values, keyword) {
  if (!keyword) return true;
  const text = normalizeStrings(values).join(" ").toLowerCase();
  return text.includes(keyword.toLowerCase());
}

function filters() {
  return { ...state.filters };
}

function filterFields() {
  if (!state.overview) return [];
  const current = filters();
  return (state.overview.fields || []).filter((item) => {
    if (current.region !== "all" && item.region !== current.region) return false;
    if (current.workType !== "all" && item.work_type !== current.workType && item.work_type_label !== current.workType) return false;
    if (current.status !== "all" && item.status !== current.status) return false;
    return matchesKeyword(
      [item.region, item.title, item.buyer_name, item.owner_name, item.work_type, item.work_type_label, item.order_id],
      current.keyword
    );
  });
}

function filterRoutes(filteredFields) {
  if (!state.overview) return [];
  const current = filters();
  const visibleOrderIds = new Set(filteredFields.map((item) => Number(item.order_id)));
  return (state.overview.routes || []).filter((item) => {
    if (current.status !== "all" && item.status !== current.status) return false;
    if (current.workType !== "all" && item.work_type !== current.workType && item.work_type_label !== current.workType) return false;
    if (current.region !== "all" && !visibleOrderIds.has(Number(item.order_id))) return false;
    return matchesKeyword(
      [item.owner_name, item.buyer_name, item.machine_type, item.work_type, item.work_type_label, item.order_id],
      current.keyword
    );
  });
}

function filterMachines(filteredFields, filteredRoutes) {
  if (!state.overview) return [];
  const current = filters();
  const fieldIdsByMachine = new Map();
  filteredFields.forEach((field) => {
    if (!field.machine_id) return;
    const currentIds = fieldIdsByMachine.get(Number(field.machine_id)) || [];
    currentIds.push(Number(field.order_id));
    fieldIdsByMachine.set(Number(field.machine_id), currentIds);
  });
  const routeMachineIds = new Set(filteredRoutes.map((item) => Number(item.machine_id)));
  return (state.overview.machines || []).filter((item) => {
    if (current.region !== "all" && item.region !== current.region) return false;
    if (
      current.workType !== "all"
      && !(item.work_types || []).includes(current.workType)
      && !(item.work_types || []).includes({ 耕整: "耕地" }[current.workType] || current.workType)
    ) {
      return false;
    }
    if (current.status !== "all" && !routeMachineIds.has(Number(item.id)) && !fieldIdsByMachine.has(Number(item.id))) return false;
    return matchesKeyword([item.owner_name, item.region, item.machine_type, item.id], current.keyword);
  });
}

function filterServiceCoverage(filteredMachines) {
  if (!state.overview) return [];
  const current = filters();
  const visibleMachineIds = new Set(filteredMachines.map((item) => Number(item.id)));
  return (state.overview.service_coverage || []).filter((item) => {
    if (!visibleMachineIds.has(Number(item.machine_id))) return false;
    if (current.workType !== "all" && item.work_type !== current.workType && item.work_type_label !== current.workType) return false;
    return matchesKeyword([item.title, item.owner_name, item.region, item.machine_type, item.sku_id], current.keyword);
  });
}

function filterAlerts() {
  if (!state.overview) return [];
  const current = filters();
  return (state.overview.weather_alerts || []).filter((item) => {
    if (current.region !== "all" && item.region !== current.region) return false;
    return matchesKeyword([item.region, item.type, item.level, item.id], current.keyword);
  });
}

function visibleData() {
  const fields = filterFields();
  const routes = filterRoutes(fields);
  const machines = filterMachines(fields, routes);
  const serviceCoverage = filterServiceCoverage(machines);
  const weatherAlerts = filterAlerts();
  return { machines, fields, routes, serviceCoverage, weatherAlerts };
}

function renderMetrics() {
  if (!state.overview) {
    dom.atlasMetrics.innerHTML = "";
    return;
  }
  const visible = visibleData();
  const totalMetrics = state.overview.metrics || {};
  dom.atlasMetrics.innerHTML = [
    metricCardHtml("可见农机", visible.machines.length, `总计 ${totalMetrics.machine_count || 0} 台`),
    metricCardHtml("可见地块", visible.fields.length, `总计 ${totalMetrics.field_count || 0} 块`),
    metricCardHtml("调度线路", visible.routes.length, `活跃 ${totalMetrics.active_route_count || 0} 条`),
    metricCardHtml("服务覆盖圈", visible.serviceCoverage.length, `总计 ${totalMetrics.service_count || 0} 个服务`),
    metricCardHtml("天气预警", visible.weatherAlerts.length, `总计 ${totalMetrics.weather_alert_count || 0} 个预警点`),
  ].join("");
}

function renderFilterOptions() {
  const filtersConfig = state.overview?.filters || {};
  dom.atlasRegionFilter.innerHTML = [
    `<option value="all">全部区域</option>`,
    ...(filtersConfig.regions || []).map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`),
  ].join("");
  dom.atlasWorkTypeFilter.innerHTML = [
    `<option value="all">全部作业类型</option>`,
    ...(filtersConfig.work_types || []).map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.label)}</option>`),
  ].join("");
  dom.atlasStatusFilter.innerHTML = [
    `<option value="all">全部订单状态</option>`,
    ...(filtersConfig.statuses || []).map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.label)}</option>`),
  ].join("");
  dom.atlasRegionFilter.value = state.filters.region;
  dom.atlasWorkTypeFilter.value = state.filters.workType;
  dom.atlasStatusFilter.value = state.filters.status;
  dom.atlasKeywordInput.value = state.filters.keyword;
}

function summaryHtml(type, data) {
  if (type === "machine") {
    const telemetry = data.latest_telemetry;
    return `
      <div class="atlas-selection-card">
        <div class="card-topline">
          <div>
            <span class="eyebrow">农机点位</span>
            <h3>#${escapeHtml(data.id)} ${escapeHtml(data.machine_type)}</h3>
          </div>
          <span class="badge ${data.status === "offline" ? "danger" : data.status === "busy" ? "warning" : "success"}">${escapeHtml(data.status)}</span>
        </div>
        <div class="atlas-info-grid">
          <div><span>机主</span><strong>${escapeHtml(data.owner_name)}</strong></div>
          <div><span>机况分</span><strong>${escapeHtml(data.health_score)}</strong></div>
          <div><span>效率</span><strong>${escapeHtml(data.capacity_mu_per_hour)} 亩/小时</strong></div>
          <div><span>服务区域</span><strong>${escapeHtml(data.region || "未标注")}</strong></div>
        </div>
        <p class="section-note">作业类型：${escapeHtml((data.work_types || []).join(" / ") || "暂未绑定")}</p>
        ${
          telemetry
            ? `<div class="note-box">最新遥测：${escapeHtml(shortTime(telemetry.ts))} · 车速 ${escapeHtml(telemetry.speed_kmh)} km/h · 发动机温度 ${escapeHtml(telemetry.engine_temp)}°C · 状态 ${escapeHtml(telemetry.status)}</div>`
            : `<div class="note-box">当前机具暂无遥测回传。</div>`
        }
      </div>
    `;
  }

  if (type === "field") {
    return `
      <div class="atlas-selection-card">
        <div class="card-topline">
          <div>
            <span class="eyebrow">订单地块</span>
            <h3>订单 #${escapeHtml(data.order_id)} ${escapeHtml(data.work_type_label)}</h3>
          </div>
          <span class="badge ${data.status === "COMPLETED" ? "success" : ["ABNORMAL_PENDING", "REASSIGN_PROPOSED"].includes(data.status) ? "danger" : "warning"}">${escapeHtml(data.stage_label)}</span>
        </div>
        <div class="atlas-info-grid">
          <div><span>地块区域</span><strong>${escapeHtml(data.region)}</strong></div>
          <div><span>面积</span><strong>${escapeHtml(data.area_mu)} 亩</strong></div>
          <div><span>作业窗口</span><strong>${escapeHtml(data.service_window || "待确认")}</strong></div>
          <div><span>机主</span><strong>${escapeHtml(data.owner_name || "待派单")}</strong></div>
        </div>
        <p class="section-note">${escapeHtml(data.title)} · 要求：${escapeHtml(data.quality_constraints || "暂无")}</p>
        <div class="note-box">最新动态：${escapeHtml(data.latest_event || "暂无")}</div>
      </div>
    `;
  }

  if (type === "coverage") {
    return `
      <div class="atlas-selection-card">
        <div class="card-topline">
          <div>
            <span class="eyebrow">服务覆盖圈</span>
            <h3>${escapeHtml(data.title)}</h3>
          </div>
          <span class="badge neutral">${escapeHtml(data.work_type_label)}</span>
        </div>
        <div class="atlas-info-grid">
          <div><span>覆盖半径</span><strong>${escapeHtml(data.radius_km)} km</strong></div>
          <div><span>起接面积</span><strong>${escapeHtml(data.min_area)} 亩</strong></div>
          <div><span>报价</span><strong>￥${escapeHtml(data.unit_price)}/${escapeHtml(data.unit)}</strong></div>
          <div><span>机具</span><strong>#${escapeHtml(data.machine_id)} ${escapeHtml(data.machine_type)}</strong></div>
        </div>
        <div class="note-box">机主 ${escapeHtml(data.owner_name)} · 完成率 ${escapeHtml(data.completion_rate)}% · ${escapeHtml(data.summary)}</div>
      </div>
    `;
  }

  if (type === "route") {
    return `
      <div class="atlas-selection-card">
        <div class="card-topline">
          <div>
            <span class="eyebrow">调度线路</span>
            <h3>订单 #${escapeHtml(data.order_id)} -> 机具 #${escapeHtml(data.machine_id)}</h3>
          </div>
          <span class="badge ${["ABNORMAL_PENDING", "REASSIGN_PROPOSED"].includes(data.status) ? "danger" : data.status === "COMPLETED" ? "success" : "warning"}">${escapeHtml(data.stage_label)}</span>
        </div>
        <div class="atlas-info-grid">
          <div><span>机主</span><strong>${escapeHtml(data.owner_name)}</strong></div>
          <div><span>需求方</span><strong>${escapeHtml(data.buyer_name)}</strong></div>
          <div><span>作业类型</span><strong>${escapeHtml(data.work_type_label)}</strong></div>
          <div><span>机地距离</span><strong>${escapeHtml(data.distance_km)} km</strong></div>
        </div>
      </div>
    `;
  }

  if (type === "alert") {
    return `
      <div class="atlas-selection-card">
        <div class="card-topline">
          <div>
            <span class="eyebrow">天气预警</span>
            <h3>${escapeHtml(data.type)} · ${escapeHtml(data.region)}</h3>
          </div>
          <span class="badge danger">${escapeHtml(String(data.level || "").toUpperCase())}</span>
        </div>
        <div class="atlas-info-grid">
          <div><span>开始时间</span><strong>${escapeHtml(shortTime(data.start) || data.start)}</strong></div>
          <div><span>结束时间</span><strong>${escapeHtml(shortTime(data.end) || data.end)}</strong></div>
          <div><span>预警等级</span><strong>${escapeHtml(data.level)}</strong></div>
          <div><span>预警类型</span><strong>${escapeHtml(data.type)}</strong></div>
        </div>
      </div>
    `;
  }

  return emptyState("点击地图上的对象后，可在这里查看详情。");
}

function renderSelection() {
  if (!state.selectedFeature) {
    dom.atlasSelectionBox.innerHTML = emptyState("点击地图上的农机、地块、覆盖圈、调度线路或天气预警点查看详情。");
    return;
  }
  dom.atlasSelectionBox.innerHTML = summaryHtml(state.selectedFeature.type, state.selectedFeature.data);
}

function renderVisibleSummary() {
  const visible = visibleData();
  dom.atlasVisibleSummary.textContent = `显示农机 ${visible.machines.length} 台 / 地块 ${visible.fields.length} 块 / 线路 ${visible.routes.length} 条 / 预警 ${visible.weatherAlerts.length} 个`;
}

function setMapPlaceholder(message, visible = true) {
  dom.atlasMapPlaceholder.textContent = message;
  dom.atlasMapPlaceholder.classList.toggle("hidden", !visible);
}

function resetMapRuntime() {
  if (state.mapRuntime.instance?.destroy) {
    state.mapRuntime.instance.destroy();
  }
  state.mapRuntime.instance = null;
  state.mapRuntime.infoWindow = null;
  state.mapRuntime.overlays = [];
  state.mapRuntime.fitTargets = [];
  dom.atlasMapCanvas.innerHTML = "";
}

function clearMapOverlays() {
  if (state.mapRuntime.instance && state.mapRuntime.overlays.length) {
    state.mapRuntime.instance.remove(state.mapRuntime.overlays);
  }
  state.mapRuntime.overlays = [];
  state.mapRuntime.fitTargets = [];
}

async function ensureMapInstance() {
  const AMap = await ensureAMap();
  if (!state.mapRuntime.instance) {
    state.mapRuntime.instance = new AMap.Map(dom.atlasMapCanvas, {
      zoom: 8,
      center: toAmapPosition(119.15, 36.63),
      resizeEnable: true,
      viewMode: "2D",
    });
    state.mapRuntime.infoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -26) });
  }
  return { AMap, map: state.mapRuntime.instance };
}

function bindOverlaySelection(overlay, type, data, html, position) {
  overlay.on("click", () => {
    state.selectedFeature = { type, data };
    renderSelection();
    if (state.mapRuntime.instance && state.mapRuntime.infoWindow && position) {
      state.mapRuntime.infoWindow.setContent(html);
      state.mapRuntime.infoWindow.open(state.mapRuntime.instance, position);
    }
  });
}

function addMachineOverlay(AMap, machine, fitTargets) {
  const position = toAmapPosition(machine.lng, machine.lat);
  const tone = machine.status === "offline" ? "fault" : machine.status === "idle" ? "selected" : "normal";
  const marker = new AMap.Marker({
    position,
    anchor: "center",
    offset: new AMap.Pixel(0, 0),
    content: `<div class="map-pin-dot ${escapeHtml(tone)}"></div>`,
  });
  const label = new AMap.Text({
    position,
    anchor: "bottom-center",
    offset: new AMap.Pixel(0, -18),
    text: `#${machine.id} ${machine.machine_type}`,
    style: pinLabelStyle(tone),
  });
  const html = summaryHtml("machine", machine);
  bindOverlaySelection(marker, "machine", machine, html, position);
  bindOverlaySelection(label, "machine", machine, html, position);
  state.mapRuntime.overlays.push(marker, label);
  fitTargets.push(marker);
}

function addFieldOverlay(AMap, field, fitTargets) {
  const position = toAmapPosition(field.lng, field.lat);
  const strokeColor = workTypeColor(field.work_type);
  const circle = new AMap.Circle({
    center: position,
    radius: Math.max(60, Number(field.plot_radius_m || 0)),
    strokeColor,
    strokeOpacity: 0.9,
    strokeWeight: 2,
    fillColor: strokeColor,
    fillOpacity: 0.12,
  });
  const marker = new AMap.Marker({
    position,
    anchor: "center",
    offset: new AMap.Pixel(0, 0),
    content: `<div class="map-pin-dot target"></div>`,
  });
  const label = new AMap.Text({
    position,
    anchor: "bottom-center",
    offset: new AMap.Pixel(0, -18),
    text: `订单#${field.order_id} ${field.work_type_label}`,
    style: pinLabelStyle("target"),
  });
  const html = summaryHtml("field", field);
  bindOverlaySelection(circle, "field", field, html, position);
  bindOverlaySelection(marker, "field", field, html, position);
  bindOverlaySelection(label, "field", field, html, position);
  state.mapRuntime.overlays.push(circle, marker, label);
  fitTargets.push(circle);
}

function addCoverageOverlay(AMap, coverage, fitTargets) {
  const position = toAmapPosition(coverage.lng, coverage.lat);
  const strokeColor = workTypeColor(coverage.work_type);
  const circle = new AMap.Circle({
    center: position,
    radius: Number(coverage.radius_km || 0) * 1000,
    strokeColor,
    strokeStyle: "dashed",
    strokeWeight: 2,
    strokeOpacity: 0.35,
    fillColor: strokeColor,
    fillOpacity: 0.04,
  });
  bindOverlaySelection(circle, "coverage", coverage, summaryHtml("coverage", coverage), position);
  state.mapRuntime.overlays.push(circle);
  fitTargets.push(circle);
}

function addRouteOverlay(AMap, route, fitTargets) {
  const fromPosition = toAmapPosition(route.from_lng, route.from_lat);
  const toPosition = toAmapPosition(route.to_lng, route.to_lat);
  const color = routeColor(route.status);
  const polyline = new AMap.Polyline({
    path: [fromPosition, toPosition],
    strokeColor: color,
    strokeWeight: ["ABNORMAL_PENDING", "REASSIGN_PROPOSED"].includes(route.status) ? 5 : 4,
    strokeStyle: ["ABNORMAL_PENDING", "REASSIGN_PROPOSED", "DISPATCH_PROPOSED"].includes(route.status) ? "dashed" : "solid",
    strokeOpacity: route.status === "COMPLETED" ? 0.55 : 0.9,
  });
  const midpoint = [(fromPosition[0] + toPosition[0]) / 2, (fromPosition[1] + toPosition[1]) / 2];
  const label = new AMap.Text({
    position: midpoint,
    anchor: "center",
    offset: new AMap.Pixel(0, 0),
    text: `#${route.order_id} · ${route.distance_km} km`,
    style: pinLabelStyle(route.status === "COMPLETED" ? "selected" : ["ABNORMAL_PENDING", "REASSIGN_PROPOSED"].includes(route.status) ? "fault" : "normal"),
  });
  const html = summaryHtml("route", route);
  bindOverlaySelection(polyline, "route", route, html, midpoint);
  bindOverlaySelection(label, "route", route, html, midpoint);
  state.mapRuntime.overlays.push(polyline, label);
  fitTargets.push(polyline);
}

function addAlertOverlay(AMap, alert, fitTargets) {
  const position = toAmapPosition(alert.lng, alert.lat);
  const color = alertColor(alert.level);
  const marker = new AMap.Marker({
    position,
    anchor: "center",
    offset: new AMap.Pixel(0, 0),
    content: `<div class="atlas-alert-pin" style="background:${escapeHtml(color)}"></div>`,
  });
  const label = new AMap.Text({
    position,
    anchor: "top-center",
    offset: new AMap.Pixel(0, 14),
    text: `${String(alert.level || "").toUpperCase()} ${alert.type}`,
    style: pinLabelStyle("fault"),
  });
  const html = summaryHtml("alert", alert);
  bindOverlaySelection(marker, "alert", alert, html, position);
  bindOverlaySelection(label, "alert", alert, html, position);
  state.mapRuntime.overlays.push(marker, label);
  fitTargets.push(marker);
}

async function fitAllVisible() {
  if (!state.mapRuntime.instance || !state.mapRuntime.fitTargets.length) return;
  state.mapRuntime.instance.setFitView(state.mapRuntime.fitTargets, false, [80, 80, 80, 80]);
}

async function renderMap() {
  clearMapOverlays();
  if (!state.overview) {
    setMapPlaceholder("正在加载地图数据...");
    return;
  }

  let mapPack;
  try {
    mapPack = await ensureMapInstance();
  } catch (error) {
    setMapPlaceholder(error.message || "地图加载失败");
    return;
  }

  const visible = visibleData();
  const { AMap, map } = mapPack;
  const fitTargets = [];

  setMapPlaceholder("", false);
  if (state.layers.coverage) {
    visible.serviceCoverage.forEach((item) => addCoverageOverlay(AMap, item, fitTargets));
  }
  if (state.layers.routes) {
    visible.routes.forEach((item) => addRouteOverlay(AMap, item, fitTargets));
  }
  if (state.layers.fields) {
    visible.fields.forEach((item) => addFieldOverlay(AMap, item, fitTargets));
  }
  if (state.layers.machines) {
    visible.machines.forEach((item) => addMachineOverlay(AMap, item, fitTargets));
  }
  if (state.layers.alerts) {
    visible.weatherAlerts.forEach((item) => addAlertOverlay(AMap, item, fitTargets));
  }

  if (!state.mapRuntime.overlays.length) {
    setMapPlaceholder("当前筛选条件下没有可展示的地图数据。");
    return;
  }

  state.mapRuntime.fitTargets = fitTargets;
  map.add(state.mapRuntime.overlays);
  map.setFitView(fitTargets, false, [80, 80, 80, 80]);
}

function syncLayerStateFromDom() {
  state.layers = {
    machines: dom.atlasLayerMachines.checked,
    fields: dom.atlasLayerFields.checked,
    coverage: dom.atlasLayerCoverage.checked,
    routes: dom.atlasLayerRoutes.checked,
    alerts: dom.atlasLayerAlerts.checked,
  };
}

function renderAll() {
  renderFilterOptions();
  renderMetrics();
  renderVisibleSummary();
  renderSelection();
  void renderMap();
}

async function loadOverview() {
  state.overview = await request("/dashboard/map-overview");
  renderAll();
}

function resetFilters() {
  state.filters = {
    region: "all",
    workType: "all",
    status: "all",
    keyword: "",
  };
  dom.atlasRegionFilter.value = "all";
  dom.atlasWorkTypeFilter.value = "all";
  dom.atlasStatusFilter.value = "all";
  dom.atlasKeywordInput.value = "";
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

function bindEvents() {
  dom.atlasRegionFilter.addEventListener("change", () => {
    state.filters.region = dom.atlasRegionFilter.value;
    renderAll();
  });
  dom.atlasWorkTypeFilter.addEventListener("change", () => {
    state.filters.workType = dom.atlasWorkTypeFilter.value;
    renderAll();
  });
  dom.atlasStatusFilter.addEventListener("change", () => {
    state.filters.status = dom.atlasStatusFilter.value;
    renderAll();
  });
  dom.atlasKeywordInput.addEventListener("input", () => {
    state.filters.keyword = dom.atlasKeywordInput.value.trim();
    renderAll();
  });

  [dom.atlasLayerMachines, dom.atlasLayerFields, dom.atlasLayerCoverage, dom.atlasLayerRoutes, dom.atlasLayerAlerts].forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      syncLayerStateFromDom();
      renderAll();
    });
  });

  dom.atlasRefreshBtn.addEventListener("click", () => void loadOverview());
  dom.atlasResetBtn.addEventListener("click", () => {
    resetFilters();
    syncLayerStateFromDom();
    renderAll();
  });
  dom.atlasMapFitBtn.addEventListener("click", () => void fitAllVisible());
}

async function init() {
  initPlatformSettings({
    onSave: async () => {
      resetMapRuntime();
      await renderMap();
    },
  });
  bindFullscreen(dom.atlasMapFullscreenBtn, dom.atlasMapCanvas.closest(".map-shell"));
  bindEvents();
  renderSelection();
  await loadOverview();
}

init().catch((error) => {
  setMapPlaceholder(error.message || String(error));
  dom.atlasSelectionBox.innerHTML = `<div class="note-box">${escapeHtml(error.message || String(error))}</div>`;
});
