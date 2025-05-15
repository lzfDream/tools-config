import sys
import yaml
import logging
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format='[%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler()]
)

logger = logging.getLogger(__name__)

def merge_configs(source_path: Path, template_path: Path, output_path: Path):
    """
    合并两个YAML配置文件
    :param source_path: 包含要覆盖值的源配置文件
    :param template_path: 模板配置文件
    :param output_path: 输出合并后的配置文件
    """
    try:
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
                            logger.error(f"Error: {path_stack} type is not match")
                            exit(1)
                        template[key] = deep_merge(source[key], template[key])
                        path_stack.pop()
                    else:
                        path_stack.append(key)
                        logger.warning(f"template key {path_stack} is not exist, ignore")
                        path_stack.pop()
            elif isinstance(source, list) and isinstance(template, list):
                for index in range(len(source)):
                    if index >= len(template):
                        logger.error(f"Error: {path_stack} index {index} is out of range")
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

        with open(output_path, 'w', encoding='utf-8') as f:
            yaml.safe_dump(merged_config, f, default_flow_style=False, allow_unicode=True)

    except Exception as e:
        logger.error(f"Error merging configs: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 4:
        logger.info("Usage: python merge_configs.py <source_config.yaml> <template_config.yaml> <output_config.yaml>")
        sys.exit(1)

    source = sys.argv[1]
    template = sys.argv[2]
    output = sys.argv[3]

    logger.info(f'start merge config: {source} -> {template} -> {output}')
    merge_configs(Path(source), Path(template), Path(output))
    logger.info('complete')
