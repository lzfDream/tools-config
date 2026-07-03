from __future__ import annotations

import argparse
import logging
import shutil
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import yaml

from owner_config.yaml_config_merger import (
    is_ini_file,
    is_json_file,
    is_yaml_file,
    load_variables,
    merge_ini_file,
    merge_json_file,
    merge_yaml_file,
)


LOGGER = logging.getLogger("owner_config")
ENV_DEFAULTS = {
    "APP_ENV": "dev",
}
LOCK_FILE_NAME = "apply.lock"


@dataclass(frozen=True)
class ProjectConfig:
    name: str
    conf_dir: Path
    files: tuple[str, ...]


def load_projects(config_path: Path) -> list[ProjectConfig]:
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    projects: list[ProjectConfig] = []
    project_names: set[str] = set()
    for project in raw.get("projects", []):
        name = project["name"]
        if name in project_names:
            raise ValueError(f"duplicate project name: {name}")
        project_names.add(name)
        projects.append(
            ProjectConfig(
                name=name,
                conf_dir=Path(project["conf_dir"]),
                files=tuple(project["files"]),
            )
        )
    return projects


def sync_configs(
    owner_root: Path,
    projects: list[ProjectConfig],
    project_filter: str | None = None,
) -> None:
    copied: list[str] = []
    code_root = resolve_code_root(owner_root)
    for project, file_name in iter_managed_files(projects, project_filter):
        target_file = resolve_target_file(code_root, project, file_name)
        baseline_file = baseline_root(owner_root, project) / file_name
        ensure_exists(target_file, "sync source file")
        copy_file(target_file, baseline_file)
        copied.append(f"{project.name}/{file_name}")
        LOGGER.info("synced %s", copied[-1])
    write_sync_meta(owner_root, copied)


def build_data_layout(owner_root: Path, projects: list[ProjectConfig]) -> None:
    ensure_variables_file(owner_root)
    ensure_env_file(owner_root)

    project_names = {project.name for project in projects}
    baseline_dir = owner_root / "data" / "baseline"
    local_dir = owner_root / "data" / "local"

    sync_project_dirs(baseline_dir, project_names)
    sync_project_dirs(local_dir, project_names)

    for project in projects:
        ensure_placeholder_files(baseline_dir / project.name, project.files)
        ensure_placeholder_files(local_dir / project.name, project.files)


def apply_configs(
    owner_root: Path,
    projects: list[ProjectConfig],
    project_filter: str | None = None,
) -> None:
    code_root = resolve_code_root(owner_root)
    app_env = load_app_env(owner_root)
    variables = load_variables(owner_root)
    for project, file_name in iter_managed_files(projects, project_filter):
        baseline_file = baseline_root(owner_root, project) / file_name
        local_file = local_root(owner_root, project, app_env) / file_name
        target_file = resolve_target_file(code_root, project, file_name)

        ensure_exists(baseline_file, "baseline file")
        if local_file.exists():
            if is_yaml_file(target_file):
                merge_yaml_file(baseline_file, local_file, target_file, variables)
            elif is_json_file(target_file):
                merge_json_file(baseline_file, local_file, target_file, variables)
            elif is_ini_file(target_file):
                merge_ini_file(baseline_file, local_file, target_file, variables)
            else:
                copy_file(local_file, target_file)
        else:
            copy_file(baseline_file, target_file)
        LOGGER.info("applied file %s/%s", project.name, file_name)
    write_apply_lock(owner_root)


def restore_configs(
    owner_root: Path,
    projects: list[ProjectConfig],
    project_filter: str | None = None,
) -> None:
    code_root = resolve_code_root(owner_root)
    for project, file_name in iter_managed_files(projects, project_filter):
        baseline_file = baseline_root(owner_root, project) / file_name
        target_file = resolve_target_file(code_root, project, file_name)
        ensure_exists(baseline_file, "baseline file")
        copy_file(baseline_file, target_file)
        LOGGER.info("restored %s/%s", project.name, file_name)
    remove_apply_lock(owner_root)


def list_configs(projects: list[ProjectConfig]) -> str:
    lines: list[str] = []
    for project in projects:
        lines.append(f"{project.name} -> {project.conf_dir}")
        for file_name in project.files:
            lines.append(f"  {file_name}")
    return "\n".join(lines)


def config_state(owner_root: Path) -> str:
    if lock_file_path(owner_root).exists():
        return "applied"
    return "baseline"


def iter_managed_files(
    projects: list[ProjectConfig],
    project_filter: str | None,
):
    matched_project = False
    for project in projects:
        if project_filter and project.name != project_filter:
            continue
        matched_project = True
        for file_name in project.files:
            yield project, file_name

    if project_filter and not matched_project:
        raise ValueError(f"unknown project: {project_filter}")


def baseline_root(owner_root: Path, project: ProjectConfig) -> Path:
    return owner_root / "data" / "baseline" / project.name


def local_root(owner_root: Path, project: ProjectConfig, app_env: str = "dev") -> Path:
    if app_env == "dev":
        return owner_root / "data" / "local" / project.name
    return owner_root / "data" / "local" / project.name / app_env


def load_app_env(owner_root: Path) -> str:
    env_path = owner_root / ".env"
    if not env_path.exists():
        raise FileNotFoundError(f".env file not found: {env_path}")

    config = parse_env_lines(env_path.read_text(encoding="utf-8").splitlines())
    return config.get("APP_ENV", ENV_DEFAULTS["APP_ENV"]) or ENV_DEFAULTS["APP_ENV"]


def resolve_code_root(owner_root: Path) -> Path:
    return owner_root.parent


def resolve_target_dir(code_root: Path, project: ProjectConfig) -> Path:
    base_dir = code_root / project.conf_dir
    conf_dir = base_dir / "conf"
    if conf_dir.is_dir():
        return conf_dir
    return base_dir


def resolve_target_file(code_root: Path, project: ProjectConfig, file_name: str) -> Path:
    return resolve_target_dir(code_root, project) / file_name


def lock_file_path(owner_root: Path) -> Path:
    return owner_root / "state" / LOCK_FILE_NAME


def ensure_command_allowed(owner_root: Path, command: str) -> None:
    if command in {"ls", "re", "apply"}:
        return
    lock_path = lock_file_path(owner_root)
    if lock_path.exists():
        raise RuntimeError(f"config state is locked, run `cfg re` first: {lock_path}")


def ensure_exists(path: Path, label: str) -> None:
    if not path.exists():
        raise FileNotFoundError(f"{label} not found: {path}")


def copy_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def ensure_variables_file(owner_root: Path) -> None:
    variables_path = owner_root / "data" / "variables.yaml"
    if variables_path.exists():
        return
    variables_path.parent.mkdir(parents=True, exist_ok=True)
    variables_path.write_text("{}\n", encoding="utf-8", newline="\n")


def ensure_env_file(owner_root: Path) -> None:
    env_path = owner_root / ".env"
    if not env_path.exists():
        env_path.write_text(render_env_lines(ENV_DEFAULTS), encoding="utf-8", newline="\n")
        return

    lines = env_path.read_text(encoding="utf-8").splitlines()
    config = parse_env_lines(lines)
    missing_items = {key: value for key, value in ENV_DEFAULTS.items() if key not in config}
    if not missing_items:
        return

    merged_lines = lines + [f"{key}={value}" for key, value in missing_items.items()]
    env_path.write_text("\n".join(merged_lines) + "\n", encoding="utf-8", newline="\n")


def write_apply_lock(owner_root: Path) -> None:
    lock_path = lock_file_path(owner_root)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text(
        f"locked_at={datetime.now(UTC).isoformat()}\n",
        encoding="utf-8",
        newline="\n",
    )


def remove_apply_lock(owner_root: Path) -> None:
    lock_path = lock_file_path(owner_root)
    if lock_path.exists():
        lock_path.unlink()


def render_env_lines(values: dict[str, str]) -> str:
    return "".join(f"{key}={value}\n" for key, value in values.items())


def parse_env_lines(lines: list[str]) -> dict[str, str]:
    config: dict[str, str] = {}
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        config[key.strip()] = value.strip()
    return config


def sync_project_dirs(root: Path, project_names: set[str]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for project_name in project_names:
        (root / project_name).mkdir(parents=True, exist_ok=True)

    for child in root.iterdir():
        if child.is_dir() and child.name not in project_names:
            shutil.rmtree(child)


def ensure_placeholder_files(root: Path, file_names: tuple[str, ...]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for file_name in file_names:
        file_path = root / file_name
        if file_path.exists():
            continue
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text("", encoding="utf-8", newline="\n")


def write_sync_meta(owner_root: Path, copied: list[str]) -> None:
    meta_path = owner_root / "state" / "sync-meta.yaml"
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta = {
        "synced_at": datetime.now(UTC).isoformat(),
        "files": copied,
    }
    meta_path.write_text(
        yaml.safe_dump(meta, default_flow_style=False, allow_unicode=True),
        encoding="utf-8",
        newline="\n",
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Manage local configs across projects.")
    parser.add_argument("command", nargs="?", choices=["ls", "sync", "apply", "re", "build"], default="apply")
    parser.add_argument("--project", dest="project_name", help="Project name, for example: entry")
    parser.add_argument(
        "--owner-root",
        help="Owner config root. Defaults to the parent directory of this script.",
    )
    return parser.parse_args(argv)


def resolve_owner_root(arg_root: str | None) -> Path:
    if arg_root:
        return Path(arg_root).resolve()
    return Path(__file__).resolve().parent.parent


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")


def main() -> int:
    configure_logging()
    args = parse_args(sys.argv[1:])
    owner_root = resolve_owner_root(args.owner_root)
    ensure_command_allowed(owner_root, args.command)
    projects = load_projects(owner_root / "config" / "projects.yaml")

    if args.command == "ls":
        print(f"state: {config_state(owner_root)}")
        print(list_configs(projects))
        return 0
    if args.command == "sync":
        sync_configs(owner_root, projects, args.project_name)
        return 0
    if args.command == "build":
        build_data_layout(owner_root, projects)
        return 0
    if args.command == "apply":
        apply_configs(owner_root, projects, args.project_name)
        return 0
    restore_configs(owner_root, projects, args.project_name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
