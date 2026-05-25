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
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

export function statusTone(order) {
  if (!order) return "neutral";
  if (["COMPLETED"].includes(order.status)) return "success";
  if (["ABNORMAL_PENDING", "REASSIGN_PROPOSED", "REFUNDING", "DISPUTE"].includes(order.status)) return "risk";
  if (["IN_SERVICE", "TO_CONFIRM"].includes(order.status)) return "active";
  return "pending";
}

export function badgeClass(tone) {
  return {
    pending: "badge-pending",
    active: "badge-active",
    success: "badge-success",
    risk: "badge-risk",
    danger: "badge-danger",
    neutral: "badge-neutral",
  }[tone] || "badge-neutral";
}

export function orderCardHtml(order, selectedId) {
  const tone = statusTone(order);
  const selected = Number(order.id) === Number(selectedId) ? "selected" : "";
  const target = order.target || {};
  const sku = order.sku || {};
  return `<article class="order-card status-${tone} ${selected}" data-order-id="${escapeHtml(order.id)}">
    <div class="card-header">
      <span class="crop-badge ${badgeClass(tone)}">${escapeHtml(order.stage_label || order.status || "待处理")}</span>
      <span class="area-info">${escapeHtml(order.area_mu || "-")} 亩</span>
    </div>
    <div class="card-body">
      <strong>${escapeHtml(sku.title || "农机服务订单")}</strong>
      <span>${escapeHtml(target.region || "未知区域")} · 订单 #${escapeHtml(order.id)}</span>
    </div>
    <div class="card-footer">
      <span>${escapeHtml(order.service_window || "待确认时窗")}</span>
      <span>${money(order.amount)}</span>
    </div>
  </article>`;
}

export function metricCardHtml(label, value, tone = "primary") {
  const color = {
    primary: "var(--ag-primary-hover)",
    green: "var(--ag-crop-green)",
    blue: "var(--ag-machine-blue)",
    red: "var(--ag-risk-red)",
  }[tone] || "var(--ag-text-primary)";
  return `<article class="metric-card">
    <div class="metric-label">${escapeHtml(label)}</div>
    <div class="metric-value" style="color:${color}">${escapeHtml(value)}</div>
  </article>`;
}

export function timelineHtml(timeline = []) {
  if (!timeline.length) return `<div class="empty-state">暂无履约节点。</div>`;
  return `<div class="timeline">
    ${timeline
      .map((item) => `<div class="timeline-item ${escapeHtml(item.state || "")}">
        ${escapeHtml(item.label || "节点")} ${item.time ? `- ${escapeHtml(item.time)}` : ""}
      </div>`)
      .join("")}
  </div>`;
}

export function emptyState(text) {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}

export function errorState(text) {
  return `<div class="error-state">${escapeHtml(text)}</div>`;
}
