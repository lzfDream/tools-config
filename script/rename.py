import os
import sys

def batch_rename(directory, rename, extension):
    # 获取目录下的所有文件
    files = [f for f in os.listdir(directory) if os.path.isfile(os.path.join(directory, f))]
     # 添加后缀名过滤
    if extension:
        files = [f for f in files if f.lower().endswith(extension.lower())]

    if len(files) == 0:
        print("没有找到符合条件的文件。")
        return

    # 按字典序排序文件
    files.sort()

    # 遍历文件并重命名
    for idx, filename in enumerate(files, start=1):
        # 获取文件扩展名
        _, ext = os.path.splitext(filename)

        # 生成新的文件名，添加编号
        new_name = f"{idx:02d}{rename}{ext}"

        # 构造完整路径
        old_path = os.path.join(directory, filename)
        new_path = os.path.join(directory, new_name)

        # 重命名文件
        os.rename(old_path, new_path)
        print(f"{filename} -> {new_name}")

if __name__ == "__main__":
    # 获取命令行参数中的第一个参数（即目录路径）
    if len(sys.argv) < 3:
        print("Please provide a directory path as the first argument.")
        sys.exit(1)

    '''
        输入格式 路径[/*.后缀] [连接符]修改后的名字 例: ./test/*.jpg _test
        输出格式 路径/编号[连接符]修改后的名字 例: ./test/01_test.jpg
    '''
    path_pattern = sys.argv[1]
    dir_path = os.path.dirname(path_pattern)

    # 从路径中从右找 / 分割，取 [1] 部分
    suffix_part = path_pattern.rsplit('/', 1)[-1]

    # 按 ; 分割，删除每一项前面的 *，组成数组
    extensions = [ext.strip().lstrip('*') for ext in suffix_part.split(';')] if '*' in suffix_part else None

    rename = sys.argv[2]

    try:
        if os.path.isdir(dir_path):
            for ext in extensions:
                print(f"处理路径: {dir_path}, 后缀: {ext}, 输出的名字: {rename}")
                batch_rename(dir_path, rename, ext)
        else:
            print(f"无效的路径: {dir_path}")
    except Exception as e:
        print(f"发生错误: {e}")
        print(f"输入参数, 路径: {dir_path}, 后缀: {extensions}, 输出的名字: {rename}")
