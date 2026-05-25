from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import RedirectResponse
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .db import Base, engine
from .routers import agents, catalog, dashboard, health, llm, machine_portal, market, orders, supervisor, weather


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(
    title="Farm Machinery Dispatch Platform API",
    version="0.1.0",
    description="FastAPI backend with DB models, order state machine, dispatch scoring, weather exception handling and agent APIs.",
    lifespan=lifespan,
)

app.include_router(health.router)
app.include_router(catalog.router, prefix="/api")
app.include_router(orders.router, prefix="/api")
app.include_router(agents.router, prefix="/api")
app.include_router(dashboard.router, prefix="/api")
app.include_router(llm.router, prefix="/api")
app.include_router(weather.router, prefix="/api")
app.include_router(market.router, prefix="/api")
app.include_router(machine_portal.router, prefix="/api")
app.include_router(supervisor.router, prefix="/api")


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"详情": exc.detail})


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={"详情": "请求参数校验失败", "错误项": exc.errors()},
    )


FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/ui", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="ui")

    @app.get("/", include_in_schema=False)
    def ui_root() -> RedirectResponse:
        return RedirectResponse(url="/ui")


FRONTEND_V2_DIR = Path(__file__).resolve().parents[2] / "frontend-v2"
if FRONTEND_V2_DIR.exists():
    app.mount("/ui-v2", StaticFiles(directory=str(FRONTEND_V2_DIR), html=True), name="ui-v2")
