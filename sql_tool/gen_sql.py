from __future__ import annotations

import sys
from datetime import datetime
from typing import IO

try:
    from env import CONTAINER_NAME, DUMP_DB, IMPORT_DB, DBConfig
except ImportError:
    print("exec 'python gen_sql.py reset' generate env.py")
    pass


def dump_all_table(f: IO[str], db_config: DBConfig) -> list[str]:
    """生成mysqldump导出所有表的命令"""
    timestamp = datetime.now().strftime("%Y%m%d")
    backup_file = f"backup_{timestamp}.sql"

    command = f"mysqldump $flag > {backup_file}"
    flag = f"flag=' -u {db_config.user} -p{db_config.password} -h {db_config.host} -P {db_config.port} --all-databases'"
    f.write(f"{flag}\n")
    f.write(f"{command}\n")
    return [backup_file]


def dump_table_struct(f: IO[str], db_config: DBConfig) -> list[str]:
    """生成mysqldump导出表结构的命令"""
    timestamp = datetime.now().strftime("%Y%m%d")
    commands = []
    files = []
    for db in db_config.database:
        backup_file = f"{db}_{timestamp}.sql"

        command = f"mysqldump $flag {db} > {backup_file}"
        commands.append(command)
        files.append(backup_file)
    flag = f"flag='-d --no-create-db --compact --skip-add-drop-table -u {db_config.user} -p{db_config.password} -h {db_config.host} -P {db_config.port}'"
    f.write(f"{flag}\n")
    f.write(f"{' && '.join(commands)}\n")
    return files


def dump_table_data(f: IO[str], db_config: DBConfig) -> list[str]:
    """生成mysqldump导出表数据的命令"""
    timestamp = datetime.now().strftime("%Y%m%d")
    commands = []
    files = []
    for db in db_config.database:
        backup_file = f"{db}_{timestamp}.sql"

        command = f"mysqldump $flag {db} > {backup_file}"
        commands.append(command)
        files.append(backup_file)
    flag = f"flag='-c -n -t --skip-extended-insert --single-transaction -u {db_config.user} -p{db_config.password} -h {db_config.host} -P {db_config.port}'"
    f.write(f"{flag}\n")
    f.write(f"{' && '.join(commands)}\n")
    return files


def dump_single_table(f: IO[str], db_config: DBConfig) -> list[str]:
    """生成mysqldump导出单个表数据的命令"""
    timestamp = datetime.now().strftime("%Y%m%d")
    commands = []
    files = []

    if db_config.table:
        for table in db_config.table:
            backup_file = f"{db_config.database[0]}_{table}_{timestamp}.sql"

            # 构建导出命令
            command = f"mysqldump $flag {db_config.database[0]} {table} > {backup_file}"
            commands.append(command)
            files.append(backup_file)

    flag = f"flag='-c -n -t --skip-extended-insert -u {db_config.user} -p{db_config.password} -h {db_config.host} -P {db_config.port}'"
    f.write(f"{flag}\n")
    f.write(f"{' && '.join(commands)}\n")

    return files


def import_command(f: IO[str], db_config: DBConfig, import_files: list[str]) -> None:
    """生成mysql导入命令"""
    commands = []
    for import_file, db in zip(import_files, db_config.database):
        command = f"mysql $flag {db} < {import_file}"
        commands.append(command)
    flag = f"flag='-u {db_config.user} -p{db_config.password} -h {db_config.host} -P {db_config.port}'"
    f.write(f"{flag}\n")
    f.write(f"{' && '.join(commands)}\n")


def copy_command_to_local(
    f: IO[str], import_files: list[str], container_name: str
) -> None:
    """生成docker复制命令，将导出的文件从容器复制到本地"""
    commands = []
    for import_file in import_files:
        command = f"docker cp {container_name}:/tmp/{import_file} ./"
        commands.append(command)
    f.write(f"{' && '.join(commands)}\n")


def copy_command_to_remote(
    f: IO[str], import_files: list[str], container_name: str
) -> None:
    """生成docker复制命令，将本地的导出文件复制到容器"""
    commands = []
    for import_file in import_files:
        command = f"docker cp ./{import_file} {container_name}:/tmp/"
        commands.append(command)
    f.write(f"{' && '.join(commands)}\n")
    f.write(f"docker cp ./*.sql {container_name}:/tmp/\n")


def main(operator: str) -> None:
    with open("command.sh", "w") as f:
        f.write("#----------------dump----------------\n")
        match operator:
            case "a":
                files = dump_all_table(f, DUMP_DB)
            case "s":
                files = dump_table_struct(f, DUMP_DB)
            case "d":
                files = dump_table_data(f, DUMP_DB)
            case "t":
                files = dump_single_table(f, DUMP_DB)
            case _:
                raise ValueError(f"Unknown operator: {operator}")

        f.write("#----------------import----------------\n")
        import_command(f, IMPORT_DB, files)

        f.write("#----------------copy----------------\n")
        copy_command_to_local(f, files, CONTAINER_NAME)
        copy_command_to_remote(f, files, CONTAINER_NAME)
        f.write("#----------------clean----------------\n")
        f.write("rm /tmp/*.sql\n")


def reset_default_config():
    """重置默认配置到env.py"""
    # 默认配置内容
    config_content = '''
from dataclasses import dataclass


@dataclass
class DBConfig:
    """数据库配置"""

    user: str
    password: str
    host: str
    port: int
    database: list[str]
    table: list[str] | None = None


CONTAINER_NAME = ""
DUMP_DB = DBConfig()
IMPORT_DB = DBConfig()
'''
    # 写入env.py文件
    with open("env.py", "w", encoding="utf-8") as f:
        f.write(config_content)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python gen_sql.py <operator>")
        print("Available operators: a (all), s (struct), d (data), t (single table)")
        print("To reset default config, use: python gen_sql.py reset")
        exit(1)
    operator = sys.argv[1]

    if operator == "reset":
        reset_default_config()
    else:
        main(operator)
