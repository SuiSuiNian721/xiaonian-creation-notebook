"""Shared normalization for network_args / optimizer_args style lists."""

from __future__ import annotations


def normalize_kv_arg_list(values) -> list[str]:
    """Normalize key=value style arg list from UI payload."""
    if not isinstance(values, list):
        return []

    ordered: list[str] = []
    key_index: dict[str, int] = {}
    for raw in values:
        if not isinstance(raw, str):
            continue
        item = raw.strip()
        if not item or "=" not in item:
            continue
        key, value = item.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if value.lower() in {"undefined", "null", "nan"}:
            continue
        normalized = f"{key}={value}"
        if key in key_index:
            ordered[key_index[key]] = normalized
        else:
            key_index[key] = len(ordered)
            ordered.append(normalized)
    return ordered


def normalize_custom_args(config: dict) -> None:
    """Merge *_custom tables into canonical arg lists and drop invalid entries."""
    for base_key in ("network_args", "optimizer_args"):
        custom_key = f"{base_key}_custom"
        merged: list[str] = []
        if isinstance(config.get(base_key), list):
            merged.extend(config.get(base_key) or [])
        if isinstance(config.get(custom_key), list):
            merged.extend(config.get(custom_key) or [])

        normalized = normalize_kv_arg_list(merged)
        if normalized:
            config[base_key] = normalized
        else:
            config.pop(base_key, None)
        config.pop(custom_key, None)
