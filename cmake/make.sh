#!/bin/bash
cd $(dirname $0)

# 创建构建目录
mkdir -p build
cd build

# 生成构建系统文件
cmake ..
start_time=$(date +%s)  # 记录开始时间
# 使用CMake内置命令构建项目
cmake --build . -j8
end_time=$(date +%s)  # 记录结束时间
elapsed_time=$((end_time - start_time))  # 计算耗时
minutes=$((elapsed_time / 60))
seconds=$((elapsed_time % 60))
echo "Time: ${minutes}m ${seconds}s"
