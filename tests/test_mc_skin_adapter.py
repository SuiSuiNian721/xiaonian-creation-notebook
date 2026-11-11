"""工作台 Minecraft 适配器的实际 CLI、像素与文件保留契约。"""
from __future__ import annotations

import copy
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "integrations/minecraft-skin/skin_adapter.py"
SKILL = ROOT / "integrations/minecraft-pixel-skin"
sys.path.insert(0, str(SKILL / "scripts"))
from skin_tools import blank_skin, uv_faces  # noqa: E402


class SkinAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mc-skin-adapter-")
        self.root = Path(self.temp.name)
        self.serial = 0

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, *args, success=True):
        completed = subprocess.run(
            [sys.executable, "-B", str(ADAPTER), *map(str, args)],
            capture_output=True, text=True, encoding="utf-8", check=False,
            env={**os.environ, "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"},
        )
        if success:
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        else:
            self.assertNotEqual(completed.returncode, 0, completed.stdout)
        self.assertFalse(completed.stdout.startswith("\ufeff"))
        result = json.loads(completed.stdout)
        if not success:
            self.assertTrue(result.get("error"), result)
            self.assertRegex(result["error"], r"[\u4e00-\u9fff]")
        return result

    def frozen(self, eye):
        return json.loads((SKILL / f"assets/templates/{eye}/versions/1.0.0.json").read_text("utf-8"))

    def request(self, model="slim", eye=None):
        surfaces = []
        for face, boxes in uv_faces(model).items():
            width, height = boxes["base"][2:]
            surfaces.append({"face": face, "base": ["s" * width] * height})
        return {
            "model": model, "eyeTemplate": eye,
            "plan": {"palette": {"s": [230, 190, 165, 255]}, "surfaces": surfaces,
                     "eyePalette": {key: value["rgba"] for key, value in self.frozen(eye)["palette"].items()} if eye else {}},
            "provenance": {"userInstruction": "按我给的角色参考制作皮肤。", "requestId": "fixture-test"},
        }

    def render(self, request, success=True, output=None):
        self.serial += 1
        request_path = self.root / f"request-{self.serial}.json"
        request_path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
        output = output or self.root / f"candidate-{self.serial}"
        result = self.cli("render", "--request", request_path, "--output", output, success=success)
        return output, result

    def test_environment_reports_authoritative_uv_and_frozen_palette_roles(self):
        result = self.cli("environment")
        self.assertTrue(result["available"])
        self.assertIn("pillow", result)
        self.assertEqual(result["uv"], {model: uv_faces(model) for model in ("slim", "classic")})
        self.assertEqual({entry["id"] for entry in result["templates"]}, {"eye_A", "eye_B"})
        for entry in result["templates"]:
            self.assertEqual(entry["version"], "1.0.0")
            self.assertEqual(set(entry["requiredPaletteKeys"]), set(self.frozen(entry["id"])["palette"]))
            self.assertTrue(all(value["role"] for value in entry["palette"].values()))

    def test_skill_snapshot_manifest_records_all_original_files_without_including_itself(self):
        manifest_path = SKILL / "source-manifest.json"
        self.assertTrue(manifest_path.is_file(), "缺少随包 Skill 来源清单")
        raw = manifest_path.read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        manifest = json.loads(raw)
        self.assertEqual(manifest["sourceRoot"], r"F:\codex\skills\minecraft-pixel-skin")
        self.assertIsNotNone(datetime.fromisoformat(manifest["generatedAtUtc"].replace("Z", "+00:00")).tzinfo)
        self.assertEqual(len(manifest["files"]), 27)
        recorded = {item["path"] for item in manifest["files"]}
        self.assertNotIn("source-manifest.json", recorded)
        actual = {path.relative_to(SKILL).as_posix() for path in SKILL.rglob("*") if path.is_file()}
        self.assertEqual(recorded, actual - {"source-manifest.json"})
        for item in manifest["files"]:
            self.assertEqual(hashlib.sha256((SKILL / item["path"]).read_bytes()).hexdigest(), item["sha256"])

    def test_probe_decodes_supported_still_images_without_changing_source(self):
        for image_format, extension, mime in (("PNG", "png", "image/png"), ("JPEG", "jpg", "image/jpeg"), ("WEBP", "webp", "image/webp")):
            with self.subTest(image_format=image_format):
                source = self.root / ("参考." + extension)
                Image.new("RGB", (47, 83), (10, 30, 80)).save(source, image_format)
                before = source.read_bytes()
                result = self.cli("probe", "--source", source)
                self.assertEqual(result, {"width": 47, "height": 83, "format": image_format, "mime": mime})
                self.assertEqual(source.read_bytes(), before)
        gif = self.root / "unsupported.gif"
        Image.new("RGB", (2, 2)).save(gif)
        self.cli("probe", "--source", gif, success=False)
        animated = self.root / "animated.png"
        Image.new("RGBA", (2, 2), "red").save(animated, save_all=True, append_images=[Image.new("RGBA", (2, 2), "blue")])
        self.cli("probe", "--source", animated, success=False)
        huge = self.root / "too-wide.png"
        Image.new("RGB", (4097, 1)).save(huge)
        self.cli("probe", "--source", huge, success=False)

    def test_each_model_and_eye_produces_native_png_with_frozen_pixels_and_offline_preview(self):
        for model in ("slim", "classic"):
            for eye in ("eye_A", "eye_B"):
                with self.subTest(model=model, eye=eye):
                    request = self.request(model, eye)
                    output, result = self.render(request)
                    self.assertEqual(set(result["files"]), {"skin.png", "layers.png", "manifest.json", "preview.html"})
                    self.assertTrue(result["validation"]["passed"])
                    self.assertEqual(result["validation"]["base_pixels"], 1568 if model == "slim" else 1632)
                    with Image.open(output / "skin.png") as image:
                        self.assertEqual(image.size, (64, 64))
                        self.assertEqual(image.mode, "RGBA")
                        for surface in self.frozen(eye)["surfaces"]:
                            x, y, _, _ = uv_faces(model)[surface["face"]]["base"]
                            for v, row in enumerate(surface["base"]):
                                for u, token in enumerate(row):
                                    if token != ".":
                                        self.assertEqual(image.getpixel((x + u, y + v)), tuple(request["plan"]["eyePalette"][token]))
                    manifest_bytes = (output / "manifest.json").read_bytes()
                    self.assertFalse(manifest_bytes.startswith(b"\xef\xbb\xbf"))
                    manifest = json.loads(manifest_bytes)
                    self.assertTrue(manifest["png_readback_verified"])
                    self.assertEqual(manifest["status"], "candidate")
                    self.assertFalse(manifest["game_runtime_verified"])
                    self.assertEqual(len(manifest["faces"]), 36)
                    self.assertEqual(set(manifest["review_faces"]), set(uv_faces(model)))
                    with Image.open(output / "layers.png") as board:
                        self.assertEqual(board.size, (1200, 160 + 460 * 36))
                    self.assertEqual(manifest["template"]["version"], "1.0.0")
                    template_path = SKILL / f"assets/templates/{eye}/versions/1.0.0.json"
                    self.assertEqual(manifest["template"]["sha256"], hashlib.sha256(template_path.read_bytes()).hexdigest())
                    page = (output / "preview.html").read_text("utf-8")
                    self.assertIn("data:image/png;base64,", page)
                    self.assertIn("skinview3d.SkinViewer", page)
                    self.assertNotRegex(page, r'<(?:script|link)[^>]+(?:src|href)=["\']https?://')
                    self.assertIn('model: "' + model + '"', page)

    def test_inspect_returns_full_rgba_matrices_and_source_is_retained_in_local_edit(self):
        source = self.root / "原始皮肤.png"
        original = blank_skin("slim", (50, 100, 150, 255))
        original.putpixel((40, 8), (20, 40, 80, 255))
        original.save(source, "PNG")
        before = source.read_bytes()
        inspection = self.cli("inspect", "--source", source, "--model", "slim")
        self.assertTrue(inspection["validation"]["passed"])
        self.assertEqual(len(inspection["faces"]), 36)
        front = next(face for face in inspection["faces"] if face["face"] == "head.front")
        self.assertEqual(front["base"][0][0], [50, 100, 150, 255])
        self.assertEqual(front["outer"][0][0], [20, 40, 80, 255])
        request = self.request()
        request["source"] = str(source)
        request["plan"]["palette"]["r"] = [120, 10, 20, 255]
        request["plan"]["surfaces"] = [{"face": "head.front", "base": ["r......."] + ["........"] * 7}]
        output, _ = self.render(request)
        self.assertEqual(source.read_bytes(), before)
        manifest = json.loads((output / "manifest.json").read_text("utf-8"))
        self.assertEqual(manifest["changed_pixels"], [[8, 8]])
        self.assertEqual(manifest["source_sha256"], hashlib.sha256(before).hexdigest())
        self.assertEqual(manifest["review_faces"], ["head.front"])
        with Image.open(output / "layers.png") as board:
            self.assertEqual(board.size, (1200, 160 + 460))
        with Image.open(output / "skin.png") as image:
            for y in range(64):
                for x in range(64):
                    if (x, y) != (8, 8):
                        self.assertEqual(image.getpixel((x, y)), original.getpixel((x, y)))

    def test_rejects_missing_new_base_face_keep_clear_and_invalid_matrix(self):
        cases = []
        missing = self.request(); missing["plan"]["surfaces"].pop(); cases.append(missing)
        keep = self.request(); keep["plan"]["surfaces"][0]["base"][0] = "........"; cases.append(keep)
        clear = self.request(); clear["plan"]["surfaces"][0]["base"][0] = "--------"; cases.append(clear)
        wrong = self.request(); wrong["plan"]["surfaces"][0]["base"][0] = "sss"; cases.append(wrong)
        unknown = self.request(); unknown["plan"]["surfaces"][0]["face"] = "unknown.front"; cases.append(unknown)
        for request in cases:
            with self.subTest(request=request["plan"]["surfaces"][0]):
                output, _ = self.render(request, success=False)
                self.assertFalse(output.exists())

    def test_partial_edit_layer_board_contains_modified_face_and_eye_face(self):
        source = self.root / "classic-source.png"
        blank_skin("classic").save(source)
        request = self.request(model="classic", eye="eye_B")
        request["source"] = str(source)
        request["plan"]["surfaces"] = [{"face": "body.back", "base": ["s......."] + ["........"] * 11}]
        output, _ = self.render(request)
        manifest = json.loads((output / "manifest.json").read_text("utf-8"))
        self.assertEqual(manifest["review_faces"], ["head.front", "body.back"])
        with Image.open(output / "layers.png") as board:
            self.assertEqual(board.size, (1200, 160 + 460 * 2))

    def test_invalid_source_size_base_alpha_outer_alpha_and_uv_are_rejected(self):
        images = []
        images.append(Image.new("RGBA", (64, 32), (255, 255, 255, 255)))
        base = blank_skin("slim"); base.putpixel((8, 8), (1, 2, 3, 128)); images.append(base)
        outer = blank_skin("slim"); outer.putpixel((40, 8), (1, 2, 3, 128)); images.append(outer)
        uv = blank_skin("slim"); uv.putpixel((0, 0), (1, 2, 3, 255)); images.append(uv)
        for index, image in enumerate(images):
            with self.subTest(index=index):
                source = self.root / f"invalid-{index}.png"
                image.save(source)
                request = self.request(); request["source"] = str(source); request["plan"]["surfaces"] = []
                output, _ = self.render(request, success=False)
                self.assertFalse(output.exists())

    def test_rejects_existing_output_and_preserves_existing_bytes(self):
        output = self.root / "existing"
        output.mkdir()
        marker = output / "skin.png"
        marker.write_bytes(b"never overwrite")
        self.render(self.request(), success=False, output=output)
        self.assertEqual(marker.read_bytes(), b"never overwrite")
        self.assertEqual(list(output.iterdir()), [marker])

    def test_rejects_directory_link_output_and_linked_ancestor(self):
        destination = self.root / "real"
        destination.mkdir()
        linked = self.root / "linked"
        try:
            linked.symlink_to(destination, target_is_directory=True)
        except OSError as error:
            if os.name != "nt":
                raise error
            # Windows 目录联接不依赖创建符号链接的管理员权限，同样不能跟随。
            completed = subprocess.run(
                ["pwsh", "-NoProfile", "-Command", "New-Item -ItemType Junction -Path $env:MC_TEST_LINK -Target $env:MC_TEST_DEST | Out-Null"],
                env={**os.environ, "MC_TEST_LINK": str(linked), "MC_TEST_DEST": str(destination)},
                capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
        try:
            self.render(self.request(), success=False, output=linked)
            self.render(self.request(), success=False, output=linked / "nested")
            self.assertEqual(list(destination.iterdir()), [])
        finally:
            if linked.is_symlink():
                linked.unlink()
            else:
                os.rmdir(linked)

    def test_eye_palette_requires_all_explicit_bindings_and_opaque_alpha(self):
        for eye in ("eye_A", "eye_B"):
            request = self.request(eye=eye); del request["plan"]["eyePalette"]["I"]
            self.render(request, success=False)
            request = self.request(eye=eye); request["plan"]["eyePalette"]["I"][3] = 128
            self.render(request, success=False)
            request = self.request(eye=eye); request["plan"]["eyePalette"]["H"] = [1, 2, 3, 255]
            self.render(request, success=False)

    def test_eye_preserve_creates_recorded_local_variant_without_changing_frozen_template(self):
        template_path = SKILL / "assets/templates/eye_A/versions/1.0.0.json"
        before = template_path.read_bytes()
        source = self.root / "hair.png"
        image = blank_skin("slim")
        image.putpixel((9, 12), (18, 15, 35, 255))
        image.save(source)
        request = self.request(eye="eye_A")
        request["source"] = str(source); request["plan"]["surfaces"] = []
        request["plan"]["eyePreserve"] = [{"xy": [1, 4], "reason": "角色参考中这一格为基础层发丝，保留原发色。"}]
        output, _ = self.render(request)
        self.assertEqual(template_path.read_bytes(), before)
        with Image.open(output / "skin.png") as result:
            self.assertEqual(result.getpixel((9, 12)), (18, 15, 35, 255))
        manifest = json.loads((output / "manifest.json").read_text("utf-8"))
        self.assertEqual(manifest["eye_preserve"], request["plan"]["eyePreserve"])
        self.assertTrue(manifest["template"]["outer_all_keep"])
        self.assertEqual(manifest["review_faces"], ["head.front"])
        invalid = copy.deepcopy(request); invalid["plan"]["eyePreserve"] = [{"xy": [3, 3], "reason": "此格不属于眼型操作区"}]
        self.render(invalid, success=False)

    def test_eye_occlusions_need_real_user_instruction_and_only_exempt_exact_pixels(self):
        source = self.root / "occluded.png"
        image = blank_skin("slim")
        image.putpixel((42, 13), (30, 20, 10, 255))
        image.save(source)
        request = self.request(eye="eye_A")
        request["source"] = str(source); request["plan"]["surfaces"] = []
        request["plan"]["eyeOcclusions"] = [{"xy": [2, 5], "reason": "用户指定参考中的遮眼刘海。"}]
        request["provenance"]["userInstruction"] = "保留参考中遮住左眼的刘海。"
        output, _ = self.render(request)
        manifest = json.loads((output / "manifest.json").read_text("utf-8"))
        self.assertEqual(manifest["exceptions"][0]["authorization"], request["provenance"]["userInstruction"])
        self.assertEqual(manifest["exceptions"][0]["xy"], [2, 5])
        missing = copy.deepcopy(request); missing["provenance"].pop("userInstruction")
        self.render(missing, success=False)
        image.putpixel((45, 13), (30, 20, 10, 255)); image.save(source)
        self.render(request, success=False)


if __name__ == "__main__":
    unittest.main()
