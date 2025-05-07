import os
import sys
from pypdf import PdfWriter

def merge_pdfs(input_folder, output_file):
    # 获取文件夹中所有PDF文件并按字典序排序
    pdf_files = sorted(
        [f for f in os.listdir(input_folder) if f.endswith('.pdf')],
        key=str.lower
    )

    merger = PdfWriter()

    for pdf_file in pdf_files:
        file_path = os.path.join(input_folder, pdf_file)
        try:
            merger.append(file_path)
            print(f"已添加: {pdf_file}")
        except Exception as e:
            print(f"无法添加 {pdf_file}: {str(e)}")

    # 输出合并后的文件
    merger.write(output_file)
    merger.close()
    print(f"\n合并完成！输出文件: {output_file}")

# 使用示例
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Please input a directory path")
        sys.exit(1)

    path = sys.argv[1]
    if not os.path.isdir(path):
        print(f"Invalid directory path: {path}")
        sys.exit(1)

    merge_pdfs(
        input_folder=path,  # PDF文件所在文件夹
        output_file='merged.pdf'  # 合并后的输出文件名
    )