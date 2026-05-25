# 农机速配三端后端

这版后端从单页原型演进为三端统一 API：

- 租赁端：服务列表、下单、订单轨迹
- 农机端：接单、拒单、改约、出发、开工、完工、故障上报、GPS 作业核算
- 主管端：派单候选、确认派单、天气异常、故障改派、运营概览

## 启动方式

```bash
cd backend
python scripts/seed_from_mock.py
uvicorn app.main:app --reload --port 8000
```

打开：

- `http://127.0.0.1:8000/ui`
- `http://127.0.0.1:8000/ui-v2`
- `http://127.0.0.1:8000/ui/rent`
- `http://127.0.0.1:8000/ui/machine`
- `http://127.0.0.1:8000/ui/supervisor`

其中 `/ui` 是原有前端，`/ui-v2` 是保留原前端后新增的“麦浪网格风”前端。v2 当前已覆盖租赁端、农机端和主管端：

- `http://127.0.0.1:8000/ui-v2/rent`
- `http://127.0.0.1:8000/ui-v2/machine`
- `http://127.0.0.1:8000/ui-v2/supervisor`

## 主要接口

保留的基础接口：

- `GET /health`
- `GET /api/catalog/users`
- `GET /api/catalog/machines`
- `GET /api/catalog/skus`
- `POST /api/orders`
- `POST /api/orders/{order_id}/pay`
- `POST /api/orders/{order_id}/transition`
- `POST /api/agents/demand/parse`
- `POST /api/agents/dispatch/propose`
- `POST /api/agents/exception/handle`
- `GET /api/weather/order/{order_id}`

新增三端接口：

- `GET /api/market/home`
- `GET /api/market/services`
- `GET /api/market/orders?buyer_id=...`
- `GET /api/market/orders/{order_id}/tracking`
- `GET /api/machine/orders?owner_id=...`
- `POST /api/machine/orders/{order_id}/accept`
- `POST /api/machine/orders/{order_id}/reject`
- `POST /api/machine/orders/{order_id}/reschedule`
- `POST /api/machine/orders/{order_id}/depart`
- `POST /api/machine/orders/{order_id}/start`
- `POST /api/machine/orders/{order_id}/finish`
- `POST /api/machine/orders/{order_id}/fault`
- `GET /api/supervisor/overview`
- `GET /api/supervisor/orders`
- `GET /api/supervisor/orders/{order_id}`
- `POST /api/supervisor/orders/{order_id}/dispatch/confirm`
- `POST /api/supervisor/orders/{order_id}/resume`
- `POST /api/supervisor/orders/{order_id}/refund`

## 调度算法

首次派单和改派都走规则化评分，方便讲解与复现。当前评分主要看：

- 距离
- 可用性
- 履约效率
- 机况健康分
- 机主口碑
- 价格竞争力
- 天气风险

主管端会直接展示候选机组的评分拆解，不是只返回一个黑盒结果。

## 天气与 GPS 作业核算

- 天气接口使用 Open-Meteo，按订单目的地和作业时间查询。
- 前端展示未来三天、每三小时一条天气预报。
- 暴雨或雷暴高风险时，天气异常处置会建议进入异常池，并优先考虑取消退款。
- 农机端点击“开始作业”后会播放模拟 GPS 轨迹，绘制地块、作业路径和已覆盖面积。
- GPS 作业核算按“轨迹长度 × 作业幅宽”估算实际作业面积，用于演示作业监管和结算依据。

## 测试

```bash
cd backend
python -m unittest discover -s tests -p "test_*.py" -v
```
