"""Local YOLOX / DWPose inference and conservative training crop geometry.

Coordinate decoding follows the published YOLOX and SimCC model interfaces;
no installed ComfyUI code is imported or executed by this adapter.
"""
import math


def inference_image(image):
    """Use a predictable white background for inference, retaining crop alpha."""
    if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
        from PIL import Image
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")
    return image.convert("RGB")


def crop_regions(size, people, mode):
    width, height = size
    if mode == "preserve":
        return [], []
    credible = [person for person in people if person.get("score", 0) >= 0.4]
    if not credible:
        return [], ["未可靠识别主体，保留全图"]
    if mode == "character" and len(credible) > 1:
        return [], ["存在多个主体，未自动选择角色，保留全图复核"]
    regions, warnings = [], []

    def region(box, kind, margin=0.08):
        if len(box) != 4 or not all(math.isfinite(float(v)) for v in box):
            return
        left, top, right, bottom = box
        if right <= left or bottom <= top:
            return
        pad_x, pad_y = (right - left) * margin, (bottom - top) * margin
        box = [max(0, math.floor(left - pad_x)), max(0, math.floor(top - pad_y)), min(width, math.ceil(right + pad_x)), min(height, math.ceil(bottom + pad_y))]
        if min(box[2] - box[0], box[3] - box[1]) < 96:
            return
        if (box[2] - box[0]) * (box[3] - box[1]) > width * height * 0.97:
            return
        regions.append({"box": box, "kind": kind})

    if mode == "pose":
        all_boxes = []
        for person in credible:
            points = person.get("keypoints", [])
            # The first 17 joints use COCO body order. Preserve wrists and ankles
            # rather than inventing coordinates for occluded / out-of-frame limbs.
            if len(points) < 17 or any(points[i][2] < 0.4 for i in (9, 10, 15, 16)) or sum(p[2] >= 0.4 for p in points[:17]) < 10:
                return [], ["手足或身体关节置信度不足，保留全图复核"]
            valid = [p for p in points if p[2] >= 0.4 and math.isfinite(p[0]) and math.isfinite(p[1])]
            if any(x < 0 or y < 0 or x > width or y > height for x, y, _ in valid):
                return [], ["关键点越出原图，保留全图复核"]
            x1, y1, x2, y2 = person["box"]
            all_boxes.append([min([x1] + [p[0] for p in valid]), min([y1] + [p[1] for p in valid]), max([x2] + [p[0] for p in valid]), max([y2] + [p[1] for p in valid])])
        region([min(b[0] for b in all_boxes), min(b[1] for b in all_boxes), max(b[2] for b in all_boxes), max(b[3] for b in all_boxes)], "pose", 0.04)
    elif mode == "character":
        person = credible[0]
        region(person["box"], "subject", 0.08)
        points = person.get("keypoints", [])
        face = [p for p in points[:5] if p[2] >= 0.5]
        if len(face) >= 3:
            left, right = min(p[0] for p in face), max(p[0] for p in face)
            center_x, center_y = (left + right) / 2, sum(p[1] for p in face) / len(face)
            span = max(right - left, (person["box"][2] - person["box"][0]) * 0.16)
            region([center_x - span * 1.1, center_y - span * 1.4, center_x + span * 1.1, center_y + span * 1.3], "portrait", 0)
        else:
            warnings.append("面部置信度不足，未生成人脸特写")
    return regions, warnings


class DWPoseDetector:
    def __init__(self, directory):
        from pathlib import Path
        import onnxruntime as ort
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        # CPU keeps preprocessing independent of a user's active GPU workloads.
        self.detector = ort.InferenceSession(str(Path(directory) / "yolox_l.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
        self.pose = ort.InferenceSession(str(Path(directory) / "dw-ll_ucoco_384.onnx"), sess_options=options, providers=["CPUExecutionProvider"])

    def detect(self, image):
        import cv2
        import numpy as np
        rgb = np.asarray(image.convert("RGB"))
        # These exported DWPose models consume the same BGR array as their
        # reference runtime. The detector uses unnormalized float input.
        frame = rgb[:, :, ::-1].copy()
        height, width = frame.shape[:2]
        shape = self.detector.get_inputs()[0].shape
        target_h, target_w = int(shape[2]), int(shape[3])
        ratio = min(target_h / height, target_w / width)
        padded = np.full((target_h, target_w, 3), 114, dtype=np.uint8)
        resized = cv2.resize(frame, (max(1, int(width * ratio)), max(1, int(height * ratio))))
        padded[:resized.shape[0], :resized.shape[1]] = resized
        tensor = padded.transpose(2, 0, 1)[None].astype(np.float32)
        prediction = self.detector.run(None, {self.detector.get_inputs()[0].name: tensor})[0][0].copy()
        grids, strides = [], []
        for stride in (8, 16, 32):
            y, x = np.meshgrid(np.arange(target_h // stride), np.arange(target_w // stride), indexing="ij")
            grids.append(np.stack([x, y], axis=-1).reshape(-1, 2))
            strides.append(np.full((x.size, 1), stride))
        grid, step = np.concatenate(grids), np.concatenate(strides)
        if prediction.shape[0] != grid.shape[0] or prediction.shape[1] < 6:
            raise ValueError("主体检测模型的输出格式与 YOLOX 不符。")
        centers = (prediction[:, :2] + grid) * step
        sizes = np.exp(np.clip(prediction[:, 2:4], -20, 20)) * step
        boxes = np.concatenate([centers - sizes / 2, centers + sizes / 2], axis=1) / ratio
        scores = prediction[:, 4] * prediction[:, 5]
        indices = np.flatnonzero(scores >= 0.4)
        kept = []
        for index in indices[np.argsort(scores[indices])[::-1]]:
            box = boxes[index]
            if not np.isfinite(box).all() or box[2] <= box[0] or box[3] <= box[1]:
                continue
            if any(self._overlap(box, boxes[other]) > 0.45 for other in kept):
                continue
            kept.append(int(index))
            if len(kept) >= 8:
                break
        result = []
        pose_shape = self.pose.get_inputs()[0].shape
        input_h, input_w = int(pose_shape[2]), int(pose_shape[3])
        for index in kept:
            box = boxes[index].copy()
            box[[0, 2]] = np.clip(box[[0, 2]], 0, width)
            box[[1, 3]] = np.clip(box[[1, 3]], 0, height)
            center = (box[:2] + box[2:]) / 2
            scale = (box[2:] - box[:2]) * 1.25
            aspect = input_w / input_h
            if scale[0] > scale[1] * aspect:
                scale[1] = scale[0] / aspect
            else:
                scale[0] = scale[1] * aspect
            if min(scale) < 1:
                continue
            factors = np.array([input_w, input_h]) / scale
            transform = np.array([[factors[0], 0, input_w / 2 - center[0] * factors[0]], [0, factors[1], input_h / 2 - center[1] * factors[1]]], dtype=np.float32)
            crop = cv2.warpAffine(frame, transform, (input_w, input_h))
            crop = ((crop.astype(np.float32) - np.array([123.675, 116.28, 103.53])) / np.array([58.395, 57.12, 57.375])).transpose(2, 0, 1)[None].astype(np.float32)
            outputs = self.pose.run(None, {self.pose.get_inputs()[0].name: crop})
            if len(outputs) != 2:
                raise ValueError("关键点模型没有返回 SimCC 坐标。")
            x, y = outputs
            coordinates = np.stack([x.argmax(axis=-1), y.argmax(axis=-1)], axis=-1)[0].astype(float) / 2
            confidence = np.minimum(x.max(axis=-1), y.max(axis=-1))[0]
            coordinates = coordinates / np.array([input_w, input_h]) * scale + center - scale / 2
            points = [[round(float(a), 3), round(float(b), 3), round(float(c), 4)] for (a, b), c in zip(coordinates, confidence)]
            result.append({"box": [round(float(v), 3) for v in box], "score": float(scores[index]), "keypoints": points})
        return result

    @staticmethod
    def _overlap(a, b):
        intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
        union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
        return intersection / max(union, 1)
