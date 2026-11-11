"""工作台 Minecraft 制作桥：保留原图，以随包 skill 实作并校验候选像素。"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

sys.dont_write_bytecode = True
SKILL_ROOT = Path(__file__).resolve().parents[1] / "minecraft-pixel-skin"
sys.path.insert(0, str(SKILL_ROOT / "scripts"))

import PIL
from PIL import Image, UnidentifiedImageError

from skin_tools import (blank_skin, changed_pixels, compose_template, file_hash,
                        normalized_rows, pixel_hash, rgba, uv_faces, validate_skin,
                        validate_template, write_json, write_png)
from render_review import draw_board

MAX_IMAGE_SIDE = 4096
MAX_IMAGE_PIXELS = 16_000_000
EYES = {"eye_A": "第一种角色眼睛", "eye_B": "第二种角色眼睛"}
FILES = ["skin.png", "layers.png", "manifest.json", "preview.html"]


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"无法读取 UTF-8 JSON 文件：{error}") from error


def load_eye(eye_id):
    if eye_id not in EYES:
        raise ValueError("眼型只能选择第一种、第二种或不套用模板")
    path = SKILL_ROOT / "assets" / "templates" / eye_id / "versions" / "1.0.0.json"
    template = read_json(path)
    if (template.get("id") != eye_id or template.get("version") != "1.0.0"
            or template.get("approval", {}).get("status") != "approved"):
        raise ValueError("随包冻结眼型版本或确认状态不一致")
    for surface in template["surfaces"]:
        if any(token != "." for row in surface["outer"] for token in row):
            raise ValueError("冻结眼型外层必须全部 KEEP")
    for model in ("slim", "classic"):
        validate_template(template, model)
    return path, template


def environment():
    templates = []
    for eye_id, name in EYES.items():
        path, template = load_eye(eye_id)
        templates.append({"id": eye_id, "name": name, "version": template["version"],
                          "palette": template["palette"],
                          "requiredPaletteKeys": list(template["palette"]),
                          "sha256": file_hash(path)})
    return {"available": True, "python": sys.executable, "pythonVersion": sys.version.split()[0],
            "pillow": PIL.__version__, "templates": templates,
            "uv": {model: uv_faces(model) for model in ("slim", "classic")}}


def decoded_image(path):
    """先核对头部边界，再完整解码；不对输入写盘或重采样。"""
    try:
        with Image.open(path) as image:
            image_format = image.format
            if image_format not in ("PNG", "JPEG", "WEBP"):
                raise ValueError("参考图片仅支持 PNG、JPEG 或 WEBP")
            width, height = image.size
            if not (0 < width <= MAX_IMAGE_SIDE and 0 < height <= MAX_IMAGE_SIDE
                    and width * height <= MAX_IMAGE_PIXELS):
                raise ValueError("参考图每边不能超过 4096 像素，总像素不能超过 1600 万")
            if getattr(image, "is_animated", False) or getattr(image, "n_frames", 1) != 1:
                raise ValueError("参考图片必须是单帧静态图片")
            image.load()
            info = {"width": width, "height": height, "format": image_format,
                    "mime": {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[image_format]}
            return image.convert("RGBA"), info
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise ValueError(f"图片无法完整解码：{error}") from error


def skin_image(path):
    image, info = decoded_image(path)
    if info["format"] != "PNG" or image.size != (64, 64):
        raise ValueError("已有皮肤必须是原生 64×64 PNG 图片")
    return image


def face_data(image, model):
    result = []
    for face, boxes in uv_faces(model).items():
        item = {"face": face, "baseBox": boxes["base"], "outerBox": boxes["outer"]}
        for layer in ("base", "outer"):
            x, y, width, height = boxes[layer]
            item[layer] = [[list(image.getpixel((x + u, y + v))) for u in range(width)]
                           for v in range(height)]
        result.append(item)
    return result


def inspect_skin(source_path, model):
    path = Path(source_path).resolve(strict=True)
    image = skin_image(path)
    return {"model": model, "source_sha256": file_hash(path),
            "validation": validate_skin(image, model), "faces": face_data(image, model)}


def object_value(value, name):
    if not isinstance(value, dict):
        raise ValueError(f"{name} 必须是 JSON 对象")
    return value


def array_value(value, name):
    if not isinstance(value, list):
        raise ValueError(f"{name} 必须是数组")
    return value


def build_plan(plan, model, is_new):
    plan = object_value(plan, "plan")
    palette = object_value(plan.get("palette"), "plan.palette")
    if len(palette) > 256:
        raise ValueError("像素方案调色板最多允许 256 个颜色")
    colors = {}
    for key, value in palette.items():
        if not isinstance(key, str) or len(key) != 1 or key in (".", "-"):
            raise ValueError("像素调色板必须使用单字符键，不能占用 . 或 -")
        colors[key] = {"rgba": list(rgba(value)), "role": "当前角色方案颜色"}
    faces = uv_faces(model)
    surfaces, seen = [], set()
    for item in array_value(plan.get("surfaces"), "plan.surfaces"):
        item = object_value(item, "surface")
        face = item.get("face")
        if face not in faces or face in seen:
            raise ValueError(f"方案面重复或 UV 面名无效：{face}")
        if set(item) - {"face", "base", "outer"}:
            raise ValueError(f"{face} 包含未知层或字段")
        seen.add(face)
        surface = {"face": face}
        for layer in ("base", "outer"):
            _, _, width, height = faces[face][layer]
            raw_rows = item.get(layer)
            if raw_rows is None:
                if layer == "base" and is_new:
                    raise ValueError(f"新皮肤必须完整提供 {face} 基础层")
                raw_rows = ["." * width for _ in range(height)]
            if not isinstance(raw_rows, list) or any(not isinstance(row, str) for row in raw_rows):
                raise ValueError(f"{face} 的 {layer} 必须是字符串数组")
            rows = normalized_rows(raw_rows, width, height)
            for row in rows:
                for token in row:
                    if token not in (".", "-") and token not in colors:
                        raise ValueError(f"{face} 使用未声明的颜色键：{token}")
                    if layer == "base" and token == "-":
                        raise ValueError("- 只能清空外层，不能清空基础层")
                    if is_new and layer == "base" and token == ".":
                        raise ValueError("新皮肤 36 个基础面必须逐格完整，不能用 KEEP 代替制作")
            surface[layer] = ["".join(row) for row in rows]
        surfaces.append(surface)
    if is_new and seen != set(faces):
        raise ValueError("新皮肤必须完整提供全部 36 个基础面")
    if not surfaces:
        return None
    # skill 模板不允许空调色板；全 KEEP 的局部检查仍可使用不参与绘制的哨兵色。
    template = {"schema_version": 1, "id": "workbench_plan", "version": "1.0.0-candidate",
                "models": [model], "approval": {"status": "pending"},
                "provenance": {"kind": "authored"},
                "palette": colors or {"_": {"rgba": [0, 0, 0, 255], "role": "未使用的验证色"}},
                "surfaces": surfaces, "protected_visible": [], "allowed_alpha": []}
    validate_template(template, model)
    return template


def local_eye_items(items, label):
    result, seen = [], set()
    for item in array_value(items, label):
        item = object_value(item, label)
        xy, reason = item.get("xy"), item.get("reason")
        if (not isinstance(xy, list) or len(xy) != 2
                or any(type(n) is not int or not 0 <= n < 8 for n in xy)):
            raise ValueError(f"{label} 只接受头部正面局部坐标 [0..7,0..7]")
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError(f"{label} 每一格必须说明实际参考依据")
        if tuple(xy) in seen:
            raise ValueError(f"{label} 坐标不能重复")
        seen.add(tuple(xy))
        result.append({"xy": list(xy), "reason": reason.strip()})
    return result


def prepare_eye(request, model):
    plan, eye_id = request["plan"], request.get("eyeTemplate")
    preserve = local_eye_items(plan.get("eyePreserve", []), "eyePreserve")
    occlusions = local_eye_items(plan.get("eyeOcclusions", []), "eyeOcclusions")
    if eye_id is None:
        if preserve or occlusions or plan.get("eyePalette"):
            raise ValueError("未选择眼型时不能设置眼型配色或保护例外")
        return None, None, {}, [], preserve
    path, frozen = load_eye(eye_id)
    overrides = object_value(plan.get("eyePalette"), "plan.eyePalette")
    required = set(frozen["palette"])
    if set(overrides) != required:
        raise ValueError("必须显式绑定所选眼型的全部颜色键，且不能添加未知键：" + ", ".join(sorted(required)))
    for color in overrides.values():
        if rgba(color)[3] != 255:
            raise ValueError("眼型配色必须保持不透明 Alpha 255")
    candidate = copy.deepcopy(frozen)
    if preserve:
        front = next(surface for surface in candidate["surfaces"] if surface["face"] == "head.front")
        for item in preserve:
            x, y = item["xy"]
            row = list(front["base"][y])
            if row[x] in (".", "-"):
                raise ValueError("eyePreserve 只能保留冻结眼型原本会绘制的基础层像素")
            row[x] = "."
            front["base"][y] = "".join(row)
        candidate["approval"] = {"status": "pending"}
        candidate["version"] = frozen["version"] + "-work-candidate"
    protected = {tuple(item["xy"]) for item in frozen.get("protected_visible", [])}
    exceptions = []
    for item in occlusions:
        if tuple(item["xy"]) not in protected:
            raise ValueError("eyeOcclusions 只能指向所选模板明确声明的可见保护格")
        provenance = object_value(request.get("provenance"), "provenance")
        authorization = provenance.get("userInstruction")
        if not isinstance(authorization, str) or not authorization.strip():
            raise ValueError("遮眼例外缺少 provenance.userInstruction 中的真实用户指令，不能自动编造授权")
        exceptions.append({"face": "head.front", "xy": item["xy"], "reason": item["reason"],
                           "authorization": authorization})
    validate_template(candidate, model)
    record = {"id": eye_id, "name": EYES[eye_id], "version": frozen["version"],
              "path": str(path), "sha256": file_hash(path), "outer_all_keep": True,
              "palette_overrides": overrides, "candidate_version": candidate["version"],
              "candidate_surfaces": candidate["surfaces"]}
    return candidate, record, overrides, exceptions, preserve


def new_output_path(value):
    """不先 resolve：保留链接路径，逐级拒绝符号链接、目录联接与重解析点。"""
    path = Path(os.path.abspath(value))
    for current in (path, *path.parents):
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        if (stat.S_ISLNK(metadata.st_mode) or getattr(current, "is_junction", lambda: False)()
                or getattr(metadata, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)):
            raise ValueError("输出路径及其上级目录不能是符号链接、目录联接或重解析点")
    if os.path.lexists(path):
        raise FileExistsError("候选输出目录已经存在，不能覆盖源文件或已有版本")
    return path


def preview_page(image_path, model):
    skin = "data:image/png;base64," + base64.b64encode(image_path.read_bytes()).decode("ascii")
    viewer_code = (SKILL_ROOT / "assets/vendor/skinview3d.bundle.js").read_text(encoding="utf-8")
    # JSON 避免任何内容被解释为 HTML；下载页自带 renderer 与原生 PNG，不访问网络。
    page_data = json.dumps({"skin": skin, "model": model}, ensure_ascii=False).replace("<", "\\u003c")
    return """<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Minecraft 皮肤候选</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#eff3f7;color:#26374a;font:15px/1.5 "Microsoft YaHei",sans-serif}main{max-width:840px;margin:auto;padding:24px}h1{font-size:24px;margin:0 0 16px}.controls{display:flex;flex-wrap:wrap;gap:16px;align-items:center}select,a{font:inherit;color:inherit}select{padding:6px;border:1px solid #bcc9d5;border-radius:7px}a{margin-left:auto}canvas{display:block;width:100%;height:560px;margin-top:20px;background:#dbe6f1;border-radius:16px}p{font-size:13px;color:#60748a}@media(max-width:560px){main{padding:16px}canvas{height:460px}}
</style><main><h1>皮肤候选</h1><div class="controls">
<label>视角 <select id="view"><option value="angle">斜侧面</option><option value="front">正面</option><option value="other">另一侧</option><option value="back">背面</option><option value="top">顶部</option></select></label>
<label><input type="checkbox" id="outer" checked> 显示外层</label><a id="download" download="skin.png">下载 PNG</a></div>
<canvas id="model" aria-label="可旋转的 Minecraft 皮肤三维预览"></canvas><p id="status" role="status">正在加载本地预览……</p></main>
<script>__LIBRARY__</script><script>
const data=__DATA__;
const canvas=document.getElementById('model');
document.getElementById('download').href=data.skin;
window.viewer=null;
function applyView(){
 const value=document.getElementById('view').value;
 const angle={front:0,angle:0.62,other:-0.62,back:Math.PI,top:0}[value];
 viewer.camera.position.set(Math.sin(angle)*68,value==='top'?70:0,Math.cos(angle)*(value==='top'?0.1:68));
 viewer.camera.lookAt(0,0,0);viewer.controls.target.set(0,0,0);viewer.camera.updateProjectionMatrix();
}
function applyOuter(){for(const part of ['head','body','leftArm','rightArm','leftLeg','rightLeg'])viewer.playerObject.skin[part].outerLayer.visible=document.getElementById('outer').checked;}
window.reviewReady=(async()=>{
 window.viewer=new skinview3d.SkinViewer({canvas,width:Math.max(240,Math.round(canvas.clientWidth)),height:Math.round(canvas.clientHeight),fov:32,zoom:1});
 await viewer.loadSkin(data.skin,{model: "__MODEL__"});
 viewer.globalLight.intensity=0;viewer.cameraLight.intensity=0;
 viewer.playerObject.skin.traverse(object=>{if(!object.isMesh)return;for(const material of Array.isArray(object.material)?object.material:[object.material]){if(!material.map)continue;material.map.colorSpace='';material.map.needsUpdate=true;material.emissiveMap=material.map;material.emissive.set(0xffffff);material.emissiveIntensity=1;material.color.set(0);material.needsUpdate=true;}});
 applyView();applyOuter();
 document.getElementById('view').addEventListener('change',applyView);
 document.getElementById('outer').addEventListener('change',applyOuter);
 window.addEventListener('resize',()=>viewer.setSize(Math.max(240,Math.round(canvas.clientWidth)),Math.round(canvas.clientHeight)));
 document.getElementById('status').textContent='候选预览 · skinview3d 3.4.2 · 游戏内效果尚未验证';
 return true;
})().catch(error=>{document.getElementById('status').textContent='本地三维预览加载失败：'+error.message;throw error;});
</script></html>
""".replace("__LIBRARY__", viewer_code).replace("__DATA__", page_data).replace("__MODEL__", model)


def render(request_path, output_path):
    output = new_output_path(output_path)
    request_path = Path(request_path).resolve(strict=True)
    request = object_value(read_json(request_path), "制作请求")
    model = request.get("model")
    if model not in ("slim", "classic"):
        raise ValueError("模型必须明确为 slim 或 classic")
    object_value(request.get("plan"), "plan")
    source_path, source_hash = None, None
    if request.get("source") is not None:
        if not isinstance(request["source"], str) or not request["source"].strip():
            raise ValueError("源皮肤路径必须是非空字符串")
        source_path = Path(request["source"])
        if not source_path.is_absolute():
            source_path = request_path.parent / source_path
        source_path = source_path.resolve(strict=True)
        source_hash = file_hash(source_path)
        source = skin_image(source_path)
    else:
        source = blank_skin(model)
    plan_template = build_plan(request["plan"], model, source_path is None)
    eye, template_record, eye_palette, exceptions, preserve = prepare_eye(request, model)
    candidate = source.copy()
    if plan_template:
        candidate = compose_template(candidate, plan_template, model, purpose="review")
    if eye:
        candidate = compose_template(candidate, eye, model, eye_palette, purpose="review")
    validation = validate_skin(candidate, model, [eye] if eye else [],
                               {eye["id"]: eye_palette} if eye else {}, exceptions=exceptions)
    if not validation["passed"]:
        raise ValueError("候选像素未通过校验：" + json.dumps(validation["errors"][:12], ensure_ascii=False))
    if source_path and file_hash(source_path) != source_hash:
        raise RuntimeError("制作过程中源皮肤发生变化，已停止输出")
    changes = changed_pixels(source, candidate)
    faces = face_data(candidate, model)
    touched = [surface["face"] for surface in (plan_template or {}).get("surfaces", [])]
    priority = [surface["face"] for surface in eye["surfaces"]] if eye else []
    review_faces = list(dict.fromkeys(priority + touched))
    # 直到所有计划、配色、来源和最终像素检查通过，才创建新的输出目录。
    output = new_output_path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    new_output_path(output)
    output.mkdir(exist_ok=False)
    write_png(output / "skin.png", candidate)
    with Image.open(output / "skin.png") as reopened:
        readback = (reopened.format == "PNG" and reopened.mode == "RGBA"
                    and reopened.size == (64, 64) and reopened.tobytes() == candidate.tobytes())
    if not readback or (source_path and file_hash(source_path) != source_hash):
        raise RuntimeError("PNG 回读或源文件保持校验失败")
    draw_board([{"label": face, "image": candidate, "model": model, "face": face}
                for face in review_faces], "皮肤候选 · 像素分层", "基础层 / 外层 / 同坐标叠加；每格为原生 PNG 的一个像素。", output / "layers.png")
    with (output / "preview.html").open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(preview_page(output / "skin.png", model))
    if source_path and file_hash(source_path) != source_hash:
        raise RuntimeError("生成审阅文件期间源皮肤发生变化，候选未验收")
    manifest = {"schema_version": 1, "status": "candidate", "purpose": "review", "model": model,
                "source": str(source_path) if source_path else None, "source_sha256": source_hash,
                "source_unchanged": file_hash(source_path) == source_hash if source_path else True,
                "template": template_record, "eye_preserve": preserve, "exceptions": exceptions,
                "provenance": request.get("provenance", {}), "plan": request["plan"],
                "faces": faces, "review_faces": review_faces,
                "pixel_sha256": pixel_hash(candidate), "output_sha256": file_hash(output / "skin.png"),
                "changed_pixels": changes, "unchanged_pixels": 4096 - len(changes),
                "png_readback_verified": readback, "validation": validation,
                "renderer": "skinview3d 3.4.2", "browser_preview_verified": False,
                "game_runtime_verified": False, "files": FILES}
    write_json(output / "manifest.json", manifest)
    return {"files": FILES, "validation": validation, "model": model, "changed": len(changes),
            "png_readback_verified": readback, "game_runtime_verified": False}


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError("命令参数无效：" + message)


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = JsonArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("environment")
    probe = commands.add_parser("probe")
    probe.add_argument("--source", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("--source", required=True)
    inspect.add_argument("--model", choices=("slim", "classic"), required=True)
    make = commands.add_parser("render")
    make.add_argument("--request", required=True)
    make.add_argument("--output", required=True)
    try:
        args = parser.parse_args()
        if args.command == "environment":
            result = environment()
        elif args.command == "probe":
            _, result = decoded_image(args.source)
        elif args.command == "inspect":
            result = inspect_skin(args.source, args.model)
        else:
            result = render(args.request, args.output)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"error": "皮肤工具执行失败：" + str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
