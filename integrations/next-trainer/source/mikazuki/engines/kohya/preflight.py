from .extension_state import read_status
from .environment import audit_environment


def check_runtime(runtime):
    status = read_status(runtime)
    if status["state"] != "ready":
        raise ValueError("kohya (sd-scripts) 环境未就绪。请在工作台“LoRA 训练 → 接入配置 → 准备训练环境”核对兼容 Next Trainer 安装和 Kohya Python，完成后重新检查；启动内核不会安装训练环境。")
    audit = audit_environment(runtime)
    if not audit["ok"]:
        raise ValueError("kohya 环境检查失败: " + "; ".join(audit["errors"]))
