export const apiBase = `${window.location.origin}/api`;

export async function request(path, options = {}) {
  const init = {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: options.body,
  };
  const response = await fetch(`${apiBase}${path}`, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(formatApiError(data));
  }
  return data;
}

export function formatApiError(data) {
  if (!data) return "请求失败";
  if (typeof data === "string") return data;
  if (data.详情) {
    if (typeof data.详情 === "string") return data.详情;
    if (data.详情.错误) return data.详情.错误;
  }
  if (data.detail) {
    if (typeof data.detail === "string") return data.detail;
    if (data.detail.错误) return data.detail.错误;
  }
  if (data.错误) return String(data.错误);
  return JSON.stringify(data);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function money(value) {
  return `￥${Number(value || 0).toFixed(0)}`;
}

export function shortTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function urgencyText(level) {
  return { high: "加急", medium: "常规", low: "普通" }[level] || level || "常规";
}

export function stageTone(order) {
  const status = order.status;
  const stage = order.stage_key;
  if (["COMPLETED", "REFUNDED"].includes(status)) return "success";
  if (["ABNORMAL_PENDING", "REASSIGN_PROPOSED", "REFUNDING", "DISPUTE"].includes(status)) return "danger";
  if (["PAID_ESCROW", "DISPATCH_PROPOSED", "DISPATCH_CONFIRMED", "REASSIGN_CONFIRMED"].includes(status)) return "warning";
  if (["accepted", "en_route", "reassign_accepted", "reassign_en_route"].includes(stage)) return "info";
  return "neutral";
}

export function badgeHtml(order) {
  return `<span class="badge ${stageTone(order)}">${escapeHtml(order.stage_label)}</span>`;
}

export function metricCardHtml(label, value, desc = "") {
  return `<article class="metric-card">
    <div class="metric-label">${escapeHtml(label)}</div>
    <div class="metric-value">${escapeHtml(value)}</div>
    <div class="metric-desc">${escapeHtml(desc)}</div>
  </article>`;
}

export function emptyState(text) {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}

export function serviceCardHtml(service, selectedSkuId = null) {
  const selectedClass = Number(selectedSkuId) === Number(service.sku_id) ? "selected" : "";
  return `<article class="service-card ${selectedClass}" data-sku-id="${service.sku_id}">
    <div class="card-topline">
      <span class="eyebrow">${escapeHtml(service.work_type_label)}</span>
      <span class="service-meta">${escapeHtml(service.region || "平台调度")}</span>
    </div>
    <h3>${escapeHtml(service.title)}</h3>
    <p class="service-summary">${escapeHtml(service.summary)}</p>
    <div class="tag-row">
      ${(service.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
    </div>
    <div class="card-metrics">
      <span>机主 ${escapeHtml(service.owner_name)}</span>
      <span>${escapeHtml(service.owner_rating)} 分</span>
      <span>预计 ${escapeHtml(service.eta_minutes)} 分钟联系</span>
    </div>
    <div class="card-bottomline">
      <div class="price-block">
        <strong>${money(service.unit_price)}</strong>
        <span>/${escapeHtml(service.unit)}</span>
      </div>
      <div class="service-stats">
        <span>${escapeHtml(service.completion_rate)}% 完成率</span>
        <span>${escapeHtml(service.monthly_orders)} 单历史</span>
      </div>
    </div>
  </article>`;
}

export function orderCardHtml(order, options = {}) {
  const selectedClass = options.selected ? "selected" : "";
  const subtitle = options.subtitle
    || `${order.target.region} · ${order.area_mu}亩 · ${money(order.amount)}`;
  const counterpart = options.counterpart === "buyer"
    ? `需求方 ${order.buyer.name}`
    : `机主 ${order.owner.name}`;
  return `<article class="order-card ${selectedClass}" data-order-id="${order.id}">
    <div class="card-topline">
      <div>
        <span class="eyebrow">订单 #${escapeHtml(order.id)}</span>
        <h3>${escapeHtml(order.sku.title)}</h3>
      </div>
      ${badgeHtml(order)}
    </div>
    <div class="order-line">${escapeHtml(subtitle)}</div>
    <div class="order-line muted">${escapeHtml(counterpart)} · ${escapeHtml(order.service_window)}</div>
    <p class="order-note">${escapeHtml(order.logistics_text)}</p>
  </article>`;
}

export function timelineHtml(timeline = []) {
  return `<div class="timeline-list">
    ${timeline
      .map(
        (step) => `<div class="timeline-item ${escapeHtml(step.state)}">
          <div class="timeline-dot"></div>
          <div class="timeline-body">
            <div class="timeline-title">${escapeHtml(step.label)}</div>
            <div class="timeline-meta">${escapeHtml(step.time || "")}</div>
            <div class="timeline-detail">${escapeHtml(step.detail || "")}</div>
          </div>
        </div>`
      )
      .join("")}
  </div>`;
}

export function candidateTableHtml(candidates = [], selectedMachineId = null) {
  if (!candidates.length) return emptyState("还没有生成调度候选");
  return `<div class="candidate-grid">
    ${candidates
      .map((item) => {
        const isSelected = Number(selectedMachineId) === Number(item.machine_id);
        const reasonTags = (item.reason_tags || []).slice(0, 3);
        const selectedClass = isSelected ? "is-selected" : "";
        return `<article class="candidate-card ${selectedClass}" data-machine-id="${escapeHtml(item.machine_id)}" role="button" tabindex="0">
          <div class="candidate-card-head">
            <div>
              <div class="eyebrow">候选机具 #${escapeHtml(item.machine_id)}</div>
              <h4>${escapeHtml(item.machine_type)}</h4>
              <div class="muted">${escapeHtml(item.owner_name)} · 机主评分 ${escapeHtml(item.owner_rating)}</div>
            </div>
            <span class="badge ${isSelected ? "success" : "neutral"}">${isSelected ? "当前已选" : "点击展开详情"}</span>
          </div>
          <div class="candidate-metric-row">
            <div class="candidate-metric">
              <strong>${escapeHtml(item.score)}</strong>
              <span>综合总分</span>
            </div>
            <div class="candidate-metric">
              <strong>${escapeHtml(item.eta_minutes)} 分钟</strong>
              <span>预计到场</span>
            </div>
            <div class="candidate-metric">
              <strong>${escapeHtml(item.distance_km)} km</strong>
              <span>距地块</span>
            </div>
            <div class="candidate-metric">
              <strong>${money(item.price_per_mu)}/亩</strong>
              <span>报价</span>
            </div>
          </div>
          <div class="tag-row">
            ${reasonTags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
          </div>
          <div class="candidate-detail ${isSelected ? "expanded" : ""}">
            <div class="candidate-detail-grid">
              <div><span>履约时长</span><strong>${escapeHtml(item.capacity_hours)} 小时</strong></div>
              <div><span>机况分</span><strong>${escapeHtml(item.health_score)}</strong></div>
              <div><span>天气分</span><strong>${escapeHtml(item.weather_risk_score)}</strong></div>
              <div><span>天气建议</span><strong>${escapeHtml(item.weather_action_hint || "无")}</strong></div>
            </div>
            <div class="candidate-score-grid">
              <span>距离 ${escapeHtml(item.score_breakdown?.distance ?? "-")}</span>
              <span>可用 ${escapeHtml(item.score_breakdown?.availability ?? "-")}</span>
              <span>效率 ${escapeHtml(item.score_breakdown?.capacity ?? "-")}</span>
              <span>机况 ${escapeHtml(item.score_breakdown?.health ?? "-")}</span>
              <span>口碑 ${escapeHtml(item.score_breakdown?.reputation ?? "-")}</span>
              <span>报价 ${escapeHtml(item.score_breakdown?.price ?? "-")}</span>
            </div>
            <p class="order-note">${escapeHtml(item.composite_reason || "当前候选暂无补充说明。")}</p>
          </div>
        </article>`;
      })
      .join("")}
  </div>`;
}

export function heatRowHtml(item) {
  return `<div class="heat-row">
    <div class="heat-row-head">
      <strong>${escapeHtml(item.region)}</strong>
      <span>${escapeHtml(item.total_orders)} 单</span>
    </div>
    <div class="heat-bar"><span style="width:${Math.max(12, Number(item.heat || 0))}%"></span></div>
    <div class="heat-row-meta">
      <span>活跃 ${escapeHtml(item.active_orders)}</span>
      <span>异常 ${escapeHtml(item.abnormal_orders)}</span>
      <span>完成率 ${escapeHtml(item.completion_rate)}%</span>
    </div>
  </div>`;
}

export function ownerRankHtml(owner) {
  return `<div class="rank-item">
    <div>
      <strong>${escapeHtml(owner.name)}</strong>
      <div class="muted">${escapeHtml(owner.region)} · ${escapeHtml(owner.completed_orders)} 单完成</div>
    </div>
    <div class="rank-score">${escapeHtml(owner.service_score)}</div>
  </div>`;
}
