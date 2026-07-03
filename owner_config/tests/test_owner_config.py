import json
from pathlib import Path

import pytest
import yaml

from owner_config.cli import (
    apply_configs,
    build_data_layout,
    list_configs,
    load_projects,
    main,
    parse_args,
    resolve_code_root,
    resolve_target_file,
    restore_configs,
    sync_configs,
)
from owner_config.yaml_config_merger import merge_ini_file


@pytest.fixture
def project_env(tmp_path: Path) -> dict[str, Path]:
    code_root = tmp_path / "code"
    target_root = code_root / "se" / "sdk"
    owner_root = code_root / "owner_config"
    target_root.mkdir(parents=True)
    owner_root.mkdir(parents=True)

    write_yaml(
        target_root / "entry" / "conf" / "dev.yaml",
        {
            "server": {
                "workers": 4,
                "host": "127.0.0.1",
                "port": 3306,
                "debug": False,
            },
            "logging": {"std": {"log_level": "INFO"}},
            "database": {"dsn": "mysql://127.0.0.1:3306/entry"},
            "pipelines": [
                {"name": "api", "enabled": True},
                {"name": "worker", "enabled": False},
            ],
        },
    )
    write_yaml(
        target_root / "entry" / "conf" / "uvicorn.log.yaml",
        {
            "root": {"level": "INFO"},
            "handlers": {"console_error": {"level": "INFO"}},
        },
    )
    write_text(
        target_root / "entry" / "conf" / "app.ini",
        "[app]\nmode=default\n",
    )
    write_json(
        target_root / "entry" / "conf" / "feature.json",
        {
            "feature": {
                "enabled": False,
                "host": "127.0.0.1",
                "port": 8080,
            },
            "url": "http://127.0.0.1:8080/api",
            "pipelines": [
                {"name": "api", "enabled": True},
                {"name": "worker", "enabled": False},
            ],
        },
    )

    write_yaml(
        owner_root / "config" / "projects.yaml",
        {
            "projects": [
                {
                    "name": "entry",
                    "conf_dir": "se/sdk/entry",
                    "files": [
                        "dev.yaml",
                        "uvicorn.log.yaml",
                        "app.ini",
                        "feature.json",
                    ],
                }
            ]
        },
    )
    write_text(owner_root / ".env", "APP_ENV=dev\n")

    return {
        "code_root": code_root,
        "owner_root": owner_root,
        "target_root": target_root,
    }


def test_sync_copies_managed_files_into_baseline(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")

    sync_configs(owner_root, projects)

    baseline_dev = owner_root / "data" / "baseline" / "entry" / "dev.yaml"
    baseline_ini = owner_root / "data" / "baseline" / "entry" / "app.ini"

    assert yaml.safe_load(baseline_dev.read_text(encoding="utf-8")) == {
        "server": {
            "workers": 4,
            "host": "127.0.0.1",
            "port": 3306,
            "debug": False,
        },
        "logging": {"std": {"log_level": "INFO"}},
        "database": {"dsn": "mysql://127.0.0.1:3306/entry"},
        "pipelines": [
            {"name": "api", "enabled": True},
            {"name": "worker", "enabled": False},
        ],
    }
    assert baseline_ini.read_text(encoding="utf-8") == "[app]\nmode=default\n"


def test_apply_merges_yaml_and_overwrites_non_yaml(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    target_root = project_env["target_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)
    write_yaml(
        owner_root / "data" / "variables.yaml",
        {
            "MYSQL_HOST": "db.internal",
            "MYSQL_PORT": 3307,
            "DEBUG_ENABLED": True,
        },
    )

    write_yaml(
        owner_root / "data" / "local" / "entry" / "dev.yaml",
        {
            "server": {
                "workers": 1,
                "host": "@{MYSQL_HOST}",
                "port": "@{MYSQL_PORT}",
                "debug": "@{DEBUG_ENABLED}",
            },
            "database": {"dsn": "mysql://@{MYSQL_HOST}:@{MYSQL_PORT}/entry"},
            "pipelines": [{"enabled": False}],
        },
    )
    write_text(
        owner_root / "data" / "local" / "entry" / "app.ini",
        "[app]\nmode=local\n",
    )

    apply_configs(owner_root, projects)

    merged = yaml.safe_load((target_root / "entry" / "conf" / "dev.yaml").read_text(encoding="utf-8"))
    assert merged == {
        "server": {
            "workers": 1,
            "host": "db.internal",
            "port": 3307,
            "debug": True,
        },
        "logging": {"std": {"log_level": "INFO"}},
        "database": {"dsn": "mysql://db.internal:3307/entry"},
        "pipelines": [
            {"name": "api", "enabled": False},
            {"name": "worker", "enabled": False},
        ],
    }
    assert (target_root / "entry" / "conf" / "app.ini").read_text(encoding="utf-8") == "[app]\nmode=local\n"


def test_apply_merges_ini_and_preserves_untouched_keys(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    target_root = project_env["target_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    write_text(
        target_root / "entry" / "conf" / "app.ini",
        "[app]\nmode=default\nenabled=true\n\n[worker]\nqueue=default\n",
    )
    sync_configs(owner_root, projects)
    write_text(
        owner_root / "data" / "local" / "entry" / "app.ini",
        "[app]\nmode=local\n",
    )

    apply_configs(owner_root, projects)

    assert (target_root / "entry" / "conf" / "app.ini").read_text(encoding="utf-8") == (
        "[app]\nmode=local\nenabled=true\n\n[worker]\nqueue=default\n"
    )


def test_apply_rejects_unknown_ini_key(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)
    write_text(
        owner_root / "data" / "local" / "entry" / "app.ini",
        "[app]\nunknown=value\n",
    )

    with pytest.raises(ValueError, match="unknown key"):
        apply_configs(owner_root, projects)


def test_merge_ini_file_supports_non_utf8_baseline(tmp_path: Path) -> None:
    baseline_path = tmp_path / "baseline.ini"
    local_path = tmp_path / "local.ini"
    output_path = tmp_path / "output.ini"

    baseline_text = "[App]\r\n// 项目名称\r\nName=默认\r\nEnabled=True\r\n\r\n[Module]\r\na.dll\r\nb.dll\r\n"
    baseline_path.write_bytes(baseline_text.encode("gb18030"))
    local_path.write_text("[App]\nName=本地\n", encoding="utf-8", newline="\n")

    merge_ini_file(baseline_path, local_path, output_path, {})

    merged_text = output_path.read_bytes().decode("gb18030")
    assert "Name=本地" in merged_text
    assert "Enabled=True" in merged_text
    assert "a.dll" in merged_text
    assert "b.dll" in merged_text


def test_apply_preserves_yaml_key_order_from_baseline(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    target_root = project_env["target_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")

    write_text(
        target_root / "entry" / "conf" / "dev.yaml",
        "server:\n"
        "  workers: 4\n"
        "logging:\n"
        "  std:\n"
        "    log_level: INFO\n"
        "database:\n"
        "  dsn: mysql://127.0.0.1:3306/entry\n"
        "pipelines:\n"
        "  - name: api\n"
        "    enabled: true\n"
        "  - name: worker\n"
        "    enabled: false\n",
    )
    sync_configs(owner_root, projects)
    write_yaml(
        owner_root / "data" / "local" / "entry" / "dev.yaml",
        {"server": {"workers": 1}},
    )

    apply_configs(owner_root, projects)

    merged_text = (target_root / "entry" / "conf" / "dev.yaml").read_text(encoding="utf-8")
    assert merged_text.index("server:") < merged_text.index("logging:")
    assert merged_text.index("logging:") < merged_text.index("database:")
    assert merged_text.index("database:") < merged_text.index("pipelines:")
    assert "\n\nlogging:\n" in merged_text
    assert "\n\ndatabase:\n" in merged_text
    assert "\n\npipelines:\n" in merged_text
    assert '\npipelines:\n  - name: "api"\n' in merged_text


def test_apply_formats_yaml_strings_and_bools(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    target_root = project_env["target_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)
    write_yaml(
        owner_root / "data" / "local" / "entry" / "dev.yaml",
        {
            "server": {
                "host": "http://db.internal:3306",
                "debug": True,
            },
            "database": {"dsn": "mysql://db.internal:3306/entry"},
        },
    )

    apply_configs(owner_root, projects)

    merged_text = (target_root / "entry" / "conf" / "dev.yaml").read_text(encoding="utf-8")
    assert 'host: "http://db.internal:3306"' in merged_text
    assert 'debug: True' in merged_text
    assert 'dsn: "mysql://db.internal:3306/entry"' in merged_text


def test_apply_merges_json_with_variables(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    target_root = project_env["target_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)
    write_yaml(
        owner_root / "data" / "variables.yaml",
        {
            "JSON_HOST": "json.internal",
            "JSON_PORT": 9090,
            "JSON_ENABLED": True,
        },
    )
    write_json(
        owner_root / "data" / "local" / "entry" / "feature.json",
        {
            "feature": {
                "enabled": "@{JSON_ENABLED}",
                "host": "@{JSON_HOST}",
                "port": "@{JSON_PORT}",
            },
            "url": "http://@{JSON_HOST}:@{JSON_PORT}/api",
            "pipelines": [{"enabled": False}],
        },
    )

    apply_configs(owner_root, projects)

    merged_text = (target_root / "entry" / "conf" / "feature.json").read_text(encoding="utf-8")
    merged = json.loads(merged_text)
    assert merged == {
        "feature": {
            "enabled": True,
            "host": "json.internal",
            "port": 9090,
        },
        "url": "http://json.internal:9090/api",
        "pipelines": [
            {"name": "api", "enabled": False},
            {"name": "worker", "enabled": False},
        ],
    }
    assert '\n    "feature": {\n        "enabled": true,' in merged_text


def test_apply_reads_env_specific_local_overrides(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    target_root = project_env["target_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)
    write_text(owner_root / ".env", "APP_ENV=prod\n")

    write_yaml(
        owner_root / "data" / "local" / "entry" / "dev.yaml",
        {"server": {"workers": 1}},
    )
    write_yaml(
        owner_root / "data" / "local" / "entry" / "prod" / "dev.yaml",
        {"server": {"workers": 9}},
    )

    apply_configs(owner_root, projects)

    merged = yaml.safe_load((target_root / "entry" / "conf" / "dev.yaml").read_text(encoding="utf-8"))
    assert merged["server"]["workers"] == 9


def test_build_syncs_data_directories_and_bootstrap_files(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    write_text(owner_root / ".env", "APP_ENV=prod\n")
    write_yaml(owner_root / "data" / "variables.yaml", {"OLD": "value"})
    write_text(owner_root / "data" / "baseline" / "removed" / "stale.txt", "stale\n")
    write_text(owner_root / "data" / "local" / "removed" / "stale.txt", "stale\n")
    write_text(owner_root / "data" / "local" / "removed" / "prod" / "stale.txt", "stale\n")
    write_text(owner_root / "data" / "local" / "entry" / "prod" / "keep.txt", "keep\n")

    build_data_layout(owner_root, projects)

    assert (owner_root / "data" / "baseline" / "entry").is_dir()
    assert (owner_root / "data" / "local" / "entry").is_dir()
    assert (owner_root / "data" / "local" / "entry" / "prod").is_dir()
    assert not (owner_root / "data" / "baseline" / "removed").exists()
    assert not (owner_root / "data" / "local" / "removed").exists()
    assert (owner_root / "data" / "local" / "entry" / "prod" / "keep.txt").read_text(encoding="utf-8") == "keep\n"
    assert yaml.safe_load((owner_root / "data" / "variables.yaml").read_text(encoding="utf-8")) == {"OLD": "value"}
    assert (owner_root / ".env").read_text(encoding="utf-8") == "APP_ENV=prod\n"


def test_build_creates_missing_env_and_variables_files(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    (owner_root / ".env").unlink()

    build_data_layout(owner_root, projects)

    assert (owner_root / ".env").read_text(encoding="utf-8") == "APP_ENV=dev\n"
    assert yaml.safe_load((owner_root / "data" / "variables.yaml").read_text(encoding="utf-8")) == {}


def test_build_creates_placeholder_files_from_projects(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    write_text(owner_root / "data" / "baseline" / "entry" / "app.ini", "kept\n")
    write_text(owner_root / "data" / "local" / "entry" / "feature.json", "kept\n")

    build_data_layout(owner_root, projects)

    assert (owner_root / "data" / "baseline" / "entry" / "dev.yaml").read_text(encoding="utf-8") == ""
    assert (owner_root / "data" / "baseline" / "entry" / "uvicorn.log.yaml").read_text(encoding="utf-8") == ""
    assert (owner_root / "data" / "baseline" / "entry" / "feature.json").read_text(encoding="utf-8") == ""
    assert (owner_root / "data" / "baseline" / "entry" / "app.ini").read_text(encoding="utf-8") == "kept\n"
    assert (owner_root / "data" / "local" / "entry" / "dev.yaml").read_text(encoding="utf-8") == ""
    assert (owner_root / "data" / "local" / "entry" / "uvicorn.log.yaml").read_text(encoding="utf-8") == ""
    assert (owner_root / "data" / "local" / "entry" / "app.ini").read_text(encoding="utf-8") == ""
    assert (owner_root / "data" / "local" / "entry" / "feature.json").read_text(encoding="utf-8") == "kept\n"


def test_apply_writes_lock_and_re_removes_it(
    project_env: dict[str, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner_root = project_env["owner_root"]
    lock_path = owner_root / "state" / "apply.lock"
    write_yaml(owner_root / "data" / "local" / "entry" / "dev.yaml", {"server": {"workers": 2}})

    monkeypatch.setattr("sys.argv", ["cfg", "sync", "--owner-root", str(owner_root)])
    assert main() == 0

    monkeypatch.setattr("sys.argv", ["cfg", "apply", "--owner-root", str(owner_root)])
    assert main() == 0
    assert lock_path.exists()

    monkeypatch.setattr("sys.argv", ["cfg", "re", "--owner-root", str(owner_root)])
    assert main() == 0
    assert not lock_path.exists()


def test_lock_blocks_non_restore_commands(
    project_env: dict[str, Path],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    owner_root = project_env["owner_root"]
    lock_path = owner_root / "state" / "apply.lock"
    write_text(lock_path, "locked\n")

    monkeypatch.setattr("sys.argv", ["cfg", "sync", "--owner-root", str(owner_root)])
    with pytest.raises(RuntimeError, match="cfg re"):
        main()

    monkeypatch.setattr("sys.argv", ["cfg", "build", "--owner-root", str(owner_root)])
    with pytest.raises(RuntimeError, match="cfg re"):
        main()

    monkeypatch.setattr("sys.argv", ["cfg", "ls", "--owner-root", str(owner_root)])
    assert main() == 0
    assert capsys.readouterr().out.startswith("state: applied\n")


def test_apply_is_allowed_when_locked(
    project_env: dict[str, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner_root = project_env["owner_root"]
    target_root = project_env["target_root"]
    lock_path = owner_root / "state" / "apply.lock"
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)
    write_yaml(owner_root / "data" / "local" / "entry" / "dev.yaml", {"server": {"workers": 2}})
    write_text(lock_path, "locked\n")

    monkeypatch.setattr("sys.argv", ["cfg", "apply", "--owner-root", str(owner_root)])
    assert main() == 0
    assert lock_path.exists()

    merged = yaml.safe_load((target_root / "entry" / "conf" / "dev.yaml").read_text(encoding="utf-8"))
    assert merged["server"]["workers"] == 2


def test_ls_shows_baseline_state_when_unlocked(
    project_env: dict[str, Path],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    owner_root = project_env["owner_root"]

    monkeypatch.setattr("sys.argv", ["cfg", "ls", "--owner-root", str(owner_root)])
    assert main() == 0
    assert capsys.readouterr().out.startswith("state: baseline\n")


def test_apply_hides_override_details_at_info_level(
    project_env: dict[str, Path],
    caplog: pytest.LogCaptureFixture,
) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)

    write_yaml(
        owner_root / "data" / "local" / "entry" / "dev.yaml",
        {"server": {"workers": 2}},
    )

    with caplog.at_level("INFO"):
        apply_configs(owner_root, projects)

    assert "override" not in caplog.text
    assert "applied file entry/dev.yaml" in caplog.text


def test_apply_rejects_unknown_yaml_key(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)

    write_yaml(
        owner_root / "data" / "local" / "entry" / "dev.yaml",
        {"server": {"extra": 1}},
    )

    with pytest.raises(ValueError, match="unknown key"):
        apply_configs(owner_root, projects)


def test_apply_rejects_unknown_json_key(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)

    write_json(
        owner_root / "data" / "local" / "entry" / "feature.json",
        {"feature": {"extra": 1}},
    )

    with pytest.raises(ValueError, match="unknown key"):
        apply_configs(owner_root, projects)


def test_apply_rejects_undefined_variable(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)
    (owner_root / ".env").unlink()

    write_yaml(
        owner_root / "data" / "local" / "entry" / "dev.yaml",
        {"server": {"host": "@{MYSQL_HOST}"}},
    )

    with pytest.raises(FileNotFoundError, match="\\.env"):
        apply_configs(owner_root, projects)


def test_apply_rejects_null_json_value(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)

    write_json(
        owner_root / "data" / "local" / "entry" / "feature.json",
        {"feature": {"port": None}},
    )

    with pytest.raises(ValueError, match="null value"):
        apply_configs(owner_root, projects)


def test_apply_rejects_non_scalar_variable_value(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)
    write_yaml(
        owner_root / "data" / "variables.yaml",
        {"MYSQL_HOST": {"value": "db.internal"}},
    )
    write_yaml(
        owner_root / "data" / "local" / "entry" / "dev.yaml",
        {"server": {"host": "@{MYSQL_HOST}"}},
    )

    with pytest.raises(ValueError, match="scalar"):
        apply_configs(owner_root, projects)


def test_apply_rejects_null_yaml_value(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)

    write_yaml(
        owner_root / "data" / "local" / "entry" / "dev.yaml",
        {"server": {"workers": None}},
    )

    with pytest.raises(ValueError, match="null value"):
        apply_configs(owner_root, projects)


def test_restore_replaces_target_with_baseline(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    target_root = project_env["target_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)

    write_yaml(
        target_root / "entry" / "conf" / "dev.yaml",
        {"server": {"workers": 99}},
    )
    write_text(
        target_root / "entry" / "conf" / "app.ini",
        "[app]\nmode=changed\n",
    )

    restore_configs(owner_root, projects)

    restored = yaml.safe_load((target_root / "entry" / "conf" / "dev.yaml").read_text(encoding="utf-8"))
    assert restored == {
        "server": {
            "workers": 4,
            "host": "127.0.0.1",
            "port": 3306,
            "debug": False,
        },
        "logging": {"std": {"log_level": "INFO"}},
        "database": {"dsn": "mysql://127.0.0.1:3306/entry"},
        "pipelines": [
            {"name": "api", "enabled": True},
            {"name": "worker", "enabled": False},
        ],
    }
    assert (target_root / "entry" / "conf" / "app.ini").read_text(encoding="utf-8") == "[app]\nmode=default\n"


def test_apply_rejects_type_mismatch(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)

    write_yaml(
        owner_root / "data" / "local" / "entry" / "dev.yaml",
        {"server": ["wrong-type"]},
    )

    with pytest.raises(ValueError, match="type mismatch"):
        apply_configs(owner_root, projects)


def test_apply_rejects_json_type_mismatch(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")
    sync_configs(owner_root, projects)

    write_json(
        owner_root / "data" / "local" / "entry" / "feature.json",
        {"feature": ["wrong-type"]},
    )

    with pytest.raises(ValueError, match="type mismatch"):
        apply_configs(owner_root, projects)


def test_conf_dir_resolves_relative_to_code_root(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    code_root = project_env["code_root"]
    target_root = project_env["target_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")

    assert resolve_code_root(owner_root) == code_root
    assert resolve_target_file(code_root, projects[0], "dev.yaml") == target_root / "entry" / "conf" / "dev.yaml"


def test_conf_dir_accepts_absolute_path(project_env: dict[str, Path]) -> None:
    code_root = project_env["code_root"]
    target_root = project_env["target_root"]
    projects = [
        type(load_projects(project_env["owner_root"] / "config" / "projects.yaml")[0])(
            name="entry",
            conf_dir=target_root / "entry",
            files=("dev.yaml",),
        )
    ]

    assert resolve_target_file(code_root, projects[0], "dev.yaml") == target_root / "entry" / "conf" / "dev.yaml"


def test_parse_args_defaults_to_apply() -> None:
    args = parse_args([])

    assert args.command == "apply"


def test_parse_args_accepts_ls_and_re() -> None:
    list_args = parse_args(["ls"])
    build_args = parse_args(["build"])
    restore_args = parse_args(["re", "--project", "entry"])

    assert list_args.command == "ls"
    assert build_args.command == "build"
    assert restore_args.command == "re"
    assert restore_args.project_name == "entry"


def test_list_configs_omits_copy_suffix(project_env: dict[str, Path]) -> None:
    owner_root = project_env["owner_root"]
    projects = load_projects(owner_root / "config" / "projects.yaml")

    listed = list_configs(projects)

    assert listed == ("entry -> se/sdk/entry\n  dev.yaml\n  uvicorn.log.yaml\n  app.ini\n  feature.json")
    assert "[copy]" not in listed


def write_yaml(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(data, default_flow_style=False, allow_unicode=True),
        encoding="utf-8",
        newline="\n",
    )


def write_text(path: Path, data: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data, encoding="utf-8", newline="\n")


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
