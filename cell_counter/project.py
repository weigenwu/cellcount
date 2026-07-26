from __future__ import annotations

import csv
import json
import re
import statistics
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from .imaging import (
    DEFAULT_PARAMETERS,
    SUPPORTED_EXTENSIONS,
    count_detections,
    export_annotated,
    image_size,
)


PROJECT_VERSION = 1
CHANNEL_PATTERN = re.compile(r"^(?P<base>.+?)(?P<suffix>_ch\d+)$", re.I)


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _extract_pixel_size(root: Path) -> float:
    for xml_path in root.rglob("*_Properties.xml"):
        try:
            tree = ElementTree.parse(xml_path)
            for node in tree.iter("DimensionDescription"):
                if node.attrib.get("DimID") in {"X", "1"}:
                    voxel = node.attrib.get("Voxel")
                    if voxel:
                        return float(voxel)
                    elements = float(node.attrib.get("NumberOfElements", 0))
                    length = float(node.attrib.get("Length", 0))
                    if elements and length:
                        return length / elements * (1e6 if length < 1 else 1)
        except (OSError, ValueError, ElementTree.ParseError):
            continue
    return 0.218


def _matching_file(
    directory: Path, base: str, suffix: str, extension: str
) -> Path | None:
    exact = directory / f"{base}{suffix}{extension}"
    if exact.exists():
        return exact
    for candidate in directory.iterdir():
        if (
            candidate.is_file()
            and candidate.suffix.lower() in SUPPORTED_EXTENSIONS
            and candidate.stem.lower() == f"{base}{suffix}".lower()
        ):
            return candidate
    return None


def scan_experiment(
    root_path: str,
    suffixes: dict[str, str] | None = None,
) -> dict[str, Any]:
    root = Path(root_path).expanduser().resolve()
    if not root.is_dir():
        raise ValueError("所选路径不是有效文件夹")
    suffixes = suffixes or {
        "dapi": "_ch00",
        "nk": "_ch01",
        "tumor": "_ch02",
    }
    if not all(suffixes.get(key) for key in ("dapi", "nk", "tumor")):
        raise ValueError("蓝、绿、红通道后缀不能为空")

    blue_files = [
        path
        for path in root.rglob("*")
        if path.is_file()
        and path.suffix.lower() in SUPPORTED_EXTENSIONS
        and path.stem.lower().endswith(suffixes["dapi"].lower())
    ]
    views: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for blue in sorted(blue_files, key=lambda item: str(item).lower()):
        base = blue.stem[: -len(suffixes["dapi"])]
        green = _matching_file(
            blue.parent, base, suffixes["nk"], blue.suffix.lower()
        )
        red = _matching_file(
            blue.parent, base, suffixes["tumor"], blue.suffix.lower()
        )
        overlay = _matching_file(blue.parent, base, "", blue.suffix.lower())
        relative_dir = blue.parent.relative_to(root)
        group = str(relative_dir) if str(relative_dir) != "." else root.name
        view_id = str((relative_dir / base)).replace("\\", "/")
        if view_id in seen_ids:
            continue
        seen_ids.add(view_id)
        errors = []
        if green is None:
            errors.append("缺少绿色 NK 通道")
        if red is None:
            errors.append("缺少红色肿瘤通道")
        dimensions: tuple[int, int] | None = None
        if not errors:
            try:
                sizes = [image_size(path) for path in (blue, green, red)]
                dimensions = sizes[0]
                if len(set(sizes)) != 1:
                    errors.append("三通道尺寸不一致")
            except Exception as exc:
                errors.append(str(exc))
        views.append(
            {
                "id": view_id,
                "group": group,
                "name": base,
                "paths": {
                    "overlay": str(overlay or blue),
                    "dapi": str(blue),
                    "nk": str(green) if green else None,
                    "tumor": str(red) if red else None,
                },
                "width": dimensions[0] if dimensions else 0,
                "height": dimensions[1] if dimensions else 0,
                "status": "error" if errors else "pending",
                "error": "；".join(errors),
            }
        )
    if not views:
        raise ValueError(
            f"没有找到以 {suffixes['dapi']} 结尾的蓝色通道图片"
        )

    groups = sorted({view["group"] for view in views})
    pixel_size_um = _extract_pixel_size(root)
    output_dir = root.parent / f"{root.name}_cell-count-results"
    return {
        "version": PROJECT_VERSION,
        "created_at": _now(),
        "updated_at": _now(),
        "root": str(root),
        "name": root.name,
        "output_dir": str(output_dir),
        "pixel_size_um": pixel_size_um,
        "suffixes": suffixes,
        "groups": groups,
        "views": views,
        "parameters_by_group": {
            group: deepcopy(DEFAULT_PARAMETERS) for group in groups
        },
        "results": {},
    }


def public_project(project: dict[str, Any]) -> dict[str, Any]:
    output = deepcopy(project)
    for view in output["views"]:
        result = output["results"].get(view["id"], {})
        view["status"] = result.get("status", view["status"])
        view["error"] = result.get("error", view["error"])
        view["counts"] = count_detections(result.get("detections", []))
    output.pop("results", None)
    return output


def save_project(project: dict[str, Any]) -> Path:
    output_dir = Path(project["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    project["updated_at"] = _now()
    target = output_dir / "cell-count-project.json"
    temporary = output_dir / "cell-count-project.json.tmp"
    temporary.write_text(
        json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(target)
    return target


def load_project(path: str) -> dict[str, Any]:
    target = Path(path).expanduser().resolve()
    data = json.loads(target.read_text(encoding="utf-8"))
    if data.get("version") != PROJECT_VERSION:
        raise ValueError("项目文件版本不受支持")
    if not Path(data["root"]).is_dir():
        raise ValueError("项目对应的原始图片文件夹不存在")
    return data


def _view_rows(project: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for view in project["views"]:
        result = project["results"].get(view["id"], {})
        counts = count_detections(result.get("detections", []))
        rows.append(
            {
                "实验组": view["group"],
                "视野": view["name"],
                "DAPI总数": counts["dapi_total"],
                "肿瘤细胞": counts["tumor"],
                "NK细胞": counts["nk"],
                "未分类": counts["unclassified"],
                "待复核双阳性": counts["double_positive"],
                "人工修正数": counts["corrected"],
                "参数预设": result.get("parameter_group", view["group"]),
                "状态": result.get("status", view["status"]),
                "错误": result.get("error", view["error"]),
            }
        )
    return rows


def export_results(
    project: dict[str, Any],
    include_annotations: bool = True,
) -> dict[str, str]:
    output_dir = Path(project["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    rows = _view_rows(project)
    csv_path = output_dir / "cell-count-results.csv"
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    summary_path = output_dir / "group-summary.csv"
    numeric_keys = ["DAPI总数", "肿瘤细胞", "NK细胞", "未分类", "待复核双阳性"]
    with summary_path.open("w", encoding="utf-8-sig", newline="") as handle:
        fieldnames = ["实验组", "指标", "总和", "均值", "标准差", "视野数"]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for group in project["groups"]:
            group_rows = [
                row for row in rows if row["实验组"] == group and row["状态"] == "done"
            ]
            for key in numeric_keys:
                values = [int(row[key]) for row in group_rows]
                writer.writerow(
                    {
                        "实验组": group,
                        "指标": key,
                        "总和": sum(values),
                        "均值": round(statistics.mean(values), 3) if values else "",
                        "标准差": round(statistics.stdev(values), 3)
                        if len(values) > 1
                        else 0 if values else "",
                        "视野数": len(values),
                    }
                )

    errors = [
        {"view_id": view["id"], "group": view["group"], "error": row["错误"]}
        for view, row in zip(project["views"], rows)
        if row["错误"]
    ]
    error_path = output_dir / "error-report.json"
    error_path.write_text(
        json.dumps(errors, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    project_path = save_project(project)

    if include_annotations:
        annotation_dir = output_dir / "annotated"
        annotation_dir.mkdir(exist_ok=True)
        for view in project["views"]:
            result = project["results"].get(view["id"], {})
            if result.get("status") != "done":
                continue
            safe_group = re.sub(r'[<>:"/\\|?*]', "_", view["group"])
            target_dir = annotation_dir / safe_group
            target_dir.mkdir(exist_ok=True)
            export_annotated(
                view["paths"]["overlay"],
                result.get("detections", []),
                target_dir / f"{view['name']}_annotated.png",
            )
    return {
        "output_dir": str(output_dir),
        "results_csv": str(csv_path),
        "summary_csv": str(summary_path),
        "project_json": str(project_path),
        "error_report": str(error_path),
    }

