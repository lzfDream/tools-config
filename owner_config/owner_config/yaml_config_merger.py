from __future__ import annotations

import configparser
import json
import logging
import re
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


LOGGER = logging.getLogger("owner_config.yaml_merge")

YAML_SUFFIXES = {".yaml", ".yml"}
JSON_SUFFIXES = {".json"}
INI_SUFFIXES = {".ini"}
VARIABLE_PATTERN = re.compile(r"@\{([A-Za-z_][A-Za-z0-9_]*)\}")
SCALAR_TYPES = (str, int, float, bool)
TEXT_FALLBACK_ENCODINGS = ("utf-8", "utf-8-sig", "gb18030")


class QuotedString(str):
    pass


@dataclass(frozen=True)
class YamlBool:
    value: bool


class OwnerConfigYamlDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False) -> Any:
        return super().increase_indent(flow=flow, indentless=False)


def represent_quoted_string(dumper: OwnerConfigYamlDumper, data: QuotedString) -> yaml.ScalarNode:
    return dumper.represent_scalar("tag:yaml.org,2002:str", str(data), style='"')


def represent_yaml_bool(dumper: OwnerConfigYamlDumper, data: YamlBool) -> yaml.ScalarNode:
    return dumper.represent_scalar("tag:yaml.org,2002:bool", "True" if data.value else "False")


OwnerConfigYamlDumper.add_representer(QuotedString, represent_quoted_string)
OwnerConfigYamlDumper.add_representer(YamlBool, represent_yaml_bool)


def merge_yaml_file(
    baseline_path: Path,
    local_path: Path,
    output_path: Path,
    variables: dict[str, str | int | float | bool],
) -> None:
    baseline_config = load_yaml_file(baseline_path)
    local_config = resolve_variables(load_yaml_file(local_path), variables)
    merged_config = merge_yaml_value(baseline_config, local_config, path=())
    rendered_yaml = yaml.dump(
        prepare_yaml_output(merged_config),
        Dumper=OwnerConfigYamlDumper,
        default_flow_style=False,
        allow_unicode=True,
        sort_keys=False,
    )
    if isinstance(merged_config, dict):
        rendered_yaml = add_blank_lines_between_top_level_keys(rendered_yaml)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        rendered_yaml,
        encoding="utf-8",
        newline="\n",
    )


def merge_json_file(
    baseline_path: Path,
    local_path: Path,
    output_path: Path,
    variables: dict[str, str | int | float | bool],
) -> None:
    baseline_config = load_json_file(baseline_path)
    local_config = resolve_variables(load_json_file(local_path), variables)
    merged_config = merge_structured_value(baseline_config, local_config, path=())

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(merged_config, ensure_ascii=False, indent=4) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def merge_ini_file(
    baseline_path: Path,
    local_path: Path,
    output_path: Path,
    variables: dict[str, str | int | float | bool],
) -> None:
    baseline_config, baseline_encoding = load_ini_file(baseline_path)
    local_config, _ = load_ini_file(local_path)
    local_config = resolve_ini_variables(local_config, variables)
    merged_config = merge_structured_value(baseline_config, local_config, path=())

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(render_ini_file(merged_config).encode(baseline_encoding))


def load_yaml_file(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def load_json_file(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_ini_file(path: Path) -> tuple[dict[str, dict[str, str | None]], str]:
    parser = configparser.ConfigParser(comment_prefixes=(";", "#", "//"), allow_no_value=True)
    parser.optionxform = str
    text, encoding = read_text_with_fallback(path)
    parser.read_string(text)

    config: dict[str, dict[str, str | None]] = {}
    if parser.defaults():
        config[parser.default_section] = dict(parser.defaults())
    for section in parser.sections():
        config[section] = dict(parser.items(section, raw=True))
    return config, encoding


def load_variables(owner_root: Path) -> dict[str, str | int | float | bool]:
    variables_path = owner_root / "data" / "variables.yaml"
    if not variables_path.exists():
        return {}

    raw = load_yaml_file(variables_path)
    if not isinstance(raw, dict):
        raise ValueError(f"variables file must be a mapping: {variables_path}")

    variables: dict[str, str | int | float | bool] = {}
    for key, value in raw.items():
        if not isinstance(key, str):
            raise ValueError(f"variable name must be string: {key!r}")
        if not is_scalar_variable(value):
            raise ValueError(f"variable {key} must be a scalar value")
        variables[key] = value
    return variables


def read_text_with_fallback(path: Path) -> tuple[str, str]:
    raw = path.read_bytes()
    for encoding in TEXT_FALLBACK_ENCODINGS:
        try:
            return raw.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError("utf-8", raw, 0, len(raw), f"unable to decode {path}")


def resolve_variables(value: Any, variables: dict[str, str | int | float | bool]) -> Any:
    if isinstance(value, dict):
        return {key: resolve_variables(item, variables) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve_variables(item, variables) for item in value]
    if isinstance(value, str):
        return resolve_string_variables(value, variables)
    return value


def resolve_ini_variables(
    value: dict[str, dict[str, str | None]],
    variables: dict[str, str | int | float | bool],
) -> dict[str, dict[str, str | None]]:
    resolved: dict[str, dict[str, str | None]] = {}
    for section, items in value.items():
        resolved[section] = {}
        for key, item in items.items():
            if item is None:
                resolved[section][key] = None
                continue
            resolved[section][key] = str(resolve_string_variables(item, variables))
    return resolved


def resolve_string_variables(
    value: str,
    variables: dict[str, str | int | float | bool],
) -> str | int | float | bool:
    match = VARIABLE_PATTERN.fullmatch(value)
    if match:
        return lookup_variable(match.group(1), variables)

    return VARIABLE_PATTERN.sub(
        lambda item: str(lookup_variable(item.group(1), variables)),
        value,
    )


def lookup_variable(name: str, variables: dict[str, str | int | float | bool]) -> str | int | float | bool:
    if name not in variables:
        raise ValueError(f"undefined variable: {name}")
    return variables[name]


def is_scalar_variable(value: Any) -> bool:
    return value is not None and isinstance(value, SCALAR_TYPES)


def merge_structured_value(baseline: Any, local: Any, path: tuple[str | int, ...]) -> Any:
    if local is None:
        if baseline is None:
            return None
        raise ValueError(f"null value at {format_path(path)}")

    if type(local) is not type(baseline):
        raise ValueError(
            f"type mismatch at {format_path(path)}: "
            f"expected {type(baseline).__name__}, got {type(local).__name__}"
        )

    if isinstance(local, dict):
        merged = deepcopy(baseline)
        for key, value in local.items():
            if key not in baseline:
                raise ValueError(f"unknown key at {format_path(path + (key,))}")
            merged[key] = merge_structured_value(baseline[key], value, path + (key,))
        return merged

    if isinstance(local, list):
        merged = deepcopy(baseline)
        for index, value in enumerate(local):
            if index >= len(baseline):
                raise ValueError(f"list index out of range at {format_path(path + (index,))}")
            merged[index] = merge_structured_value(baseline[index], value, path + (index,))
        return merged

    if baseline != local:
        LOGGER.debug("override %s: %r -> %r", format_path(path), baseline, local)
    return local


def merge_yaml_value(baseline: Any, local: Any, path: tuple[str | int, ...]) -> Any:
    return merge_structured_value(baseline, local, path)


def prepare_yaml_output(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: prepare_yaml_output(item) for key, item in value.items()}
    if isinstance(value, list):
        return [prepare_yaml_output(item) for item in value]
    if isinstance(value, str):
        return QuotedString(value)
    if isinstance(value, bool):
        return YamlBool(value)
    return value


def add_blank_lines_between_top_level_keys(rendered_yaml: str) -> str:
    lines = rendered_yaml.splitlines()
    if not lines:
        return rendered_yaml

    formatted_lines: list[str] = []
    for index, line in enumerate(lines):
        is_top_level_key = bool(line) and not line.startswith((" ", "-"))
        if index > 0 and is_top_level_key and formatted_lines[-1] != "":
            formatted_lines.append("")
        formatted_lines.append(line)
    return "\n".join(formatted_lines) + "\n"


def render_ini_file(config: dict[str, dict[str, str | None]]) -> str:
    sections: list[str] = []
    for section, items in config.items():
        lines = [f"[{section}]"]
        for key, value in items.items():
            if value is None:
                lines.append(key)
            else:
                lines.append(f"{key}={value}")
        sections.append("\n".join(lines))
    return "\n\n".join(sections) + "\n"


def is_yaml_file(path: Path) -> bool:
    return path.suffix.lower() in YAML_SUFFIXES


def is_json_file(path: Path) -> bool:
    return path.suffix.lower() in JSON_SUFFIXES


def is_ini_file(path: Path) -> bool:
    return path.suffix.lower() in INI_SUFFIXES


def format_path(path: tuple[str | int, ...]) -> str:
    if not path:
        return "<root>"
    return ".".join(str(part) for part in path)
