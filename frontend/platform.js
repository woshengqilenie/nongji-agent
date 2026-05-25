const LLM_STORAGE_KEY = "llm_config_v1";
const MAP_STORAGE_KEY = "map_config_v1";

const runtime = {
  llm: {
    endpoint: "",
    apiKey: "",
    model: "deepseek-chat",
  },
  map: {
    key: "",
    securityJsCode: "",
  },
  modalReady: false,
  mapScriptKey: "",
  mapPromise: null,
};

function loadConfig() {
  try {
    const raw = localStorage.getItem(LLM_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      runtime.llm = {
        endpoint: parsed.endpoint || "",
        apiKey: parsed.apiKey || "",
        model: parsed.model || "deepseek-chat",
      };
    }
  } catch {
    // ignore
  }
  try {
    const raw = localStorage.getItem(MAP_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      runtime.map = {
        key: parsed.key || "",
        securityJsCode: parsed.securityJsCode || "",
      };
    }
  } catch {
    // ignore
  }
}

function saveConfig() {
  localStorage.setItem(LLM_STORAGE_KEY, JSON.stringify(runtime.llm));
  localStorage.setItem(MAP_STORAGE_KEY, JSON.stringify(runtime.map));
}

function modalHtml() {
  return `
    <div id="platformSettingsModal" class="settings-modal hidden">
      <div class="settings-panel">
        <div class="panel-head">
          <div>
            <h3>外部服务设置</h3>
            <p class="section-note">这里延续上一版的 LLM 与高德地图接入方式。</p>
          </div>
          <button id="platformSettingsClose" class="btn secondary">关闭</button>
        </div>
        <div class="settings-section">
          <span class="eyebrow">LLM</span>
          <label class="field">
            <span>接口地址</span>
            <input id="platformLlmEndpoint" type="text" placeholder="http://127.0.0.1:5001/v1/chat/completions" />
          </label>
          <label class="field">
            <span>API Key</span>
            <input id="platformLlmApiKey" type="password" placeholder="留空则尝试后端环境变量" />
          </label>
          <label class="field">
            <span>模型名称</span>
            <input id="platformLlmModel" type="text" placeholder="deepseek-chat" />
          </label>
        </div>
        <div class="settings-section">
          <span class="eyebrow">高德地图</span>
          <label class="field">
            <span>高德 JS Key</span>
            <input id="platformMapKey" type="text" placeholder="请输入高德地图 Key" />
          </label>
          <label class="field">
            <span>安全密钥（可选）</span>
            <input id="platformMapSecurity" type="password" placeholder="如启用安全密钥，请填写" />
          </label>
        </div>
        <div class="inline-actions">
          <button id="platformSettingsSave" class="btn primary">保存设置</button>
          <button id="platformSettingsClear" class="btn warning">清空本地设置</button>
        </div>
        <div id="platformSettingsHint" class="note-box">保存后，租赁端会优先使用 LLM 解析需求，主管端会尝试加载高德地图。</div>
      </div>
    </div>
  `;
}

function fillModalInputs() {
  document.getElementById("platformLlmEndpoint").value = runtime.llm.endpoint;
  document.getElementById("platformLlmApiKey").value = runtime.llm.apiKey;
  document.getElementById("platformLlmModel").value = runtime.llm.model || "deepseek-chat";
  document.getElementById("platformMapKey").value = runtime.map.key;
  document.getElementById("platformMapSecurity").value = runtime.map.securityJsCode;
}

function syncStatus() {
  const llmStatus = document.getElementById("platformLlmStatus");
  const mapStatus = document.getElementById("platformMapStatus");
  if (llmStatus) {
    llmStatus.textContent = runtime.llm.endpoint ? `AI已配置 · ${runtime.llm.model}` : "AI未配置";
  }
  if (mapStatus) {
    mapStatus.textContent = runtime.map.key ? "地图已配置" : "地图未配置";
  }
}

export function initPlatformSettings({ onSave } = {}) {
  loadConfig();
  if (!runtime.modalReady) {
    document.body.insertAdjacentHTML("beforeend", modalHtml());
    const headerNav = document.querySelector(".header-nav");
    if (headerNav) {
      const statusHtml = `
        <button id="platformOpenSettings" class="nav-pill" type="button">外部服务设置</button>
        <span id="platformLlmStatus" class="hint-chip"></span>
        <span id="platformMapStatus" class="hint-chip"></span>
      `;
      headerNav.insertAdjacentHTML("beforeend", statusHtml);
    }

    const modal = document.getElementById("platformSettingsModal");
    const hint = document.getElementById("platformSettingsHint");
    document.getElementById("platformOpenSettings")?.addEventListener("click", () => {
      fillModalInputs();
      modal.classList.remove("hidden");
    });
    document.getElementById("platformSettingsClose")?.addEventListener("click", () => {
      modal.classList.add("hidden");
    });
    modal?.addEventListener("click", (event) => {
      if (event.target === modal) modal.classList.add("hidden");
    });
    document.getElementById("platformSettingsSave")?.addEventListener("click", async () => {
      runtime.llm.endpoint = document.getElementById("platformLlmEndpoint").value.trim();
      runtime.llm.apiKey = document.getElementById("platformLlmApiKey").value.trim();
      runtime.llm.model = document.getElementById("platformLlmModel").value.trim() || "deepseek-chat";
      runtime.map.key = document.getElementById("platformMapKey").value.trim();
      runtime.map.securityJsCode = document.getElementById("platformMapSecurity").value.trim();
      saveConfig();
      hint.textContent = "已保存外部服务设置。";
      syncStatus();
      modal.classList.add("hidden");
      if (onSave) await onSave({ llm: { ...runtime.llm }, map: { ...runtime.map } });
    });
    document.getElementById("platformSettingsClear")?.addEventListener("click", async () => {
      runtime.llm = { endpoint: "", apiKey: "", model: "deepseek-chat" };
      runtime.map = { key: "", securityJsCode: "" };
      localStorage.removeItem(LLM_STORAGE_KEY);
      localStorage.removeItem(MAP_STORAGE_KEY);
      hint.textContent = "已清空本地设置。";
      fillModalInputs();
      syncStatus();
      if (onSave) await onSave({ llm: { ...runtime.llm }, map: { ...runtime.map } });
    });
    runtime.modalReady = true;
  }
  syncStatus();
}

export function getLLMConfig() {
  loadConfig();
  return { ...runtime.llm };
}

export function getMapConfig() {
  loadConfig();
  return { ...runtime.map };
}

function parseSSEBlock(block) {
  let event = "message";
  const dataLines = [];
  for (const line of block.split("\n")) {
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
    // keep text
  }
  return { event, data };
}

export async function streamLLMChat({ apiBase, messages, stage, onToken, onDone }) {
  const llm = getLLMConfig();
  const resp = await fetch(`${apiBase}/llm/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: llm.endpoint || "",
      api_key: llm.apiKey || "",
      model: llm.model || "deepseek-chat",
      messages,
      stage,
      temperature: 0.2,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // ignore
    }
    throw new Error(data?.详情 || data?.detail || text || "模型流式调用失败");
  }
  if (!resp.body) throw new Error("模型流式响应为空");

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

export function extractJsonObject(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(lng, lat) {
  let ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
  ret += ((20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(lat * Math.PI) + 40.0 * Math.sin((lat / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((lat / 12.0) * Math.PI) + 320 * Math.sin((lat * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(lng, lat) {
  let ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
  ret += ((20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(lng * Math.PI) + 40.0 * Math.sin((lng / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((lng / 12.0) * Math.PI) + 300.0 * Math.sin((lng / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

export function wgs84ToGcj02(lng, lat) {
  const lngValue = Number(lng);
  const latValue = Number(lat);
  if (!Number.isFinite(lngValue) || !Number.isFinite(latValue)) return [lng, lat];
  if (outOfChina(lngValue, latValue)) return [lngValue, latValue];
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  let dLat = transformLat(lngValue - 105.0, latValue - 35.0);
  let dLng = transformLng(lngValue - 105.0, latValue - 35.0);
  const radLat = (latValue / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lngValue + dLng, latValue + dLat];
}

export function toAmapPosition(lng, lat) {
  // Runtime and seeded coordinates are standardized as WGS84; convert before drawing on AMap.
  return wgs84ToGcj02(lng, lat);
}

function resetMapScript() {
  const old = document.getElementById("amap-platform-script");
  if (old) old.remove();
  try {
    delete window.AMap;
  } catch {
    window.AMap = undefined;
  }
  runtime.mapScriptKey = "";
  runtime.mapPromise = null;
}

export async function ensureAMap() {
  const mapConfig = getMapConfig();
  if (!mapConfig.key) {
    throw new Error("请先在“外部服务设置”中填写高德地图 Key");
  }
  if (runtime.mapScriptKey && runtime.mapScriptKey !== mapConfig.key) {
    resetMapScript();
  }
  if (window.AMap && runtime.mapScriptKey === mapConfig.key) {
    return window.AMap;
  }
  if (!runtime.mapPromise) {
    runtime.mapPromise = new Promise((resolve, reject) => {
      if (mapConfig.securityJsCode) {
        window._AMapSecurityConfig = { securityJsCode: mapConfig.securityJsCode };
      }
      const script = document.createElement("script");
      script.id = "amap-platform-script";
      script.async = true;
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(mapConfig.key)}`;
      script.onload = () => {
        if (!window.AMap) {
          reject(new Error("高德地图脚本已加载，但 AMap 不可用"));
          return;
        }
        runtime.mapScriptKey = mapConfig.key;
        resolve(window.AMap);
      };
      script.onerror = () => reject(new Error("高德地图脚本加载失败，请检查 Key 或网络"));
      document.head.appendChild(script);
    });
  }
  return runtime.mapPromise;
}
