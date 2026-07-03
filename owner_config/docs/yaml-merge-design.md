# Structured Config Merge Design

## Goal

Keep local structured config files minimal. Users only declare the keys they want to change, and `apply` merges those changes into the synced `baseline` before writing to the target project.

Support shared values through `data/variables.yaml`, so local YAML/JSON/INI can reference global variables with `@{VAR_NAME}`.

## Scope

- Only `.yaml`, `.yml`, `.json`, and `.ini` files use merge semantics during `apply`
- `APP_ENV=dev` reads overrides from `data/local/<project>/*`
- Non-`dev` environments read overrides from `data/local/<project>/<env>/*`
- Only local YAML/JSON/INI files participate in variable expansion
- Non-YAML files keep the original copy-based behavior
- `sync` and `restore` stay copy-based
- `build` synchronizes project directories under `data/baseline/` and `data/local/`, creates missing empty placeholder files from `projects.yaml.files`, and bootstraps `.env` plus `data/variables.yaml`
- After a successful `apply`, `state/apply.lock` is created; while it exists, `ls` remains available for status inspection, `apply` may run again, and `re` may clear the lock

## Merge Rules

- Variable expansion happens before merge
- `data/variables.yaml` must be a mapping of variable names to scalar values
- If a YAML/JSON string is exactly `@{VAR_NAME}`, it becomes the variable's original scalar type
- If `@{VAR_NAME}` appears inside a longer string, it is interpolated as text
- `dict`: recursive merge
- `list`: recursive merge by index
- scalar: replace the baseline value

The merge is intentionally strict:

- Undefined variables raise `ValueError`
- Non-scalar variable values raise `ValueError`
- Unknown keys in `local` raise `ValueError`
- `null` values in `local` raise `ValueError`
- Type mismatches raise `ValueError`
- List indexes beyond baseline length raise `ValueError`

## Integration

- `owner_config.cli.apply_configs()` loads `data/variables.yaml` once and dispatches by file suffix
- `owner_config.cli.load_app_env()` reads `owner_config/.env`; `build` bootstraps `APP_ENV=dev` when missing
- `owner_config.cli.main()` always allows `ls` and `apply`, allows `re` to clear `state/apply.lock`, and blocks every other command while the lock exists
- `owner_config.yaml_config_merger.merge_yaml_file()`, `merge_json_file()`, and `merge_ini_file()` resolve variables, then perform parsing, merge, and output
- Missing local YAML falls back to copying baseline directly

## Test Coverage

- Variable substitution works for whole-string replacement and string interpolation
- Variable substitution preserves scalar types for whole-string replacement
- YAML/JSON merge preserves untouched baseline keys
- Non-YAML files still overwrite from `local`
- Unknown variable, non-scalar variable value, unknown key, `null`, and type mismatch cases fail fast
