import os
import shutil
import sys
import yaml
import logging
from pathlib import Path

os.chdir(Path(__file__).parent)

logging.basicConfig(
    level=logging.INFO,
    format='[%(levelname)s] %(filename)s:%(lineno)d %(message)s',
    handlers=[logging.StreamHandler()]
)

logger = logging.getLogger(__name__)


def merge_configs(template_path: Path, source_path: Path, output_path: Path):
    """
    合并两个YAML配置文件
    :param source_path: 包含要覆盖值的源配置文件
    :param template_path: 模板配置文件
    :param output_path: 输出合并后的配置文件
    """
    try:
        if template_path.exists() and not source_path.exists():
            # 模板文件存在修改的文件不存在 直接将模板文件复制
            logger.info(
                f'not change to copy config: {template_path.as_posix()} {output_path.as_posix()}')
            shutil.copy(template_path, output_path)
            return
        with open(source_path, 'r', encoding='utf-8') as f:
            source_config = yaml.safe_load(f) or {}

        with open(template_path, 'r', encoding='utf-8') as f:
            template_config = yaml.safe_load(f) or {}

        path_stack = []

        def deep_merge(source, template):
            if isinstance(source, dict) and isinstance(template, dict):
                for key in list(source.keys()):
                    if key in template and template[key] is not None:
                        path_stack.append(key)
                        if type(source[key]) != type(template[key]):
                            logger.error(
                                f"Error: {path_stack} type is not match")
                            exit(1)
                        template[key] = deep_merge(source[key], template[key])
                        path_stack.pop()
                    else:
                        path_stack.append(key)
                        logger.warning(
                            f"template key {path_stack} is not exist, ignore")
                        path_stack.pop()
            elif isinstance(source, list) and isinstance(template, list):
                for index in range(len(source)):
                    if index >= len(template):
                        logger.error(
                            f"Error: {path_stack} index {index} is out of range")
                        sys.exit(1)

                    path_stack.append(index)
                    template[index] = deep_merge(
                        source[index], template[index])
                    path_stack.pop()
            else:
                if type(source) != type(template) or template is None:
                    logger.error(f"Error: {path_stack} type is not match")
                    exit(1)

                if source == template:
                    return template

                logger.info(f'{path_stack} : {template} -> {source}')
                template = source
            return template

        merged_config = deep_merge(source_config, template_config)

        with open(output_path, 'w', encoding='utf-8', newline='\n') as f:
            yaml.safe_dump(merged_config, f,
                           default_flow_style=False, allow_unicode=True)

    except Exception as e:
        logger.error(f"Error merging configs: {e}")


def merge_configs_path(template_path: Path, source_path: Path, output_path: Path):
    # 遍历目录下所有yaml文件
    template_files = list(template_path.glob('*.yaml')) + \
        list(template_path.glob('*.yml'))
    if not template_files:
        logger.error(
            f"No YAML files found in template directory: {template_path}")
        return

    # 处理每个template文件
    source_files = [source_path /
                    template_file.name for template_file in template_files]
    output_files = [output_path /
                    template_file.name for template_file in template_files]
    for template, source, output in zip(template_files, source_files, output_files):
        logger.info('---------------------------------')
        logger.info(f'start merge config: {template.as_posix()} {source.as_posix()} {output.as_posix()}')
        merge_configs(template, source, output)


def copy_conf_path(template_path: Path, output_path: Path):
    # 将模板目录下的所有yaml文件复制到输出目录
    template_files = list(template_path.glob('*.yaml')) + \
        list(template_path.glob('*.yml'))
    if not template_files:
        logger.error(
            f"No YAML files found in template directory: {template_path}")
        return
    # 处理每个template文件
    output_files = [output_path /
                    template_file.name for template_file in template_files]
    for template, output in zip(template_files, output_files):
        logger.info(f'copy config: {template.as_posix()} {output.as_posix()}')
        shutil.copy(template, output)


if __name__ == "__main__":
    if len(sys.argv) < 4:
        logger.error(
            "Usage: python merge_configs.py <template_config.yaml|dir> <source_config.yaml|dir> <output_config.yaml|dir>")
        sys.exit(1)

    template = sys.argv[1]
    source = sys.argv[2]
    output = sys.argv[3]

    template_files = []
    source_files = []
    output_files = []

    # 处理template是目录的情况
    template_path = Path(template)
    if template_path.is_dir():
        # 确保source和output也是目录
        output_path = Path(output)
        source_path = Path(source)
        if not output_path.is_dir() or not source_path.is_dir():
            logger.error(
                f"source and output must be a directory when template is a directory")
            sys.exit(1)

        merge_configs_path(template_path, source_path, output_path)
    else:
        logger.info(f'start merge config: {template.as_posix()} {source.as_posix()} {output.as_posix()}')
        merge_configs(template, source, output)

    logger.info('complete')
