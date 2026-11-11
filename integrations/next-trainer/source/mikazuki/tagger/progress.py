"""Thread-safe tagger download / batch tagging progress for WebUI polling."""

from __future__ import annotations

import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Optional


class TaggerCancelled(Exception):
    """User requested cooperative cancel of download or tagging."""


@dataclass
class _StepProgress:
    current: int = 0
    total: int = 0
    filename: str = ""
    bytes_current: int = 0
    bytes_total: int = 0
    percent: int = 0


@dataclass
class TaggerProgressSnapshot:
    phase: str = "idle"  # idle | downloading | tagging | done | error | cancelling
    message: str = ""
    model: str = ""
    download: _StepProgress = field(default_factory=_StepProgress)
    tagging: _StepProgress = field(default_factory=_StepProgress)
    error: Optional[str] = None
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        return data


class TaggerProgress:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._busy = False
        self._cancel_requested = False
        self._snapshot = TaggerProgressSnapshot()

    def _touch(self, **kwargs: Any) -> None:
        with self._lock:
            if self._cancel_requested:
                phase = kwargs.get("phase")
                if phase not in ("idle", "error", "done", "cancelling", None):
                    return
            for key, value in kwargs.items():
                if key == "download" and isinstance(value, dict):
                    for dk, dv in value.items():
                        setattr(self._snapshot.download, dk, dv)
                elif key == "tagging" and isinstance(value, dict):
                    for tk, tv in value.items():
                        setattr(self._snapshot.tagging, tk, tv)
                elif hasattr(self._snapshot, key):
                    setattr(self._snapshot, key, value)
            self._snapshot.updated_at = time.time()

    def get(self) -> dict[str, Any]:
        with self._lock:
            return self._snapshot.to_dict()

    def is_busy(self) -> bool:
        with self._lock:
            return self._busy

    def is_cancel_requested(self) -> bool:
        with self._lock:
            return self._cancel_requested

    def request_cancel(self) -> bool:
        with self._lock:
            if not self._busy:
                return False
            self._cancel_requested = True
            self._snapshot.phase = "cancelling"
            self._snapshot.message = "正在中止…"
            self._snapshot.updated_at = time.time()
            return True

    def check_cancelled(self) -> None:
        if self.is_cancel_requested():
            raise TaggerCancelled()

    def try_begin(self, phase: str, model: str, message: str) -> bool:
        with self._lock:
            if self._busy:
                return False
            self._cancel_requested = False
            self._busy = True
            self._snapshot = TaggerProgressSnapshot(
                phase=phase,
                model=model,
                message=message,
                download=_StepProgress(),
                tagging=_StepProgress(),
                error=None,
            )
            self._snapshot.updated_at = time.time()
            return True

    def release(self) -> None:
        with self._lock:
            self._busy = False

    def begin_download(self, model: str, total_files: int, message: str = "正在下载模型…") -> None:
        self._touch(
            phase="downloading",
            model=model,
            message=message,
            error=None,
            download={
                "current": 0,
                "total": max(total_files, 1),
                "filename": "",
                "bytes_current": 0,
                "bytes_total": 0,
                "percent": 0,
            },
            tagging={"current": 0, "total": 0, "filename": ""},
        )

    def set_download(self, current: int, total: int, filename: str = "") -> None:
        msg = f"正在下载模型 {filename}（{current}/{total} 个文件）" if filename else f"正在下载模型（{current}/{total}）"
        self._touch(
            phase="downloading",
            message=msg,
            download={
                "current": current,
                "total": total,
                "filename": filename,
                "bytes_current": 0,
                "bytes_total": 0,
                "percent": 0,
            },
        )

    def set_download_bytes(
        self,
        *,
        file_index: int,
        file_total: int,
        filename: str,
        bytes_current: int,
        bytes_total: int,
    ) -> None:
        file_total = max(file_total, 1)
        file_index = min(max(file_index, 1), file_total)
        bytes_total = max(bytes_total, 0)
        bytes_current = min(max(bytes_current, 0), bytes_total) if bytes_total else max(bytes_current, 0)

        if bytes_total > 0:
            file_frac = bytes_current / bytes_total
            file_pct = int(file_frac * 100)
            overall_pct = int(((file_index - 1) + file_frac) / file_total * 100)
            cur_mb = bytes_current / (1024 * 1024)
            tot_mb = bytes_total / (1024 * 1024)
            if tot_mb >= 1:
                size_hint = f"{cur_mb:.1f}MB/{tot_mb:.1f}MB"
            else:
                size_hint = f"{bytes_current}/{bytes_total}B"
            if file_total > 1:
                msg = (
                    f"正在下载模型 {filename} {file_pct}%（{size_hint}，"
                    f"总进度 {overall_pct}%）"
                )
            else:
                msg = f"正在下载模型 {filename} {file_pct}%（{size_hint}）"
        else:
            overall_pct = int(file_index / file_total * 100)
            msg = f"正在下载模型 {filename}（{file_index}/{file_total}）"

        self._touch(
            phase="downloading",
            message=msg,
            download={
                "current": file_index,
                "total": file_total,
                "filename": filename,
                "bytes_current": bytes_current,
                "bytes_total": bytes_total,
                "percent": overall_pct,
            },
        )

    def begin_tagging(self, model: str, total_images: int, message: str = "准备打标…") -> None:
        self._touch(
            phase="tagging",
            model=model,
            message=message,
            error=None,
            tagging={"current": 0, "total": max(total_images, 0), "filename": ""},
        )

    def set_tagging(self, current: int, total: int, filename: str = "") -> None:
        msg = f"正在打标 {filename} ({current}/{total})" if filename and total else f"正在打标 ({current}/{total})"
        self._touch(
            phase="tagging",
            message=msg,
            tagging={"current": current, "total": total, "filename": filename},
        )

    def complete_download_for_tagging(self, model: str, message: str = "模型已就绪，开始打标…") -> None:
        snap = self.get()
        download = snap.get("download") or {}
        total = int(download.get("total") or 0)
        self._touch(
            phase="tagging",
            model=model,
            message=message,
            error=None,
            download={
                "current": total,
                "total": total,
                "filename": "",
            },
            tagging={"current": 0, "total": 0, "filename": ""},
        )

    def finish_download_success(self, message: str = "模型已就绪") -> None:
        snap = self.get()
        download = snap.get("download") or {}
        total = int(download.get("total") or 0)
        self._touch(
            phase="done",
            message=message,
            error=None,
            download={
                "current": total,
                "total": total,
                "filename": "",
            },
        )
        self.release()

    def finish_success(self, message: str = "打标完成") -> None:
        snap = self.get()
        tagging = snap.get("tagging") or {}
        total = int(tagging.get("total") or 0)
        self._touch(
            phase="done",
            message=message,
            error=None,
            tagging={
                "current": total,
                "total": total,
                "filename": "",
            },
        )
        self.release()

    def finish_error(self, message: str) -> None:
        self._touch(phase="error", message=message, error=message)
        self.release()

    def finish_cancelled(self, message: str = "已中止") -> None:
        with self._lock:
            self._cancel_requested = False
            self._busy = False
            self._snapshot = TaggerProgressSnapshot(phase="idle", message=message)
            self._snapshot.updated_at = time.time()

    def reset_idle(self, message: str = "空闲") -> None:
        with self._lock:
            self._cancel_requested = False
            self._busy = False
            self._snapshot = TaggerProgressSnapshot(phase="idle", message=message)
            self._snapshot.updated_at = time.time()


tagger_progress = TaggerProgress()
