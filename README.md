# 农机速配调度平台

面向农忙季农机服务场景的三端协同调度平台：租赁端下单、主管端智能派单、农机端履约，贯穿天气异常与故障改派两条异常链路，并用 GPS 轨迹核算实际作业面积。

后端 FastAPI + SQLite；Agent 参与需求理解（一句话填单）、派单建议（规则化评分 + 可解释评分拆解）与异常处置建议。仓库内置可控模拟数据，克隆后即可本地运行完整业务闭环。

*A three-portal farm machinery service dispatch platform powered by FastAPI + SQLite, with agent-assisted demand parsing and rule-based dispatch scoring.*

## 三端能力

**租赁端**
- 服务品类浏览、一句话填单、托管支付、订单轨迹、验收确认

**农机端**
- 接单、拒单、改约、出发、开工、完工、故障上报
- GPS 作业核算：模拟轨迹绘制，按"轨迹长度 × 作业幅宽"估算实际作业面积

**主管端**
- 订单池、派单候选与评分拆解、天气异常处置、故障改派、运营总控与复盘

## Agent 与调度逻辑

- 需求理解：自然语言需求 → 结构化订单要素（品类、面积、农时、质量约束等）
- 派单决策：距离 / 可用性 / 履约效率 / 机况健康分 / 机主口碑 / 价格竞争力 / 天气风险 多维评分，主管端展示完整评分拆解，不是黑盒结果
- 异常处置：天气或设备故障时给出暂停、改派、恢复或退款建议
- 天气：按订单目的地与作业时间查询预报（Open-Meteo），支持模拟天气场景覆写，用于异常链路演示

## 技术结构

```text
浏览器前端
├─ /ui      三端前端（旧版）
└─ /ui-v2   麦浪网格风新版前端

FastAPI 后端
├─ 三端业务 API
├─ 订单状态机
├─ 调度评分逻辑
├─ 天气服务
├─ LLM 兼容接口代理
└─ 静态前端挂载

SQLite 数据库
├─ 用户 / 农机 / 服务 SKU
├─ 订单 / 订单事件
└─ 调度日志
```

## 快速开始

```bash
git clone https://github.com/woshengqilenie/nongji-agent.git
cd nongji-agent/backend
python -m venv .venv
# Windows:  .\.venv\Scripts\Activate.ps1
# macOS/Linux:  source .venv/bin/activate
pip install -r requirements.txt
python scripts/seed_from_mock.py
uvicorn app.main:app --reload --port 8000
```

浏览器打开：

- http://127.0.0.1:8000/ui-v2 （推荐，麦浪网格风新版）
- http://127.0.0.1:8000/ui （旧版三端）

## 测试

后端含 27 项单元测试（unittest），覆盖 Agent 逻辑、订单状态机、API 流程、天气服务与路由：

```bash
cd backend
python scripts/seed_from_mock.py   # 首次运行需要先初始化数据
python -m unittest discover -s tests -p "test_*.py" -v
```

## 外部服务

- 高德地图：农机位置、地块、调度线路与 GPS 轨迹展示
- Open-Meteo：天气预报（无需 API Key，网络不可用时自动回退本地快照）
- LLM：OpenAI 兼容接口，用于一句话填单与 AI 建议（可选）

外部服务在页面右上角"外部服务设置"中配置。

## 设计文档

- [业务逻辑说明文档](./业务逻辑说明文档.md)：业务目标、角色、订单流转与 Agent 介入点
- [专业技术说明文档](./专业技术说明文档.md)：系统结构、核心模块、接口与测试验证

## License

[MIT](./LICENSE)
