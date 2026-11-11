"""Loopback-only, authenticated, complete-WAV MOSS speech service."""

import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import socket
import threading
from urllib.parse import urlsplit

from engine import IncompleteAudioError, MossEngine, ProfileChangedError, VoiceProfile, read_json, validate_wav


SERVICE = "moss-character-voice"
VERSION = 1
MODEL_ID = "moss-tts-local"
VOICE_ID = "xiaoli-warm-bright"
VOICE_NAME = "测试音色 · 温暖清亮"
MAX_BODY = 16384


class RequestError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


class VoiceServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, config, profile, port, engine_factory):
        self.token = config["token"]
        self.voice_id = config["voiceId"]
        self.voice_name = VOICE_NAME
        self.profile = profile
        self.engine = engine_factory(profile)
        self.synthesis_lock = threading.Lock()
        self.stopping = False
        super().__init__(("127.0.0.1", port), VoiceHandler)

    def handle_error(self, request, client_address):
        # Never print request contents, private paths, or exception tracebacks.
        pass

    def server_close(self):
        super().server_close()
        # An already accepted synthesis finishes before CPU resources are freed.
        with self.synthesis_lock:
            self.engine.close()


class VoiceHandler(BaseHTTPRequestHandler):
    server_version = SERVICE
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, format, *args):
        pass

    def _send(self, status, data, content_type="application/json; charset=utf-8", headers=None):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.close_connection = True
        self.wfile.write(data)

    def send_error(self, code, message=None, explain=None):
        self._send(code, {"error": {"code": "http_error", "message": "无效的 HTTP 请求"}})

    def _boundary(self):
        hosts = self.headers.get_all("Host", [])
        valid_hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if len(hosts) != 1 or hosts[0].lower() not in valid_hosts:
            raise RequestError(403, "invalid_host", "仅接受本机回环服务请求")
        origins = self.headers.get_all("Origin", [])
        if len(origins) > 1:
            raise RequestError(403, "invalid_origin", "不允许此请求来源")
        if origins:
            try:
                origin = urlsplit(origins[0])
                valid = (origin.scheme == "http" and origin.hostname in {"localhost", "127.0.0.1"}
                    and not origin.username and not origin.password and not origin.path
                    and not origin.query and not origin.fragment and (origin.port is None or 1 <= origin.port <= 65535))
            except ValueError:
                valid = False
            if not valid:
                raise RequestError(403, "invalid_origin", "不允许此请求来源")
        if self.headers.get_all("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) > 1:
            raise RequestError(400, "invalid_framing", "请求体长度无效")

    def _authenticate(self):
        values = self.headers.get_all("Authorization", [])
        expected = ("Bearer " + self.server.token).encode("utf-8")
        if len(values) != 1 or not hmac.compare_digest(values[0].encode("utf-8"), expected):
            raise RequestError(401, "unauthorized", "语音服务身份验证失败")

    def _body(self):
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise RequestError(415, "invalid_content_type", "请求需要 application/json")
        length = self.headers.get("Content-Length", "")
        if not re.fullmatch(r"[0-9]{1,8}", length):
            raise RequestError(400, "invalid_length", "请求体长度无效")
        length = int(length)
        if length > MAX_BODY:
            raise RequestError(413, "body_too_large", "请求体过大")
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("incomplete body")
            data = json.loads(raw.decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("expected object")
            return data
        except (ValueError, UnicodeError, socket.timeout):
            raise RequestError(400, "invalid_json", "请求需要完整的 JSON 对象") from None

    def _speech(self):
        data = self._body()
        text = data.get("input")
        if not isinstance(text, str) or not text.strip() or len(text) > 500:
            raise RequestError(400, "invalid_input", "台词需要为 1–500 字符的非空文本")
        try:
            text.encode("utf-8")
        except UnicodeError:
            raise RequestError(400, "invalid_input", "台词含无效字符") from None
        if (data.get("voice") != self.server.voice_id or data.get("model") != MODEL_ID
                or data.get("response_format") != "wav"):
            raise RequestError(400, "invalid_voice_request", "音色、模型或音频格式不匹配")
        if self.server.stopping:
            raise RequestError(503, "shutting_down", "语音服务正在停止")
        if not self.server.synthesis_lock.acquire(blocking=False):
            raise RequestError(429, "voice_busy", "语音服务正在合成，请稍后重试")
        try:
            self.server.profile.assert_unchanged()
            audio = validate_wav(self.server.engine.synthesize(text))
            self.server.profile.assert_unchanged()
            self._send(200, audio, "audio/wav", {
                "X-Voice-Id": self.server.voice_id,
                "X-Voice-Profile-SHA256": self.server.profile.profile_sha256,
                "X-Reference-SHA256": self.server.profile.reference_sha256,
            })
        finally:
            self.server.synthesis_lock.release()

    def _dispatch(self):
        try:
            self._boundary()
            if self.command == "GET" and self.path == "/health":
                self._send(200, {"service": SERVICE, "version": VERSION,
                    "busy": self.server.synthesis_lock.locked(), "loaded": bool(self.server.engine.loaded)})
                return
            self._authenticate()
            if self.command == "GET" and self.path == "/v1/voices":
                self.server.profile.assert_unchanged()
                self._send(200, {"voices": [{"id": self.server.voice_id, "name": self.server.voice_name,
                    "profileSha256": self.server.profile.profile_sha256,
                    "referenceSha256": self.server.profile.reference_sha256}]})
            elif self.command == "GET" and self.path == "/v1/models":
                self._send(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model",
                    "created": 0, "owned_by": SERVICE}]})
            elif self.command == "POST" and self.path == "/v1/audio/speech":
                self._speech()
            elif self.command == "POST" and self.path == "/shutdown":
                self.server.stopping = True
                self._send(200, {"service": SERVICE, "stopping": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                raise RequestError(404, "not_found", "语音服务接口不存在")
        except RequestError as exc:
            self._send(exc.status, {"error": {"code": exc.code, "message": exc.message}})
        except ProfileChangedError:
            self._send(409, {"error": {"code": "voice_profile_changed", "message": "音色配方或参考已变更，请重新启动语音服务"}})
        except IncompleteAudioError:
            self._send(422, {"error": {"code": "generation_incomplete", "message": "语音达到生成上限，请缩短台词后重试"}})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self._send(500, {"error": {"code": "synthesis_failed", "message": "本地语音合成失败，请检查模型环境后重试"}})

    do_GET = _dispatch
    do_POST = _dispatch


def create_server(config_path, port=0, engine_factory=MossEngine):
    config, _ = read_json(Path(config_path))
    token = config.get("token")
    if (type(config.get("version")) is not int or config.get("version") != VERSION
            or config.get("service") != SERVICE or config.get("voiceId") != VOICE_ID
            or config.get("voiceName") not in (VOICE_NAME, "小璃 · 温暖清亮")):
        raise ValueError("私有服务配置身份不匹配")
    if not isinstance(token, str) or not re.fullmatch(r"[\x21-\x7e]{32,256}", token):
        raise ValueError("私有服务令牌无效")
    if not isinstance(config.get("profilePath"), str):
        raise ValueError("私有服务配置缺少音色配方")
    profile = VoiceProfile.load(config["profilePath"])
    return VoiceServer(config, profile, port, engine_factory)


def main():
    parser = argparse.ArgumentParser(description="固定参考测试音色本地语音服务")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port 必须介于 1 和 65535")
    try:
        server = create_server(args.config, args.port)
    except Exception:
        parser.exit(1, "本地语音服务启动失败：请检查私有配置、固定参考校验值与本地模型路径。\n")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
