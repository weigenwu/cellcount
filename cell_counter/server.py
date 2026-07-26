from __future__ import annotations

import argparse
import json
import mimetypes
import os
import subprocess
import threading
import time
import urllib.parse
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .imaging import analyze_channels, count_detections, make_preview, read_signal
from .project import (
    export_results,
    load_project,
    public_project,
    save_project,
    scan_experiment,
)


APP_ROOT = Path(__file__).resolve().parent.parent
STATIC_ROOT = APP_ROOT / "static"


class State:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.project: dict[str, Any] | None = None
        self.cancel_event = threading.Event()
        self.job: dict[str, Any] = {
            "running": False,
            "completed": 0,
            "total": 0,
            "current": "",
            "errors": [],
            "elapsed_seconds": 0,
            "eta_seconds": None,
        }


STATE = State()


def _select_folder() -> str:
    import tkinter
    from tkinter import filedialog

    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        return filedialog.askdirectory(title="选择显微镜图片文件夹") or ""
    finally:
        root.destroy()


def _select_project() -> str:
    import tkinter
    from tkinter import filedialog

    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        return (
            filedialog.askopenfilename(
                title="打开细胞计数项目",
                filetypes=[("细胞计数项目", "*.json"), ("JSON", "*.json")],
            )
            or ""
        )
    finally:
        root.destroy()


def _find_view(project: dict[str, Any], view_id: str) -> dict[str, Any]:
    for view in project["views"]:
        if view["id"] == view_id:
            return view
    raise ValueError("找不到指定视野")


def _has_manual_changes(result: dict[str, Any]) -> bool:
    return any(
        item.get("manual") or item.get("deleted")
        for item in result.get("detections", [])
    )


def _run_batch(view_ids: list[str], clear_manual: bool) -> None:
    started = time.time()
    with STATE.lock:
        project = STATE.project
        if project is None:
            return
        STATE.job.update(
            {
                "running": True,
                "completed": 0,
                "total": len(view_ids),
                "current": "",
                "errors": [],
                "elapsed_seconds": 0,
                "eta_seconds": None,
            }
        )
        STATE.cancel_event.clear()

    for index, view_id in enumerate(view_ids):
        if STATE.cancel_event.is_set():
            break
        with STATE.lock:
            assert STATE.project is not None
            project = STATE.project
            view = _find_view(project, view_id)
            result = project["results"].get(view_id, {})
            if _has_manual_changes(result) and not clear_manual:
                STATE.job["errors"].append(
                    {"view_id": view_id, "error": "存在人工修正，未重新分析"}
                )
                STATE.job["completed"] = index + 1
                continue
            STATE.job["current"] = f"{view['group']} / {view['name']}"
            project["results"][view_id] = {
                "status": "running",
                "error": "",
                "detections": [],
                "parameter_group": view["group"],
            }
            parameters = dict(project["parameters_by_group"][view["group"]])
            pixel_size_um = float(project["pixel_size_um"])
        try:
            if view["error"]:
                raise ValueError(view["error"])
            dapi = read_signal(view["paths"]["dapi"], "dapi")
            nk = read_signal(view["paths"]["nk"], "nk")
            tumor = read_signal(view["paths"]["tumor"], "tumor")
            detections = analyze_channels(
                dapi, nk, tumor, parameters, pixel_size_um
            )
            with STATE.lock:
                project["results"][view_id] = {
                    "status": "done",
                    "error": "",
                    "detections": detections,
                    "parameter_group": view["group"],
                    "parameters": parameters,
                }
        except Exception as exc:
            with STATE.lock:
                message = str(exc)
                project["results"][view_id] = {
                    "status": "error",
                    "error": message,
                    "detections": [],
                    "parameter_group": view["group"],
                }
                STATE.job["errors"].append({"view_id": view_id, "error": message})
        with STATE.lock:
            elapsed = time.time() - started
            STATE.job["completed"] = index + 1
            STATE.job["elapsed_seconds"] = round(elapsed, 1)
            average = elapsed / (index + 1)
            STATE.job["eta_seconds"] = round(
                average * (len(view_ids) - index - 1), 1
            )
            save_project(project)

    with STATE.lock:
        STATE.job["running"] = False
        STATE.job["current"] = "已取消" if STATE.cancel_event.is_set() else "完成"
        if STATE.project:
            save_project(STATE.project)


class Handler(BaseHTTPRequestHandler):
    server_version = "CellScope/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

    def _json(self, payload: Any, status: int = 200) -> None:
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def _error(self, exc: Exception, status: int = 400) -> None:
        self._json({"ok": False, "error": str(exc)}, status)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _project(self) -> dict[str, Any]:
        with STATE.lock:
            if STATE.project is None:
                raise ValueError("请先打开实验文件夹或项目")
            return STATE.project

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            try:
                self._api_get(parsed)
            except Exception as exc:
                self._error(exc)
            return
        self._static(parsed.path)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            self._api_post(parsed.path, self._body())
        except Exception as exc:
            self._error(exc)

    def _api_get(self, parsed: urllib.parse.ParseResult) -> None:
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/api/health":
            self._json({"ok": True, "service": "CellScope", "local": True})
        elif parsed.path == "/api/project":
            self._json({"ok": True, "project": public_project(self._project())})
        elif parsed.path == "/api/job":
            with STATE.lock:
                self._json({"ok": True, "job": dict(STATE.job)})
        elif parsed.path == "/api/detections":
            view_id = query.get("view_id", [""])[0]
            project = self._project()
            result = project["results"].get(view_id, {})
            self._json(
                {
                    "ok": True,
                    "detections": result.get("detections", []),
                    "counts": count_detections(result.get("detections", [])),
                    "status": result.get("status", "pending"),
                    "error": result.get("error", ""),
                }
            )
        elif parsed.path == "/api/image":
            view_id = query.get("view_id", [""])[0]
            channel = query.get("channel", ["overlay"])[0]
            project = self._project()
            view = _find_view(project, view_id)
            if channel not in {"overlay", "dapi", "nk", "tumor"}:
                raise ValueError("无效通道")
            path = view["paths"].get(channel)
            if not path:
                raise ValueError("该通道不存在")
            content, _ = make_preview(path)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "private, max-age=3600")
            self.end_headers()
            self.wfile.write(content)
        else:
            self._json({"ok": False, "error": "接口不存在"}, 404)

    def _api_post(self, path: str, body: dict[str, Any]) -> None:
        if path == "/api/select-folder":
            selected = _select_folder()
            self._json({"ok": True, "path": selected})
        elif path == "/api/select-project":
            selected = _select_project()
            self._json({"ok": True, "path": selected})
        elif path == "/api/open":
            project = scan_experiment(body.get("path", ""), body.get("suffixes"))
            with STATE.lock:
                STATE.project = project
            save_project(project)
            self._json({"ok": True, "project": public_project(project)})
        elif path == "/api/load":
            project = load_project(body.get("path", ""))
            with STATE.lock:
                STATE.project = project
            self._json({"ok": True, "project": public_project(project)})
        elif path == "/api/parameters":
            project = self._project()
            group = body["group"]
            if group not in project["groups"]:
                raise ValueError("实验组不存在")
            parameters = body["parameters"]
            project["parameters_by_group"][group] = parameters
            if body.get("apply_to_all"):
                for item in project["groups"]:
                    project["parameters_by_group"][item] = dict(parameters)
            save_project(project)
            self._json({"ok": True})
        elif path == "/api/analyze":
            project = self._project()
            with STATE.lock:
                if STATE.job["running"]:
                    raise ValueError("已有批处理正在运行")
            view_ids = body.get("view_ids") or [
                view["id"] for view in project["views"] if not view["error"]
            ]
            known = {view["id"] for view in project["views"]}
            view_ids = [view_id for view_id in view_ids if view_id in known]
            if not view_ids:
                raise ValueError("没有可分析的视野")
            with STATE.lock:
                STATE.job.update(
                    {
                        "running": True,
                        "completed": 0,
                        "total": len(view_ids),
                        "current": "准备中",
                        "errors": [],
                        "elapsed_seconds": 0,
                        "eta_seconds": None,
                    }
                )
            worker = threading.Thread(
                target=_run_batch,
                args=(view_ids, bool(body.get("clear_manual"))),
                daemon=True,
            )
            worker.start()
            self._json({"ok": True, "total": len(view_ids)})
        elif path == "/api/cancel":
            STATE.cancel_event.set()
            self._json({"ok": True})
        elif path == "/api/correction":
            project = self._project()
            view_id = body["view_id"]
            result = project["results"].get(view_id)
            if not result or result.get("status") != "done":
                raise ValueError("该视野尚未完成分析")
            detections = result["detections"]
            action = body["action"]
            if action == "add":
                classification = body.get("classification", "unclassified")
                detections.append(
                    {
                        "id": f"manual-{int(time.time() * 1000)}",
                        "x": round(float(body["x"]), 2),
                        "y": round(float(body["y"]), 2),
                        "area_px": 452.39,
                        "area_um2": round(
                            452.39 * float(project["pixel_size_um"]) ** 2, 3
                        ),
                        "radius": 12.0,
                        "circularity": 1.0,
                        "classification": classification,
                        "tumor_fraction": 0,
                        "nk_fraction": 0,
                        "manual": True,
                        "deleted": False,
                    }
                )
            else:
                detection = next(
                    (
                        item
                        for item in detections
                        if item["id"] == body.get("detection_id")
                    ),
                    None,
                )
                if detection is None:
                    raise ValueError("未找到标记")
                if action == "delete":
                    detection["deleted"] = True
                    detection["manual"] = True
                elif action == "reclassify":
                    detection["classification"] = body["classification"]
                    detection["manual"] = True
                elif action == "restore":
                    detection["deleted"] = False
                    detection["manual"] = True
                else:
                    raise ValueError("未知修正操作")
            save_project(project)
            self._json(
                {
                    "ok": True,
                    "detections": detections,
                    "counts": count_detections(detections),
                }
            )
        elif path == "/api/export":
            outputs = export_results(
                self._project(), bool(body.get("include_annotations", True))
            )
            self._json({"ok": True, "outputs": outputs})
        elif path == "/api/open-output":
            output = Path(self._project()["output_dir"]).resolve()
            output.mkdir(parents=True, exist_ok=True)
            os.startfile(output)  # type: ignore[attr-defined]
            self._json({"ok": True})
        else:
            self._json({"ok": False, "error": "接口不存在"}, 404)

    def _static(self, url_path: str) -> None:
        relative = "index.html" if url_path in {"", "/"} else url_path.lstrip("/")
        target = (STATIC_ROOT / relative).resolve()
        if STATIC_ROOT.resolve() not in target.parents and target != STATIC_ROOT.resolve():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not target.is_file():
            target = STATIC_ROOT / "index.html"
        content = target.read_bytes()
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{mime}; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


def main() -> None:
    parser = argparse.ArgumentParser(description="CellScope 本地细胞计数")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"
    print(f"CellScope 已启动：{url}")
    print("关闭此窗口即可停止服务。")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
