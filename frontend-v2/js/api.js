export const apiBase = `${window.location.origin}/api`;

export async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: options.body,
  });
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

export const supervisorApi = {
  overview: () => request("/supervisor/overview"),
  order: (orderId) => request(`/supervisor/orders/${orderId}`),
  dispatchers: async () => {
    const users = await request("/catalog/users");
    return users.filter((item) => item.role === "dispatcher" || item.role === "admin");
  },
  machines: () => request("/catalog/machines"),
  weather: (orderId) => request(`/weather/order/${orderId}`),
  proposeDispatch: (orderId, autoTransition) =>
    request("/agents/dispatch/propose", {
      method: "POST",
      body: JSON.stringify({ order_id: orderId, auto_transition: autoTransition }),
    }),
  confirmDispatch: (orderId, payload) =>
    request(`/supervisor/orders/${orderId}/dispatch/confirm`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  handleException: (payload) =>
    request("/agents/exception/handle", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  resume: (orderId, payload) =>
    request(`/supervisor/orders/${orderId}/resume`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  refund: (orderId, payload) =>
    request(`/supervisor/orders/${orderId}/refund`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
